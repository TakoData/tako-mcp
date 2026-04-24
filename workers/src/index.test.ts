import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Valid RFC 6750 b64token — any non-empty ASCII token works for these tests
// because `extractBearer` only validates shape, not value. Django's the one
// that would reject a bogus token; we mock nothing here and never hit Django.
const TEST_TOKEN = "test-token-abc123";
const AUTH_HEADER = `Bearer ${TEST_TOKEN}`;

describe("worker routing", () => {
  it("GET /health returns 200 with text/plain body 'ok'", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("ok");
  });

  it("GET /unknown returns 404", async () => {
    const res = await SELF.fetch("https://example.com/unknown");
    expect(res.status).toBe(404);
  });

  it("POST /mcp accepts an initialize request and returns serverInfo matching registry", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    };

    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify(initializeRequest),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      };
    };

    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("tako-mcp");
    expect(body.result.serverInfo.version).toBe("0.1.0");
    // Guard against silent SDK negotiation regressions — a missing or
    // malformed protocolVersion should fail loudly. The regex tolerates
    // future SDK bumps without pinning to a specific release.
    expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("POST /mcp without Authorization returns 401 with JSON-RPC bearer error", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");

    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    // BEARER_AUTH_JSON_RPC_CODE — Phase 1 convention from auth.ts.
    expect(body.error.code).toBe(-32001);
    expect(body.error.data.kind).toBe("missing");
  });

  it("POST /mcp tools/list returns the full Phase 2 tool set", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name).sort();
    // The exact set of tools registered by the codegen barrel. When a tool
    // is added or removed, update this list alongside the tool-module file.
    expect(names).toEqual([
      "create_chart",
      "create_report",
      "explore_knowledge_graph",
      "get_chart_image",
      "get_credit_balance",
      "get_report",
      "knowledge_search",
      "list_reports",
      "open_chart_ui",
    ]);
  });

  it("POST /mcp tools/call invokes the registered handler and surfaces structuredContent", async () => {
    // `open_chart_ui` is a pure URL/HTML builder — no Django fetch, so we can
    // exercise the full SDK → registry → handler path without mocking the
    // network in the integration test.
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "open_chart_ui",
          arguments: { pub_id: "abc123" },
        },
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent?: {
          pub_id: string;
          embed_url: string;
          iframe_html: string;
          dark_mode: boolean;
          width: number;
          height: number;
        };
      };
    };

    // `structuredContent` is the typed payload; clients without that support
    // fall back to the `content[0].text` JSON string. Both must be present
    // when the tool declares an `outputSchema`.
    expect(body.result.structuredContent).toMatchObject({
      pub_id: "abc123",
      dark_mode: true,
      width: 900,
      height: 600,
    });
    expect(body.result.structuredContent?.embed_url).toContain("/embed/abc123/");
    expect(body.result.structuredContent?.iframe_html).toContain("<iframe");
    expect(body.result.content[0]).toMatchObject({ type: "text" });
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      pub_id: string;
    };
    expect(parsed.pub_id).toBe("abc123");
  });
});
