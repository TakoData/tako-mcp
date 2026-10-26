import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";
import { SERVER_VERSION } from "./mcp.js";
import { APP_UI_TEMPLATE_NAME, CHART_WIDGET_DESCRIPTION } from "./tools/_chart_widget.js";
import { CHATGPT_CLOSED_WORLD_TOOLS } from "./tools/_surface.js";
import { PLUGIN_TOOL_NAMES } from "../scripts/plugin-tool-url.js";

// Valid RFC 6750 b64token — any non-empty ASCII token works for these tests
// because `extractBearer` only validates shape, not value. Django's the one
// that would reject a bogus token; we mock nothing here and never hit Django.
const TEST_TOKEN = "test-token-abc123";
const AUTH_HEADER = `Bearer ${TEST_TOKEN}`;

interface RpcBody {
  result?: Record<string, unknown>;
  error?: { code: number };
}

async function postRpc(url: string, method: string, params: Record<string, unknown> = {}): Promise<RpcBody> {
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: AUTH_HEADER,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RpcBody;
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "test-client", version: "0.0.0" },
};
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const CLAUDE_PLUGIN_MCP_URL = `https://example.com/mcp?tools=${PLUGIN_TOOL_NAMES.join(",")}`;

interface SkillEntry {
  uri: string;
  resources: Array<{ uri: string; digest: string; size: number }>;
}

async function listSkills(url: string): Promise<SkillEntry[]> {
  const body = await postRpc(url, "skills/list");
  return (body.result as { skills: SkillEntry[] }).skills;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `tools/list` names for one URL, sorted. */
async function listToolNames(url: string): Promise<string[]> {
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: AUTH_HEADER,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((t) => t.name).sort();
}

function postMcp(
  url: string,
  message: { method: string; params?: unknown },
  sessionId?: string,
): Promise<Response> {
  return SELF.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: AUTH_HEADER,
      ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, params: {}, ...message }),
  });
}

