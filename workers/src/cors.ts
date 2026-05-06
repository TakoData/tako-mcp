/**
 * CORS for the OAuth discovery + DCR + token surface.
 *
 * Browser-based MCP clients (notably the OpenAI Apps SDK submission
 * wizard at platform.openai.com) auto-detect OAuth via fetch() from
 * a different origin. Without ACAO the browser blocks the response
 * body and the wizard reports "couldn't detect OAuth metadata."
 *
 * Wildcard origin is correct here: every endpoint we expose CORS on
 * is either a public discovery doc or a stateless OAuth endpoint that
 * never reads or sets cookies. The cookie-bearing surface (/authorize,
 * /login, /oauth/stytch_callback) is reached by top-level browser
 * navigation, not CORS fetches, so it deliberately stays uncovered.
 */

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "access-control-max-age": "86400",
};

/** Paths that browser-based MCP clients hit cross-origin and therefore
 *  need CORS headers on both the response and the OPTIONS preflight. */
export const CORS_PATHS = new Set<string>([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/token",
  "/revoke",
]);

/** Returns a new Response with CORS headers merged in. The original
 *  response's body, status, and existing headers are preserved. */
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  // Wildcard ACAO + Vary: Origin keeps shared caches honest if any get
  // inserted between us and the browser later.
  headers.append("vary", "Origin");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** 204 preflight response with the CORS headers attached. */
export function corsPreflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}
