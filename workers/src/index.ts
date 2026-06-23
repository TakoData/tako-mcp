import { CORS_PATHS, corsPreflight, withCors } from "./cors.js";
import type { Env } from "./env.js";
import { handleIconRequest } from "./icons.js";
import { handleMcpRequest } from "./mcp.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleProtectedResourceMetadata,
  handleRegister,
  handleRevoke,
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

    // CORS preflight for the discovery + DCR + token endpoints. Browser-
    // based MCP submission flows (e.g. OpenAI Apps SDK at
    // platform.openai.com) preflight POST /register and POST /token, and
    // need ACAO on the metadata GETs. See `cors.ts` for the full rationale.
    if (request.method === "OPTIONS" && CORS_PATHS.has(url.pathname)) {
      return corsPreflight();
    }

    // Brand-icon proxy. Connector cards in Claude / ChatGPT fetch these
    // URLs directly (advertised via `serverInfo.icons` on `initialize`).
    // Serving through the worker keeps the public URL stable across
    // Tako frontend redeploys — see `icons.ts` header for why proxying
    // is preferable to pointing connectors at Tako's hashed CDN paths.
    if (request.method === "GET" && url.pathname.startsWith("/icons/")) {
      return handleIconRequest(url.pathname);
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
      return withCors(handleProtectedResourceMetadata(request, env));
    }
    // We deliberately do NOT alias `/.well-known/openid-configuration`.
    // Two rounds of external advice converged on the same conclusion:
    // ChatGPT's App Review classifier dislikes a "half-OIDC / half-OAuth"
    // shape, where the OIDC URL resolves but the doc lacks OIDC-only
    // fields (jwks_uri, id_token_signing_alg_values_supported,
    // subject_types_supported). Once the wizard discovers the OIDC URL,
    // it locks the OIDC fields on the form, and `OIDC enabled` cannot be
    // cleared cleanly. Pure OAuth + DCR is the safer shape for MCP Apps.
    // Strict OIDC clients will (correctly) fall back to OAuth on 404.
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      return withCors(handleAuthServerMetadata(request, env));
    }
    if (url.pathname === "/register") {
      return withCors(await handleRegister(request, env));
    }
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/token") {
      return withCors(await handleToken(request, env));
    }
    if (url.pathname === "/revoke") {
      return withCors(handleRevoke(request, env));
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
