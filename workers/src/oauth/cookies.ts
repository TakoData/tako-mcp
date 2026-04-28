/**
 * Cookie utilities for the Worker-issued state and session cookies.
 *
 * The Worker uses two cookies during the OAuth dance, both signed JWTs:
 * - `tako_oauth_state` — short-lived (10min), written when /authorize
 *   redirects to /login; carries OAuth params across the Stytch round-trip.
 * - `tako_oauth_session` — medium-lived (30min), written by
 *   /oauth/stytch_callback after the Stytch + Tako lookup succeeds; carries
 *   `{user_id, user_email, encrypted_tako_token}` so /authorize and POST
 *   /authorize can complete without re-doing the upstream lookups.
 *
 * Both cookies are HttpOnly + Secure + SameSite=Lax. Lax (not Strict)
 * because the OAuth dance involves redirects from third-party origins
 * (claude.ai, chatgpt.com); Strict would suppress the cookie on those
 * cross-origin entry points and break the flow. Lax is the right level
 * since cookies are still scoped to the Worker's origin and the JWTs
 * are signed.
 */

export const STATE_COOKIE = "tako_oauth_state";
export const SESSION_COOKIE = "tako_oauth_session";

/** Conservative TTLs. Tunable when we have user data. */
export const STATE_COOKIE_MAX_AGE_S = 10 * 60;
export const SESSION_COOKIE_MAX_AGE_S = 30 * 60;

interface CookieOptions {
  maxAgeSeconds: number;
  /**
   * Override SameSite. The default `Lax` is correct for top-level
   * navigation flows (redirects between OAuth participants). Pass
   * `None` only when a cookie absolutely must travel on a third-party
   * iframe / cross-site fetch — neither of our cookies needs that.
   */
  sameSite?: "Lax" | "Strict" | "None";
}

/**
 * Build a `Set-Cookie` header value. Always HttpOnly + Secure;
 * `path=/` so /authorize, /oauth/stytch_callback, and POST /authorize
 * all see the same cookies.
 */
export function buildSetCookie(
  name: string,
  value: string,
  opts: CookieOptions,
): string {
  const sameSite = opts.sameSite ?? "Lax";
  // Cookie `Max-Age` and `Path` are widely supported and unambiguous.
  // We avoid setting an explicit `Domain` so the cookie defaults to
  // the Worker's host (e.g. `mcp.tako.com`) — never accidentally
  // shared with sibling domains.
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    `SameSite=${sameSite}`,
  ].join("; ");
}

/**
 * Build a `Set-Cookie` header that immediately invalidates the named
 * cookie. Used to clean up `tako_oauth_state` after consumption and
 * `tako_oauth_session` on explicit logout.
 */
export function buildClearCookie(name: string): string {
  return [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Parse the value of a single named cookie out of an incoming `Cookie`
 * header. Returns `null` if absent. Does not handle multiple cookies
 * with the same name (which shouldn't happen for our cookies — they
 * are always set on the same Path) and does no value decoding beyond
 * splitting on `=` once: our cookie values are JWTs, which contain only
 * URL-safe characters by construction.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq);
    if (k !== name) continue;
    return trimmed.slice(eq + 1);
  }
  return null;
}