function initializeMessage(declaresUi: boolean) {
  return {
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: declaresUi
        ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }
        : {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

async function toolSearchWidgetUri(url: string): Promise<string> {
  const res = await postMcp(url, { method: "tools/list" });
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }> };
  };
  const uri = body.result.tools.find((t) => t.name === "tako_search")?._meta?.ui?.resourceUri;
  expect(uri).toBeTruthy();
  return uri as string;
}

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

    it("GET /mcp/chatgpt returns 405 with Allow: POST (same carve-out)", async () => {
      const res = await SELF.fetch("https://example.com/mcp/chatgpt", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });

    it("POST /mcp/chatgpt reaches the MCP handler; unknown MCP-ish paths 404", async () => {
      const reached = await SELF.fetch("https://example.com/mcp/chatgpt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(reached.status).not.toBe(404);
      const unknown = await SELF.fetch("https://example.com/mcp/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unknown.status).toBe(404);
    });

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

  it("POST /mcp tools/list returns the default tool set", async () => {
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
    // Default listing with NO tools param (spec D3). Opt-in tools appear
    // only when named in ?tools=, which then REPLACES this list.
    expect(names).toEqual([
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
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
      // The top-level `securitySchemes` field is a chatgpt-surface
      // compatibility injection (`withChatGptToolSecuritySchemes`) — the
      // generic surface must NOT carry it.
      expect(
        (t as { securitySchemes?: unknown }).securitySchemes,
      ).toBeUndefined();
      // The generic default surface contains only open-world retrieval tools.
      expect(t.annotations.openWorldHint, t.name).toBe(true);
    }

    // MCP Apps: `/mcp` declares the widget on every connection, so the
    // listing doesn't vary by client. Only the tools that own a widget carry it.
    for (const t of body.result.tools) {
      const meta = t._meta as { ui?: { resourceUri?: string } } | undefined;
      if (t.name === "tako_search") {
        expect(meta?.ui?.resourceUri).toBeTruthy();
      } else {
        expect(meta?.ui, t.name).toBeUndefined();
      }
    }
  });

  it("POST /mcp with visualize in the allowlist declares the widget on tako_visualize", async () => {
    const res = await SELF.fetch(
      "https://example.com/mcp?tools=search,available_data,contents,visualize",
      {
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
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
      };
    };
    const names = new Set(body.result.tools.map((t) => t.name));
    expect(names.has("tako_visualize")).toBe(true);
    // Exactly the four names the allowlist carries — a tool it leaves out is
    // absent even when it is a default.
    expect(names.has("tako_available_data")).toBe(true);
    expect(names.has("tako_agent")).toBe(false);
    expect(body.result.tools).toHaveLength(4);

    const visualizeTool = body.result.tools.find(
      (t) => t.name === "tako_visualize",
    );
    const meta = visualizeTool?._meta as
      | { ui?: { resourceUri?: string } }
      | undefined;
    expect(meta?.ui?.resourceUri).toBeTruthy();
  });

  it("POST /mcp tools/list actually SERVES the web-snippet contract to the client", async () => {
    // End-to-end counterpart to the unit guards in tako_search.test.ts /
    // tako_search_advanced.test.ts. Those assert the wording sits on the advertised zod
    // schema; this asserts it survives `.shape` extraction in mcp.ts and the
    // SDK's zod→JSON-Schema conversion and reaches the wire. Worth a second
    // test because the bug being guarded was precisely a description that
    // existed, read correctly in source, and was served to nobody — it lived
    // on `webResultSchema`, which is the wire-parse guard, not the advertised
    // schema. A unit test on the zod object alone would not have caught the
    // serialization half of that.
    // The allowlist names both tools this test reads: `tako_search_advanced` is
    // opt-in, and naming it REPLACES the defaults, so `tako_search` has to
    // be named too (spec D1).
    const res = await SELF.fetch("https://example.com/mcp?tools=search,search_advanced", {
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
          outputSchema?: {
            properties?: {
              web_results?: {
                description?: string;
                items?: { properties?: { snippet?: { description?: string } } };
              };
            };
          };
        }>;
      };
    };

    // Both search tools serve the TYPED projected element schema, so the
    // contract rides on `snippet` itself (the loose-wrapper fallback covers
    // any tool that has not migrated yet).
    const snippetDescFor = (name: string): string | undefined => {
      const tool = body.result.tools.find((t) => t.name === name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      const web = tool?.outputSchema?.properties?.web_results;
      return web?.items?.properties?.snippet?.description ?? web?.description;
    };
    for (const name of ["tako_search", "tako_search_advanced"]) {
      const desc = snippetDescFor(name);
      // The three things a client cannot infer from a snippet's value alone:
      // it is query-selected rather than the page opening, it may be
      // non-contiguous, and absence is legitimate.
      expect(desc, `${name} serves no snippet contract`).toBeDefined();
      expect(desc).toMatch(/selected against/i);
      expect(desc).toContain(" … ");
      expect(desc).toMatch(/null/);
    }
  });

  it("POST /mcp tools/list serves one client-agnostic tako_search description", async () => {
    // `tako_search` is now fast-only (`/api/v3/search`) with no in-tool
    // deep path, so the per-client description split is gone: every host
    // gets the same description. It promises the inline auto-render and
    // points deep / empty-result follow-ups at the Tako agent; it must NOT
    // mention the removed legacy machinery (`search_effort`, server-side
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

    // Promises the inline chart render. It must NOT reference
    // `tako_search_advanced` — opt-in since spec D1, so naming it would route
    // models to a tool the default connection has not registered.
    expect(claudeDesc).toContain("The first card's chart renders inline");
    expect(claudeDesc).toContain("some hosts also show every other card's chart, in search's order");
    expect(claudeDesc).not.toContain("tako_search_advanced");

    // No residue from the removed legacy deep/async machinery.
    expect(claudeDesc).not.toContain("auto-escalation");
    expect(claudeDesc).not.toContain("search_effort");
    expect(claudeDesc).not.toContain("start_deep_knowledge_search");
  });

  it("POST /mcp/chatgpt resources/list includes the chart widget bundle", async () => {
    // ChatGPT always gets the widget; `/mcp` gets it per connection.
    const res = await SELF.fetch("https://example.com/mcp/chatgpt", {
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
      "openai/widgetDescription": CHART_WIDGET_DESCRIPTION,
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

  it("POST /mcp/chatgpt resources/read returns the widget HTML at the MCP Apps mimeType", async () => {
    const res = await SELF.fetch("https://example.com/mcp/chatgpt", {
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
      "openai/widgetDescription": CHART_WIDGET_DESCRIPTION,
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

  it("POST /mcp/chatgpt resources/templates/list gives the baked chart template its CSP but not the chart widget description", async () => {
    const res = await SELF.fetch("https://example.com/mcp/chatgpt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "resources/templates/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        resourceTemplates: Array<{ name: string; _meta?: Record<string, unknown> }>;
      };
    };
    const template = body.result.resourceTemplates.find((t) => t.name === APP_UI_TEMPLATE_NAME);
    expect(template?._meta).toMatchObject({
      ui: { csp: { frameDomains: ["http://localhost:8000"] } },
    });
    expect(template?._meta).not.toHaveProperty("openai/widgetDescription");
  });

  it("POST /mcp?tools=contents declares no resources capability — a connection with no skill and no widget tool has none to serve", async () => {
    // The capability declaration is the contract, and it must match what the
    // surface can answer. A connection registers the chart widget when it
    // serves a widget tool, and the skills it serves (`skillsForTools` in
    // skills.ts), and the SDK declares `resources` lazily on the first
    // `registerResource` call — so a generic connection that gets neither
    // declares nothing, and a spec-following client never asks.
    const res = await SELF.fetch("https://example.com/mcp?tools=contents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(body.result.capabilities.resources).toBeUndefined();
    // The neighbouring empty-list capability is deliberately NOT symmetric:
    // `prompts` is still declared and still answers `[]`. If that changes,
    // it changes in its own commit.
    expect(body.result.capabilities.prompts).toBeDefined();
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("POST /mcp declares the resources capability — the widget bundle is a real resource", async () => {
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
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(body.result.capabilities.resources).toBeDefined();
    expect(body.result.capabilities.prompts).toBeDefined();
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("POST /mcp/chatgpt DOES declare resources — the widget is a real one", async () => {
    // The other half of the assertion above, and what makes deleting the
    // generic empty-list handlers safe: the declaration follows the widget
    // registration per server instance, so dropping it on one surface cannot
    // take it off the other.
    const res = await SELF.fetch("https://example.com/mcp/chatgpt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 14,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(body.result.capabilities.resources).toBeDefined();
  });

  it("POST /mcp?tools=contents resources/list answers -32601 when the connection gets no skill and no widget tool", async () => {
    // Undeclared capability, so "method not found" is the honest answer. An
    // empty list used to stand here instead, to keep a capability-probing
    // scanner quiet; it made the server advertise `resources` on every
    // connection and never serve one, which an agent-readiness audit scored
    // as the broken capability it was.
    const res = await SELF.fetch("https://example.com/mcp?tools=contents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 15,
        method: "resources/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { resources: unknown[] };
      error?: { code: number };
    };
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32601);
  });

  it("POST /mcp resources/list lists the same resources for claude UAs — the UA changes nothing", async () => {
    // The UA classifier is gone (spec D2): a claude UA on /mcp gets the
    // same generic surface as everyone else, so it lists the same widget
    // bundle and served skill.
    const widgetUri = await toolSearchWidgetUri("https://example.com/mcp");
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
    const body = (await res.json()) as { result?: { resources: Array<{ uri: string }> } };
    const withoutUa = (await postRpc("https://example.com/mcp", "resources/list")).result?.resources;
    expect(body.result?.resources.map((resource) => resource.uri)).toEqual([
      widgetUri,
      "skill://tako-search/SKILL.md",
    ]);
    expect(body.result?.resources).toEqual(withoutUa);
  });

  it("POST /mcp initialize declares the skills extension", async () => {
    const body = await postRpc("https://example.com/mcp", "initialize", INITIALIZE_PARAMS);
    const capabilities = body.result?.capabilities as {
      extensions?: Record<string, unknown>;
      resources?: unknown;
    };
    expect(capabilities.extensions?.[SKILLS_EXTENSION]).toEqual({});
    expect(capabilities.resources).toBeDefined();
  });

  it("POST /mcp?tools=search initialize declares no skills extension", async () => {
    const body = await postRpc("https://example.com/mcp?tools=search", "initialize", INITIALIZE_PARAMS);
    const capabilities = body.result?.capabilities as { extensions?: Record<string, unknown> };
    expect(capabilities.extensions?.[SKILLS_EXTENSION]).toBeUndefined();
  });

  it("POST /mcp?tools=search answers -32601 to the skills methods", async () => {
    const url = "https://example.com/mcp?tools=search";
    expect((await postRpc(url, "skills/list")).error?.code).toBe(-32601);
    expect(
      (await postRpc(url, "skills/get", { uri: "skill://tako-search/SKILL.md" })).error?.code,
    ).toBe(-32601);
  });

  it("POST /mcp resources/list lists exactly the widget bundle and the served skill", async () => {
    const widgetUri = await toolSearchWidgetUri("https://example.com/mcp");
    const resources = (await postRpc("https://example.com/mcp", "resources/list")).result
      ?.resources as Array<{ uri: string }>;
    expect(resources.map((resource) => resource.uri)).toEqual([
      widgetUri,
      "skill://tako-search/SKILL.md",
    ]);
  });

  it("POST /mcp/chatgpt does not serve skills", async () => {
    const url = "https://example.com/mcp/chatgpt";
    const initialized = await postRpc(url, "initialize", INITIALIZE_PARAMS);
    const capabilities = initialized.result?.capabilities as { extensions?: Record<string, unknown> };
    expect(capabilities.extensions?.[SKILLS_EXTENSION]).toBeUndefined();
    expect((await postRpc(url, "skills/list")).error?.code).toBe(-32601);
    expect(
      (await postRpc(url, "skills/get", { uri: "skill://tako-search/SKILL.md" })).error?.code,
    ).toBe(-32601);
    const resources = (await postRpc(url, "resources/list")).result?.resources as Array<{ uri: string }>;
    expect(resources.filter((resource) => resource.uri.startsWith("skill://"))).toEqual([]);
  });

  it("POST /mcp skills/list follows the tools allowlist", async () => {
    const namesAt = async (url: string) =>
      (await listSkills(url)).map((skill) => skill.uri);
    expect(await namesAt("https://example.com/mcp")).toEqual(["skill://tako-search/SKILL.md"]);
    expect(await namesAt(CLAUDE_PLUGIN_MCP_URL)).toEqual([
      "skill://tako-agent/SKILL.md",
      "skill://tako-search/SKILL.md",
    ]);
  });

  it("POST /mcp resources/read matches each listed digest and size", async () => {
    const listed = (await listSkills(CLAUDE_PLUGIN_MCP_URL)).flatMap((skill) => skill.resources);
    expect(listed).toHaveLength(2);
    for (const resource of listed) {
      const body = await postRpc(CLAUDE_PLUGIN_MCP_URL, "resources/read", { uri: resource.uri });
      const contents = body.result?.contents as Array<{ uri: string; text: string }>;
      expect(contents).toHaveLength(1);
      expect(contents[0]?.uri).toBe(resource.uri);
      const bytes = new TextEncoder().encode(contents[0]?.text);
      expect(bytes.byteLength).toBe(resource.size);
      expect(`sha256:${await sha256Hex(bytes)}`).toBe(resource.digest);
    }
  });

  it("POST /mcp resources/list returns the chart widget bundle regardless of the session", async () => {
    const widgetUri = await toolSearchWidgetUri("https://example.com/mcp");
    const withUi = await postMcp("https://example.com/mcp", { method: "resources/list" }, "ui-x");
    const withoutHeader = await postMcp("https://example.com/mcp", { method: "resources/list" });

    expect(await withUi.text()).toBe(await withoutHeader.text());
    const body = (await postMcp("https://example.com/mcp", { method: "resources/list" }, "ui-x").then(
      (r) => r.json(),
    )) as { result: { resources: Array<{ uri: string; mimeType: string }> } };
    const widget = body.result.resources.find((r) => r.uri === widgetUri);
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

describe("MCP Apps session on /mcp", () => {
  it("issues a ui- session ID to an initialize that declares MCP Apps support", async () => {
    const res = await postMcp("https://example.com/mcp", initializeMessage(true));
    expect(res.headers.get("mcp-session-id")).toMatch(/^ui-/);
    expect(res.status).toBe(200);
  });

  it("issues a noui- session ID to an initialize that declares nothing", async () => {
    const res = await postMcp("https://example.com/mcp", initializeMessage(false));
    expect(res.headers.get("mcp-session-id")).toMatch(/^noui-/);
  });

  it("issues no session ID on /mcp/chatgpt", async () => {
    const res = await postMcp("https://example.com/mcp/chatgpt", initializeMessage(true));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists the same tools whatever the session ID", async () => {
    const bodies = await Promise.all(
      ["ui-x", "noui-x", undefined].map(async (id) =>
        (await postMcp("https://example.com/mcp", { method: "tools/list" }, id)).text(),
      ),
    );
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(await toolSearchWidgetUri("https://example.com/mcp")).toBeTruthy();
  });
});
