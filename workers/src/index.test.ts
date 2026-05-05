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

  it("POST /mcp tools/list returns the default tool set (non-ChatGPT clients)", async () => {
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
      result: {
        tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
      };
    };
    const names = body.result.tools.map((t) => t.name).sort();
    // Default tool set — NO `start_deep_knowledge_search` or
    // `wait_for_knowledge_search`. Those are ChatGPT-only (see
    // `mcp.ts`'s `CHATGPT_ONLY_TOOL_NAMES`); on Claude.ai and other
    // clients with `resetTimeoutOnProgress` support, deep search
    // happens inside `knowledge_search`'s auto-escalation path.
    expect(names).toEqual([
      "create_chart",
      "create_report",
      "export_report",
      "get_chart_image",
      "get_credit_balance",
      "get_report",
      "knowledge_search",
      "list_reports",
      "open_chart_ui",
    ]);

    // MCP Apps: `open_chart_ui` and `knowledge_search` ship the
    // chart widget bundle. `knowledge_search` is a single-tool flow
    // (no kickoff/wait split) — the deep path polls internally and
    // emits MCP progress notifications to keep the client timeout
    // alive — so a successful tool call always carries a chart in
    // the result, and the widget never has to render an empty
    // intermediate state.
    // All widget-carrying tools' listings must declare the URI
    // under all three metadata keys: `_meta.ui.resourceUri` (open
    // MCP Apps spec, read by claude.ai / VS Code / Goose), the legacy
    // flat `_meta["ui/resourceUri"]` (older host readers), and
    // `_meta["openai/outputTemplate"]` (ChatGPT's Apps SDK — without
    // it the widget loads but `window.openai.toolOutput` never
    // populates). Other tools ship no widget and should declare
    // none of these fields.
    const widgetTools = new Set(["open_chart_ui", "knowledge_search"]);
    for (const name of widgetTools) {
      const tool = body.result.tools.find((t) => t.name === name);
      expect(tool?._meta).toMatchObject({
        ui: { resourceUri: "ui://tako/embed/chart" },
        "ui/resourceUri": "ui://tako/embed/chart",
        "openai/outputTemplate": "ui://tako/embed/chart",
      });
    }
    for (const t of body.result.tools) {
      if (widgetTools.has(t.name)) continue;
      const meta = t._meta as
        | {
            ui?: unknown;
            "ui/resourceUri"?: unknown;
            "openai/outputTemplate"?: unknown;
          }
        | undefined;
      expect(meta?.ui).toBeUndefined();
      expect(meta?.["ui/resourceUri"]).toBeUndefined();
      expect(meta?.["openai/outputTemplate"]).toBeUndefined();
    }
  });

  it("POST /mcp tools/list adds the deep-search kickoff/wait pair on ChatGPT clients", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        // `detectMcpClient` matches "chatgpt" / "openai" substrings
        // in the User-Agent — the Apps SDK's UA includes one of
        // these. We use a stand-in here.
        "user-agent": "ChatGPT/1.0 (+https://chatgpt.com)",
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
    const names = new Set(body.result.tools.map((t) => t.name));
    expect(names.has("start_deep_knowledge_search")).toBe(true);
    expect(names.has("wait_for_knowledge_search")).toBe(true);
    // The default 10 tools are still present alongside.
    expect(names.has("knowledge_search")).toBe(true);
    expect(body.result.tools).toHaveLength(11);
  });

  it("POST /mcp resources/list includes the open_chart_ui widget bundle", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "resources/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        resources: Array<{
          uri: string;
          mimeType?: string;
          _meta?: Record<string, unknown>;
        }>;
      };
    };
    const widget = body.result.resources.find(
      (r) => r.uri === "ui://tako/embed/chart",
    );
    expect(widget).toBeDefined();
    expect(widget?.mimeType).toBe("text/html;profile=mcp-app");
    // CSP-allowed iframe domain mirrors `resolvePublicBase(env)` (which in
    // tests resolves to `DJANGO_BASE_URL` / `http://localhost:8000`). The
    // widget embeds Tako's own embed page; without this the host's CSP
    // blocks the inner iframe. ChatGPT also reads `_meta.ui.csp.frameDomains`
    // (the open spec) for iframe permissions; the OpenAI-namespaced
    // `widgetCSP` field is for `redirect_domains` (safe-link handling),
    // a different concept we don't need.
    expect(widget?._meta).toMatchObject({
      ui: { csp: { frameDomains: ["http://localhost:8000"] } },
    });
  });

  it("POST /mcp resources/read returns the widget HTML at the MCP Apps mimeType", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "resources/read",
        params: { uri: "ui://tako/embed/chart" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        contents: Array<{ uri: string; mimeType?: string; text?: string }>;
      };
    };
    expect(body.result.contents).toHaveLength(1);
    const item = body.result.contents[0]! as {
      uri: string;
      mimeType?: string;
      text?: string;
      _meta?: { ui?: { csp?: { frameDomains?: unknown } } };
    };
    expect(item.uri).toBe("ui://tako/embed/chart");
    expect(item.mimeType).toBe("text/html;profile=mcp-app");
    // Content-item `_meta.ui.csp` is what ChatGPT and other MCP-Apps
    // hosts read during `resources/read` — content-item value takes
    // precedence over registration-level `_meta` per the ext-apps
    // contract. Without this on the read response, frame-ancestors
    // stays empty and the inner iframe is blocked by the host's CSP.
    expect(item._meta).toMatchObject({
      ui: { csp: { frameDomains: ["http://localhost:8000"] } },
    });
    // Sanity-check the bundle's wire protocol: it MUST listen for the
    // `ui/notifications/tool-result` JSON-RPC method (the post-message
    // event the host emits on every tool call) and validate `embed_url`
    // is http(s) before assigning to `iframe.src`. If this regresses,
    // the widget either silently never renders or exposes itself to a
    // hostile `javascript:` payload from a compromised server.
    expect(item.text).toContain("ui/notifications/tool-result");
    expect(item.text).toContain("https?:");
    expect(item.text).toContain("tako-embed");
  });

  it("POST /mcp tools/call from claude.ai (widget suppressed) skips extraMeta image_data_url", async () => {
    // Regression test for the `extraMeta` gating: when the widget is
    // suppressed (claude.ai User-Agent), `mcp.ts` must NOT call the
    // tool's `extraMeta` hook. Otherwise the worker fires a redundant
    // PNG fetch (the same one `extraContentBlocks` already does on
    // suppressed hosts) and inflates the JSON-RPC response with a
    // ~330 KB unused `image_data_url` data URI that no widget will
    // read.
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "claude-mcp-client/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
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
        content: Array<{ type: string }>;
        _meta?: Record<string, unknown>;
      };
    };
    // `extraContentBlocks` is the path claude.ai uses for inline
    // rendering — it fires on suppressed hosts. The PNG fetch will
    // fail in the test env (localhost:8000 unreachable), so the
    // resulting array is empty and no image content block is appended.
    // What we're locking in here is the `_meta` shape: no
    // `image_data_url` key, which would only be set by `extraMeta`.
    // `_meta` may be entirely absent (no widget metadata + no
    // `extraMeta` payload = empty), or present with only the dynamic
    // resolver entries — assert against either shape via optional
    // chaining.
    expect(body.result._meta?.image_data_url).toBeUndefined();
    // The widget metadata wiring (`_meta["openai/outputTemplate"]` etc.)
    // is also gated on `ui !== undefined`, so suppressed-host calls
    // come back without those keys too. Sanity-check the gate still
    // covers the whole `ui` block, not just `extraMeta`.
    expect(body.result._meta?.["openai/outputTemplate"]).toBeUndefined();
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
          image_url: string;
          dark_mode: boolean;
          width: number;
          height: number;
        };
      };
    };

    // `structuredContent` is the typed payload; clients without that support
    // fall back to the `content[0].text` JSON string. Both must be present
    // when the tool declares an `outputSchema`. The output deliberately does
    // NOT carry an `iframe_html` field — see open_chart_ui.ts header for
    // the regression that motivated dropping it.
    expect(body.result.structuredContent).toMatchObject({
      pub_id: "abc123",
      dark_mode: true,
      width: 900,
      height: 500,
    });
    expect(body.result.structuredContent?.embed_url).toContain("/embed/abc123/");
    expect(body.result.structuredContent?.image_url).toContain(
      "/api/v1/image/abc123/",
    );
    expect(body.result.structuredContent).not.toHaveProperty("iframe_html");
    expect(body.result.content[0]).toMatchObject({ type: "text" });
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      pub_id: string;
    };
    expect(parsed.pub_id).toBe("abc123");
  });
});
