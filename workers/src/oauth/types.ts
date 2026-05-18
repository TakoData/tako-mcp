/**
 * Shared types for the OAuth implementation. Centralized so the JWT claim
 * shapes have one source of truth — every handler that mints or verifies a
 * given token type imports the same interface, preventing the
 * "auth code claims drifted between mint and verify" class of bug.
 */

import type { JwtClaims } from "./jwt.js";

/* --------------------------- Tokens --------------------------- */

/**
 * Stable string discriminator on every JWT we mint. Used in `verifyJwt`
 * callsites so a stolen access token can't be reused as a refresh token
 * (or vice versa) — even though both are signed by the same key.
 */
export type OAuthTokenType =
  | "auth_code"
  | "access"
  | "refresh"
  | "session" // worker-issued session cookie after Stytch login
  | "state" // worker-issued cookie carrying OAuth params across the Stytch round-trip
  | "client_id"; // signed JWT used as the DCR client_id (no PII, just registration metadata)

interface BaseClaims extends JwtClaims {
  type: OAuthTokenType;
}

/* --------------------------- DCR --------------------------- */

export interface ClientIdClaims extends BaseClaims {
  type: "client_id";
  client_name: string;
  redirect_uris: string[];
  iat: number;
}

/* --------------------------- Authorization --------------------------- */

/**
 * The auth code minted on POST /authorize. Carries the user identity and
 * encrypted Tako token forward to /token without persisting anything.
 */
export interface AuthCodeClaims extends BaseClaims {
  type: "auth_code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  user_id: string;
  user_email: string;
  /** AES-GCM-encrypted Tako API token. See `encryptAesGcm` in `jwt.ts`. */
  enc_tako_token: string;
  /** Unique JWT ID for single-use enforcement (OAuth 2.1 §4.1.2). The
   *  redemption handler records this in Workers Cache after a successful
   *  exchange and rejects subsequent presentations with the same `jti`. */
  jti: string;
  /** RFC 8707 §2 — the resource the authorization code is bound to.
   *  Optional because the parameter is OPTIONAL per the RFC and legacy
   *  clients (Claude.ai today) do not send it. When present, /token
   *  MUST receive a matching `resource` and the issued access /
   *  refresh tokens carry it as the `aud` claim. */
  resource?: string;
}

/* --------------------------- Tokens issued to clients --------------------------- */

/**
 * Note on plaintext claims: `user_id` and `user_email` are visible to
 * anyone who decodes the JWT (clients store these tokens). The Tako API
 * token is the only secret value; it lives encrypted in
 * `enc_tako_token`. This is industry-standard for JWT access tokens
 * (clients are expected to read certain claims), but if the user's
 * email becomes a stricter PII boundary, replace `user_email` with an
 * opaque ID and look up the email server-side at consent-render time.
 */
export interface AccessTokenClaims extends BaseClaims {
  type: "access";
  scope: string;
  user_id: string;
  user_email: string;
  enc_tako_token: string;
  /** RFC 8707 §3 — the resource the token is intended for, propagated
   *  from the authorization code's `resource` claim. Resource servers
   *  SHOULD validate this matches their own canonical URL before
   *  accepting the token. Optional for backward compat with tokens
   *  minted before resource indicators landed. */
  aud?: string;
}

export interface RefreshTokenClaims extends BaseClaims {
  type: "refresh";
  scope: string;
  user_id: string;
  user_email: string;
  enc_tako_token: string;
  /** Unique JWT ID for single-use enforcement (OAuth 2.1 §4.3.1
   *  refresh-token rotation). Recorded in Workers Cache on successful
   *  exchange so re-presenting the same refresh token is rejected.
   *
   *  Optional during the rolling cutover: legacy refresh tokens minted
   *  before TAKO-2701 shipped have no `jti` claim, and `verifyJwt`'s
   *  runtime cast does not enforce shape. New tokens always carry `jti`.
   *  Tighten back to required `string` once the 14-day legacy window has
   *  passed and the bypass in `checkAndMarkRedeemed` is removed. */
  jti?: string;
  /** RFC 8707 §3 — same semantics as on `AccessTokenClaims`. Carried on
   *  the refresh token so subsequent refresh_token grants can re-issue
   *  access tokens with the same `aud` without re-running /authorize. */
  aud?: string;
}

/* --------------------------- Worker-only cookies --------------------------- */

/**
 * `tako_oauth_state` cookie. Set on /authorize when the user has no
 * worker session yet, carries the original OAuth query params across the
 * Stytch round-trip so /oauth/stytch_callback can resume the flow.
 */
export interface StateCookieClaims extends BaseClaims {
  type: "state";
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  /** RFC 8707 resource indicator carried across the Stytch login round-
   *  trip so /oauth/stytch_callback can rebuild the original /authorize
   *  request faithfully. Optional for backward compat with state cookies
   *  minted before resource indicators landed. */
  resource?: string;
}

/**
 * `tako_oauth_session` cookie. Set on /oauth/stytch_callback after we
 * exchange Stytch's redirect token for a session JWT and identify the
 * user. Carries the (encrypted) Stytch session JWT itself — NOT a
 * cached Tako API token. The Tako token is re-fetched on every
 * `POST /authorize` so token rotations on trytako.com are always
 * reflected in newly-issued OAuth grants.
 *
 * Why we cache the Stytch JWT instead of the Tako token: if a user
 * rotates their Tako API token at trytako.com, every previously-issued
 * OAuth grant becomes invalid (the embedded token no longer authenticates
 * to Django — that's the documented kill switch). But on reconnect, the
 * user expects the NEW connector to work. If we cached the Tako token
 * here, the reconnect flow would reuse the stale cached token. By
 * keeping the Stytch JWT and re-fetching the Tako token at consent
 * time, we always issue grants with the user's current Tako token.
 *
 * Freshness is bounded by the Stytch session: if the user signs out of
 * trytako.com (revoking the Stytch session), subsequent
 * `POST /authorize` attempts will be rejected at the Tako call and
 * force a fresh `/login` round-trip. This is a feature.
 *
 * The Stytch JWT is encrypted (not just signed) because, unlike a Tako
 * API token, a Stytch session JWT can be replayed against any
 * Stytch-protected resource for its lifetime; encryption ensures a
 * SIGN_KEY-only leak doesn't expose it.
 */
export interface SessionCookieClaims extends BaseClaims {
  type: "session";
  user_id: string;
  user_email: string;
  enc_stytch_session_jwt: string;
}

/* --------------------------- Stytch --------------------------- */

/**
 * Subset of Stytch's authenticate-response we actually consume. Stytch's
 * full schema is large; we only need user identity + the session JWT
 * that we'll later present to Django to mint a Tako API token.
 */
export interface StytchAuthenticateResult {
  session_jwt: string;
  user: {
    user_id: string;
    emails: Array<{ email: string }>;
  };
}
