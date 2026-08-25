import { CORS_PATHS, corsPreflight, withCors } from "./cors.js";
import {
  handleCdnAssetProxy,
  handleEmbedDataProxy,
  handleEmbedProxy,
} from "./embed_proxy.js";
import type { Env } from "./env.js";
import { handleIconRequest } from "./icons.js";
import { handleMcpRequest } from "./mcp.js";
import { surfaceForPath } from "./surface.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleLoginPassword,
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

    const surface = surfaceForPath(url.pathname);
    if (request.method === "POST" && surface !== null) {
      return handleMcpRequest(request, env, surface);
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

    // CORS-readable proxy for Tako's chart embed page, so the MCP Apps widget
    // can render the REAL interactive card rather than a PNG of it. Returns
    // `undefined` — falling through to the 404 below — when the
    // `PUBLIC_CDN_URL` binding is absent or the pub_id is malformed. Both
    // deployed envs set that binding, so this route is LIVE in staging and
    // production; it ceases to exist only where the binding does. See
    // `embed_proxy.ts`.
    const embedProxied = await handleEmbedProxy(request, env);
    if (embedProxied !== undefined) return embedProxied;

    // Companion passthrough for the assets that page references (Card.js, its
    // lazily imported chunks, the Geist/Inter fonts). Tako's CDN answers CORS
    // for `tako.com` only, and a `type="module"` script is always fetched in
    // CORS mode, so serving them from our own origin is what makes the native
    // card work inside a sandbox. Same gate, same fall-through to 404.
    const assetProxied = await handleCdnAssetProxy(request, env);
    if (assetProxied !== undefined) return assetProxied;

    // Third leg of the same feature: the card's own tab-data endpoint. The
    // proxied page inlines data for the tab it opens on and fetches every other
    // tab at click time from a path resolved against `window.location.href` —
    // the host's sandbox origin inside a widget, so without this the card showed
    // "There was an error loading the data." on eleven of Nvidia's twelve tabs.
    // Same gate and same fall-through to 404. See `embed_proxy.ts`.
    const dataProxied = await handleEmbedDataProxy(request, env);
    if (dataProxied !== undefined) return dataProxied;

    // GET /mcp (server->client SSE stream) and DELETE /mcp (session
    // terminate) are genuinely not offered: we run stateless JSON-response
    // mode and never issue an `Mcp-Session-Id`, so there is no session to
    // resubscribe to or tear down.
    //
    // They must still answer 405, not fall through to the catch-all 404.
    // Streamable HTTP gives those two codes different meanings: 405 means
    // "this method is not available here" (the spec's prescribed reply from
    // a server that does not offer the optional SSE stream), while 404 on a
    // session-bearing request means "your session is gone, re-initialize".
    //
    // Cursor obeys that distinction. Against the 404 it re-initialized,
    // re-issued the GET, and after 5 consecutive session-404s disabled the
    // transport for good:
    //
    //   Failed to open SSE stream
    //   Tombstoning streamable HTTP transport after 5 consecutive session
    //   HTTP 404 responses; automatic retry disabled
    //
    // Claude Desktop and Claude Code never hit this because they do not
    // open the GET stream, which is why it went unnoticed. Context7 and
    // AWS's remote servers both return 405 here and connect cleanly.
    if (
      (request.method === "GET" || request.method === "DELETE") &&
      surface !== null
    ) {
      return new Response("method not allowed", {
        status: 405,
        headers: {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    // OpenAI connector-directory domain verification. During the
    // submission flow OpenAI hits this URL and expects to read back
    // the exact token shown in their dashboard. Token is per-env via
    // `OPENAI_APPS_CHALLENGE_TOKEN`. We only serve it when configured;
    // an unset/empty binding falls through to the catch-all 404 below,
    // so a non-production environment never satisfies a verification it
    // wasn't issued. Plain text response — no CORS wrapper needed
    // (OpenAI hits this server-to-server, not from a browser).
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/openai-apps-challenge" &&
      env.OPENAI_APPS_CHALLENGE_TOKEN
    ) {
      return new Response(env.OPENAI_APPS_CHALLENGE_TOKEN, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

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
    // Email + password sign-in. A server-side form POST rather than a
    // browser-SDK call, so the password never passes through the CDN-loaded
    // Stytch script and the session lands via the same cookie Google's
    // redirect uses.
    //
    // Every OAuth route here is an EXACT `pathname ===` compare, so this needs
    // no particular position relative to `/login` above. Any future
    // `startsWith("/login")` handler would have to go below this line.
    if (url.pathname === "/login/password") {
      return handleLoginPassword(request, env);
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
