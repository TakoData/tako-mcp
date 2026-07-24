/**
 * RFC 8707 Resource Indicators helpers.
 *
 * This MCP server's canonical resource is its endpoint URL — `${origin}/mcp`
 * (e.g. `https://mcp.tako.com/mcp`) — the value advertised as `resource` in the
 * protected-resource metadata. Tokens issued by `/token` are audienced to that
 * value (their `aud` claim), while `iss` is the authorization-server issuer
 * (the bare origin, matching the RFC 8414 metadata). `/mcp` validates both.
 */

/** The authorization-server issuer identifier: the bare origin. */
export function serverIssuer(req: Request): string {
  return new URL(req.url).origin;
}

/** The canonical resource identifier for THIS server: the `/mcp` endpoint. */
export function serverResource(req: Request): string {
  return `${new URL(req.url).origin}/mcp`;
}

/**
 * Canonicalize a client-supplied `resource` value for comparison against
 * {@link serverResource}. Returns `null` for anything that isn't a valid
 * http(s) URL.
 *
 * Canonical form = origin + path with the query and fragment removed and any
 * trailing slash stripped. This keeps the `/mcp` path significant (a token for
 * `${origin}/mcp` is not valid for a different path on the same origin) while
 * tolerating the `?tools=...` query the real endpoint carries and a trailing
 * slash. `URL` also lowercases the host and drops default ports.
 */
export function canonicalizeResource(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}
