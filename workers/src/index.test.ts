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

  // `/login/password` is wired in `index.ts` but every other test calls
  // `handleLoginPassword` directly, so dropping the dispatch line would leave
  // the whole suite green while password sign-in 404'd in production. The
  // router is exact-match, so what proves wiring is simply that this path does
  // NOT fall through to the catch-all 404.
  describe("POST /login/password is wired into the router", () => {
    it("does not fall through to the catch-all 404", async () => {
      // No OAUTH_*/STYTCH_* secrets in the test env, so the handler's own
      // config gate answers 503 `temporarily_unavailable`. Any non-404 proves
      // dispatch reached the handler.
      const res = await SELF.fetch("https://example.com/login/password", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=e%40t.com&password=pw",
      });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(503);
    });

    it("answers 405 on a GET, before any config gate", async () => {
      // The method check runs first, so this distinguishes "route exists" from
      // "route missing" without depending on secrets at all.
      const res = await SELF.fetch("https://example.com/login/password");
      expect(res.status).toBe(405);
    });
  });

  // The native-card proxy routes, end to end through the router.
  //
  // All other coverage of these two is handler-level in `embed_proxy.test.ts`,
  // which calls the functions directly and therefore cannot catch a WIRING
  // mistake — ordering against the `/mcp` branch, or the fall-through to the
  // catch-all 404. `index.ts` now awaits both on every request that gets past
  // the icon route, so the wiring is worth one assertion of its own.
  //
  // The test environment has no `PUBLIC_CDN_URL`, so this pins the BINDING-ABSENT
  // configuration: local dev, and any env where the switch has been pulled. It is
  // no longer the production configuration — both deployed envs set the binding
  // (`wrangler.jsonc`) — so what this asserts is that the routes are gated on
  // that binding and vanish cleanly without it, not that they are invisible in
  // prod. The live-route properties are covered in `embed_proxy.test.ts` and
  // post-deploy by smoke step 6.
  describe("the native-card proxy routes do not exist without PUBLIC_CDN_URL", () => {
    it("404s /embed-html/{pub_id}", async () => {
      const res = await SELF.fetch(
        "https://example.com/embed-html/VKd7qE8K9Ba16kMFENNQ",
      );
      expect(res.status).toBe(404);
    });

    it("404s /cdn-asset/{path}", async () => {
      const res = await SELF.fetch(
        "https://example.com/cdn-asset/archive/abc/vite_dist/assets/Card.js",
      );
      expect(res.status).toBe(404);
    });

    it("404s their preflights too, rather than advertising CORS", async () => {
      for (const path of [
        "/embed-html/VKd7qE8K9Ba16kMFENNQ",
        "/cdn-asset/archive/abc/Card.js",
      ]) {
        const res = await SELF.fetch(`https://example.com${path}`, {
          method: "OPTIONS",
        });
        expect(res.status, path).toBe(404);
      }
    });

    it("still serves /health and POST /mcp, so the routes are inert not blocking", async () => {
      // Both handlers are awaited ahead of most of the router. A regression that
      // made them throw rather than decline would take the surface below them
      // down with it — see the OAuth blast-radius case in `embed_proxy.test.ts`.
      expect((await SELF.fetch("https://example.com/health")).status).toBe(200);
      const res = await SELF.fetch("https://example.com/mcp", {
        method: "GET",
      });
      expect(res.status).toBe(405);
    });
  });

  // Regression: Cursor tombstoned the transport against production.
  //
  // Streamable HTTP reserves 404-on-a-session-request to mean "this session
  // is gone, re-initialize", and requires 405 from a server that does not
  // offer the optional server->client SSE stream. We run stateless (no
  // Mcp-Session-Id is ever issued) so we genuinely do not offer that
  // stream — but GET /mcp used to fall through to the catch-all 404, so
  // Cursor read it as session death, re-initialized, retried, and after
  // 5 consecutive session-404s disabled the transport permanently:
  //
  //   Failed to open SSE stream
  //   Tombstoning streamable HTTP transport after 5 consecutive
  //   session HTTP 404 responses; automatic retry disabled
  //
  // 405 tells the client "this method is not available here" without
  // implying the session died, which is what Context7 and AWS's remote
  // servers return and why they connect cleanly in Cursor.
  describe("unsupported methods on /mcp return 405, never 404", () => {
    for (const method of ["GET", "DELETE"] as const) {
      it(`${method} /mcp returns 405 with Allow: POST`, async () => {
        const res = await SELF.fetch("https://example.com/mcp", {
          method,
          headers: { accept: "text/event-stream" },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
      });
    }

    it("GET /mcp does not 404 even when a stale Mcp-Session-Id is sent", async () => {
      // A client that had previously been handed a session id (or invented
      // one) must still not be told the session expired.
      const res = await SELF.fetch("https://example.com/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "stale-session-from-a-previous-connection",
        },
      });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(405);
    });
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
        tools: Array<{
          name: string;
          annotations: {
            readOnlyHint: boolean;
            destructiveHint: boolean;
            openWorldHint: boolean;
          };
          _meta?: Record<string, unknown>;
        }>;
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

    // Every runtime tool advertises per-tool auth via _meta, reverse-DNS
    // namespaced per the MCP _meta rules (the only field the SDK preserves).
    // Non-ChatGPT clients keep the pre-existing oauth2-only constant —
    // `noauth` is scoped to anonymous ChatGPT listings only (see
    // securitySchemesForTool), so this authenticated no-UA request shows
    // the same values it always did.
    for (const t of body.result.tools) {
      expect(t._meta?.["com.tako/securitySchemes"]).toEqual([
        { type: "oauth2", scopes: ["mcp"] },
      ]);
      // The top-level `securitySchemes` field is a ChatGPT-only
      // compatibility injection (`withChatGptToolSecuritySchemes`) — this
      // request has no User-Agent, so non-ChatGPT descriptors must NOT
      // carry it.
      expect(
        (t as { securitySchemes?: unknown }).securitySchemes,
      ).toBeUndefined();
      // No User-Agent → client `unknown`, which resolves the ChatGPT
      // override family (see `annotationClientFamily` in
      // tools/_surface.ts): retrieval is closed-world under the Apps
      // reading, so an OpenAI reviewer with an unrecognized UA never sees
      // labels contradicting chatgpt-app-submission.json. Only `claude`
      // retains the canonical MCP open-world meaning.
      expect(t.annotations.openWorldHint).toBe(false);
    }

    // MCP Apps: this request carries no User-Agent, so `detectMcpClient`
    // falls through to "unknown" — the one bucket still denied the chart
    // widget (see `widgetSuppressed` in mcp.ts). ChatGPT and Claude both
    // get the widget now (interactive iframe on ChatGPT, image-branch
    // render on Claude); only the unknown long tail (Cursor, Windsurf,
    // Gemini CLI, …) falls back to the inline PNG `image` content block
    // on tool results, so NO tool in this listing declares widget
    // metadata under any of the three keys. The ChatGPT- and Claude-side
    // widget metadata is asserted in the respective tools/list tests
    // below.
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

  it("POST /mcp tools/list serves ChatGPT the five submitted tools with top-level securitySchemes", async () => {
    // ChatGPT's Apps SDK reads `securitySchemes` at the descriptor TOP
    // LEVEL (developers.openai.com/apps-sdk/build/auth). The MCP SDK
    // drops unknown descriptor fields, so `handleMcpRequest` injects the
    // field into the buffered response for ChatGPT clients only
    // (`withChatGptToolSecuritySchemes`).
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "ChatGPT/1.0",
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
        tools: Array<{
          name: string;
          securitySchemes?: Array<{ type: string; scopes?: string[] }>;
        }>;
      };
    };
    // The default authenticated ChatGPT surface = exactly the five tools
    // chatgpt-app-submission.json declares (visualize is default-on for
    // ChatGPT; the agent pair needs ?tools=agent).
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_contents",
      "tako_search",
      "tako_visualize",
    ]);
    // AUTHENTICATED connection: the caller is already linked, so no tool
    // advertises `noauth` — schemes are per-connection, and advertising
    // anonymous capability to a linked client could invite a host to
    // route calls onto the shared free-tier account. The anonymous
    // (pre-link) listing is where `noauth` appears — asserted in
    // freetier.test.ts.
    const oauth2 = { type: "oauth2", scopes: ["mcp"] };
    for (const t of body.result.tools) {
      expect(t.securitySchemes, t.name).toEqual([oauth2]);
    }
  });

  it("POST /mcp tools/list declares the chart widget _meta for claude clients", async () => {
    // claude.ai loads the widget URI from the `tools/list` registration
    // `_meta`, not from a separate handshake (see the mcp.ts April
    // findings on Claude's Apps loading path) — so registration `_meta`
    // is the load-bearing wire surface for inline charts on claude.ai,
    // same as it is for ChatGPT. This pins `tako_search`'s listing to
    // carry all three widget keys for a claude User-Agent, mirroring the
    // ChatGPT assertion above.
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
    const takoSearchTool = body.result.tools.find(
      (t) => t.name === "tako_search",
    );
    expect(takoSearchTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://tako/embed/chart" },
      "ui/resourceUri": "ui://tako/embed/chart",
      "openai/outputTemplate": "ui://tako/embed/chart",
    });
    // The second widget owner. `tako_visualize` is on Claude's DEFAULT
    // surface (no `?tools=visualize`) precisely so the tool whose entire
    // output is a chart can render that chart inline here — a listing without
    // the widget keys would leave it a link-only tool and defeat the point.
    // Both tools share one `ui://tako/embed/chart` resource; `mcp.ts` dedupes
    // the registration and still wires `_meta` onto each tool.
    const takoVisualizeTool = body.result.tools.find(
      (t) => t.name === "tako_visualize",
    );
    expect(takoVisualizeTool, "tako_visualize must be on claude's default surface").toBeDefined();
    expect(takoVisualizeTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://tako/embed/chart" },
      "ui/resourceUri": "ui://tako/embed/chart",
      "openai/outputTemplate": "ui://tako/embed/chart",
    });
  });

  it("POST /mcp tools/list serves canonical MCP annotations to claude UAs", async () => {
    // `claude` is the one client family that keeps the canonical MCP
    // hint readings — every other family, unknown included, resolves the
    // ChatGPT override set (see `annotationClientFamily` in
    // tools/_surface.ts). Pin the split end-to-end.
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
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          annotations: { openWorldHint: boolean; readOnlyHint: boolean };
        }>;
      };
    };
    // 4 retrieval tools + tako_visualize (default-on for widget clients).
    expect(body.result.tools).toHaveLength(5);
    // The 4 retrieval tools keep the MCP spec's open-world, read-only meaning
    // for claude.
    const retrieval = body.result.tools.filter(
      (t) => t.name !== "tako_visualize",
    );
    expect(retrieval).toHaveLength(4);
    for (const t of retrieval) {
      expect(t.annotations.openWorldHint, t.name).toBe(true);
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
    }
    // And `tako_visualize` keeps the CANONICAL readings on claude — a write
    // (`readOnlyHint: false`) over a closed domain (`openWorldHint: false`,
    // since it renders data the caller already supplied). Its
    // `annotationsByClient.chatgpt` override widens `openWorldHint` to true
    // for Apps review, which reads the hint as "publishes publicly visible
    // state"; that override must NOT leak to claude, which reads it per spec.
    const visualize = body.result.tools.find(
      (t) => t.name === "tako_visualize",
    );
    expect(visualize?.annotations.readOnlyHint).toBe(false);
    expect(visualize?.annotations.openWorldHint).toBe(false);
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
        tools: Array<{
          name: string;
          annotations: {
            readOnlyHint: boolean;
            destructiveHint: boolean;
            openWorldHint: boolean;
          };
          _meta?: Record<string, unknown>;
        }>;
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
    // widget clients (`WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES`) — it powers the widget.
    expect(names.has("tako_visualize")).toBe(true);
    // 4 defaults + tako_visualize (ChatGPT default-on) + the split pair = 7.
    expect(body.result.tools).toHaveLength(7);

    const agentStartTool = body.result.tools.find(
      (t) => t.name === "tako_agent_start",
    );
    expect(agentStartTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    const agentWaitTool = body.result.tools.find(
      (t) => t.name === "tako_agent_wait",
    );
    expect(agentWaitTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    // Registration `_meta` is STATIC per tool, and deliberately so even
    // though a chart-less call cannot use it: a tool descriptor is written
    // once, before any call, so it cannot know whether the next result will
    // carry a card. That is the root of the empty-widget-gap problem — ChatGPT
    // keeps a minimum-height widget card for every mounted widget and ignores
    // the shrink to zero, so a zero-card search left a grey void (reported
    // 2026-08). An earlier revision of this comment claimed the handler threw
    // on empty for ChatGPT to dodge it; it does not, and has not since the
    // zero-result `guidance` path replaced the throw. What covers it now is
    // two-sided: the bundle labels the box it cannot escape (`collapse()` in
    // `_chart_widget.ts`), and the tool RESULT names no ui resource at all
    // when there is no chart (`mcp.test.ts`), which removes the box outright
    // on any host that decides per call rather than per descriptor.
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
      result: {
        tools: Array<{
          name: string;
          annotations: {
            readOnlyHint: boolean;
            destructiveHint: boolean;
            openWorldHint: boolean;
          };
        }>;
      };
    };
    const names = new Set(body.result.tools.map((t) => t.name));
    // The agent is opt-in: without `?tools=agent`, ChatGPT gets neither the
    // split pair nor the single tool.
    expect(names.has("tako_agent_start")).toBe(false);
    expect(names.has("tako_agent_wait")).toBe(false);
    expect(names.has("tako_agent")).toBe(false);
    expect(names.has("tako_search")).toBe(true);
    // `tako_visualize` IS present without opting in — ChatGPT keeps it on
    // the default surface (`WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES`) for the widget.
    expect(names.has("tako_visualize")).toBe(true);
    // The other opt-in tools stay absent for ChatGPT too; the default
    // discovery tool is present.
    expect(names.has("tako_available_data")).toBe(true);
    expect(names.has("get_credit_balance")).toBe(false);
    // 4 defaults + tako_visualize = 5.
    expect(body.result.tools).toHaveLength(5);

    for (const tool of body.result.tools) {
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations.openWorldHint, tool.name).toBe(
        tool.name === "tako_visualize",
      );
      expect(tool.annotations.readOnlyHint, tool.name).toBe(
        tool.name !== "tako_visualize",
      );
    }

    // The widget ships on ChatGPT (and Claude — see the claude tools/list
    // test above), so `tako_visualize`'s listing must declare the chart
    // resource under all three metadata keys:
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
    // Not `tako_visualize`: this is a claude UA, and visualize is default-on
    // for widget clients (`WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES`), so its
    // presence here says nothing about the alias. `credits` is the honest
    // check that the alias widened nothing beyond the agent.
    expect(names.has("get_credit_balance")).toBe(false);
    // 4 defaults + tako_visualize (widget client) + tako_agent = 6.
    expect(body.result.tools).toHaveLength(6);
  });

  it("POST /mcp?tools=<unknown> ignores the bad value and serves the default 4 tools", async () => {
    // A typo (or any unrecognized alias) in `?tools=` must never break the
    // connection: unknown tokens are dropped, no optional tool is enabled, and
    // the request layer still returns exactly the 4 defaults. This guards the
    // parser's "unknown token is never fatal" promise end-to-end.
    //
    // Deliberately a NON-widget UA: `tako_visualize` is default-on for
    // chatgpt/claude, so on those clients "exactly the 4 defaults" is not the
    // right expectation and the count would stop testing the parser.
    const res = await SELF.fetch("https://example.com/mcp?tools=nope", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
        "user-agent": "cursor-vscode/1.0",
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
    // No User-Agent → client "unknown", the one bucket still denied the
    // widget (see `widgetSuppressed` in mcp.ts — ChatGPT and Claude both
    // get it). Unknown clients render the chart via the inline PNG image
    // content block on tool results instead, so the listing must NOT
    // declare widget metadata.
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

    // Widget metadata ships for ChatGPT and Claude only — the
    // unknown-client listing carries none of the three widget keys (the
    // ChatGPT default-surface and claude tools/list tests assert their
    // presence there).
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
    // Other opt-ins stay off. `tako_visualize` is excluded from this check:
    // the UA is claude, where it is default-on for widget clients.
    expect(names.has("tako_agent")).toBe(false);
    expect(names.has("get_credit_balance")).toBe(false);
    // 4 defaults + tako_visualize (widget client) + the 3 graph primitives = 8.
    expect(body.result.tools).toHaveLength(8);
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

  it("POST /mcp tools/list actually SERVES the web-snippet contract to the client", async () => {
    // End-to-end counterpart to the unit guards in tako_search.test.ts /
    // tako_answer.test.ts. Those assert the wording sits on the advertised zod
    // schema; this asserts it survives `.shape` extraction in mcp.ts and the
    // SDK's zod→JSON-Schema conversion and reaches the wire. Worth a second
    // test because the bug being guarded was precisely a description that
    // existed, read correctly in source, and was served to nobody — it lived
    // on `webResultSchema`, which is the wire-parse guard, not the advertised
    // schema. A unit test on the zod object alone would not have caught the
    // serialization half of that.
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }),
    });
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          outputSchema?: { properties?: { web_results?: { description?: string } } };
        }>;
      };
    };

    for (const name of ["tako_search", "tako_answer"]) {
      const tool = body.result.tools.find((t) => t.name === name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      const desc = tool?.outputSchema?.properties?.web_results?.description;
      // The three things a client cannot infer from a snippet's value alone:
      // it is query-selected rather than the page opening, it may be
      // non-contiguous, and absence is legitimate.
      expect(desc, `${name} serves no web_results description`).toBeDefined();
      expect(desc).toMatch(/selected against/i);
      expect(desc).toContain(" … ");
      expect(desc).toMatch(/null/);
    }
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
    // The widget resource registers for ChatGPT here; the Claude
    // registration is asserted separately below (see `widgetSuppressed`
    // in mcp.ts — unknown clients are the only ones that don't get it).
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
    // Pin `resourceDomains` present for ChatGPT explicitly. This is the
    // one ADDITIVE change to ChatGPT's wire surface in the Claude-widget
    // rollout (`csp` is built client-agnostically); `toMatchObject` above
    // passes whether or not the key exists, so without this assertion a
    // regression that drops it — or a strict-validating Apps SDK build
    // that would reject it — has no test signal.
    const chatgptResourceDomains = (
      widget?._meta as { ui?: { csp?: { resourceDomains?: unknown } } }
    )?.ui?.csp?.resourceDomains;
    expect(Array.isArray(chatgptResourceDomains)).toBe(true);
    expect((chatgptResourceDomains as string[]).length).toBeGreaterThan(0);
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
    // CSP-allowed iframe domain mirrors `resolvePublicBase(env)` (which in
    // tests resolves to `DJANGO_BASE_URL` / `http://localhost:8000`). The
    // server declares this identically for every client — Claude clients
    // don't get a restricted `frameDomains` list; claude.ai's own
    // host-side sandbox is what blocks the iframe, not this metadata.
    expect(widget?._meta).toMatchObject({
      ui: { csp: { frameDomains: ["http://localhost:8000"] } },
    });
    // `resourceDomains` allow-lists the origins the image-branch fallback
    // is permitted to fetch/embed from (the remote `image_url` and the
    // server-fetched `image_data_url`) — must be a non-empty array of
    // valid origins (staging/production always resolve to `https://`;
    // the local test config's `DJANGO_BASE_URL` is `http://localhost:8000`,
    // same as the `frameDomains` assertion above).
    const resourceDomains = (
      widget?._meta as { ui?: { csp?: { resourceDomains?: unknown } } }
    )?.ui?.csp?.resourceDomains;
    expect(Array.isArray(resourceDomains)).toBe(true);
    expect((resourceDomains as string[]).length).toBeGreaterThan(0);
    for (const origin of resourceDomains as string[]) {
      expect(origin).toMatch(/^https?:\/\//);
    }
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
