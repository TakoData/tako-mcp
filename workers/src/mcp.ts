import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// No `.js` suffix — the SDK's package.json `exports` map only exposes
// `./validation/cfworker`, unlike the other server subpaths which do ship
// `.js` entries. Adding the extension here breaks module resolution.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import type { Env } from "./env.js";

/**
 * Server identity. Must match `registry/server.json` so clients see consistent
 * metadata whether they read the registry or call `initialize`.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fresh `McpServer` with tako-mcp identity. No tools are registered
 * yet — that lands in Phase 2.
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      // Default Ajv validator uses `new Function(...)` under the hood and
      // breaks in the Workers runtime (no eval). The @cfworker/json-schema
      // provider ships with the SDK exactly for this case.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
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
 * `enableJsonResponse: true` makes the transport return a single JSON-RPC
 * response body instead of an SSE stream, which keeps the wire format simple
 * for the common request/response case.
 *
 * `env` is threaded through so Phase 2 tool handlers can reach
 * `DJANGO_BASE_URL` (and future bindings) via `djangoGet` / `djangoPost`.
 */
export async function handleMcpRequest(
  request: Request,
  // `env` is unused until Phase 2 registers tools — accepted now so
  // `index.ts` wires bindings through the right shape from the start.
  env: Env,
): Promise<Response> {
  void env;
  // TODO(Phase 2, Linear project "Tako MCP"): wire `extractBearer` from
  // `./auth.ts` BEFORE registering any tool. Phase 1 intentionally ships
  // /mcp without auth because no tools are exposed (initialize handshake
  // is harmless). The moment a tool lands, this endpoint starts proxying
  // to Django — unauthenticated access must be closed in the same PR.
  try {
    const server = createMcpServer();
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
      // stream for `transport.close()` to truncate, and no tools are
      // registered that could produce one.
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
    // `server.connect(transport)` or future handlers — we don't want to
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
