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
import { decryptAesGcm, verifyJwt } from "./jwt.js";
import type { AccessTokenClaims } from "./types.js";

/**
 * Verify an incoming bearer token as a Worker-issued OAuth access JWT.
 * Returns the decrypted Tako API token on success, `null` otherwise
 * (any failure path: missing config, wrong shape, bad signature,
 * expired, decryption failure).
 *
 * The fall-through behavior is deliberate: a raw Tako API token (the
 * existing Claude Code path) is not a JWT and will fail the shape
 * check immediately, so this function never accidentally consumes
 * a non-OAuth bearer.
 */
export async function tryResolveOAuthAccessToken(
  bearer: string,
  env: Env,
): Promise<string | null> {
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
    return null;
  }
  // Cheap shape check — three base64url segments separated by dots.
  // Avoids the HMAC import for non-JWT bearers (the common case for
  // Claude Code raw-token use) and is tighter than `split(".").length`
  // alone — a Tako token that happens to contain two dots would no
  // longer falsely look like a JWT.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) {
    return null;
  }

  const claims = await verifyJwt<AccessTokenClaims>(bearer, sign);
  if (!claims || claims.type !== "access") return null;
  if (typeof claims.enc_tako_token !== "string") return null;

  const decrypted = await decryptAesGcm(claims.enc_tako_token, enc);
  if (decrypted === null) {
    // Signature verified (so the token came from us) but decryption
    // failed — strongly implies the encryption key was rotated without
    // also rotating the signing key, leaving in-flight access tokens
    // un-decryptable. Log so this is visible during a key-rotation
    // incident; return null so the request fails closed.
    console.error(
      "OAuth access token signature valid but Tako-token decryption failed " +
        "(likely encryption-key rotation without coordinated signing-key rotation)",
    );
    return null;
  }
  return decrypted;
}
