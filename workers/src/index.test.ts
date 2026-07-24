import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";
import { SERVER_VERSION } from "./mcp.js";

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

  it("GET /.well-known/openai-apps-challenge returns the configured token as plain text", async () => {
    // OpenAI's connector-directory domain-verification flow GETs this
    // URL during submission and matches the response body verbatim
    // against the token shown in their dashboard. The token comes
    // from the `OPENAI_APPS_CHALLENGE_TOKEN` binding (per env, in
    // `wrangler.jsonc`); for the test runner the top-level `vars`
    // entry stubs it to a known string.
    const res = await SELF.fetch(
      "https://example.com/.well-known/openai-apps-challenge",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("dev-stub-not-a-real-challenge-token");
  });

  it("GET /.well-known/openai-apps-challenge returns 404 when the token is unset", async () => {
    // The "never satisfy an un-issued challenge" security property: with
    // no `OPENAI_APPS_CHALLENGE_TOKEN` binding, the route must not answer
    // and instead falls through to the catch-all 404. `SELF.fetch` always
    // carries the configured stub, so we invoke the handler directly with
    // an env lacking the token to exercise the unset path.
    const env = { DJANGO_BASE_URL: "http://localhost:8000" } as Env;
    const res = await worker.fetch(
      new Request("https://example.com/.well-known/openai-apps-challenge"),
      env,
    );
    expect(res.status).toBe(404);
  });

  // We deliberately do not alias the OIDC discovery path. ChatGPT's App
  // Review wizard auto-locks the OIDC form fields once the URL resolves,
  // and the resulting half-OIDC / half-OAuth shape trips its classifier.
  // Pure OAuth + DCR is the safer path for MCP Apps; strict OIDC clients
  // (correctly) fall back to OAuth on 404.
  it("GET /.well-known/openid-configuration returns 404 (pure OAuth, not OIDC)", async () => {
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
    expect(body.result.serverInfo.version).toBe(SERVER_VERSION);
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
    // Default tool set with NO `tools` query param — every opt-in tool is
    // absent. The agent trio (`?tools=agent`), `tako_visualize`
    // (`?tools=visualize`), and `get_credit_balance` (`?tools=credits`)
    // are all in `OPTIONAL_TOOL_NAMES` (see `_optional.ts`) and only appear
    // when the connector opts in. Chart-authoring tools (`create_chart`,
    // `get_chart_image`, `open_chart_ui`) were removed in 0.3.0;
    // `tako_search` is the sole owner of the chart widget on the default
    // surface (auto-renders the top card inline).
    expect(names).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_contents",
      "tako_search",
    ]);

    // Every runtime tool advertises per-tool OAuth via _meta, reverse-DNS
    // namespaced per the MCP _meta rules (the only field the SDK preserves).
    for (const t of body.result.tools) {
      expect(t._meta?.["com.tako/securitySchemes"]).toEqual([
        { type: "oauth2", scopes: ["mcp"] },
      ]);
    }

    // MCP Apps: the chart widget is ChatGPT-only (see `widgetSuppressed`
    // in mcp.ts). Non-ChatGPT clients — claude AND the unknown long tail
    // (Cursor, Windsurf, Gemini CLI, …) — get the chart as an inline PNG
    // `image` content block on tool results instead, so NO tool in this
    // listing declares widget metadata under any of the three keys.
    // The ChatGPT-side widget metadata is asserted in the ChatGPT
    // tools/list tests below.
    for (const t of body.result.tools) {
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

  it("POST /mcp?tools=agent adds the agent split pair on ChatGPT clients", async () => {
    const res = await SELF.fetch("https://example.com/mcp?tools=agent", {
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
    // With the agent opted in, ChatGPT gets the split pair...
    expect(names.has("tako_agent_start")).toBe(true);
    expect(names.has("tako_agent_wait")).toBe(true);
    // ...and NOT the single tako_agent tool (excluded for chatgpt).
    expect(names.has("tako_agent")).toBe(false);
    // The default tools are still present alongside.
    expect(names.has("tako_search")).toBe(true);
    // `tako_visualize` is opt-in for other clients but default-on for
    // ChatGPT (`CHATGPT_DEFAULT_ON_TOOL_NAMES`) — it powers the widget.
    expect(names.has("tako_visualize")).toBe(true);
    // 4 defaults + tako_visualize (ChatGPT default-on) + the split pair = 7.
    expect(body.result.tools).toHaveLength(7);

    // `tako_search` is the sole chart-widget tool on ChatGPT after 0.3.0.
    // The empty-fast widget-gap problem (ChatGPT pins widget container
    // height at the highest ever notified and ignores shrink notifications,
    // so a clean `count: 0` result rendered as a persistent empty container)
    // is handled by `tako_search`'s handler throwing on empty for ChatGPT —
    // tool errors don't reserve a widget container, so the widget can stay
    // shipped without leaving a gap on the empty path.
    const takoSearchTool = body.result.tools.find((t) => t.name === "tako_search");
    expect(takoSearchTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://tako/embed/chart" },
      "ui/resourceUri": "ui://tako/embed/chart",
      "openai/outputTemplate": "ui://tako/embed/chart",
    });
  });

  it("POST /mcp (no tools param) omits every agent tool on ChatGPT clients", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
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
    // The agent is opt-in: without `?tools=agent`, ChatGPT gets neither the
    // split pair nor the single tool.
    expect(names.has("tako_agent_start")).toBe(false);
    expect(names.has("tako_agent_wait")).toBe(false);
    expect(names.has("tako_agent")).toBe(false);
    expect(names.has("tako_search")).toBe(true);
    // `tako_visualize` IS present without opting in — ChatGPT keeps it on
    // the default surface (`CHATGPT_DEFAULT_ON_TOOL_NAMES`) for the widget.
    expect(names.has("tako_visualize")).toBe(true);
    // The other opt-in tools stay absent for ChatGPT too; the default
    // discovery tool is present.
    expect(names.has("tako_available_data")).toBe(true);
    expect(names.has("get_credit_balance")).toBe(false);
    // 4 defaults + tako_visualize = 5.
    expect(body.result.tools).toHaveLength(5);

    // The widget is ChatGPT-only, so `tako_visualize`'s listing must
    // declare the chart resource under all three metadata keys:
    // `_meta.ui.resourceUri` (open MCP Apps spec), the legacy flat
    // `_meta["ui/resourceUri"]` (older host readers), and
    // `_meta["openai/outputTemplate"]` (ChatGPT's Apps SDK — without it
    // the widget loads but `window.openai.toolOutput` never populates).
    const visualizeTool = body.result.tools.find(
      (t) => t.name === "tako_visualize",
    ) as { _meta?: Record<string, unknown> } | undefined;
    expect(visualizeTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://tako/embed/chart" },
      "ui/resourceUri": "ui://tako/embed/chart",
      "openai/outputTemplate": "ui://tako/embed/chart",
    });
  });

  it("POST /mcp?tools=agent adds the single tako_agent tool on non-ChatGPT clients", async () => {
    const res = await SELF.fetch("https://example.com/mcp?tools=agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        // Non-ChatGPT UA → single-call `tako_agent`, not the split pair.
        "user-agent": "claude-mcp-client/1.0",
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
    // Claude / unknown clients get the single-call tool...
    expect(names.has("tako_agent")).toBe(true);
    // ...and never the ChatGPT-only split pair.
    expect(names.has("tako_agent_start")).toBe(false);
    expect(names.has("tako_agent_wait")).toBe(false);
    expect(names.has("tako_search")).toBe(true);
    // Other opt-in tools stay absent — `?tools=agent` enables only the agent.
    expect(names.has("tako_visualize")).toBe(false);
    // 4 default tools + tako_agent = 5.
    expect(body.result.tools).toHaveLength(5);
  });

  it("POST /mcp?tools=<unknown> ignores the bad value and serves the default 4 tools", async () => {
    // A typo (or any unrecognized alias) in `?tools=` must never break the
    // connection: unknown tokens are dropped, no optional tool is enabled, and
    // the request layer still returns exactly the 4 defaults. This guards the
    // parser's "unknown token is never fatal" promise end-to-end.
    const res = await SELF.fetch("https://example.com/mcp?tools=nope", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "claude-mcp-client/1.0",
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
    // No opt-in tool sneaks in from an unrecognized alias.
    expect(names.has("tako_agent")).toBe(false);
    expect(names.has("tako_agent_start")).toBe(false);
    expect(names.has("tako_agent_wait")).toBe(false);
    expect(names.has("tako_visualize")).toBe(false);
    expect(names.has("tako_search")).toBe(true);
    expect(body.result.tools).toHaveLength(4);
  });

  it("POST /mcp?tools=visualize adds tako_visualize without widget metadata (non-ChatGPT)", async () => {
    // No User-Agent → client "unknown". The chart widget is ChatGPT-only
    // (see `widgetSuppressed` in mcp.ts); non-ChatGPT clients render the
    // chart via the inline PNG image content block on tool results, so
    // the listing must NOT declare widget metadata.
    const res = await SELF.fetch("https://example.com/mcp?tools=visualize", {
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
    const names = new Set(body.result.tools.map((t) => t.name));
    expect(names.has("tako_visualize")).toBe(true);
    // Only the requested alias is enabled — the other opt-ins stay off — and
    // the default discovery tool is present.
    expect(names.has("tako_available_data")).toBe(true);
    expect(names.has("get_credit_balance")).toBe(false);
    expect(names.has("tako_agent")).toBe(false);
    // 4 default tools + tako_visualize = 5.
    expect(body.result.tools).toHaveLength(5);

    // Widget metadata is ChatGPT-only — the unknown-client listing carries
    // none of the three widget keys (the ChatGPT default-surface test
    // asserts their presence there).
    const visualizeTool = body.result.tools.find(
      (t) => t.name === "tako_visualize",
    );
    const meta = visualizeTool?._meta as
      | {
          ui?: unknown;
          "ui/resourceUri"?: unknown;
          "openai/outputTemplate"?: unknown;
        }
      | undefined;
    expect(meta?.ui).toBeUndefined();
    expect(meta?.["ui/resourceUri"]).toBeUndefined();
    expect(meta?.["openai/outputTemplate"]).toBeUndefined();
  });

  it("POST /mcp?tools=graph adds the three graph primitives (off by default)", async () => {
    const res = await SELF.fetch("https://example.com/mcp?tools=graph", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "claude-mcp-client/1.0",
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
    // The alias enables all three low-level primitives together — the
    // power-user escape hatch behind the default tako_available_data.
    expect(names.has("tako_graph_search")).toBe(true);
    expect(names.has("tako_graph_related")).toBe(true);
    expect(names.has("tako_graph_node")).toBe(true);
    expect(names.has("tako_available_data")).toBe(true);
    // Other opt-ins stay off.
    expect(names.has("tako_agent")).toBe(false);
    expect(names.has("tako_visualize")).toBe(false);
    expect(names.has("get_credit_balance")).toBe(false);
    // 4 default tools + the 3 graph primitives = 7.
    expect(body.result.tools).toHaveLength(7);
  });

  it("POST /mcp?tools=visualize,credits composes multiple single-tool aliases", async () => {
    const res = await SELF.fetch(
      "https://example.com/mcp?tools=visualize,credits",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: AUTH_HEADER,
          "user-agent": "claude-mcp-client/1.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = new Set(body.result.tools.map((t) => t.name));
    expect(names.has("tako_visualize")).toBe(true);
    expect(names.has("get_credit_balance")).toBe(true);
    // Aliases not in the list stay off.
    expect(names.has("tako_agent")).toBe(false);
    // 4 default tools + tako_visualize + get_credit_balance = 6.
    expect(body.result.tools).toHaveLength(6);
  });

  it("POST /mcp tools/list serves one client-agnostic tako_search description", async () => {
    // `tako_search` is now fast-only (`/api/v3/search`) with no in-tool
    // deep path, so the per-client description split is gone: every host
    // gets the same description. It promises the inline auto-render and
    // points deep / empty-result follow-ups at the Tako agent
    // (`tako_agent_start` → `tako_agent_wait`); it must NOT mention the
    // removed legacy machinery (`search_effort`, server-side
    // auto-escalation, or the old `start_deep_knowledge_search` tool).
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
      const ks = body.result.tools.find((t) => t.name === "tako_search");
      return ks?.description ?? "";
    }

    const claudeDesc = await descFor("claude-mcp-client/1.0");
    const chatgptDesc = await descFor("ChatGPT/1.0 (+https://chatgpt.com)");
    const unknownDesc = await descFor();

    // Same description regardless of host.
    expect(chatgptDesc).toBe(claudeDesc);
    expect(unknownDesc).toBe(claudeDesc);

    // Promises the inline auto-render and routes the "I just want a written
    // answer" case to tako_answer. The cross-reference is client-agnostic
    // (names the peer data tool, not the ChatGPT-only agent split tools)
    // since this one description string is served verbatim to every host.
    expect(claudeDesc).toContain("auto-renders inline");
    expect(claudeDesc).toContain("tako_answer");

    // No residue from the removed legacy deep/async machinery.
    expect(claudeDesc).not.toContain("auto-escalation");
    expect(claudeDesc).not.toContain("search_effort");
    expect(claudeDesc).not.toContain("start_deep_knowledge_search");
  });

  it("POST /mcp resources/list includes the chart widget bundle (ChatGPT)", async () => {
    // The widget resource registers only for ChatGPT clients — the sole
    // host that renders it (see `widgetSuppressed` in mcp.ts).
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "ChatGPT/1.0 (+https://chatgpt.com)",
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

  it("POST /mcp resources/read returns the widget HTML at the MCP Apps mimeType (ChatGPT)", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "ChatGPT/1.0 (+https://chatgpt.com)",
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

  it("POST /mcp resources/list returns an empty list (not -32601) for unknown clients", async () => {
    // The chart widget resource registers for ChatGPT and Claude clients —
    // the two hosts that render MCP Apps widgets (see `widgetSuppressed`
    // in mcp.ts) — so no `registerResource` call ever happens on an
    // unknown-client server instance — and without this the SDK would
    // never advertise the `resources` capability, turning `resources/list`
    // into a hard -32601 for capability-probing clients (Smithery's scan,
    // some hosts). Mirror of the prompts/list guarantee below.
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "resources/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { resources: unknown[] };
      error?: { code: number };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.resources).toEqual([]);
  });

  it("POST /mcp resources/list includes the chart widget bundle (Claude)", async () => {
    // Claude clients now get the same widget resource registration as
    // ChatGPT (the gate flip in mcp.ts) — claude.ai renders MCP Apps
    // widgets inline in the chat body, unlike its collapsed treatment of
    // `image` content blocks, so the widget resource must be discoverable
    // via `resources/list` for a claude-mcp-client user agent too.
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
        id: 13,
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
  });

  it("POST /mcp prompts/list returns an empty list (not -32601) for capability-probing clients", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { prompts: unknown[] }; error?: { code: number } };
    // Must NOT be JSON-RPC -32601 "Method not found" — that is the warning
    // Smithery's capability scan surfaces. We expose no prompts, so an empty
    // list is the friendly, spec-clean response.
    expect(body.error).toBeUndefined();
    expect(body.result?.prompts).toEqual([]);
  });
});
