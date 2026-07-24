/**
 * RFC 8707 Resource Indicators helpers.
 *
 * This MCP server is a single protected resource. Per the MCP authorization
 * spec's Canonical Server URI guidance, a client may legitimately name it as
 * either the bare origin (`https://mcp.tako.com`) or the endpoint URL
 * (`https://mcp.tako.com/mcp`); both identify this server, so both are
 * accepted. The metadata advertises the endpoint form as the preferred
 * (`serverResource`), while `iss` on issued tokens is the bare-origin
 * authorization-server issuer (`serverIssuer`). `/mcp` accepts a token whose
 * `aud` is either accepted form and rejects any other.
 */

/** The authorization-server issuer identifier: the bare origin. */
export function serverIssuer(req: Request): string {
  return new URL(req.url).origin;
}

/** The preferred canonical resource identifier: the `/mcp` endpoint. */
export function serverResource(req: Request): string {
  return `${new URL(req.url).origin}/mcp`;
}

/**
 * The set of resource identifiers that name THIS server for a given origin:
 * the bare origin and the `/mcp` endpoint. Kept as a helper so `/authorize`,
 * `/token`, and `/mcp` all decide "is this our resource?" identically.
 */
export function isServerResource(canonical: string, origin: string): boolean {
  return canonical === origin || canonical === `${origin}/mcp`;
}

/**
 * Canonicalize a client-supplied `resource` value for comparison. Returns
 * `null` for anything that isn't a valid http(s) URL.
 *
 * Canonical form = origin + path with the query and fragment removed and any
 * trailing slash stripped, so `${origin}/mcp`, `${origin}/mcp/`, and
 * `${origin}/mcp?tools=agent` all collapse to `${origin}/mcp`, while the bare
 * origin stays the bare origin. `URL` also lowercases the host and drops
 * default ports.
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
