/**
 * Anonymous free tier for `/mcp`.
 *
 * When a request arrives with NO `Authorization` header and both free-tier
 * bindings are configured, the Worker serves it as a rate-limited anonymous
 * request instead of a 401: a shared free-tier Tako API key is forwarded to
 * Django, the visible toolset shrinks to `FREE_TIER_TOOL_NAMES`, and
 * `tools/call` requests are metered per client IP through Cloudflare's
 * rate-limit binding. JSON-RPC batch arrays are rejected outright (see
 * `checkFreeTierRateLimit`) rather than metered — a batch would let one
 * limiter hit cover an arbitrary number of Django-spending calls. Design
 * doc:
 * `docs/superpowers/specs/2026-07-26-anonymous-free-tier-design.md`.
 *
 * Fail modes, deliberately asymmetric:
 * - Configuration missing → fail CLOSED (`resolveFreeTierConfig` returns
 *   null, callers keep today's 401). An env that never opted in must not
 *   silently serve anonymous traffic.
 * - Limiter runtime failure → fail OPEN for that request. A Cloudflare
 *   limiter hiccup must not take the tier down; the free-tier account's own
 *   Django-side limits backstop total spend.
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

/** Resolved free-tier bindings — proof the env opted in. */
export interface FreeTierConfig {
  /** Forwarded to Django as `X-API-Key` for anonymous requests. */
  apiKey: string;
  /** Per-IP request limiter (see `checkFreeTierRateLimit`). */
  limiter: RateLimit;
}

/**
 * Gate the free tier on configuration: BOTH the shared API key and the
 * rate-limit binding must be present, else `null` (fail-closed — callers
 * return the same 401 the Worker served before the free tier existed).
 * The limiter is shape-checked (not just truthy) so a misconfigured
 * binding fails here, at the gate, instead of throwing mid-request.
 */
export function resolveFreeTierConfig(env: Env): FreeTierConfig | null {
  const apiKey = env.FREE_TIER_API_KEY;
  const limiter = env.FREE_TIER_RATE_LIMITER;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (typeof limiter?.limit !== "function") return null;
  return { apiKey, limiter };
}

/**
 * Should this JSON-RPC body count against the free-tier limit?
 *
 * Only `tools/call` is metered — it is the only method that spends the
 * shared account's Tako credits. Handshake and discovery methods
 * (`initialize`, `tools/list`, notifications, pings) must stay unmetered
 * or clients would burn quota (or get 429s) just connecting. Array bodies
 * never reach here — `checkFreeTierRateLimit` rejects batches before the
 * metering decision — so no recursion into batch elements is needed.
 * Anything unparseable / non-object is unmetered: it can never reach
 * Django, and the SDK will reject it with a proper JSON-RPC error on its
 * own.
 */
export function isMeteredJsonRpcBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "tools/call"
  );
}

/**
 * Meter an anonymous request. Peeks at a CLONE of the request body (the
 * transport still needs the original stream), skips the limiter entirely
 * for unmetered methods, and keys the bucket on `CF-Connecting-IP` —
 * Cloudflare sets it on every proxied request; the `"unknown"` shared
 * bucket only occurs in local `wrangler dev`.
 *
 * A JSON-RPC batch (array body) is rejected outright as `"batch"`,
 * checked before the metering decision — the MCP SDK dispatches every
 * element of a batch individually, so a single limiter hit would cover an
 * arbitrary number of Django-spending calls. JSON-RPC batching was
 * removed from the MCP spec in 2025-06-18, so no legitimate modern client
 * sends one; this only runs on the anonymous path, so authenticated
 * requests are unaffected.
 *
 * Limiter failure fails OPEN (see module header for why).
 */
export async function checkFreeTierRateLimit(
  request: Request,
  limiter: RateLimit,
): Promise<"allowed" | "limited" | "batch"> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return "allowed";
  }
  if (Array.isArray(body)) return "batch";
  if (!isMeteredJsonRpcBody(body)) return "allowed";

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const { success } = await limiter.limit({ key });
    console.log(`[free-tier] ip=${key} ${success ? "allowed" : "limited"}`);
    return success ? "allowed" : "limited";
  } catch (err) {
    console.error(
      `[free-tier] ip=${key} rate limiter error (failing open): ${String(err)}`,
    );
    return "allowed";
  }
}

/**
 * The 429 body's `message`. States the limit number — keep in sync with
 * the `simple.limit` value on the `FREE_TIER_RATE_LIMITER` binding in
 * `wrangler.jsonc`. The URL is the upsell: a free API key lifts the
 * anonymous per-IP limit and unlocks the full toolset.
 */
export const FREE_TIER_LIMIT_MESSAGE =
  "Free tier limit reached (10 requests/min). Get a free API key at " +
  "https://trytako.com/account/ for higher limits.";

/**
 * HTTP 429 for an over-limit anonymous request. JSON-RPC envelope with
 * `id: null` (the limiter runs before the SDK parses the request id),
 * `code: -32000` (implementation-defined server-error range; distinct
 * from `-32001`, which auth failures use), and a `Retry-After` matching
 * the limiter window.
 */
export function freeTierLimitResponse(): Response {
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
