/**
 * Anonymous free tier for `/mcp`.
 *
 * When a request arrives with NO `Authorization` header and all three
 * free-tier bindings are configured, the Worker serves it as a rate-limited
 * anonymous request instead of a 401: a shared free-tier Tako API key is
 * forwarded to Django, the visible toolset shrinks to
 * `FREE_TIER_TOOL_NAMES`, and requests are limited by two buckets:
 *
 * - A GLOBAL ceiling (constant key, every anonymous request regardless of
 *   method) — the actual spend/volume bound. Per-IP keying means nothing
 *   for hosted MCP hosts (claude.ai, ChatGPT, Centaur) whose fetches all
 *   egress from a handful of platform IPs, and an IPv6 /64 can mint
 *   endless distinct keys — so the global bucket is the control that
 *   bounds the shared account, and it also caps the otherwise-unmetered
 *   handshake methods (`initialize`, `tools/list`), which need no
 *   credential at all.
 * - A PER-IP bucket (fairness layer) counting only `tools/call`s that
 *   name one of the three free tools — the only requests that spend Tako
 *   credits. Calls to hidden tools return "tool not found" without
 *   burning the caller's per-IP quota (they still count globally).
 *
 * JSON-RPC batch arrays are rejected outright (see
 * `checkFreeTierRateLimit`) rather than metered — a batch would let one
 * limiter hit cover an arbitrary number of Django-spending calls. Bodies
 * over `MAX_FREE_TIER_BODY_BYTES` are rejected before being buffered:
 * this parse is new pre-auth surface, so it must not read unbounded
 * unauthenticated input. Design doc:
 * `docs/superpowers/specs/2026-07-26-anonymous-free-tier-design.md`.
 *
 * Fail modes, deliberately asymmetric:
 * - Configuration missing → fail CLOSED (`resolveFreeTierConfig` returns
 *   null, callers keep today's 401). An env that never opted in must not
 *   silently serve anonymous traffic.
 * - Limiter runtime failure → fail OPEN for that request. A Cloudflare
 *   limiter hiccup must not take the tier down; the free-tier account's own
 *   Django-side limits backstop total spend. Detection runbook is in
 *   `workers/README.md` — the greppable signal is the "failing open" error
 *   line below.
 */

import type { Env, RateLimit } from "./env.js";

/** Which surface a connection gets — see `createMcpServer`'s tier gate. */
export type Tier = "free" | "authenticated";

/**
 * The complete anonymous tool surface. Everything else is hidden (not
 * listed, not callable) rather than listed-but-erroring — tools that
 * error on call waste agent turns.
 */
export const FREE_TIER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_available_data",
  "tako_search",
  "tako_answer",
]);

/**
 * Upper bound on an anonymous request body. The body peek below buffers a
 * clone of unauthenticated input, so it must be bounded the same way
 * `django.ts` bounds error-body reads. Real free-tier tool calls are a few
 * KiB of JSON; 128 KiB is generous.
 */
export const MAX_FREE_TIER_BODY_BYTES = 128 * 1024;

/** Resolved free-tier bindings — proof the env opted in. */
export interface FreeTierConfig {
  /** Forwarded to Django as `X-API-Key` for anonymous requests. */
  apiKey: string;
  /** Per-IP fairness limiter — free-tool `tools/call`s only. */
  limiter: RateLimit;
  /** Global (constant-key) ceiling — every anonymous request. */
  globalLimiter: RateLimit;
}

/**
 * Gate the free tier on configuration: the shared API key and BOTH
 * rate-limit bindings must be present, else `null` (fail-closed — callers
 * return the same 401 the Worker served before the free tier existed).
 * The limiters are shape-checked (not just truthy) so a misconfigured
 * binding fails here, at the gate, instead of throwing mid-request. The
 * key is trimmed: `wrangler secret put` fed from a pipe or file picks up
 * a trailing newline, which would otherwise 401 every anonymous request
 * downstream — indistinguishable from a wrong key.
 */
