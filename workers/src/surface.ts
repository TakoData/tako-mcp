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

/** Exact-match resolution; null means "not an MCP endpoint". */
export function surfaceForPath(pathname: string): Surface | null {
  return MCP_PATHS.get(pathname) ?? null;
}
