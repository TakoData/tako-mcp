import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// No `.js` suffix — the SDK's package.json `exports` map only exposes
// `./validation/cfworker`, unlike the other server subpaths which do ship
// `.js` entries. Adding the extension here breaks module resolution.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import {
  BearerAuthError,
  bearerAuthErrorToJsonRpc,
  extractBearer,
} from "./auth.js";
import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "./django.js";
import type { Env } from "./env.js";
import { tryResolveOAuthAccessToken } from "./oauth/access.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import type { AnyToolModule, ToolContext } from "./tools/types.js";

/**
 * Server identity. `registry/server.json` is the canonical source — keep this
 * constant and `workers/package.json#version` aligned with it when bumping.
 * Clients compare what they read from the registry against what `initialize`
 * returns, so a mismatch surfaces as "wrong server" in tooling.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * MCP Apps UI resource MIME type. Hosts (claude.ai, ChatGPT Apps SDK, VS
 * Code Insiders, Goose) gate sandbox-iframe rendering on this exact value
 * — plain `text/html` resources are treated as opaque and not rendered as
 * widgets. Source: MCP Apps standard ("text/html;profile=mcp-app") and
 * the OpenAI Apps SDK "Build your MCP server" guide.
 */
const APP_UI_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The CfWorker schema validator is stateless (it compiles a schema on each
 * `validate` call), so one module-scope instance is reused across warm
 * invocations rather than allocating a fresh one per `/mcp` POST.
 *
 * Default Ajv validator uses `new Function(...)` under the hood and breaks
 * in the Workers runtime (no eval). The @cfworker/json-schema provider ships
 * with the SDK exactly for this case.
 */
const JSON_SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator();

/**
 * Build a fresh `McpServer` with tako-mcp identity and register every tool
 * in `TOOL_REGISTRY` against it. Each handler closes over the per-request
 * `ToolContext` so tools see the right Bearer token + env bindings without
 * having to reach for request state themselves.
 */
export function createMcpServer(
  ctx: ToolContext,
  options: { iconsBaseUrl?: string } = {},
): McpServer {
  // Hosts (Claude.ai connector cards, ChatGPT app directory, etc.) pick
  // one entry per the spec's matching rules: theme first, then size.
  // Order entries best-fit-first within each theme so simple hosts that
  // just take `icons[0]` still get a sensible asset.
  //
  // URLs are served by this same worker under `/icons/*` (see
  // `icons.ts`). Going through our own origin keeps the public icon URL
  // stable across Tako frontend deploys — Tako only exposes its brand
  // assets under hashed CDN paths that rotate per deploy, so proxying
  // is the only way to ship a serverInfo.icons array that doesn't rot.
  // `iconsBaseUrl` is omitted in tests / non-HTTP contexts; in that
  // case we just don't advertise icons.
  const icons =
    options.iconsBaseUrl !== undefined
      ? [
          {
            src: `${options.iconsBaseUrl}/icons/favicon.svg`,
            mimeType: "image/svg+xml",
            theme: "light" as const,
          },
          {
            src: `${options.iconsBaseUrl}/icons/favicon-light.svg`,
            mimeType: "image/svg+xml",
            theme: "dark" as const,
          },
          {
            src: `${options.iconsBaseUrl}/icons/apple-touch-icon.png`,
            mimeType: "image/png",
            sizes: ["180x180"],
          },
        ]
      : undefined;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Tako",
      websiteUrl: "https://tako.com",
      description:
        "Interactive charts and live-data visualizations for finance, economics, demographics, prediction markets, and more.",
      ...(icons !== undefined ? { icons } : {}),
    },
    {
      jsonSchemaValidator: JSON_SCHEMA_VALIDATOR,
    },
  );

  for (const tool of TOOL_REGISTRY) {
    registerTool(server, tool, ctx);
  }

  return server;
}

