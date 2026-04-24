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
import type { Env } from "./env.js";
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
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
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

  server.registerTool(
    tool.name,
    config as Parameters<McpServer["registerTool"]>[1],
    async (input) => {
      const output = await tool.handler(input as unknown, ctx);
      // When the tool declares an `outputSchema`, report the structured
      // payload alongside a JSON-stringified text fallback. Clients that
      // understand `structuredContent` get the typed value; legacy clients
      // fall back to the text content. When no outputSchema, text-only is
      // sufficient.
      const text = JSON.stringify(output, null, 2);
      const result: {
        content: Array<{ type: "text"; text: string }>;
        structuredContent?: Record<string, unknown>;
      } = {
        content: [{ type: "text", text }],
      };
      if (tool.outputSchema !== undefined) {
        result.structuredContent = output as Record<string, unknown>;
      }
      return result;
    },
  );
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
  let token: string;
  try {
    token = extractBearer(request);
  } catch (err) {
    if (err instanceof BearerAuthError) {
      return bearerAuthResponse(err);
    }
    throw err;
  }

  const ctx: ToolContext = { token, env };

  try {
    const server = createMcpServer(ctx);
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
 * supply a Bearer token on retry.
 */
function bearerAuthResponse(err: BearerAuthError): Response {
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
        "WWW-Authenticate": `Bearer error="invalid_token"`,
      },
    },
  );
}
