/**
 * Anonymous free tier for `/mcp`.
 *
 * When a request arrives with NO `Authorization` header and all three
 * free-tier bindings are configured, the Worker serves it as a rate-limited
 * anonymous request instead of a 401: a shared free-tier Tako API key is
 * forwarded to Django, the EXECUTABLE toolset shrinks to
 * `FREE_TIER_TOOL_NAMES` (ChatGPT clients additionally LIST — but cannot
 * run — the auth-required submitted tools, see
 * `CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES` in `tools/_surface.ts`),
 * and requests are limited by two buckets:
 *
 * - A constant-key bucket hit by every anonymous request regardless of
 *   method — PER-COLO BURST SHAPING, not a true global ceiling:
 *   Cloudflare's ratelimit binding counts per colo with no global mode,
 *   so the enforced number is `limit × (colos reached)`, and hosted MCP
 *   hosts (claude.ai, ChatGPT, Centaur) egressing from many regions
 *   maximize that fan-out. It still bounds per-colo floods — including
 *   the otherwise-unmetered handshake methods, which need no credential
 *   at all. The genuinely GLOBAL ceiling is Django's Redis-backed
 *   per-user throttles on the free-tier account (search and answer at
 *   720/min per user, graph at 180/min + 10,000/day per user — see
 *   `app/backend/api/throttling/policy.py` in the monorepo), which every
 *   anonymous request lands on because they all authenticate as the one
 *   `FREE_TIER_API_KEY` user.
 * - A PER-IP bucket (fairness layer) counting only `tools/call`s that
 *   name one of the three free tools — the only requests that spend Tako
 *   credits. Calls to hidden tools return "tool not found" without
 *   burning the caller's per-IP quota (they still count per-colo).
 *   Per-IP keying alone means little for hosted hosts (shared egress
 *   IPs), which is why the platform-wide bound lives in Django.
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
 * The complete anonymous EXECUTABLE tool surface. On most clients
 * everything else is hidden (not listed, not callable) rather than
 * listed-but-erroring — tools that error on call waste agent turns. The
 * one exception is ChatGPT, whose link-account UI requires the two
 * auth-required submitted tools to stay LISTED on anonymous connections
 * (`CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES` in `tools/_surface.ts`);
 * those answer an `_meta["mcp/www_authenticate"]` challenge at dispatch
 * (see the free-tier gate in `mcp.ts`) and never execute anonymously.
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
 * just connecting, and a `tools/call` for a non-free tool spends no
 * credit either — on most clients it returns "tool not found"; on
 * ChatGPT the listed-but-gated tools (`tako_contents`, `tako_visualize`)
 * return an auth challenge from the dispatch gate in `mcp.ts` without
 * ever reaching Django — so a confused client retrying it must not burn
 * its whole minute. Both stay bounded by the global ceiling, which
 * counts every anonymous request before this decision is made. Array bodies never
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
  /**
   * Admitted. `body` is the parsed JSON-RPC body when the peek could parse
   * one (absent for unparseable bodies) — carried so the caller can gate
   * `tools/call`s naming known-but-auth-required tools BEFORE the SDK sees
   * them (see `handleMcpRequest`'s hidden-tool gate in `mcp.ts`) without a
   * second body read.
   */
  | { kind: "allowed"; body?: unknown }
  /**
   * Per-colo ceiling exhausted — every anonymous request counts here.
   * `requestId` is set when the body is a `tools/call` request (any tool
   * name) so the response can be a readable tool result; null otherwise.
   */
  | { kind: "global_limited"; requestId: JsonRpcRequestId }
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
 * 1. Body size — a declared `Content-Length` over
 *    `MAX_FREE_TIER_BODY_BYTES` is rejected before any read, and the
 *    body peek itself is a BOUNDED read that aborts past the same cap
 *    (`Content-Length` is client-supplied and can lie; the bounded read
 *    is the enforcement, the header check just a cheap early exit).
 * 2. Per-colo ceiling — one constant-key `limit()` per anonymous request
 *    (parse failures included, so garbage floods still count). The peek
 *    runs FIRST so that a ceiling-limited `tools/call` can carry its
 *    request id and answer as a readable tool result instead of a 429
 *    the SDK client swallows as a transport error.
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
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isFinite(declaredBytes) || declaredBytes > MAX_FREE_TIER_BODY_BYTES) {
      return { kind: "too_large" };
    }
  }

  const peeked = await readBoundedJson(request);
  if (peeked.kind === "too_large") return { kind: "too_large" };
  const body = peeked.kind === "ok" ? peeked.body : undefined;

  // A response with a matching id can only be built for a `tools/call`
  // (the tool-error result shape is not a valid reply to other methods).
  const toolsCallId = jsonRpcToolsCallId(body);

  try {
    const { success } = await config.globalLimiter.limit({ key: "global" });
    if (!success) {
      console.log("[free-tier] per-colo ceiling limited");
      return { kind: "global_limited", requestId: toolsCallId };
    }
  } catch (err) {
    console.error(
      `[free-tier] global rate limiter error (failing open): ${String(err)}`,
    );
  }

  if (peeked.kind === "unparseable") return { kind: "allowed" };
  if (Array.isArray(body)) return { kind: "batch" };
  if (!isMeteredJsonRpcBody(body)) return { kind: "allowed", body };

  const rawId = (body as { id?: unknown }).id;
  const requestId: JsonRpcRequestId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const metered = await hitPerIpLimiter(request, config.limiter, requestId);
  return metered.kind === "allowed" ? { kind: "allowed", body } : metered;
}