export function resolveFreeTierConfig(env: Env): FreeTierConfig | null {
  const apiKey =
    typeof env.FREE_TIER_API_KEY === "string"
      ? env.FREE_TIER_API_KEY.trim()
      : "";
  const limiter = env.FREE_TIER_RATE_LIMITER;
  const globalLimiter = env.FREE_TIER_GLOBAL_RATE_LIMITER;
  if (apiKey.length === 0) return null;
  if (typeof limiter?.limit !== "function") return null;
  if (typeof globalLimiter?.limit !== "function") return null;
  return { apiKey, limiter, globalLimiter };
}

/**
 * Should this JSON-RPC body count against the free-tier PER-IP limit?
 *
 * Only a `tools/call` naming one of the three free tools is metered — the
 * only request shape that spends the shared account's Tako credits.
 * Handshake and discovery methods (`initialize`, `tools/list`,
 * notifications, pings) must stay unmetered or clients would burn quota
 * just connecting, and a `tools/call` for a hidden tool (`tako_agent`,
 * `get_credit_balance`, …) returns "tool not found" without spending a
 * credit, so a confused client retrying it must not burn its whole
 * minute. Both stay bounded by the global ceiling, which counts every
 * anonymous request before this decision is made. Array bodies never
 * reach here — `checkFreeTierRateLimit` rejects batches before the
 * metering decision. Anything unparseable / non-object is unmetered: it
 * can never reach Django, and the SDK will reject it with a proper
 * JSON-RPC error on its own.
 */
export function isMeteredJsonRpcBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return false;
  if (typeof params !== "object" || params === null) return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && FREE_TIER_TOOL_NAMES.has(name);
}

/** A JSON-RPC request id — what `freeTierLimitResponse` echoes back. */
export type JsonRpcRequestId = string | number | null;

/** Outcome of the anonymous-path admission checks, in check order. */
export type FreeTierMeterResult =
  | { kind: "allowed" }
  /** Global ceiling exhausted — every anonymous request counts here. */
  | { kind: "global_limited" }
  /** Body over `MAX_FREE_TIER_BODY_BYTES` (or unparseable length). */
  | { kind: "too_large" }
  /** JSON-RPC batch (array body) — rejected, never metered. */
  | { kind: "batch" }
  /**
   * Per-IP bucket exhausted on a metered `tools/call`. Carries the
   * request id (when the body was parseable) so the response can be a
   * proper JSON-RPC *result* the client resolves — see
   * `freeTierLimitResponse` for why a 429 would never reach the model.
   */
  | { kind: "limited"; requestId: JsonRpcRequestId };

/**
 * Derive the per-IP bucket key from `CF-Connecting-IP`. Cloudflare sets
 * the header on every proxied request (and overwrites any client-supplied
 * value), so the `"unknown"` shared bucket only occurs in local
 * `wrangler dev`. IPv6 addresses are keyed by their /64 prefix — end
 * users typically hold an entire /64, so keying the full address would
 * hand one subscriber effectively unlimited distinct buckets.
 */
export function freeTierRateLimitKey(ip: string | null): string {
  if (ip === null) return "unknown";
  if (!ip.includes(":")) return ip;
  // Expand `::` far enough to name the first four hextets (the /64).
  const [head = "", tail = ""] = ip.split("::");
  const headParts = head === "" ? [] : head.split(":");
  if (!ip.includes("::")) return `v6:${headParts.slice(0, 4).join(":")}`;
  const tailParts = tail === "" ? [] : tail.split(":");
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = [...headParts, ...Array<string>(missing).fill("0"), ...tailParts];
  return `v6:${full.slice(0, 4).join(":")}`;
}

/**
 * Admission checks for an anonymous request, in order:
 *
 * 1. Global ceiling — one constant-key `limit()` per anonymous request,
 *    before the body is even looked at. This is the spend/volume bound
 *    (see module header) and the only limit on handshake methods.
 * 2. Body size — a declared `Content-Length` over
 *    `MAX_FREE_TIER_BODY_BYTES` is rejected before any read, and the
 *    body peek itself is a BOUNDED read that aborts past the same cap
 *    (`Content-Length` is client-supplied and can lie; the bounded read
 *    is the enforcement, the header check just a cheap early exit).
 * 3. Batch rejection — array bodies (see module header).
 * 4. Per-IP metering — only for `tools/call`s naming a free tool, keyed
 *    per `freeTierRateLimitKey`, on a CLONE of the body (the transport
 *    still needs the original stream).
 *
 * Limiter failure (either bucket) fails OPEN — see module header. The
 * "failing open" error line is the runbook grep target.
 */
