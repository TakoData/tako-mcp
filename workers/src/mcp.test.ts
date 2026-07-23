import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
  extractErrorDetail,
} from "./django.js";
import type { Env } from "./env.js";
import { createMcpServer, djangoErrorToToolResult } from "./mcp.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
} from "./tools/__test_helpers.js";
import type { McpClientKind, ToolContext } from "./tools/types.js";

describe("djangoErrorToToolResult", () => {
  // Read tools (tako_search/tako_answer/tako_contents) declare an
  // `outputSchema`. Spec-compliant MCP clients validate ANY
  // `structuredContent` present on a result against that schema — even when
  // `isError: true` — so attaching the error discriminant as
  // `structuredContent` made every Django error get rejected with a generic
  // `-32602` (masking the real failure). The machine-readable detail now
  // rides on `_meta["tako/error"]`, which clients forward but do NOT validate.
  it("omits structuredContent so clients validating against outputSchema don't reject the error", () => {
    const err = new DjangoHttpError({
      path: "/api/v3/search/",
      method: "POST",
      status: 503,
      body: "service unavailable",
    });
    const result = djangoErrorToToolResult(err);
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("maps DjangoUnauthorizedError to kind=unauthorized with status 401", () => {
    const err = new DjangoUnauthorizedError({
      path: "/api/v1/knowledge_search",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result._meta["tako/error"]).toEqual({
      kind: "unauthorized",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 401,
    });
    // No body captured → text stays body-free and `_meta` carries no `body`.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result._meta["tako/error"]).not.toHaveProperty("body");
  });

  it("surfaces a 401 auth-failure body in both _meta and text content", () => {
    const detail = "Invalid token.";
    const body = JSON.stringify({ detail });
    const err = new DjangoUnauthorizedError({
      path: "/api/v3/search/",
      method: "POST",
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "unauthorized",
      path: "/api/v3/search/",
      method: "POST",
      status: 401,
      body,
    });
    // 401 is a 4xx client error → the lifted reason reaches the model text.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
  });

  it("maps DjangoTimeoutError with no status and includes timeoutMs", () => {
    const err = new DjangoTimeoutError({
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "timeout",
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    // No `status` — timeouts have no HTTP status by construction.
    expect(result._meta["tako/error"]).not.toHaveProperty("status");
  });

  it("maps DjangoNotFoundError to kind=not_found with status 404", () => {
    const err = new DjangoNotFoundError({
      path: "/api/v1/charts/missing",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "not_found",
      path: "/api/v1/charts/missing",
      method: "GET",
      status: 404,
    });
    // No body on this construction → nothing spliced, no `body` key.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result._meta["tako/error"]).not.toHaveProperty("body");
  });

  it("surfaces a 404 not-found body in both _meta and text content", () => {
    const detail = "No card found for that URL.";
    const body = JSON.stringify({ detail });
    const err = new DjangoNotFoundError({
      path: "/api/v1/contents/",
      method: "POST",
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "not_found",
      path: "/api/v1/contents/",
      method: "POST",
      status: 404,
      body,
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
  });

  it("maps DjangoBadRequestError and surfaces the response body in both _meta and text content", () => {
    const err = new DjangoBadRequestError({
      path: "/api/v3/search/",
      method: "POST",
      body: '{"query":["this field is required"]}',
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "bad_request",
      path: "/api/v3/search/",
      method: "POST",
      status: 400,
      body: '{"query":["this field is required"]}',
    });
    // A field-keyed DRF validation map is flattened to readable text (which
    // field failed) rather than spliced as raw JSON — the guidance the LLM
    // needs to retry, and not every MCP client surfaces structured detail.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: query: this field is required`,
    });
  });

  it("maps DjangoResponseParseError to kind=response_parse with the 2xx status", () => {
    const err = new DjangoResponseParseError({
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 200,
      cause: new Error("unexpected token"),
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "response_parse",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 200,
    });
  });

  it("maps DjangoHttpError (catch-all) and surfaces the response body in _meta", () => {
    const err = new DjangoHttpError({
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "http",
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    // 5xx SERVER-error body stays in `_meta` only — not spliced into the text
    // content. It carries no LLM-actionable detail and a noisy upstream body
    // (often an HTML error page) would flood the text channel.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result.content[0]?.text).not.toContain("service unavailable");
  });

  it("splices a 403 (protected-source) body into the text content, not just _meta", () => {
    // Regression: a 403 from /api/v1/contents on a protected source used to
    // surface only the opaque "Django returned 403 for POST ..." message,
    // burying the actionable reason in `_meta` where most clients never read
    // it. 4xx CLIENT-error bodies are now spliced into the model-visible text.
    const detail = "Data export is not available for this card (protected source).";
    const body = JSON.stringify({ detail });
    const err = new DjangoHttpError({
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    const result = djangoErrorToToolResult(err);
    // `_meta` keeps the full raw JSON envelope untouched.
    expect(result._meta["tako/error"]).toEqual({
      kind: "http",
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    // The model-visible text carries the lifted `detail` message, not the
    // raw `{"detail": …}` JSON envelope.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
    expect(result.content[0]?.text).toContain("protected source");
    expect(result.content[0]?.text).not.toContain('{"detail"');
  });

  it("does NOT splice a non-JSON 4xx body (e.g. a Cloudflare HTML block page)", () => {
    // A 4xx can carry a raw HTML edge/WAF page (403 block, 429 challenge).
    // It stays on `_meta` for debugging but must not flood the model text —
    // same failure mode the 5xx exclusion guards against, just on a 4xx.
    const body = "<!DOCTYPE html><html><body>Access denied (Error 1020)</body></html>";
    const err = new DjangoHttpError({
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toMatchObject({ status: 403, body });
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result.content[0]?.text).not.toContain("DOCTYPE");
  });
});

describe("extractErrorDetail", () => {
  it("lifts DRF `detail`", () => {
    expect(extractErrorDetail('{"detail":"nope"}')).toBe("nope");
  });
  it("lifts `error`", () => {
    expect(extractErrorDetail('{"error":"boom"}')).toBe("boom");
  });
  it("lifts `message`", () => {
    expect(extractErrorDetail('{"message":"kaboom"}')).toBe("kaboom");
  });
  it("joins a nested list of detail strings", () => {
    expect(extractErrorDetail('{"detail":["a","b"]}')).toBe("a b");
  });
  it("flattens a field-keyed 400 validation map to readable text", () => {
    expect(extractErrorDetail('{"query":["this field is required"]}')).toBe(
      "query: this field is required",
    );
    expect(
      extractErrorDetail('{"query":["required"],"count":["must be an integer"]}'),
    ).toBe("query: required; count: must be an integer");
  });
  it("returns undefined for non-JSON text (e.g. an HTML edge page)", () => {
    expect(extractErrorDetail("service unavailable")).toBeUndefined();
    expect(extractErrorDetail("<html>Access denied</html>")).toBeUndefined();
  });
  it("returns undefined for a truncated (unparseable) JSON body", () => {
    expect(extractErrorDetail('{"detail":"long messag...[truncated]')).toBeUndefined();
  });
  it("returns undefined for a JSON object with no recognised message (bare discriminator)", () => {
    expect(
      extractErrorDetail('{"error_type":"RELEVANT_RESULTS_NOT_FOUND"}'),
    ).toBeUndefined();
  });
});

/**
 * Per-client chart rendering gates in `registerTool`.
 *
 * Two independent gates decide how a chart-bearing tool result renders:
 *
 *   - `widgetSuppressed` — skip the MCP Apps widget (`appUiResource`).
 *     Claude clients keep this ON: claude.ai's widget container clips
 *     the chart iframe, so no widget `_meta` ships there.
 *   - `inlinePngFallbackSuppressed` — skip the `extraContentBlocks`
 *     PNG image content block. Claude clients keep this OFF so charts
 *     render inline as images (claude.ai, Claude desktop, and Claude
 *     Code all render `image` content blocks in-chat, and the model
 *     can see the chart while composing its answer).
 *
 * Exercised end-to-end over an in-memory MCP transport: real server,
 * real tool registration, real `tools/call` — only the upstream
 * Django/PNG `fetch` is stubbed.
 */
describe("chart render gates per client", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  function makeCtx(client: McpClientKind): ToolContext {
    return {
      token: "sk-test",
      env: ENV,
      sendProgress: noopSendProgress,
      client,
    };
  }

  /** A v3 search response whose top card auto-chains the chart widget. */
  function searchResponse(): Response {
    return jsonResponse(200, {
      cards: [
        {
          card_id: "c1",
          title: "US GDP",
          embed_url: "https://trytako.com/embed/c1/",
        },
      ],
      web_results: [],
      request_id: "req-1",
    });
  }

  /**
   * Stand-in chart PNG. `fetchPngContentBlock` validates content-type
   * and size only (not PNG structure), so a tiny body is enough for the
   * image-content-block path. (`fetchImageDataUrlAndDims` — the widget
   * `_meta` path — DOES parse the IHDR and degrades to undefined on
   * this body, which is also fine for these tests.)
   */
  function pngResponse(): Response {
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }

  type ContentBlock = { type: string; [key: string]: unknown };

  /**
   * Spin up the real MCP server for `client`, call `tako_search` over
   * an in-memory transport, and return the raw tool result.
   */
  async function callSearch(
    client: McpClientKind,
  ): Promise<{ content: ContentBlock[]; _meta?: Record<string, unknown> }> {
    const server = createMcpServer(makeCtx(client), { client });
    // The test runtime stubs `ajv` (see vitest.config.ts) — the SDK
    // Client must get the same Workers-safe validator the server uses.
    const mcpClient = new Client(
      { name: "gate-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      return (await mcpClient.callTool({
        name: "tako_search",
        arguments: { query: "US GDP" },
      })) as { content: ContentBlock[]; _meta?: Record<string, unknown> };
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("claude client: chart ships as an inline image content block (widget stays suppressed)", async () => {
    // Call 1: v3 search. Call 2: chart PNG for the image content block.
    mockFetchSequence([searchResponse(), pngResponse()]);

    const result = await callSearch("claude");

    const imageBlocks = result.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]?.mimeType).toBe("image/png");
    expect(typeof imageBlocks[0]?.data).toBe("string");
    expect((imageBlocks[0]?.data as string).length).toBeGreaterThan(0);
    // Widget stays suppressed for claude — no MCP Apps resource URI in
    // the result `_meta` (claude.ai's widget container clips charts).
    expect(
      (result._meta as { ui?: unknown } | undefined)?.ui,
    ).toBeUndefined();
  });

  it("unknown client: chart ships as an inline image content block (no widget metadata)", async () => {
    // Unknown clients are the long tail of MCP hosts (Cursor, Windsurf,
    // Gemini CLI, LibreChat, …). Almost none of them implement the MCP
    // Apps widget spec, but virtually all render `image` content
    // blocks — so they get the same PNG treatment as Claude clients.
    // Call 1: v3 search. Call 2: chart PNG for the image content block.
    mockFetchSequence([searchResponse(), pngResponse()]);

    const result = await callSearch("unknown");

    const imageBlocks = result.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]?.mimeType).toBe("image/png");
    expect(
      (result._meta as { ui?: unknown } | undefined)?.ui,
    ).toBeUndefined();
  });

  it("chatgpt client: widget metadata ships, no image block, and no PNG prefetch", async () => {
    // Exactly ONE response queued: the v3 search. ChatGPT keeps the
    // interactive widget (which loads `embed_url` itself), so neither
    // the image-content-block fetch nor `extraMeta`'s PNG prefetch may
    // fire — `mockFetchSequence` throws loudly on any second call.
    mockFetchSequence([searchResponse()]);

    const result = await callSearch("chatgpt");

    expect(result.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(
      (result._meta as { ui?: unknown } | undefined)?.ui,
    ).toBeDefined();
  });

  it("claude client: no image block when the search returns zero cards", async () => {
    // Empty result → no top card → no image_url → the PNG hook must not
    // fire (queue holds only the search response; an unexpected second
    // fetch would throw loudly).
    mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-2" }),
    ]);

    const result = await callSearch("claude");

    expect(result.content.filter((b) => b.type === "image")).toHaveLength(0);
  });
});

describe("server instructions", () => {
  // The MCP `instructions` field on the `initialize` result is the
  // spec's channel for server-level usage guidance — Claude hosts
  // inject it into the system prompt as "MCP Server Instructions",
  // which is where "prefer tako_search over generic web search" has
  // to live to actually influence tool routing. Tool descriptions
  // alone are too buried in the tool list to win that decision.
  it("advertises tako_search as the preferred route for data questions and a web-search substitute", async () => {
    const ctx: ToolContext = {
      token: "sk-test",
      env: { DJANGO_BASE_URL: "https://staging.trytako.com" },
      sendProgress: noopSendProgress,
      client: "unknown",
    };
    const server = createMcpServer(ctx);
    const mcpClient = new Client(
      { name: "instructions-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const instructions = mcpClient.getInstructions();
      expect(instructions).toBeDefined();
      // Anchor phrases, not exact prose: the copy will be tuned, but it
      // must always name the tool and position it against web search.
      expect(instructions).toContain("tako_search");
      expect(instructions?.toLowerCase()).toContain("web search");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
