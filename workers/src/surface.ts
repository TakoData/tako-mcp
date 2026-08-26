/**
 * Path-selected MCP surfaces. The request PATH — never the client
 * User-Agent — decides which tool surface a connection gets (spec D2/D14):
 * `/mcp` is the generic surface every client shares; `/mcp/chatgpt` is the
 * OAuth-required surface submitted to OpenAI's app directory. Firecrawl's
 * /v2/mcp-search is the precedent: only the request path selects the
 * surface.
 */
export type Surface = "generic" | "chatgpt";

export const MCP_PATHS: ReadonlyMap<string, Surface> = new Map([
  ["/mcp", "generic"],
  ["/mcp/chatgpt", "chatgpt"],
]);

/**
 * Resolve a request path to its surface; null means "not an MCP endpoint".
 *
 * A trailing slash is insignificant, so `/mcp/` and `/mcp/chatgpt/` resolve
 * the same as the bare forms. This matters because the README tells people to
 * hand-paste `https://mcp.tako.com/mcp/chatgpt` into a connector dialog, and a
 * stray slash there used to 404 with nothing to diagnose. It also matches
 * `canonicalizeResource` in `oauth/resource.ts`, which already strips the
 * trailing slash before comparing a token audience — the two now agree about
 * what names this server.
 */
export function surfaceForPath(pathname: string): Surface | null {
  const exact = pathname.replace(/\/+$/, "");
  // `"/"` collapses to `""`, which is in no map entry — the root is not an
  // MCP endpoint and must not become one.
  return MCP_PATHS.get(exact) ?? null;
}
