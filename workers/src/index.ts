import type { Env } from "./env.js";
import { handleExportRequest } from "./exports.js";
import { handleIconRequest } from "./icons.js";
import { handleMcpRequest } from "./mcp.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleProtectedResourceMetadata,
  handleRegister,
  handleStytchCallback,
  handleToken,
} from "./oauth/handlers.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      return handleMcpRequest(request, env);
    }

    // Brand-icon proxy. Connector cards in Claude / ChatGPT fetch these
    // URLs directly (advertised via `serverInfo.icons` on `initialize`).
    // Serving through the worker keeps the public URL stable across
    // Tako frontend redeploys — see `icons.ts` header for why proxying
    // is preferable to pointing connectors at Tako's hashed CDN paths.
    if (request.method === "GET" && url.pathname.startsWith("/icons/")) {
      return handleIconRequest(url.pathname);
    }

    // Signed-token download URLs minted by `export_report`. The token
    // carries the user's API key encrypted with `EXPORT_TOKEN_KEY`, so
    // no separate auth header is required (and indeed no chat client
    // would attach one — the URL is clicked from a browser). See
    // `exports.ts` for token format and security tradeoffs.
    if (request.method === "GET" && url.pathname.startsWith("/exports/")) {
      return handleExportRequest(request, env);
    }
    // GET /mcp (SSE resubscription), DELETE /mcp (session terminate), and
    // OPTIONS /mcp (browser CORS preflight) are intentionally unrouted:
    // stateless JSON-response mode does not use GET/DELETE, and current
    // MCP clients (Claude Desktop, CLI) do not issue preflights. Revisit
    // when Phase 2 introduces streaming tools or browser-based clients —
    // see the `transport.close()` TODO in `mcp.ts`.

    // OAuth 2.1 + DCR + PKCE (TAKO-2679). The two `.well-known/...`
    // discovery docs let MCP hosts (Claude.ai, ChatGPT) bootstrap the
    // OAuth flow from just the resource URL. `/register`, `/authorize`,
    // `/token` implement the protocol per the MCP spec; `/login` and
    // `/oauth/stytch_callback` are the user-facing parts of the dance
    // that map a Stytch login to a Tako API token under the hood.
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return handleProtectedResourceMetadata(request, env);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      return handleAuthServerMetadata(request, env);
    }
    if (url.pathname === "/register") {
      return handleRegister(request, env);
    }
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/token") {
      return handleToken(request, env);
    }
    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/oauth/stytch_callback") {
      return handleStytchCallback(request, env);
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
