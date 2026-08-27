import { describe, expect, it } from "vitest";

import {
  authRequiredToolResult,
  securitySchemesForTool,
  withToolSecuritySchemes,
  wwwAuthenticate,
} from "./_security.js";

describe("securitySchemesForTool", () => {
  const OAUTH2 = { type: "oauth2", scopes: ["mcp"] };
  const ANON_GENERIC = { surface: "generic", tier: "free" } as const;

  it("advertises noauth + oauth2 for the free tool on an ANONYMOUS generic listing", () => {
    expect(securitySchemesForTool("tako_search", ANON_GENERIC)).toEqual([
      { type: "noauth" },
      OAUTH2,
    ]);
  });

  it("advertises oauth2 only for auth-required tools, even anonymously", () => {
    for (const name of [
      "tako_answer",
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
      "tako_visualize",
      "tako_agent",
    ]) {
      expect(securitySchemesForTool(name, ANON_GENERIC)).toEqual([OAUTH2]);
    }
  });

  it("never advertises noauth on AUTHENTICATED connections (the caller is already linked)", () => {
    for (const name of ["tako_search", "tako_answer"]) {
      expect(
        securitySchemesForTool(name, { surface: "chatgpt", tier: "authenticated" }),
      ).toEqual([OAUTH2]);
    }
  });

  it("never advertises noauth on the chatgpt surface — it 401s anonymous requests before listing", () => {
    // tier "free" can never be SERVED on /mcp/chatgpt (handleMcpRequest
    // 401s first); this pins the metadata to match the enforcement.
    for (const surface of ["chatgpt"] as const) {
      for (const tier of ["free", "authenticated"] as const) {
        expect(securitySchemesForTool("tako_search", { surface, tier })).toEqual([
          OAUTH2,
        ]);
      }
    }
  });
});

describe("wwwAuthenticate", () => {
  it("carries resource_metadata, scope, error, and error_description", () => {
    expect(
      wwwAuthenticate("https://mcp.tako.com", "invalid_token", "expired"),
    ).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.tako.com/.well-known/oauth-protected-resource", scope="mcp", error_description="expired"',
    );
  });

  it("omits resource_metadata when the origin is unknown", () => {
    expect(wwwAuthenticate(undefined, "insufficient_scope", "sign in")).toBe(
      'Bearer error="insufficient_scope", scope="mcp", error_description="sign in"',
    );
  });

  it("strips double quotes from the description (header-injection guard)", () => {
    expect(wwwAuthenticate(undefined, "invalid_token", 'a "b" c')).toContain(
      "error_description=\"a 'b' c\"",
    );
  });

  it("neutralizes CR/LF, backslashes, and control chars in both error and description", () => {
    const value = wwwAuthenticate(
      undefined,
      "invalid\r\ntoken",
      "bad\r\nX-Evil: 1 trailing\\",
    );
    expect(value).not.toMatch(/[\r\n\\]/);
    // Must be usable as a real HTTP header value — the Workers Headers
    // constructor throws on CR/LF, which would escape as a Worker 500.
    expect(() => new Headers({ "www-authenticate": value })).not.toThrow();
  });
});

describe("authRequiredToolResult", () => {
  it("is an isError result with the mcp/www_authenticate challenge array", () => {
    const result = authRequiredToolResult("https://mcp.tako.com");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/sign in/i);
    const challenges = result._meta["mcp/www_authenticate"] as string[];
    expect(challenges).toHaveLength(1);
    // Both error and error_description are required for ChatGPT to show
    // the sign-in UI (OpenAI Apps SDK auth guide).
    expect(challenges[0]).toContain('error="insufficient_scope"');
    expect(challenges[0]).toContain("error_description=");
    expect(challenges[0]).toContain(
      'resource_metadata="https://mcp.tako.com/.well-known/oauth-protected-resource"',
    );
    expect(result._meta["tako/error"]).toEqual({ kind: "auth_required" });
  });
});

