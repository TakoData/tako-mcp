/**
 * Bridge between Stytch authentication and Tako API tokens.
 *
 * After a successful Stytch redirect-callback the Worker has a Stytch
 * session JWT identifying the user. Tako's existing `StytchAuthBackend`
 * accepts that same JWT — but only when it arrives in the
 * `stytch_session_jwt` cookie (`request.COOKIES.get(...)` in Django's
 * middleware). The Worker is calling server-to-server, so we send the
 * cookie ourselves via the `Cookie` request header. Django can't tell
 * the difference between a cookie set by a real browser and one set in
 * a server-side request — JWT signature is what authenticates.
 *
 * The endpoint we hit is `GET /api/v1/api_token/` (read-only — never
 * `POST /api/v1/generate_api_token/`, which rotates and would break
 * existing Claude Code users every time they OAuth-connect a new host).
 */

import type { Env } from "../env.js";

const TAKO_API_TOKEN_PATH = "/api/v1/api_token/";
const DEFAULT_TIMEOUT_MS = 15_000;

export type IdentityErrorKind =
  /** Tako returned 401/403 — Stytch JWT was rejected. */
  | "unauthorized"
  /** User has no API token yet (Tako returned 404 or empty). User must
   *  mint one at trytako.com → settings before OAuth-connecting. */
  | "no_token"
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
 * Strict JWT-shape regex: three base64url segments separated by dots.
 * Used to gate the value before we interpolate it into a `Cookie`
 * header — a stytch JWT containing `\r` or `\n` (theoretically
 * impossible from Stytch, but worth the cheap defense) would otherwise
 * inject headers into the upstream Tako request.
 */
const STYTCH_JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Fetch the user's Tako API token by calling `GET /api/v1/api_token/`
 * with the Stytch session JWT in a `Cookie` header. Returns the raw
 * token string. Throws `IdentityError` with a kind discriminator on
 * any failure — callers are expected to map kinds to user-visible
 * error pages (e.g. `no_token` → "go mint a token first").
 */
export async function fetchTakoApiToken(
  env: Env,
  stytchSessionJwt: string,
): Promise<string> {
  const base = env.DJANGO_BASE_URL;
  if (typeof base !== "string" || base.length === 0 || base.endsWith("/")) {
    throw new IdentityError(
      "transport",
      "DJANGO_BASE_URL is missing or has a trailing slash",
    );
  }
  if (!STYTCH_JWT_SHAPE.test(stytchSessionJwt)) {
    // Stytch should never return a non-JWT-shaped session token; if it
    // does, treat it as a transport-level breakage rather than blindly
    // forwarding to Django where it could splice the Cookie header.
    throw new IdentityError(
      "transport",
      "stytch session JWT is malformed (failed shape check)",
    );
  }
  const url = `${base}${TAKO_API_TOKEN_PATH}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        // `cookie` is a forbidden request header in browser fetches, but
        // Workers' fetch implementation allows setting it because the
        // Worker is acting as a server proxy. Django reads it via
        // `request.COOKIES.get("stytch_session_jwt")`.
        cookie: `stytch_session_jwt=${stytchSessionJwt}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      throw new IdentityError(
        "transport",
        `Tako ${TAKO_API_TOKEN_PATH} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw new IdentityError(
      "transport",
      `Tako ${TAKO_API_TOKEN_PATH} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 401/403 = Stytch session rejected by Django. Should be rare since we
  // just minted the JWT, but possible if Stytch and Django have skewed
  // clocks or the project ID/secret pair is mismatched between the
  // Worker's Stytch credentials and Django's.
  if (response.status === 401 || response.status === 403) {
    throw new IdentityError(
      "unauthorized",
      `Tako rejected the Stytch session JWT (status ${response.status})`,
      response.status,
    );
  }

  // 404 = user has no Token row yet. The user-facing fix is to visit
  // trytako.com → API tokens to mint one. We never call the generate
  // endpoint from here because it rotates, which would invalidate any
  // existing Claude Code wiring.
  if (response.status === 404) {
    throw new IdentityError(
      "no_token",
      "user has no Tako API token; must mint one at trytako.com first",
      404,
    );
  }

  if (!response.ok) {
    throw new IdentityError(
      "transport",
      `Tako ${TAKO_API_TOKEN_PATH} returned ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new IdentityError(
      "parse",
      `Tako ${TAKO_API_TOKEN_PATH} returned 2xx with non-JSON body`,
      response.status,
    );
  }

  if (typeof body !== "object" || body === null) {
    throw new IdentityError(
      "parse",
      `Tako ${TAKO_API_TOKEN_PATH} response was not an object`,
      response.status,
    );
  }
  const token = (body as Record<string, unknown>)["token"];
  if (typeof token !== "string" || token.length === 0) {
    // 200 with empty/missing token field — treat as "user has no token"
    // rather than a parse error. Some Django implementations return 200
    // with `{"token": null}` for this case.
    throw new IdentityError(
      "no_token",
      "user has no Tako API token (server returned empty/missing token field)",
      response.status,
    );
  }
  return token;
}
