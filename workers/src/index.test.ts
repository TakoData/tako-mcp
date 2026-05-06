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

  // Strict OIDC clients (notably ChatGPT App Review) reject our OAuth
  // metadata when it's served at the OIDC discovery path because we omit
  // OIDC-only fields. 404 here lets them fall back to the OAuth metadata
  // path per the MCP spec.
  it("GET /.well-known/openid-configuration returns 404 (we are not an OIDC IdP)", async () => {
    const res = await SELF.fetch(
      "https://example.com/.well-known/openid-configuration",
    );
    expect(res.status).toBe(404);
  });

  // Browser-based MCP clients (OpenAI Apps SDK wizard, etc.) auto-detect
  // OAuth via cross-origin fetch. Without ACAO the browser blocks the
  // body and detection silently fails — see `cors.ts` for the rationale.
  describe("CORS on the OAuth surface", () => {
    const CORS_PATHS = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/register",
      "/token",
    ];

    for (const path of CORS_PATHS) {
      it(`OPTIONS ${path} returns 204 with CORS headers`, async () => {
        const res = await SELF.fetch(`https://example.com${path}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://platform.openai.com",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")).toContain(
          "Content-Type",
        );
      });
    }

    it("GET /.well-known/oauth-protected-resource carries ACAO on the response", async () => {
      const res = await SELF.fetch(
        "https://example.com/.well-known/oauth-protected-resource",
        { headers: { origin: "https://platform.openai.com" } },
      );
      // Response status depends on whether OAuth is configured in the test
      // env (404 vs 200); CORS must be present either way so browser-side
      // discovery surfaces the underlying error instead of an opaque CORS
      // failure.
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("GET /.well-known/oauth-authorization-server carries ACAO on the response", async () => {
      const res = await SELF.fetch(
        "https://example.com/.well-known/oauth-authorization-server",
        { headers: { origin: "https://platform.openai.com" } },
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
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
      result: {
        tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
      };
    };
    const names = new Set(body.result.tools.map((t) => t.name));
    expect(names.has("start_deep_knowledge_search")).toBe(true);
    expect(names.has("wait_for_knowledge_search")).toBe(true);
    // The default 10 tools are still present alongside.
    expect(names.has("knowledge_search")).toBe(true);
    expect(body.result.tools).toHaveLength(11);

    // Both `knowledge_search` and `open_chart_ui` ship the chart
    // widget on ChatGPT. The empty-fast widget-gap problem (ChatGPT
    // pins widget container height at the highest ever notified
    // and ignores shrink notifications, so a clean `count: 0`
    // result rendered as a persistent empty container) is now
    // handled by `knowledge_search`'s handler throwing on empty
    // for ChatGPT — tool errors don't reserve a widget container,
    // so the widget can stay shipped without leaving a gap on the
    // empty path.
    for (const name of ["knowledge_search", "open_chart_ui"]) {
      const tool = body.result.tools.find((t) => t.name === name);
      expect(tool?._meta).toMatchObject({
        ui: { resourceUri: "ui://tako/embed/chart" },
        "ui/resourceUri": "ui://tako/embed/chart",
        "openai/outputTemplate": "ui://tako/embed/chart",
      });
    }
  });

  it("POST /mcp tools/list serves per-client knowledge_search descriptions", async () => {
    // `knowledge_search` defines `descriptionByClient` with a
    // claude variant (auto-renders inline) and a chatgpt variant
    // (must chain into open_chart_ui + escalate via kickoff/wait).
    // The Worker selects the right variant from the UA-detected
    // client kind, so each model only sees the directives that
    // actually apply to its host. Without per-client routing, a
    // single description with conditional clauses ("On Claude.ai…"
    // / "On ChatGPT…") forces the model to self-identify the host
    // — empirically unreliable.
    async function descFor(userAgent?: string): Promise<string> {
      const res = await SELF.fetch("https://example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: AUTH_HEADER,
          ...(userAgent !== undefined ? { "user-agent": userAgent } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/list",
          params: {},
        }),
      });
      const body = (await res.json()) as {
        result: { tools: Array<{ name: string; description: string }> };
      };
      const ks = body.result.tools.find((t) => t.name === "knowledge_search");
      return ks?.description ?? "";
    }

    const claudeDesc = await descFor("claude-mcp-client/1.0");
    const chatgptDesc = await descFor("ChatGPT/1.0 (+https://chatgpt.com)");
    const unknownDesc = await descFor();

    // Claude variant: must reference inline auto-render +
    // server-side auto-escalation, must NOT mention chaining into
    // start_deep_knowledge_search (that's the ChatGPT-only path).
    expect(claudeDesc).toContain("auto-renders inline");
    expect(claudeDesc).toContain("auto-escalation");
    expect(claudeDesc).not.toContain("start_deep_knowledge_search");

    // ChatGPT variant: ALSO promises the inline auto-render
    // (`knowledge_search` keeps its widget on ChatGPT now that the
    // empty-path throw avoids the widget-container gap), AND
    // includes the LLM-side escalation directive
    // (server-side auto-escalation is disabled on ChatGPT, so the
    // model must call `start_deep_knowledge_search` itself).
    expect(chatgptDesc).toContain("auto-renders inline");
    expect(chatgptDesc).toContain("start_deep_knowledge_search");

    // Unknown / future hosts: fall back to the claude-style
    // default. Most non-ChatGPT MCP hosts support inline rendering
    // and progress-notification timeout reset, so this is the
    // safer assumption than the ChatGPT branch.
    expect(unknownDesc).toBe(claudeDesc);
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

  it("POST /mcp tools/call from claude.ai (widget suppressed) returns text-only — no widget metadata, no PNG fallback", async () => {
    // claude.ai's MCP host renders chart widgets inside a constrained
    // iframe that clips the chart vertically; we suppress the widget
    // and rely on the LLM-pasted `[Open in Tako](embed_url)` link
    // (per the chart tool descriptions) so the user gets a clickable
    // path to the fully-interactive standalone embed.
    //
    // Test locks in three invariants for the suppressed-claude shape:
    //   1. No widget metadata in `_meta` (no `ui/resourceUri`,
    //      `_meta.ui.resourceUri`, or `image_data_url`) — claude.ai
    //      reads these to load the widget bundle, and shipping them
    //      would re-render the cropped iframe.
    //   2. No image content block — `extraContentBlocks` is gated on
    //      `ui === undefined && !widgetSuppressed`, so the PNG
    //      fallback also doesn't ship. claude.ai gets only the text
    //      block + structuredContent; the LLM surfaces the link.
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
    expect(body.result._meta?.image_data_url).toBeUndefined();
    expect(body.result._meta?.["ui/resourceUri"]).toBeUndefined();
    expect(
      (body.result._meta?.ui as { resourceUri?: string } | undefined)
        ?.resourceUri,
    ).toBeUndefined();
    expect(body.result._meta?.["openai/outputTemplate"]).toBeUndefined();
    // No image content block (PNG fallback) either — content array
    // should be just the JSON-stringified text block.
    expect(body.result.content.every((c) => c.type === "text")).toBe(true);
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
