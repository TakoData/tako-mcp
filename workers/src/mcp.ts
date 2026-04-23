import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

/**
 * Server identity. Must match `registry/server.json` so clients see consistent
 * metadata whether they read the registry or call `initialize`.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Latest stable MCP protocol version we advertise. The SDK also accepts older
 * versions during negotiation, so clients speaking 2024-11-05 through
 * 2025-11-25 will still work.
 */
export const PROTOCOL_VERSION = "2025-11-25";

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
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
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
    await transport.close();
    await server.close();
  }
}