export async function checkFreeTierRateLimit(
  request: Request,
  config: FreeTierConfig,
): Promise<FreeTierMeterResult> {
  try {
    const { success } = await config.globalLimiter.limit({ key: "global" });
    if (!success) {
      console.log("[free-tier] global ceiling limited");
      return { kind: "global_limited" };
    }
  } catch (err) {
    console.error(
      `[free-tier] global rate limiter error (failing open): ${String(err)}`,
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isFinite(declaredBytes) || declaredBytes > MAX_FREE_TIER_BODY_BYTES) {
      return { kind: "too_large" };
    }
  }

  const peeked = await readBoundedJson(request);
  if (peeked.kind === "too_large") return { kind: "too_large" };
  if (peeked.kind === "unparseable") return { kind: "allowed" };
  const body = peeked.body;
  if (Array.isArray(body)) return { kind: "batch" };
  if (!isMeteredJsonRpcBody(body)) return { kind: "allowed" };

  const rawId = (body as { id?: unknown }).id;
  const requestId: JsonRpcRequestId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  return hitPerIpLimiter(request, config.limiter, requestId);
}

/**
 * Read a CLONE of the request body as JSON, aborting once the byte count
 * passes `MAX_FREE_TIER_BODY_BYTES`. This is the actual size enforcement
 * for the anonymous body peek — it never buffers more than the cap plus
 * one chunk, regardless of what `Content-Length` claims. Unparseable
 * (or absent) bodies are reported as such, not thrown: the SDK gives
 * those a proper JSON-RPC error downstream.
 */
async function readBoundedJson(
  request: Request,
): Promise<
  | { kind: "ok"; body: unknown }
  | { kind: "too_large" }
  | { kind: "unparseable" }
> {
  const clone = request.clone();
  if (clone.body === null) return { kind: "unparseable" };
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_FREE_TIER_BODY_BYTES) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: "ok", body: JSON.parse(new TextDecoder().decode(joined)) };
  } catch {
    return { kind: "unparseable" };
  }
}

/** Per-IP bucket hit shared by the parsed and no-length paths. */
async function hitPerIpLimiter(
  request: Request,
  limiter: RateLimit,
  requestId: JsonRpcRequestId,
): Promise<FreeTierMeterResult> {
  const key = freeTierRateLimitKey(request.headers.get("cf-connecting-ip"));
  try {
    const { success } = await limiter.limit({ key });
    console.log(`[free-tier] ip=${key} ${success ? "allowed" : "limited"}`);
    return success ? { kind: "allowed" } : { kind: "limited", requestId };
  } catch (err) {
    console.error(
      `[free-tier] ip=${key} rate limiter error (failing open): ${String(err)}`,
    );
    return { kind: "allowed" };
  }
}

/**
 * The over-limit message. States the limit number — keep in sync with the
 * `simple.limit` value on the `FREE_TIER_RATE_LIMITER` bindings in
 * `wrangler.jsonc` (a test in `freetier.test.ts` asserts they match). The
 * URL is the upsell: a free API key lifts the anonymous per-IP limit and
 * unlocks the full toolset.
 */
export const FREE_TIER_LIMIT_MESSAGE =
  "Free tier limit reached (10 requests/min). Try again in a minute, or " +
  "get a free API key at https://trytako.com/account/ for higher limits.";

/**
 * Response for an over-limit metered `tools/call`.
 *
 * With a known request id this is deliberately HTTP 200 carrying a
 * JSON-RPC *result* with `isError: true` — the same shape Django tool
 * errors use — NOT a 429. On any non-2xx POST the MCP SDK client throws a
 * transport-level `StreamableHTTPError` and the pending `tools/call`
 * rejects, so an upsell delivered via 429 never reaches the model as
 * readable text. As a tool result, the host feeds the message straight
 * back to the model, which can relay it to the user.
 *
 * Without an id (a metered body whose `id` is absent or malformed) a
 * matching result cannot be built, so this degrades to the legacy 429
 * (`code: -32000`, distinct from `-32001` auth failures) with a
 * `Retry-After` matching the limiter window.
 */