describe("withToolSecuritySchemes", () => {
  // Production's only caller context. `mcp.ts` runs this transformer solely
  // when `surface === "chatgpt"` (see `withChatGptToolSecuritySchemes`), so a
  // `generic` fixture here would assert a wire shape production cannot
  // produce — `securitySchemesForTool` emits `noauth` only on
  // generic + free, which never reaches this function. That per-tool split is
  // covered in the `securitySchemesForTool` describe above, where it IS
  // reachable; this block tests the transformer.
  const ANON_LIST_CTX = { surface: "chatgpt", tier: "free" } as const;
  const listResponse = () => ({
    jsonrpc: "2.0",
    id: 2,
    result: {
      tools: [
        { name: "tako_search", description: "search" },
        { name: "tako_contents", description: "contents" },
      ],
    },
  });

  it("attaches each descriptor the schemes securitySchemesForTool resolves", () => {
    const body = listResponse();
    const out = withToolSecuritySchemes(body, ANON_LIST_CTX) as {
      result: { tools: Array<{ name: string; securitySchemes?: unknown }> };
    };
    // Derived, not hardcoded: this asserts the transformer DELEGATES rather
    // than re-deriving the scheme list, so the two can never disagree.
    for (const tool of out.result.tools) {
      expect(tool.securitySchemes, tool.name).toEqual(
        securitySchemesForTool(tool.name, ANON_LIST_CTX),
      );
    }
    // On the chatgpt surface every tool is OAuth-only — no `noauth` anywhere,
    // which is the property OpenAI's review requires of the submitted surface.
    expect(out.result.tools.map((t) => t.securitySchemes)).toEqual([
      [{ type: "oauth2", scopes: ["mcp"] }],
      [{ type: "oauth2", scopes: ["mcp"] }],
    ]);
  });

  it("never mutates its input (returns a new structure)", () => {
    const body = listResponse();
    const snapshot = JSON.parse(JSON.stringify(body)) as unknown;
    const out = withToolSecuritySchemes(body, ANON_LIST_CTX);
    expect(out).not.toBe(body);
    expect(body).toEqual(snapshot);
  });

  it("returns the original reference for non-tools/list bodies", () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "tako-mcp" } },
    };
    expect(withToolSecuritySchemes(initialize, ANON_LIST_CTX)).toBe(initialize);
    const toolCall = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "hi" }] },
    };
    expect(withToolSecuritySchemes(toolCall, ANON_LIST_CTX)).toBe(toolCall);
    const error = { jsonrpc: "2.0", id: 4, error: { code: -32602 } };
    expect(withToolSecuritySchemes(error, ANON_LIST_CTX)).toBe(error);
    expect(withToolSecuritySchemes(null, ANON_LIST_CTX)).toBe(null);
    expect(withToolSecuritySchemes("nope", ANON_LIST_CTX)).toBe("nope");
  });

  it("leaves malformed tool entries untouched while transforming valid ones", () => {
    const body = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [null, 42, { description: "no name" }, { name: "tako_search" }],
      },
    };
    const out = withToolSecuritySchemes(body, ANON_LIST_CTX) as {
      result: { tools: unknown[] };
    };
    expect(out.result.tools[0]).toBeNull();
    expect(out.result.tools[1]).toBe(42);
    expect(out.result.tools[2]).toEqual({ description: "no name" });
    expect(
      (out.result.tools[3] as { securitySchemes?: unknown }).securitySchemes,
    ).toBeDefined();
  });

  it("replaces a pre-existing securitySchemes with the canonical value", () => {
    const body = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [{ name: "tako_contents", securitySchemes: [{ type: "noauth" }] }],
      },
    };
    const out = withToolSecuritySchemes(body, ANON_LIST_CTX) as {
      result: { tools: Array<{ securitySchemes?: unknown }> };
    };
    expect(out.result.tools[0]?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["mcp"] },
    ]);
  });

  it("returns the original reference for an empty tools array", () => {
    const body = { jsonrpc: "2.0", id: 2, result: { tools: [] } };
    expect(withToolSecuritySchemes(body, ANON_LIST_CTX)).toBe(body);
  });

  it("transforms tools/list messages inside a JSON-RPC batch", () => {
    const other = { jsonrpc: "2.0", id: 1, result: {} };
    const batch = [other, listResponse()];
    const out = withToolSecuritySchemes(batch, ANON_LIST_CTX) as Array<{
      result?: { tools?: Array<{ securitySchemes?: unknown }> };
    }>;
    expect(out).not.toBe(batch);
    expect(out[0]).toBe(other);
    expect(out[1]?.result?.tools?.[0]?.securitySchemes).toBeDefined();
  });
});
