/**
 * Bridge between Stytch authentication and Tako API keys.
 *
 * After a successful Stytch redirect-callback the Worker has a Stytch session
 * JWT identifying the user. At OAuth consent we MINT a per-host, show-once Tako
 * API key for that user and embed it (encrypted) in the issued access token.
 *
 * We mint (POST /api/v1/internal/mcp/api_key/) rather than read, because Tako
 * API keys are hashed and shown exactly once (TAKO-3212) — there is no endpoint
 * that returns an existing raw key. Minting is additive and the backend
 * LRU-trims a user's MCP keys, so a fresh key per host never rotates another
 * host's still-valid key. Django authenticates the call from the
 * `stytch_session_jwt` cookie we set ourselves (server-to-server).
 */

import type { Env } from "../env.js";

const TAKO_MCP_KEY_MINT_PATH = "/api/v1/internal/mcp/api_key/";
const DEFAULT_TIMEOUT_MS = 15_000;

export type IdentityErrorKind =
  /** Tako returned 401/403 — Stytch JWT was rejected. */
  | "unauthorized"
  /** Tako returned 400 — the user is at the API-key cap and must prune keys. */
  | "at_cap"
  /** Network / timeout / unexpected non-2xx. Caller should 500. */
  | "transport"
  /** 2xx but body shape was unexpected. */
  | "parse";

export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;
  readonly status: number | undefined;

  constructor(kind: IdentityErrorKind, message: string, status?: number) {
    super(message);
    this.name = "IdentityError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Strict JWT-shape regex: three base64url segments separated by dots. Gates the
 * value before we interpolate it into a `Cookie` header so a JWT containing
 * `\r`/`\n` cannot inject headers into the upstream Tako request.
 */
const STYTCH_JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Mint the user's Tako API key by calling POST /api/v1/internal/mcp/api_key/
 * with the Stytch session JWT in a `Cookie` header. `clientName` (from the DCR
 * registration) names the key on the developer page. Returns the raw key.
 * Throws `IdentityError` with a kind discriminator on any failure.
 *
 * `clientName` may be `null` or empty string — the backend normalizes a
 * blank/missing name to "MCP: OAuth client", so passing `null`/`""` is an
 * intentional, supported pass-through when the DCR client did not supply a name.
 */
export async function mintTakoApiKey(
  env: Env,
  stytchSessionJwt: string,
  clientName: string | null,
): Promise<string> {
  const base = env.DJANGO_BASE_URL;
  if (typeof base !== "string" || base.length === 0 || base.endsWith("/")) {
    throw new IdentityError("transport", "DJANGO_BASE_URL is missing or has a trailing slash");
  }
  if (!STYTCH_JWT_SHAPE.test(stytchSessionJwt)) {
    throw new IdentityError("transport", "stytch session JWT is malformed (failed shape check)");
  }
  const url = `${base}${TAKO_MCP_KEY_MINT_PATH}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        // `cookie` is a forbidden browser header, but Workers' fetch allows it
        // because the Worker is a server proxy. Django reads it via
        // request.COOKIES.get("stytch_session_jwt").
        cookie: `stytch_session_jwt=${stytchSessionJwt}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ client_name: clientName }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new IdentityError("transport", `Tako ${TAKO_MCP_KEY_MINT_PATH} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new IdentityError(
      "transport",
      `Tako ${TAKO_MCP_KEY_MINT_PATH} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new IdentityError("unauthorized", `Tako rejected the Stytch session JWT (status ${response.status})`, response.status);
  }

  // 400 = the user is at the API-key cap. The fix is to revoke a key on the
  // developer page, not to retry.
  if (response.status === 400) {
    throw new IdentityError("at_cap", "user is at the Tako API-key cap; must revoke a key first", 400);
  }

  if (!response.ok) {
    throw new IdentityError("transport", `Tako ${TAKO_MCP_KEY_MINT_PATH} returned ${response.status}`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new IdentityError("parse", `Tako ${TAKO_MCP_KEY_MINT_PATH} returned 2xx with non-JSON body`, response.status);
  }
  if (typeof body !== "object" || body === null) {
    throw new IdentityError("parse", `Tako ${TAKO_MCP_KEY_MINT_PATH} response was not an object`, response.status);
  }
  const key = (body as Record<string, unknown>)["key"];
  if (typeof key !== "string" || key.length === 0) {
    throw new IdentityError("parse", `Tako ${TAKO_MCP_KEY_MINT_PATH} returned an empty/missing key field`, response.status);
  }
  return key;
}