export function freeTierLimitResponse(requestId: JsonRpcRequestId): Response {
  if (requestId === null) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: FREE_TIER_LIMIT_MESSAGE,
          data: { kind: "rate_limited" },
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "60",
        },
      },
    );
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: FREE_TIER_LIMIT_MESSAGE }],
        isError: true,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * The global-ceiling message. Keep the number in sync with the
 * `FREE_TIER_GLOBAL_RATE_LIMITER` bindings in `wrangler.jsonc` (asserted
 * by the same drift test as `FREE_TIER_LIMIT_MESSAGE`).
 */
export const FREE_TIER_GLOBAL_LIMIT_MESSAGE =
  "The Tako free tier is at capacity right now. Try again shortly, or " +
  "get a free API key at https://trytako.com/account/ for dedicated access.";

/**
 * HTTP 429 for a request over the GLOBAL anonymous ceiling. This fires
 * before the body is read, so no request id is available and the tripping
 * request may not even be a `tools/call` — a plain 429 (which the SDK
 * client surfaces as a transport error) is the honest answer here, unlike
 * the per-IP case above. It should be rare: the ceiling is sized well
 * above expected legitimate volume.
 */
export function freeTierGlobalLimitResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: FREE_TIER_GLOBAL_LIMIT_MESSAGE,
        data: { kind: "global_rate_limited" },
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": "60",
      },
    },
  );
}

/**
 * HTTP 413 for an anonymous body over `MAX_FREE_TIER_BODY_BYTES` (or with
 * an unparseable `Content-Length`). Rejected before any buffering — see
 * step 2 in `checkFreeTierRateLimit`.
 */
export function freeTierTooLargeResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `Request body exceeds the free-tier limit of ${MAX_FREE_TIER_BODY_BYTES} bytes.`,
        data: { kind: "payload_too_large" },
      },
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * The batch-rejection body's `message`. States the constraint plainly and
 * points at the same upsell as `FREE_TIER_LIMIT_MESSAGE` — a free API key
 * also lifts the batch restriction, since it puts the request on the
 * authenticated path where this check never runs.
 */
export const FREE_TIER_BATCH_MESSAGE =
  "Batch requests are not supported on the free tier. Send one JSON-RPC " +
  "request per POST, or get a free API key at https://trytako.com/account/ " +
  "for full access.";

/**
 * HTTP 400 for an anonymous JSON-RPC batch (array body). `id: null` (a
 * batch has no single request id, and this runs before the SDK would parse
 * one), `code: -32600` (JSON-RPC "Invalid Request" — batching is no longer
 * a valid request shape per the 2025-06-18 MCP spec).
 */
export function freeTierBatchResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: FREE_TIER_BATCH_MESSAGE,
        data: { kind: "batch_not_supported" },
      },
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

/**
 * Model-visible message when the SHARED free-tier account runs out of
 * Tako credits — the steady-state failure the Django-side cap exists to
 * produce (it is the fail-open spend backstop). Without this mapping the
 * anonymous user would see Django's raw billing error spliced into the
 * tool result by `djangoErrorToToolResult`, which reads as a bug rather
 * than an upsell.
 */
export const FREE_TIER_CREDITS_MESSAGE =
  "The Tako free tier is temporarily out of shared capacity. Get a free " +
  "API key at https://trytako.com/account/ to keep going with your own " +
  "account.";

/**
 * Tool result substituted for a Django payment/credit error on the free
 * tier. Same envelope `djangoErrorToToolResult` produces (`isError: true`,
 * text content, machine-readable `_meta["tako/error"]`), with the billing
 * detail replaced by upsell copy. Callers (see `registerTool`'s catch in
 * `mcp.ts`) decide *when* this applies — this module only owns the shape.
 */
export function freeTierCreditsToolResult(): {
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: FREE_TIER_CREDITS_MESSAGE }],
    _meta: { "tako/error": { kind: "free_tier_credits_exhausted" } },
    isError: true,
  };
}
