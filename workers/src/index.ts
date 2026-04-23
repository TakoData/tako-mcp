import type { Env } from "./env.js";
import { handleMcpRequest } from "./mcp.js";

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
    // GET /mcp (SSE resubscription), DELETE /mcp (session terminate), and
    // OPTIONS /mcp (browser CORS preflight) are intentionally unrouted:
    // stateless JSON-response mode does not use GET/DELETE, and current
    // MCP clients (Claude Desktop, CLI) do not issue preflights. Revisit
    // when Phase 2 introduces streaming tools or browser-based clients —
    // see the `transport.close()` TODO in `mcp.ts`.

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