/**
 * Register a single `ToolModule` with an `McpServer`, adapting between our
 * handler signature (`(input, ctx) => Promise<Output>`) and the SDK's
 * expected `CallToolResult` return shape.
 *
 * The SDK's `registerTool` takes `ZodRawShape` (the `.shape` of a z.object),
 * not a full ZodObject — common gotcha. We pull `.shape` out here so tool
 * files don't have to.
 */
function registerTool(
  server: McpServer,
  tool: AnyToolModule,
  ctx: ToolContext,
): void {
  // SDK's `registerTool` takes `ZodRawShape` (the `.shape` of a z.object),
  // not a full ZodObject — pull `.shape` here so tool files don't have to.
  const config: Record<string, unknown> = {
    title: tool.annotations.title,
    description: tool.description,
    inputSchema: tool.inputSchema.shape,
    annotations: tool.annotations,
  };

  if (tool.outputSchema !== undefined) {
    // Output schemas are optional — only read tools + `create_chart` declare
    // them. In practice every `outputSchema` we ship is `z.object(...)`,
    // so `.shape` is defined; if it isn't, we simply don't pass outputSchema.
    const outputShape = (tool.outputSchema as unknown as { shape?: unknown })
      .shape;
    if (outputShape !== undefined) {
      config.outputSchema = outputShape;
    }
  }

  // MCP Apps: when the tool ships a UI bundle, register it as a separate
  // resource and thread the widget URI into the tool's registration via
  // BOTH the open-spec field and the OpenAI-namespaced field. Clients
  // that support MCP Apps fetch the resource, sandbox it in an iframe,
  // and pipe each `tools/call` result to the widget. Clients without
  // MCP Apps support ignore the metadata and rely on the default
  // text + image content blocks the registry already emits.
  //
  // Two metadata fields, two clients:
  //
  //   - `_meta.ui.resourceUri` — the open MCP Apps standard
  //     (blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps).
  //     claude.ai, VS Code Insiders, and Goose read this field. They
  //     also pass the `tools/call` result to the widget via a JSON-RPC
  //     `postMessage` (`ui/notifications/tool-result`).
  //
  //   - `_meta["openai/outputTemplate"]` — ChatGPT's Apps SDK reads
  //     this exact namespaced key. It controls TWO things on ChatGPT's
  //     side: which widget URI to load AND whether structuredContent
  //     gets piped into `window.openai.toolOutput`. Without it, the
  //     widget loads (because ChatGPT can fall back on `_meta.ui` to
  //     find the URI) but `toolOutput` stays null forever, leaving the
  //     widget stuck on its loading state. Found the hard way: the
  //     debug widget polled `window.openai.toolOutput` 40 times across
  //     10 seconds and watched it never populate, even though
  //     `openai:set_globals` events fired with `detail.globals` set.
  if (tool.appUiResource !== undefined) {
    const ui = tool.appUiResource(ctx.env);
    const uiMeta: Record<string, unknown> = {};
    if (ui.frameDomains && ui.frameDomains.length > 0) {
      uiMeta.csp = { frameDomains: ui.frameDomains };
    }
    // Resource registration. CSP-allowed iframe domains live on
    // `_meta.ui.csp.frameDomains` (open MCP Apps spec). The bundle's
    // `_meta.ui` is set in TWO places by design (matches the official
    // `@modelcontextprotocol/ext-apps` helper):
    //
    //   1. Resource registration metadata (third arg to
    //      `server.registerResource`) — surfaces in the `resources/list`
    //      response so clients can discover CSP rules without fetching.
    //   2. The content item itself (inside `readCallback`'s
    //      `contents[0]._meta`) — clients reading the bundle read CSP
    //      from here, and per the ext-apps docs the content-item value
    //      "takes precedence" over the registration value. ChatGPT
    //      specifically reads the content-item `_meta` during
    //      `resources/read`; without it, frame-ancestors stays empty
    //      and the inner `<iframe src="https://tako.com/embed/…">` is
    //      blocked even though the registration metadata declared the
    //      domain.
    server.registerResource(
      ui.name,
      ui.uri,
      {
        // Per the MCP Apps spec: the host gates UI rendering on this
        // exact MIME type. Plain "text/html" is treated as a normal
        // resource and won't be sandbox-rendered as a widget.
        mimeType: APP_UI_MIME_TYPE,
        ...(Object.keys(uiMeta).length > 0 ? { _meta: { ui: uiMeta } } : {}),
      },
      // Static bundle — no per-request templating. The widget reads its
      // chart-specific data (pub_id, embed_url, dark_mode, …) from each
      // `tools/call` result via either `window.openai.toolOutput`
      // (ChatGPT) or a `ui/notifications/tool-result` postMessage
      // (claude.ai), so the same bundle serves every chart.
      async (uri) => {
        const contentItem: {
          uri: string;
          mimeType: string;
          text: string;
          _meta?: Record<string, unknown>;
        } = {
          uri: uri.toString(),
          mimeType: APP_UI_MIME_TYPE,
          text: ui.html,
        };
        if (Object.keys(uiMeta).length > 0) {
          contentItem._meta = { ui: uiMeta };
        }
        return { contents: [contentItem] };
      },
    );
    // Tool-side metadata: set the modern `_meta.ui.resourceUri`, the
    // legacy flat `_meta["ui/resourceUri"]` (the official ext-apps
    // helper auto-mirrors these for backward compat with older host
    // readers — we do the same so a ChatGPT build still reading the
    // legacy key works), and `_meta["openai/outputTemplate"]` (OpenAI
    // namespace alias). Three keys, one URI — same data delivered
    // under whichever name the host happens to read.
    config._meta = {
      ui: { resourceUri: ui.uri },
      "ui/resourceUri": ui.uri,
      "openai/outputTemplate": ui.uri,
    };
  }

  server.registerTool(
    tool.name,
    config as Parameters<McpServer["registerTool"]>[1],
    async (input) => {
      let output: unknown;
      try {
        output = await tool.handler(input as unknown, ctx);
      } catch (err) {
        // Map Django transport failures to a structured `isError: true`
        // result so MCP clients can distinguish "your token was rejected"
        // from "upstream timed out" without string-matching `err.message`.
        // Non-Django throws re-throw to the SDK, which wraps them in a
        // generic tool error (last-resort path for handler bugs).
        if (err instanceof DjangoError) {
          return djangoErrorToToolResult(err);
        }
        throw err;
      }
      // When the tool declares an `outputSchema`, report the structured
      // payload alongside a JSON-stringified text fallback. Clients that
      // understand `structuredContent` get the typed value; legacy clients
      // fall back to the text content. When no outputSchema, text-only is
      // sufficient.
      const text = JSON.stringify(output, null, 2);
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text }];
      // Optional per-tool hook to append extra MCP content blocks (image,
      // audio, resource). Best-effort: a thrown hook degrades to the text
      // + structuredContent that's already there rather than failing the
      // call.
      //
      // SKIPPED when the tool also ships an `appUiResource`. Reason:
      // when both are set, the response carries `content: [text, image]`
      // + a `_meta.ui.resourceUri` pointing at a widget. The base64
      // image inflates the JSON-RPC response by ~70-400 KB which on
      // ChatGPT was tokenized at ~150K tokens and apparently triggers
      // an internal size guard that silently disables widget data flow
      // (`window.openai.toolOutput` stays null, `openai:set_globals`
      // events fire only with maxHeight/maxWidth). The image is also
      // redundant for clients that DO render the widget — the widget
      // shows the chart interactively, an inline PNG below it would
      // duplicate. Clients without widget support still see the
      // structuredContent JSON (with `image_url` and `embed_url`) and
      // can render those as markdown.
      if (
        tool.extraContentBlocks !== undefined &&
        tool.appUiResource === undefined
      ) {
        try {
          const extra = await tool.extraContentBlocks(output, ctx);
          content.push(...extra);
        } catch (err) {
          console.error(
            `extraContentBlocks hook failed for ${tool.name}:`,
            err,
          );
        }
      }
      // Optional `_meta` hook. Distinct from `extraContentBlocks` and
      // `structuredContent` because `_meta` is the MCP spec's
      // metadata-only field — hosts MAY forward it to widgets via
      // `ui/notifications/tool-result` (per the MCP Apps spec) but it
      // is NOT part of the LLM's context window. Use this to ship
      // payloads the widget needs but the LLM shouldn't tokenize, e.g.
      // an inline base64 PNG too large to fit in `structuredContent`
      // without tripping claude.ai's "tool result too large for
      // context" guard.
      let resultMeta: Record<string, unknown> | undefined;
      if (tool.extraMeta !== undefined) {
        try {
          resultMeta = await tool.extraMeta(output, ctx);
        } catch (err) {
          console.error(`extraMeta hook failed for ${tool.name}:`, err);
        }
      }
      const result: {
        content: typeof content;
        structuredContent?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      } = { content };
      if (tool.outputSchema !== undefined) {
        result.structuredContent = output as Record<string, unknown>;
      }
      if (resultMeta !== undefined && Object.keys(resultMeta).length > 0) {
        result._meta = resultMeta;
      }
      return result;
    },
  );
}

