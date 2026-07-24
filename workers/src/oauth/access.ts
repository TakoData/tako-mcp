/**
 * Access-token verification for incoming `/mcp` requests. Called by
 * `mcp.ts` before the JSON-RPC handler runs; if the bearer is a valid
 * OAuth access token issued by `/token`, returns the decrypted Tako API
 * token to forward downstream as `X-API-Key`. If it's anything else
 * (raw Tako API token, malformed, expired) returns `null` and the
 * caller falls through to the existing static-Bearer path.
 *
 * Keeping this in its own file (rather than inside `handlers.ts`) makes
 * the `mcp.ts` import surface narrow and ensures the OAuth handlers can
 * evolve their internals (e.g., adding a KV-backed revocation cache
 * later) without touching the MCP request hot path.
 */

import type { Env } from "../env.js";
import { decryptAesGcm, isExpired, verifyJwt } from "./jwt.js";
import { isServerResource } from "./resource.js";
import type { AccessTokenClaims } from "./types.js";

/** The required scope every access token must carry to reach `/mcp`. */
const REQUIRED_SCOPE = "mcp";

/**
 * Result of resolving an incoming `/mcp` bearer:
 * - `ok`: a valid Worker-issued OAuth access token → forward `takoToken`.
 * - `reject`: the token IS a Worker-issued JWT but fails a binding check
 *   (wrong type / issuer / audience / scope / undecryptable). The caller
 *   MUST return a 401 — falling through to the raw-token path would send a
 *   JWT to Django as an API key and mask the real reason with a Django 401.
 * - `not_oauth`: not one of our access JWTs at all (raw Tako API token, a
 *   non-JWT bearer, a bad signature, or an expired token) → the caller falls
 *   through to the legacy raw-Tako-token path, unchanged.
 */
export type OAuthAccessResult =
  | { kind: "ok"; takoToken: string }
  | { kind: "reject"; error: string; errorDescription: string }
  | { kind: "not_oauth" };

/**
 * A `reject` that also logs one greppable line to Workers Logs. `iss`/`aud`
 * are non-secret, so a rollout regression is diagnosable in `wrangler tail`.
 */
function reject(error: string, errorDescription: string): OAuthAccessResult {
  console.error(`[oauth] /mcp reject error=${error}: ${errorDescription}`);
  return { kind: "reject", error, errorDescription };
}

/**
 * Verify an incoming bearer as a Worker-issued OAuth access JWT and bind it to
 * this resource server. `origin` is this server's bare origin; `iss` is checked
 * against it and `aud` against the accepted resource set (origin and
 * `${origin}/mcp` — see `isServerResource`).
 *
 * `iss`/`aud` are validated only when PRESENT — tokens minted before audience
 * binding shipped carry neither, and we accept their absence during the
 * rolling cutover (access tokens live 15 min, so this window is short) while
 * rejecting a token that names a DIFFERENT issuer/resource. A present but
 * non-string `iss`/`aud` (e.g. an array) is rejected outright so a future
 * minter can't silently bypass the check. An expired-but-signed access token
 * is a `reject` (not a fall-through) so the host sees a 401 + challenge and
 * runs the refresh exchange.
 */
export async function tryResolveOAuthAccessToken(
  bearer: string,
  env: Env,
  origin: string,
): Promise<OAuthAccessResult> {
  const sign = env.OAUTH_SIGN_KEY;
  const enc = env.OAUTH_ENC_KEY;
  if (
    typeof sign !== "string" ||
    sign.length === 0 ||
    typeof enc !== "string" ||
    enc.length === 0
  ) {
    // OAuth not configured on this env — every bearer falls through to
    // raw Tako-token mode. Same semantics as the legacy Claude Code path.
    return { kind: "not_oauth" };
  }
  // Cheap shape check — three base64url segments separated by dots.
  // Avoids the HMAC import for non-JWT bearers (the common case for
  // Claude Code raw-token use) and is tighter than `split(".").length`
  // alone — a Tako token that happens to contain two dots would no
  // longer falsely look like a JWT.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) {
    return { kind: "not_oauth" };
  }

  // Verify the signature but keep expired tokens so we can distinguish them
  // from a bad signature: a bad signature is indistinguishable from a raw
  // token and falls through; an expired-but-signed token is ours and rejects.
  const claims = await verifyJwt<AccessTokenClaims>(bearer, sign, {
    ignoreExpiry: true,
  });
  if (!claims) return { kind: "not_oauth" };

  // From here the signature is OURS, so any binding failure is a definite
  // 401 rather than a fall-through.
  if (claims.type !== "access") {
    return reject("invalid_token", "presented token is not an access token");
  }
  if (isExpired(claims)) {
    return reject("invalid_token", "access token is expired");
  }
  // `iss`/`aud`: reject a present-but-non-string value (array etc.) so the
  // check can't be bypassed; validate a string value; tolerate absence.
  if (claims.iss !== undefined) {
    if (typeof claims.iss !== "string" || claims.iss !== origin) {
      return reject(
        "invalid_token",
        `token issuer ${String(claims.iss)} does not match ${origin}`,
      );
    }
  }
  if (claims.aud !== undefined) {
    if (typeof claims.aud !== "string" || !isServerResource(claims.aud, origin)) {
      return reject(
        "invalid_token",
        `token audience ${String(claims.aud)} is not this resource server`,
      );
    }
  }
  const scopes =
    typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter((s) => s.length > 0)
      : [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    return reject(
      "insufficient_scope",
      `token is missing the required '${REQUIRED_SCOPE}' scope`,
    );
  }
  if (typeof claims.enc_tako_token !== "string") {
    return reject("invalid_token", "token is missing credentials");
  }

  const decrypted = await decryptAesGcm(claims.enc_tako_token, enc);
  if (decrypted === null) {
    // Signature verified (so the token came from us) but decryption
    // failed — strongly implies the encryption key was rotated without
    // also rotating the signing key, leaving in-flight access tokens
    // un-decryptable. Reject so the request fails closed with a clean 401.
    return reject(
      "invalid_token",
      "token credentials could not be decrypted (likely encryption-key rotation)",
    );
  }
  return { kind: "ok", takoToken: decrypted };
}
