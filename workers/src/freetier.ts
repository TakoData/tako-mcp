/**
 * Anonymous free tier for `/mcp`.
 *
 * When a request arrives with NO `Authorization` header and all three
 * free-tier bindings are configured, the Worker serves it as a rate-limited
 * anonymous request instead of a 401: a shared free-tier Tako API key is
 * forwarded to Django, the EXECUTABLE toolset shrinks to
 * `FREE_TIER_TOOL_NAMES` (the LISTING is unchanged — a listed
 * auth-required tool answers sign-in instructions at dispatch, see the
 * free-tier gate in `mcp.ts`), and requests are limited by two buckets:
 *
 * - A constant-key bucket hit by every anonymous request regardless of
 *   method — PER-COLO BURST SHAPING, not a true global ceiling:
 *   Cloudflare's ratelimit binding counts per colo with no global mode,
 *   so the enforced number is `limit × (colos reached)`, and hosted MCP
 *   hosts (claude.ai, ChatGPT, Centaur) egressing from many regions
 *   maximize that fan-out. It still bounds per-colo floods — including
 *   the otherwise-unmetered handshake methods, which need no credential
 *   at all. The genuinely GLOBAL ceiling is Django's Redis-backed
 *   per-user throttles on the free-tier account, which every anonymous
 *   request lands on because they all authenticate as the one
 *   `FREE_TIER_API_KEY` user. Read the live numbers from
 *   `app/backend/api/throttling/policy.py` in the monorepo rather than from
 *   here: a copy of that table went stale the moment `tako_answer` moved
 *   behind `?tools=answer` (it named answer, which no anonymous connection
 *   can reach), and again when `tako_available_data` left the free set.
 * - A PER-IP bucket (fairness layer) counting only `tools/call`s that name
 *   a tool in `FREE_TIER_TOOL_NAMES` — `tako_search`, the one request that
 *   spends Tako credits. A call to any other tool spends none and does not
 *   burn the caller's per-IP quota (it still counts per-colo).
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
import { TOOL_REGISTRY } from "./tools/_registry.js";
import { FREE_TIER_TOOL_NAMES } from "./tools/_surface.js";

/** Which surface a connection gets — see `createMcpServer`'s tier gate. */
export type Tier = "free" | "authenticated";

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
 * Only a `tools/call` naming `tako_search` or `tako_available_data` is
 * metered — the only request shape that spends the shared account's Tako
 * credits. Handshake and discovery methods (`initialize`, `tools/list`,
 * notifications, pings) must stay unmetered or clients would burn quota
 * just connecting, and a `tools/call` for any other tool spends no credit
 * either: the listing is auth-invariant on every surface (spec D4), so a
 * listed auth-required tool like `tako_contents` answers the
 * `authRequiredToolResult` sign-in result from the dispatch gate in `mcp.ts`
 * without ever reaching Django, and an unlisted name gets the SDK's genuine
 * tool-not-found. Neither should burn a confused client's whole minute. Both stay bounded by the global ceiling, which
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
  if (typeof name !== "string" || !FREE_TIER_TOOL_NAMES.has(name)) return false;
  // A free tool can still carry an input the anonymous tier REFUSES.
  // `registerTool` answers those with `authRequiredToolResult` without
  // touching Django, so metering them would let one retrying model spend its
  // whole minute on refusals. Spec: "Rejected calls stay unmetered."
  //
  // NO TOOL DECLARES SUCH A GATE TODAY. The only one was `tako_search`'s
  // `include_contents: true` (it inlined billed rows onto the shared account),
  // and the D4 split removed the parameter — rows come from `tako_contents`,
  // which is auth-required outright. The hook stays because it is the only
  // unmetered-refusal path there is: the next priced input on a free tool
  // needs it, and rebuilding it under load is worse than keeping ten lines.
  //
  // The verdict is READ FROM THE TOOL, never re-derived here. The tool's
  // `anonymousInputRejects` is the same function the dispatch gate in
  // `mcp.ts` consults, so the two cannot disagree about what gets refused.
  // An earlier revision inlined "`include_contents` is true" instead, which
  // exempted the input for EVERY free tool: `tako_available_data` ignores
  // the key (its `z.object` strips it) and declares no gate, so an anonymous
  // caller got its four Django round-trips with no per-IP hit just by adding
  // a key the tool never reads.
  const args = (params as { arguments?: unknown }).arguments;
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  if (tool?.anonymousInputRejects !== undefined) {
    const input =
      typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)
        : {};
    if (tool.anonymousInputRejects(input) !== undefined) return false;
  }
  return true;
}

/**
 * Importing `TOOL_REGISTRY` here makes `freetier.ts` reach every tool module,
 * so this file sits one edge away from a cycle. Keep `env.ts` the only home
 * for constants the tool modules need out of a request-path module — see
 * `EMBED_PROXY_PREFIX` there. `_chart_widget.ts` used to take that prefix
 * from `embed_proxy.ts`, which imports `freeTierRateLimitKey` from here, and
 * that closed `freetier → _registry → _chart_widget → embed_proxy →
 * freetier`. The failure is not a load error: `HTTP_URL_REGEX` arrives
 * `undefined` at `_search_results.ts`, zod accepts it, and the first parse
 * throws `Cannot set properties of undefined (setting 'lastIndex')` from a
 * handler. `tsc` and every schema-only test stay green.
 */

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
 * The one exception is `FREE_TIER_COMMERCE_UPSELL` below, appended per
 * SURFACE — see its own docblock for the rule; do not restate it here.
 */
export const FREE_TIER_LIMIT_MESSAGE =
  "Rate limit reached for anonymous access. Try again in a minute.";

/**
 * Upsell sentence appended to the limit/capacity messages — ONLY when the
 * caller passes `commerceCopyAllowed: true`, which `mcp.ts` derives from
 * the surface: commerce copy is allowed on the GENERIC surface for every
 * client (spec D5); the chatgpt surface never reaches this path (it 401s
 * anonymous requests before admission), and OpenAI's app guidelines ban
 * purchase-promoting copy there anyway. The anonymous limit is the natural
 * moment to say an account exists — the same conversion point Exa's
 * keyless tier uses ("add your own API key to continue").
 *
 * "up to 2,000 free requests" is the $14 one-time welcome grant, the one
 * figure with a CI guard behind it (`pricing_claims_unit_test.py` in the
 * monorepo). It is ONE-TIME: never write "per month" or any recurring
 * framing. Bare domain, no deep link: deep links rot (the `/account/`
 * path a previous version of this copy used was already stale when it was
 * removed — see `PAYMENT_REQUIRED_REMEDY_FALLBACK` in `mcp.ts`).
 */
export const FREE_TIER_COMMERCE_UPSELL =
  "Sign in with your client's MCP authentication for up to 2,000 free requests on a new account, or connect with a Tako API key (tako.com).";

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
 * `commerceCopyAllowed` (`surface === "generic"` in `mcp.ts`) appends
 * `FREE_TIER_COMMERCE_UPSELL`; defaults false so every caller fails
 * closed.
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