/**
 * The request id, iff `body` is a single JSON-RPC `tools/call` request
 * (any tool name) with a well-formed id — the only shape whose over-limit
 * response can echo an id inside a tool-error result.
 */
function jsonRpcToolsCallId(body: unknown): JsonRpcRequestId {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { method, id } = body as { method?: unknown; id?: unknown };
  if (method !== "tools/call") return null;
  return typeof id === "string" || typeof id === "number" ? id : null;
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
 * The over-limit message for the per-IP bucket. It states NO number: the
 * Cloudflare rate-limit binding is permissive and eventually consistent, so it
 * cannot enforce a specific rate (measured: 20 of 20 normal-paced requests
 * admitted against a 10-per-60s bucket). A drift test in `freetier.test.ts`
 * fails if a rate figure is reintroduced here.
 *
 * It also carries NO account link, pricing, or "get an API key" copy, and the
 * guard test in `freetier.test.ts` fails if any returns. This is a
 * model-visible string: OpenAI's commerce policy forbids promoting or selling
 * digital services, subscriptions, tokens, or credits through an app, and
 * every one of these messages reaches ChatGPT's model as tool-result text
 * (see `freeTierLimitResponse`). Paid-account functionality itself is
 * allowed — advertising it here is not. A caller who wants their own key
 * finds it the same way every other Tako API user does, on tako.com.
 * The one exception is `FREE_TIER_COMMERCE_UPSELL` below, appended only on
 * connections positively identified as Anthropic clients.
 */
export const FREE_TIER_LIMIT_MESSAGE =
  "Rate limit reached for anonymous access. Try again in a minute.";

/**
 * Upsell sentence appended to the limit/capacity messages — ONLY when the
 * caller passes `commerceCopyAllowed: true`, which `mcp.ts` derives from
 * `commerceCopyAllowedForUa` (an allowlist of POSITIVELY-identified
 * Anthropic clients; unknown UAs fail closed). The base messages stay
 * commerce-free because they reach ChatGPT's model (see
 * `FREE_TIER_LIMIT_MESSAGE`); Anthropic hosts have no such policy, and the
 * anonymous limit is the natural moment to say an account exists — the
 * same conversion point Exa's keyless tier uses ("add your own API key to
 * continue"). Bare domain, no deep link: deep links rot (the `/account/`
 * path a previous version of this copy used was already stale when it was
 * removed — see `PAYMENT_REQUIRED_REMEDY_FALLBACK` in `mcp.ts`).
 */
export const FREE_TIER_COMMERCE_UPSELL =
  "Connecting a Tako account (tako.com) lifts these anonymous-access limits.";

/**
 * Response for an over-limit metered `tools/call`.
 *
 * With a known request id this is deliberately HTTP 200 carrying a
 * JSON-RPC *result* with `isError: true` — the same shape Django tool
 * errors use — NOT a 429. On any non-2xx POST the MCP SDK client throws a
 * transport-level `StreamableHTTPError` and the pending `tools/call`
 * rejects, so a message delivered via 429 never reaches the model as
 * readable text — the caller just sees a dead transport. As a tool result,
 * the host feeds the message straight back to the model, which can relay
 * the retry advice to the user.
 *
 * Without an id (a metered body whose `id` is absent or malformed) a
 * matching result cannot be built, so this degrades to the legacy 429
 * (`code: -32000`, distinct from `-32001` auth failures) with a
 * `Retry-After` matching the limiter window.
 *
 * `commerceCopyAllowed` (from `commerceCopyAllowedForUa` in `mcp.ts`)
 * appends `FREE_TIER_COMMERCE_UPSELL`; defaults false so every caller
 * fails closed.
 */
export function freeTierLimitResponse(
  requestId: JsonRpcRequestId,
  commerceCopyAllowed = false,
): Response {
  const message = commerceCopyAllowed
    ? `${FREE_TIER_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`
    : FREE_TIER_LIMIT_MESSAGE;
  if (requestId === null) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message,
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
        content: [{ type: "text", text: message }],
        // Same discriminant every other failed tool result carries
        // (djangoErrorToToolResult, freeTierCreditsToolResult, …), same
        // spelling as the 429 branch's `data.kind` above. The chart widget
        // keys its labelled empty state on this: rate limiting is the most
        // common anonymous-ChatGPT failure, and without the marker it was
        // the one failure that still left an unlabelled blank box.
        _meta: { "tako/error": { kind: "rate_limited" } },
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
 * The per-colo-ceiling message. Deliberately numberless: the binding's
 * `limit` is enforced per Cloudflare colo, so the effective platform-wide
 * number varies with colo fan-out and any stated figure would be wrong.
 * (The drift test only asserts the three env bindings agree with each
 * other; there is no message number to sync.)
 *
 * No account link or upgrade copy either — see `FREE_TIER_LIMIT_MESSAGE`
 * for why every message in this module is a pure capacity statement.
 */
export const FREE_TIER_GLOBAL_LIMIT_MESSAGE =
  "Anonymous access is at capacity right now. Try again shortly.";

/**
 * Response for a request over the per-colo anonymous ceiling. Same
 * readability rule as `freeTierLimitResponse`: when the tripping request
 * is a `tools/call` with a known id, answer HTTP 200 with a JSON-RPC
 * tool-error result the model can read; otherwise (handshake methods,
 * unparseable bodies, batches) a plain 429 with `Retry-After` is the only
 * shape available.
 *
 * Same `commerceCopyAllowed` semantics as `freeTierLimitResponse`.
 */
export function freeTierGlobalLimitResponse(
  requestId: JsonRpcRequestId,
  commerceCopyAllowed = false,
): Response {
  const message = commerceCopyAllowed
    ? `${FREE_TIER_GLOBAL_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`
    : FREE_TIER_GLOBAL_LIMIT_MESSAGE;
  if (requestId === null) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          // A distinct kind from the per-IP bucket, on purpose. Collapsing
          // the two was tried and reverted: the two messages say different
          // things anyway, so a caller reads the topology off `message` just
          // as easily as off `kind`. Hiding it in one field and not the other
          // bought nothing and broke a client-visible contract. If the
          // topology ever needs to be genuinely opaque, the MESSAGES have to
          // converge first — and that costs the caller the difference between
          // "slow down" and "come back later".
          message,
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
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: message }],
        // See freeTierLimitResponse: the widget's failed-call label keys on
        // this. Kind mirrors the 429 branch's `data.kind`, distinct from the
        // per-IP bucket on purpose (comment above).
        _meta: { "tako/error": { kind: "global_rate_limited" } },
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
 * The body-too-large message. Unlike the rate-limit messages, this DOES
 * state a number: `MAX_FREE_TIER_BODY_BYTES` is exactly enforced by the
 * bounded read in `readBoundedJson` (not an approximate or eventually
 * consistent binding), so stating the byte cap is honest.
 */
export const FREE_TIER_TOO_LARGE_MESSAGE =
  `Request body is too large for anonymous access. The limit is ` +
  `${MAX_FREE_TIER_BODY_BYTES} bytes.`;

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
        message: FREE_TIER_TOO_LARGE_MESSAGE,
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
 * The batch-rejection body's `message`. States the constraint and the fix —
 * one request per POST — and nothing else. It used to close with the same
 * account-link upsell as `FREE_TIER_LIMIT_MESSAGE`; see that constant for
 * why no message in this module carries one. Nothing is lost operationally:
 * the actionable half was always "send one request per POST", which is what
 * a batching client has to do regardless of how it authenticates.
 */
export const FREE_TIER_BATCH_MESSAGE =
  "Batch requests are not supported for anonymous access. Send one " +
  "JSON-RPC request per POST.";

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
 * Model-visible message when the shared anonymous account runs out of Tako
 * credits. This is the DESIGNED safety valve, not an anomaly: the pre-paid
 * credit balance is the abuse bound, because the Worker rate limiters are a
 * burn-rate dampener rather than a bound. Exhaustion is therefore an expected
 * steady state, and the operator tops the account up. Without this mapping the
 * caller would see Django's raw billing error spliced into the tool result by
 * `djangoErrorToToolResult`, which reads as a bug.
 *
 * Phrased as capacity, with no account link — see `FREE_TIER_LIMIT_MESSAGE`.
 * "temporarily" and "shared" are the load-bearing words: together they tell
 * the caller the shortage is neither permanent nor their own doing, which is
 * what stops them hunting a fault in their own setup, without naming SPENT
 * CREDIT (which would hand a prober a gauge on the account's balance).
 */
export const FREE_TIER_CREDITS_MESSAGE =
  "Anonymous access is temporarily out of shared capacity. Try again later.";

/**
 * Tool result substituted for a Django payment/credit error on the free
 * tier. Same envelope `djangoErrorToToolResult` produces (`isError: true`,
 * text content, machine-readable `_meta["tako/error"]`), with the billing
 * detail replaced by the neutral capacity message. Callers (see
 * `registerTool`'s catch in `mcp.ts`) decide *when* this applies — this
 * module only owns the shape.
 *
 * The `kind` is deliberately vague about the CAUSE. The message above does
 * say the capacity is shared — that is load-bearing, because it tells the
 * caller the exhaustion is not their own doing and stops them hunting a
 * fault in their own setup. What neither states is that the shortage is
 * SPENT CREDIT, which would hand a prober a gauge for how depleted the
 * account is. "capacity" says only that the request cannot be served right
 * now. The guard test therefore bans credit and billing wording from the
 * kind, and does NOT ban "shared".
 *
 * `commerceCopyAllowed` (same semantics as `freeTierLimitResponse`) appends
 * the account upsell WITHOUT unmasking the cause: "connect an account to
 * get past shared capacity" is true and actionable whether the shared
 * account is rate-limited or dry, so the balance-gauge concern above is
 * untouched.
 */
export function freeTierCreditsToolResult(commerceCopyAllowed = false): {
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
  isError: true;
} {
  const text = commerceCopyAllowed
    ? `${FREE_TIER_CREDITS_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`
    : FREE_TIER_CREDITS_MESSAGE;
  return {
    content: [{ type: "text", text }],
    _meta: { "tako/error": { kind: "capacity" } },
    isError: true,
  };
}