/**
 * Convert a `DjangoError` into a structured MCP `CallToolResult` with
 * `isError: true`. Each subtype maps to a distinct `kind` discriminator so
 * clients can branch on `structuredContent.kind` (e.g. "unauthorized" vs
 * "timeout") instead of parsing `err.message`. Per-subtype fields
 * (`timeoutMs`, `body`) are only attached where they exist on the error.
 *
 * Exported for unit testing — the wire contract is stable enough that
 * Phase 2 tests can rely on the `kind` strings here.
 */
export function djangoErrorToToolResult(err: DjangoError): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const structured: Record<string, unknown> = {
    kind: djangoErrorKind(err),
    path: err.path,
    method: err.method,
  };
  if (err.status !== undefined) structured.status = err.status;
  if (err instanceof DjangoTimeoutError) structured.timeoutMs = err.timeoutMs;
  if (err instanceof DjangoBadRequestError || err instanceof DjangoHttpError) {
    structured.body = err.body;
  }
  // For 400s, splice the response body into the text content. DRF
  // validation errors (missing fields, invalid enum values, bad
  // component config) carry the guidance the LLM needs to retry;
  // keeping it in `structuredContent.body` alone isn't enough because
  // not every MCP client surfaces structured content to the model.
  // Intentionally scoped to `DjangoBadRequestError` — other subtypes
  // (404/401/5xx/timeout) don't carry LLM-actionable detail, so their
  // text stays body-free to keep Workers Logs greppable. `err.message`
  // stays body-free by construction (log-injection guard in
  // `django.ts`); the splice happens here at the MCP boundary.
  const text =
    err instanceof DjangoBadRequestError
      ? `${err.message}: ${err.body}`
      : err.message;
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: true,
  };
}

function djangoErrorKind(err: DjangoError): string {
  if (err instanceof DjangoUnauthorizedError) return "unauthorized";
  if (err instanceof DjangoTimeoutError) return "timeout";
  if (err instanceof DjangoNotFoundError) return "not_found";
  if (err instanceof DjangoBadRequestError) return "bad_request";
  if (err instanceof DjangoResponseParseError) return "response_parse";
  if (err instanceof DjangoHttpError) return "http";
  return "unknown";
}

/**
 * Handle a POST /mcp request using a stateless Streamable HTTP transport.
 *
 * We spin up a fresh `McpServer` + transport per request. Cloudflare Workers
 * have no persistent in-process state across requests, so stateless mode is
 * the right fit: no `Mcp-Session-Id`, no cross-request bookkeeping. Each
 * request carries all the state it needs (client sends `initialize` and
 * subsequent calls independently; re-negotiation is cheap).
 *
 * Auth gate: `extractBearer` runs BEFORE the SDK sees the request. A
 * missing / malformed / empty `Authorization` header short-circuits here
 * with a uniform JSON-RPC 401 response — the SDK never processes
 * unauthenticated traffic. `initialize` requires auth too; MCP clients are
 * expected to be configured with a Tako API token before they connect.
 *
 * `enableJsonResponse: true` makes the transport return a single JSON-RPC
 * response body instead of an SSE stream, which keeps the wire format simple
 * for the common request/response case.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // Gate the whole endpoint behind Bearer auth. If the header is missing /
  // malformed / empty, return a uniform 401 before invoking the SDK.
  let bearer: string;
  try {
    bearer = extractBearer(request);
  } catch (err) {
    if (err instanceof BearerAuthError) {
      return bearerAuthResponse(request, err);
    }
    throw err;
  }

  // Two-mode bearer handling:
  // - OAuth access JWT issued by /token: verify signature, decrypt the
  //   per-user Tako API token from the `enc_tako_token` claim, forward
  //   that token downstream as `X-API-Key`. Each user authenticates as
  //   themselves to Django.
  // - Raw Tako API token (the existing Claude Code path): non-JWT shape,
  //   `tryResolveOAuthAccessToken` returns null, we forward the bearer
  //   verbatim. Backwards-compatible with every Claude Code install in
  //   the wild.
  const oauthMappedToken = await tryResolveOAuthAccessToken(bearer, env);
  const token = oauthMappedToken ?? bearer;

  const ctx: ToolContext = { token, env };

  try {
    // Use the request's own origin as the icon base, so each deployed
    // env (mcp.tako.com, mcp.staging.tako.com, *.workers.dev) advertises
    // icons it itself serves under `/icons/*`. Prevents staging
    // connectors from referencing prod URLs and vice versa.
    const requestOrigin = new URL(request.url).origin;
    const server = createMcpServer(ctx, { iconsBaseUrl: requestOrigin });
    // Omitting `sessionIdGenerator` puts the transport in stateless mode — no
    // `Mcp-Session-Id` header is issued or validated. This matches the Worker
    // model (no persistent per-session state) and keeps each request
    // self-contained.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // TODO(Phase 2): revisit this unconditional close.
      //
      // Safe today ONLY because `enableJsonResponse: true` buffers the full
      // response before `handleRequest` resolves — there is no in-flight SSE
      // stream for `transport.close()` to truncate.
      //
      // When Phase 2 introduces tools that stream results over SSE, this
      // `finally` will clear `_streamMapping` and abort the stream before
      // the client has read it. Likely fix: move to on-error close only and
      // rely on Workers GC at request completion to release resources.
      await transport.close();
      await server.close();
    }
  } catch (err) {
    // The SDK handles JSON-RPC validation errors internally. This outer
    // catch is a last-resort safety net for unexpected throws from
    // `server.connect(transport)` or tool handler bugs — we don't want to
    // leak a generic Worker 500 (or the exception message) to clients.
    // Log to Workers Logs (observability is enabled in wrangler.jsonc) so
    // production incidents still produce a signal.
    console.error("mcp handler error:", err);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
}

/**
 * Build the HTTP 401 response for a bearer auth failure. The body is a
 * JSON-RPC 2.0 error envelope with `id: null` (auth failures happen before
 * the SDK sees the request id). The `code` / `data.kind` pair comes from
 * {@link bearerAuthErrorToJsonRpc}; see `auth.ts`.
 *
 * Emits `WWW-Authenticate: Bearer` per RFC 6750 §3 so clients know to
 * supply a Bearer token on retry. The `resource_metadata` parameter
 * (RFC 9728) points the client at our OAuth protected-resource discovery
 * doc — that is how MCP hosts (Claude.ai, ChatGPT) bootstrap an OAuth
 * flow when they have only the MCP URL and got a 401.
 */
function bearerAuthResponse(request: Request, err: BearerAuthError): Response {
  const origin = new URL(request.url).origin;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: bearerAuthErrorToJsonRpc(err),
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );
}
