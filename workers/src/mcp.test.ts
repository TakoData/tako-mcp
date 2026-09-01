import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
import { FREE_TIER_TOOL_NAMES, resolveToolSet } from "./tools/_surface.js";
import {
  SERVER_INSTRUCTIONS,
} from "./instructions.js";
import {
  AUTH_INVALID_MESSAGE,
  createMcpServer,
  djangoErrorToToolResult,
  GENERIC_SIGN_IN_HINT,
  logSdkValidationRejections,
  PAYMENT_REQUIRED_MESSAGE,
  PAYMENT_REQUIRED_REMEDY_FALLBACK,
  paymentRequiredToolResult,
  structuredContentFor,
  withChatGptToolSecuritySchemes,
} from "./mcp.js";
import type { Surface } from "./surface.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import { toolAnnotationsForSurface } from "./tools/_surface.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  TIER_CLAIM,
} from "./tools/__test_helpers.js";
import type { ToolContext } from "./tools/types.js";

describe("toolAnnotationsForSurface", () => {
  it("preserves the canonical MCP annotations on the generic surface", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(toolAnnotationsForSurface(tool, "generic")).toEqual(
        tool.annotations,
      );
    }
  });

  it("uses OpenAI Apps review semantics for chatgpt descriptors", () => {
    for (const tool of TOOL_REGISTRY) {
      const annotations = toolAnnotationsForSurface(tool, "chatgpt");
      expect(annotations.destructiveHint, tool.name).toBe(false);
      // `tako_visualize` mints a publicly reachable card URL — the one
      // tool Apps review reads as publishing state (`openWorldHint:
      // true` + `readOnlyHint: false`); retrieval tools stay read-only.
      expect(annotations.openWorldHint, tool.name).toBe(
        tool.name === "tako_visualize",
      );
    }
    for (const name of [
      "tako_search",
      "tako_search_advanced",
      "tako_available_data",
      "tako_contents",
    ]) {
      expect(
        toolAnnotationsForSurface(
          TOOL_REGISTRY.find((tool) => tool.name === name)!,
          "chatgpt",
        ).readOnlyHint,
        name,
      ).toBe(true);
    }
    for (const name of ["tako_visualize", "tako_agent"]) {
      expect(
        toolAnnotationsForSurface(
          TOOL_REGISTRY.find((tool) => tool.name === name)!,
          "chatgpt",
        ).readOnlyHint,
        name,
      ).toBe(false);
    }
  });
});

describe("djangoErrorToToolResult", () => {
  // Read tools (tako_search/tako_search_advanced/tako_contents) declare an
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
    expect(result.content[0]?.text).toContain(err.message);
    expect(result.content[0]?.text).not.toContain("service unavailable");
    // 503 is transient: the model is told to retry the same call rather than
    // read it as a permanent failure and abandon the tool.
    expect(result.content[0]?.text).toContain("retry the SAME call once");
  });

  it("a Django timeout carries the transient-retry sentence", () => {
    const result = djangoErrorToToolResult(
      new DjangoTimeoutError({
        path: "/api/v1/answer/",
        method: "POST",
        timeoutMs: 130000,
      }),
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("timed out");
    expect(text).toContain("transient upstream condition");
  });

  it("does NOT invite a retry on a non-transient 5xx", () => {
    // 500 specifically: usually a handler crash the same input reproduces,
    // not an infrastructure fault — see RETRYABLE_STATUS's comment.
    const err = new DjangoHttpError({
      path: "/api/v1/whatever", method: "GET", status: 500, body: "boom",
    });
    const text = djangoErrorToToolResult(err).content[0]?.text ?? "";
    expect(text).toBe(err.message);
    expect(text).not.toContain("retry");
  });

  it("leaves a handler's own modelGuidance untouched", () => {
    // tako_contents' self-correcting 403 text is already actionable; appending
    // a generic retry line would contradict "fall back, don't retry".
    const err = new DjangoHttpError({
      path: "/api/v1/contents", method: "POST", status: 503, body: "x",
    });
    err.modelGuidance = "Fall back to the card preview; do not retry.";
    expect(djangoErrorToToolResult(err).content[0]?.text).toBe(
      "Fall back to the card preview; do not retry.",
    );
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
 *     ChatGPT and Claude clients both keep this OFF now: claude.ai
 *     renders MCP Apps widgets inline in the chat body via the image
 *     branch (claude.ai's own outer CSP ignores our `frameDomains`
 *     declaration, so the bundle's runtime `window.openai` check falls
 *     back from iframe to image there), so both get widget `_meta`.
 *     Unknown clients keep it ON — the long tail of MCP hosts rarely
 *     implements MCP Apps.
 *   - `inlinePngFallbackSuppressed` — skip the `extraContentBlocks`
 *     PNG image content block. Attaching the widget (`ui !== undefined`)
 *     already suppresses this hook, and only the chatgpt surface attaches
 *     one — so the GENERIC surface is what renders `image` content blocks
 *     in-chat, for every client on it.
 *
 * Exercised end-to-end over an in-memory MCP transport: real server,
 * real tool registration, real `tools/call` — only the upstream
 * Django/PNG `fetch` is stubbed.
 */
describe("chart render gates per surface", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  function makeCtx(surface: Surface): ToolContext {
    return {
      token: "sk-test",
      env: ENV,
      sendProgress: noopSendProgress,
      surface,
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
    surface: Surface,
  ): Promise<{
    content: ContentBlock[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }> {
    const server = createMcpServer(makeCtx(surface), { surface });
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

  /**
   * 1x1 transparent PNG — a REAL PNG (valid IHDR), because the widget
   * `_meta` path (`fetchImageDataUrlAndDims`) parses dimensions and
   * degrades to undefined on a bare signature.
   */
  function realPngResponse(): Response {
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }

  it("generic surface: chart ships as an inline image content block (no widget metadata)", async () => {
    // The generic surface serves the long tail of MCP hosts (Cursor,
    // Windsurf, Gemini CLI, LibreChat, claude.ai, Claude Code, …).
    // Almost none of them implement the MCP Apps widget spec, but
    // virtually all render `image` content blocks — so the generic
    // surface ships the portable PNG (spec D14/D15; the claude.ai widget
    // is a fast-follow gated on anthropics/claude-ai-mcp#753 and #40).
    // Call 1: v3 search. Call 2: chart PNG for the image content block.
    mockFetchSequence([searchResponse(), pngResponse()]);

    const result = await callSearch("generic");

    const imageBlocks = result.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]?.mimeType).toBe("image/png");
    expect(
      (result._meta as { ui?: unknown } | undefined)?.ui,
    ).toBeUndefined();
  });

  it("chatgpt surface: widget metadata ships, no image block, dimensions-only PNG read", async () => {
    // Widget `_meta`, no image content block, and a RANGED dimensions
    // read instead of the full PNG bake.
    //
    // An earlier shape of this test queued ONE response and relied on
    // `mockFetchSequence`'s queue-exhaustion throw to pin "no PNG
    // prefetch" — but the top card carries an `image_url`, so
    // `extraMeta` DOES fetch (the ranged `fetchPngDimensions`), and the
    // throw was swallowed by that helper's catch and again by mcp.ts's
    // `extraMeta` catch: a revert to the full-bake path stayed green
    // (round-3 review finding on PR #239). So the second fetch is
    // queued and asserted: exactly two calls, and the PNG one carries a
    // Range header — a full `fetchImageDataUrlAndDims` bake reads the
    // whole body and sends none.
    const fetchMock = mockFetchSequence([
      searchResponse(),
      new Response(new Uint8Array(64), {
        status: 206,
        headers: { "content-type": "image/png" },
      }),
    ]);

    const result = await callSearch("chatgpt");

    expect(result.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(
      (result._meta as { ui?: unknown } | undefined)?.ui,
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pngRequest = new Request(...(fetchMock.mock.calls[1] as [RequestInfo, RequestInit?]));
    expect(pngRequest.url).toContain("/api/v1/image/");
    expect(pngRequest.headers.get("range")).not.toBeNull();
  });

  it("generic surface: no image block when the search returns zero cards", async () => {
    // Empty result → no top card → no image_url → `extraMeta`'s PNG
    // prefetch must not fire (queue holds only the search response; an
    // unexpected second fetch would throw loudly) and no image content
    // block ships either — both hold with the widget path too.
    mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-2" }),
    ]);

    const result = await callSearch("generic");

    expect(result.content.filter((b) => b.type === "image")).toHaveLength(0);
    // The zero-result guidance must survive the SDK round trip: it is
    // declared in the tool's published outputSchema, so `structuredContent` keeps it
    // (an undeclared key would be silently stripped by the SDK's
    // outputSchema parse — this pins schema and builder together).
    expect(
      (result.structuredContent as { guidance?: string }).guidance,
    ).toMatch(/tako_available_data/);
  });

  it("a chart-less result references no ui resource at all", async () => {
    // The result-side half of the empty-widget fix. A zero-card call has
    // nothing to render, so it must not point at a widget: a host that decides
    // per RESULT then mounts nothing, and no empty card appears.
    //
    // This does NOT reach ChatGPT or claude.ai — both read the widget URI from
    // `tools/list` registration `_meta`, which is static per tool and stays
    // declared (asserted in index.test.ts). Their empty card is handled inside
    // the bundle, by the labelled empty state. This is for spec-compliant hosts
    // that honour the per-call reference, and it is the only lever that removes
    // the box rather than dressing it.
    mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-3" }),
    ]);

    const result = await callSearch("generic");

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.ui).toBeUndefined();
    expect(meta?.["ui/resourceUri"]).toBeUndefined();
  });

  it("a chart-bearing result still points at its baked per-chart widget (chatgpt)", async () => {
    // The other side of the same branch: declining to reference a resource on
    // an empty result must not cost the populated one its per-pub_id URI.
    // (Two fetches: search + the ranged dimensions read.)
    mockFetchSequence([
      searchResponse(),
      new Response(new Uint8Array(64), {
        status: 206,
        headers: { "content-type": "image/png" },
      }),
    ]);

    const result = await callSearch("chatgpt");

    const meta = result._meta as
      | { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
      | undefined;
    expect(meta?.ui?.resourceUri).toBe("ui://tako/embed/chart/c1");
    expect(meta?.["ui/resourceUri"]).toBe("ui://tako/embed/chart/c1");
  });

  /**
   * The full surface × has-chart matrix for the resource reference. Every
   * cell is asserted, so a change that helps one surface at the other's
   * expense fails here rather than in someone's chat window.
   *
   *                 chart          no chart
   *   chatgpt       per-pub_id     absent
   *   generic       absent         absent   ← no widget; PNG block instead
   *
   * The `generic` row is the load-bearing one for "nothing else
   * regressed": that surface never reaches the resolver at all
   * (`widgetSuppressed` leaves `ui` undefined in `registerTool`), so the
   * branch cannot touch the long tail of MCP hosts even in principle.
   */
  it("references a widget per surface and per result, and never on generic", async () => {
    const uiOf = (result: { _meta?: Record<string, unknown> }) =>
      (result._meta as { ui?: { resourceUri?: string } } | undefined)?.ui
        ?.resourceUri;

    // chatgpt, chart present: keeps its reference. (Two fetches: search +
    // the ranged dimensions read.)
    mockFetchSequence([
      searchResponse(),
      new Response(new Uint8Array(64), {
        status: 206,
        headers: { "content-type": "image/png" },
      }),
    ]);
    expect(uiOf(await callSearch("chatgpt"))).toBe("ui://tako/embed/chart/c1");

    // chatgpt, no chart: no reference. The registration `_meta` still carries
    // `openai/outputTemplate`, so ChatGPT mounts anyway and the bundle's empty
    // state is what covers it — see chatgpt-path.test.ts.
    mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-4" }),
    ]);
    expect(uiOf(await callSearch("chatgpt"))).toBeUndefined();

    // generic, chart present: no widget reference ever, and the PNG content
    // block instead — the portable path, untouched by this branch.
    mockFetchSequence([searchResponse(), pngResponse()]);
    const genericWithChart = await callSearch("generic");
    expect(uiOf(genericWithChart)).toBeUndefined();
    expect(
      genericWithChart.content.filter((b) => b.type === "image"),
    ).toHaveLength(1);

    // generic, no chart: no reference, no image block, and no second fetch
    // (no image_url to fetch) — nothing to render and nothing attempted.
    mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-5" }),
    ]);
    const genericEmpty = await callSearch("generic");
    expect(uiOf(genericEmpty)).toBeUndefined();
    expect(genericEmpty.content.filter((b) => b.type === "image")).toHaveLength(
      0,
    );
  });
});

describe("server instructions", () => {
  // The MCP `instructions` field on the `initialize` result is the
  // spec's channel for server-level usage guidance — Claude hosts
  // inject it into the system prompt as "MCP Server Instructions",
  // which is where "prefer tako_search over generic web search" has
  // to live to actually influence tool routing. Tool descriptions
  // alone are too buried in the tool list to win that decision.
  it("advertises the one-call web+data capability and names tako_search", async () => {
    const ctx: ToolContext = {
      token: "sk-test",
      env: { DJANGO_BASE_URL: "https://staging.trytako.com" },
      sendProgress: noopSendProgress,
      surface: "generic",
    };
    const server = createMcpServer(ctx, { surface: "generic" });
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
      // must always name the tool and carry the one-call capability claim.
      // The substitution line ("instead of a separate web search") was
      // REMOVED deliberately (Jay, 2026-08-30) — do not reassert it.
      expect(instructions).toContain("tako_search");
      expect(instructions?.toLowerCase()).toContain("searches the web");
      expect(instructions?.toLowerCase()).toContain("in the same call");
      // Authenticated connections (the default) keep the canonical
      // instructions byte-identical — the free-tier variant must never
      // leak to existing integrations.
      expect(instructions).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("anonymous connections get the SAME instructions as authenticated ones", async () => {
    // The host loads `instructions` once at `initialize` and nothing
    // guarantees it re-reads them after a mid-conversation sign-in, so an
    // anonymous variant ("X and Y are the tools that run here") would keep
    // steering a now-signed-in model away from the tools sign-in unlocked,
    // and would break the prompt cache at the boundary. What runs anonymously
    // is answered at dispatch (`authRequiredToolResult`, tested below), never
    // in cached prose.
    const ctx: ToolContext = {
      token: "free-tier-key",
      env: { DJANGO_BASE_URL: "https://staging.trytako.com" },
      sendProgress: noopSendProgress,
      surface: "generic",
      tier: "free",
    };
    const server = createMcpServer(ctx, { surface: "generic", tier: "free" });
    const mcpClient = new Client(
      { name: "instructions-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      expect(mcpClient.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  // AT THE CALLER, deliberately. `phantom_tool.test.ts` calls
  // `serverInstructionsFor(resolved)` directly, so it proves the
  // FUNCTION filters — it says nothing about whether `createMcpServer` passes
  // the resolved set in. Delete the `resolveToolSet(...)` argument in `mcp.ts`
  // and every other test in this repo still passes, because both instruction
  // cases above build a default-listing server. This one drives the real
  // constructor with a `?tools=` allowlist and reads the string back off the
  // client, which is the only path a host actually sees.
  it("a ?tools= connection gets instructions filtered to what it registers", async () => {
    const ctx: ToolContext = {
      token: "sk-test",
      env: { DJANGO_BASE_URL: "https://staging.trytako.com" },
      sendProgress: noopSendProgress,
      surface: "generic",
    };
    const requestedToolNames = new Set(["tako_agent"]);
    const server = createMcpServer(ctx, { surface: "generic", requestedToolNames });
    const mcpClient = new Client(
      { name: "instructions-allowlist-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const instructions = mcpClient.getInstructions();
      expect(instructions).toBeDefined();
      const registered = resolveToolSet("generic", requestedToolNames);
      // Every tool the served string names must be one this connection can
      // call. `?tools=agent` registers exactly `tako_agent`, so the three
      // tools the default instructions name must all be gone.
      for (const name of TOOL_REGISTRY.map((t) => t.name)) {
        if (registered.has(name)) continue;
        expect(instructions, `instructions name ${name}, which ?tools=agent does not register`)
          .not.toContain(name);
      }
      // Filtered, not emptied — the routing guidance that makes a host reach
      // for Tako at all lives in the shared paragraph and must survive.
      expect(instructions).toContain("knowledge graph of live structured data");
      expect(instructions).not.toBe(SERVER_INSTRUCTIONS);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

describe("free-tier tool surface", () => {
  const ctx: ToolContext = {
    token: "free-tier-key",
    env: { DJANGO_BASE_URL: "http://localhost:8000" } as Env,
    sendProgress: noopSendProgress,
    surface: "generic",
  };

  /** List tool names over an in-memory transport for the given options. */
  async function listToolNames(
    options: Partial<Parameters<typeof createMcpServer>[1]>,
  ): Promise<string[]> {
    const server = createMcpServer(ctx, {
      ...options,
      surface: options?.surface ?? "generic",
    });
    const mcpClient = new Client(
      { name: "tier-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const { tools } = await mcpClient.listTools();
      return tools.map((t) => t.name).sort();
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  it("the LISTING is auth-invariant: tier 'free' lists the same default surface (spec D4)", async () => {
    // tako_contents is LISTED anonymously — not runnable: the dispatch
    // gate answers with sign-in instructions (tested below) instead of
    // executing on the shared free-tier account.
    const expected = [
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
      "tako_search",
    ];
    await expect(listToolNames({ tier: "free" })).resolves.toEqual(expected);
    await expect(listToolNames({})).resolves.toEqual(expected);
  });

  it("a ?tools= allowlist lists identically on both tiers — execution, not listing, is what the tier gates", async () => {
    // The allowlist REPLACES the defaults (spec D1), so the listing is
    // exactly what it names.
    const optIns = new Set(["tako_agent", "tako_visualize"]);
    const expected = ["tako_agent", "tako_visualize"];
    await expect(
      listToolNames({ tier: "free", requestedToolNames: optIns }),
    ).resolves.toEqual(expected);
    await expect(
      listToolNames({ requestedToolNames: optIns }),
    ).resolves.toEqual(expected);
  });

  it("the chatgpt surface serves the fixed five-tool set", async () => {
    await expect(listToolNames({ surface: "chatgpt" })).resolves.toEqual([
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
      "tako_search",
      "tako_visualize",
    ]);
  });
});

describe("auth challenges (ChatGPT link-account flow)", () => {
  type ToolResult = {
    content: Array<{ type: string; text?: string }>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  };

  /**
   * Spin up the real MCP server and invoke one tool over an in-memory
   * transport, returning the raw tool result.
   */
  async function callTool(
    options: Partial<Parameters<typeof createMcpServer>[1]>,
    name: string,
    args: Record<string, unknown>,
    tier?: "free" | "authenticated",
  ): Promise<ToolResult> {
    const ctx: ToolContext = {
      token: "sk-test",
      env: { DJANGO_BASE_URL: "https://staging.trytako.com" } as Env,
      sendProgress: noopSendProgress,
      surface: options?.surface ?? "generic",
      ...(tier !== undefined ? { tier } : {}),
    };
    const server = createMcpServer(ctx, {
      ...options,
      surface: options?.surface ?? "generic",
    });
    const mcpClient = new Client(
      { name: "auth-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      return (await mcpClient.callTool({
        name,
        arguments: args,
      })) as ToolResult;
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Two listed-but-auth-required shapes, each with schema-valid arguments
  // so the call reaches the dispatch gate (the SDK validates input BEFORE
  // the gate — invalid args return -32602 instead): tako_contents is on
  // the default generic listing (spec D6); tako_visualize is opt-in. Note
  // the allowlist below names BOTH: `?tools=visualize` alone would replace
  // the defaults and drop tako_contents (spec D1).
  it.each([
    ["tako_contents", { urls: ["https://trytako.com/card/abc123"] }],
    [
      "tako_visualize",
      {
        components: [
          { component_type: "header", config: { title: "Revenue" } },
        ],
      },
    ],
    // tako_graph_related became DEFAULT-listed in the allowlist pass, so it is
    // listed on the anonymous surface (the listing is auth-invariant, spec D4)
    // but remains outside FREE_TIER_TOOL_NAMES and owes the same sign-in result.
    // Covered here rather than only in `scripts/smoke.ts`, which needs a
    // deployed target with free-tier bindings — `wrangler dev` has none, so
    // its anonymous block skips and the assertion never runs locally.
    ["tako_graph_related", { node_id: "ent::anthropic::1" }],
    // tako_available_data left FREE_TIER_TOOL_NAMES: one call fans out into
    // up to ~9 graph requests against the shared account's 180/minute
    // per-user graph limit (`_surface.ts`). Same sign-in result as the rest.
    ["tako_available_data", { q: "Anthropic" }],
  ] as const)(
    "anonymous generic call to %s returns the www_authenticate challenge WITHOUT executing",
    async (name, args) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await callTool(
        {
          tier: "free",
          surface: "generic",
          requestedToolNames: new Set([
            "tako_visualize",
            "tako_contents",
            "tako_graph_related",
            "tako_available_data",
          ]),
          requestOrigin: "https://mcp.example.com",
        },
        name,
        args as unknown as Record<string, unknown>,
        "free",
      );
      expect(result.isError).toBe(true);
      // The handler must never run on the shared free-tier account: no
      // Django call, no spend, no data exposure.
      expect(fetchMock).not.toHaveBeenCalled();
      // The model-visible text carries the generic sign-in hint (spec
      // D17) — one sentence, every client.
      const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
      expect(text.endsWith(GENERIC_SIGN_IN_HINT)).toBe(true);
      const challenges = result._meta?.["mcp/www_authenticate"] as string[];
      expect(challenges).toHaveLength(1);
      expect(challenges[0]).toContain('error="insufficient_scope"');
      expect(challenges[0]).toContain(
        'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      );
      expect(challenges[0]).toContain("error_description=");
    },
  );

  it("anonymous tako_search executes — it has no refusable input left", async () => {
    // The D4 split removed `include_contents`, which was the ONE input the
    // anonymous tier refused: every row it inlined billed per 1k against the
    // shared free-tier account.
    // Rows now come from tako_contents, which is auth-required outright, so
    // tako_search is unconditionally free-tier executable and the whole
    // `anonymousInputRejects` path is unused. `freetier.test.ts` covers the
    // metering half: with no gate declared, every anonymous tako_search meters.
    const okFetch = vi.fn(async () =>
      jsonResponse(200, { cards: [], web_results: [], request_id: "r-anon" }),
    );
    vi.stubGlobal("fetch", okFetch);
    const result = await callTool(
      { tier: "free", requestOrigin: "https://mcp.example.com" },
      "tako_search",
      { query: "US GDP" },
      "free",
    );
    expect(result.isError).not.toBe(true);
    expect(okFetch).toHaveBeenCalled();
    expect(
      (result._meta?.["tako/error"] as { kind?: string } | undefined)?.kind,
    ).not.toBe("auth_required");
  });

  it("a tier set ONLY on ToolContext still engages the dispatch gate (fail-closed default)", async () => {
    // Regression guard for the gate's input resolution: a future call
    // site that declares the tier on ctx but forgets options.tier must
    // not silently get the permissive default (PR #183 review finding) —
    // createMcpServer resolves options.tier ?? ctx.tier.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool(
      { requestOrigin: "https://mcp.example.com" },
      "tako_contents",
      { urls: ["https://trytako.com/card/abc123"] },
      "free", // ctx.tier only — options.tier deliberately omitted
    );
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      result._meta?.["mcp/www_authenticate"] as string[] | undefined,
    ).toHaveLength(1);
  });

  it("authenticated calls to auth-required tools execute without a challenge", async () => {
    // Regression guard for the dispatch gate's complement: a linked
    // (authenticated) connection must reach the real handler — a gate
    // keyed on the wrong tier source would block paying users on the two
    // submitted tools. The mocked 200 body doesn't match the contents
    // wire shape, so the handler may still map an error result; the
    // assertions that matter are "Django WAS called" and "no challenge".
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { title: "t", content: "c" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool(
      { requestOrigin: "https://mcp.example.com" },
      "tako_contents",
      { urls: ["https://trytako.com/card/abc123"] },
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });

  it("anonymous calls to free tools still execute (no challenge)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { cards: [], web_results: [], request_id: "r1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool(
      { tier: "free" },
      "tako_search",
      { query: "US GDP" },
      "free",
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });

  it.each(["chatgpt", "generic"] as const)(
    "a Django 401 on the %s surface attaches the reauth challenge to the mapped error",
    async (surface) => {
      // Parameterized over both surfaces: the challenge ships on EVERY
      // authenticated connection (OAuth-capable hosts key their re-link
      // UI on it; others ignore unknown `_meta`).
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(401, { detail: "Invalid API key." })),
      );
      const result = await callTool(
        { surface, requestOrigin: "https://mcp.example.com" },
        "tako_search",
        { query: "US GDP" },
      );
      expect(result.isError).toBe(true);
      const challenges = result._meta?.["mcp/www_authenticate"] as string[];
      expect(challenges).toHaveLength(1);
      expect(challenges[0]).toContain('error="invalid_token"');
      expect(challenges[0]).toContain("error_description=");
      // The existing structured error detail is preserved alongside.
      expect(
        (result._meta?.["tako/error"] as { kind?: string } | undefined)?.kind,
      ).toBe("unauthorized");
      const text = (result.content?.[0] as { text?: string } | undefined)?.text;
      expect(text).toBe(AUTH_INVALID_MESSAGE);
    },
  );

  it("a Django 401 on the FREE tier does not claim the caller's session expired", async () => {
    // On free tier the rejected credential is the SHARED free-tier key,
    // not a user session — surfacing "sign in again" there would mask a
    // shared-key outage as a per-user auth failure (adversarial review
    // finding). The plain unauthorized error must pass through unchanged.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { detail: "Invalid API key." })),
    );
    const result = await callTool(
      {
        tier: "free",
        requestOrigin: "https://mcp.example.com",
      },
      "tako_search",
      { query: "US GDP" },
      "free",
    );
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
    expect(
      (result._meta?.["tako/error"] as { kind?: string } | undefined)?.kind,
    ).toBe("unauthorized");
    // The regression this guard is named for is a TEXT-channel one: if the
    // authenticated-401 content override ever escapes its tier gate, the
    // _meta assertions above stay green while anonymous callers are told to
    // sign in about the shared key. Pin the text too (review finding).
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toBe(AUTH_INVALID_MESSAGE);
    expect(text).not.toMatch(/sign in|session|re-?authoriz/i);
  });

  it("a Django 401 on an authenticated generic connection gets the recovery message and re-auth challenge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { detail: "Invalid API key." })),
    );
    const result = await callTool(
      { requestOrigin: "https://mcp.example.com" },
      "tako_search",
      { query: "US GDP" },
    );
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toBe(AUTH_INVALID_MESSAGE);
    expect(text).not.toContain("Django");
    const challenges = result._meta?.["mcp/www_authenticate"] as string[] | undefined;
    expect(challenges?.[0]).toContain('error="invalid_token"');
    // the structured detail survives for clients that key on it
    expect(
      (result._meta?.["tako/error"] as { kind?: string } | undefined)?.kind,
    ).toBe("unauthorized");
  });
});

describe("withChatGptToolSecuritySchemes", () => {
  const JSON_CT = { "content-type": "application/json" };

  it("passes non-JSON (SSE) responses through untouched", async () => {
    const res = new Response("event: message\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    expect(await withChatGptToolSecuritySchemes(res, "authenticated")).toBe(res);
  });

  it("returns the original response when the body is not valid JSON (body stays readable)", async () => {
    const res = new Response("{not json", { headers: JSON_CT });
    const out = await withChatGptToolSecuritySchemes(res, "authenticated");
    expect(out).toBe(res);
    // The adapter reads a clone — the original body must not be consumed.
    await expect(out.text()).resolves.toBe("{not json");
  });

  it("returns the original response for non-tools/list JSON bodies", async () => {
    const res = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      { headers: JSON_CT },
    );
    expect(await withChatGptToolSecuritySchemes(res, "authenticated")).toBe(res);
  });

  it("rewrites tools/list, drops the stale content-length, and keeps status", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "tako_search" }] },
    });
    const res = new Response(body, {
      status: 200,
      headers: { ...JSON_CT, "content-length": String(body.length) },
    });
    const out = await withChatGptToolSecuritySchemes(res, "free");
    expect(out).not.toBe(res);
    expect(out.status).toBe(200);
    expect(out.headers.get("content-length")).toBeNull();
    const json = (await out.json()) as {
      result: { tools: Array<{ securitySchemes?: unknown }> };
    };
    // The chatgpt surface never advertises noauth — it 401s anonymous
    // requests before any listing exists (tier "free" is unreachable
    // there; this pins the metadata to match the enforcement).
    expect(json.result.tools[0]?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["mcp"] },
    ]);
  });

  it("resolves schemes per-connection: authenticated listings are oauth2-only", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "tako_search" }] },
    });
    const res = new Response(body, { headers: JSON_CT });
    const out = await withChatGptToolSecuritySchemes(res, "authenticated");
    const json = (await out.json()) as {
      result: { tools: Array<{ securitySchemes?: unknown }> };
    };
    expect(json.result.tools[0]?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["mcp"] },
    ]);
  });
});

describe("logSdkValidationRejections", () => {
  // The SDK answers schema-invalid tools/call arguments with -32602 before
  // any tool handler runs; this tap is the only Worker-side signal for those
  // rejections (see the doc comment in mcp.ts / PR #164 review).
  const postRequest = (body: unknown): Request =>
    new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const jsonRpcResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  it("logs the tool name and message for a -32602 tools/call rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await logSdkValidationRejections(
      postRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "tako_visualize", arguments: { components: [] } },
      }),
      jsonRpcResponse({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32602, message: "Invalid arguments: components too small" },
      }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain("tool=tako_visualize");
    expect(line).toContain("method=tools/call");
    expect(line).toContain("components too small");
  });

  it("stays silent for successful responses", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await logSdkValidationRejections(
      postRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      jsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("stays silent for non--32602 errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await logSdkValidationRejections(
      postRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }),
      jsonRpcResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws on a non-JSON response body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      logSdkValidationRejections(
        postRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
        new Response("nope", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// The slim/schema pairing contract (types.ts: slimStructured's return "MUST
// conform to the tool's advertised outputSchema") is hand-maintained across
// five pairs in two files — this guard is what turns a drift into a logged
// full-output fallback instead of a result spec-compliant clients reject.
describe("structuredContentFor", () => {
  const outputSchema = z.looseObject({ request_id: z.string() });
  const full = { request_id: "r1", cards: ["heavy", "payload"] };

  it("serves the slim object when it conforms to the outputSchema", () => {
    const structured = structuredContentFor(
      {
        name: "t",
        outputSchema,
        slimStructured: () => ({ request_id: "r1" }),
      },
      full,
    );
    expect(structured).toEqual({ request_id: "r1" });
  });

  // Serving the FULL output on drift was the old behaviour and it was the bug:
  // the SDK republishes our schemas as strict (`additionalProperties: false`),
  // so an object carrying `cards`/`sources_glossary` is rejected outright and a
  // spec-compliant client discards the ENTIRE result — text block included — on
  // a call already billed. Narrow to the declared keys instead: drop the
  // extras, never the answer.
  it("narrows to the declared keys (and logs) when the slim drifts from the schema", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const structured = structuredContentFor(
      {
        name: "t",
        outputSchema,
        // Drifted: missing the required request_id.
        slimStructured: () => ({ usage: null }),
      },
      full,
    );
    expect(structured).toEqual({ request_id: "r1" });
    expect(structured).not.toHaveProperty("cards");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not conform"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("narrows to the declared keys when the slimmer throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const structured = structuredContentFor(
      {
        name: "t",
        outputSchema,
        slimStructured: () => {
          throw new Error("boom");
        },
      },
      full,
    );
    expect(structured).toEqual({ request_id: "r1" });
    errorSpy.mockRestore();
  });

  it("narrows the full output when no slimmer is declared", () => {
    expect(structuredContentFor({ name: "t", outputSchema }, full)).toEqual({
      request_id: "r1",
    });
  });

  // Last resort: if even the narrowed object cannot satisfy the schema there is
  // nothing conforming to send, and omitting is spec-legal where a rejected
  // result is fatal. The payload rides in the text channel regardless.
  // Last resort: a required declared key is missing, so nothing conforming can
  // be built. Ship the narrowed object rather than omitting it. Both violate the
  // spec and both are fatal on the official SDKs (which throw on a MISSING
  // structuredContent as hard as on a mismatched one), but a permissive client
  // gets the fields that are present from this and nothing from omission.
  it("serves the narrowed object (never undefined) when narrowing cannot conform", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const structured = structuredContentFor(
      { name: "t", outputSchema, slimStructured: () => ({ usage: null }) },
      { cards: ["only undeclared keys"] },
    );
    expect(structured).not.toBeUndefined();
    // Narrowed: the undeclared key is gone even on this path.
    expect(structured).not.toHaveProperty("cards");
    expect(structured).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("STILL does not conform"),
    );
    errorSpy.mockRestore();
  });

  it("serves the slim object as-is when the tool declares no outputSchema", () => {
    expect(
      structuredContentFor(
        { name: "t", slimStructured: () => ({ anything: 1 }) },
        full,
      ),
    ).toEqual({ anything: 1 });
  });
});

describe("paymentRequiredToolResult", () => {
  // The two REAL 402 bodies these endpoints emit (verified against the
  // monorepo, subscriptions/decorators.py):
  //   - SubscriptionCreditThrottle: monthly plan credits, regrant each
  //     cycle — remedy is a plan upgrade or the reset.
  const SUBSCRIPTION_402_BODY = JSON.stringify({
    error: "insufficient_credits",
    message:
      "You don't have enough credits for this request (need 3, have 0). " +
      "Upgrade your plan for more credits.",
    upgrade_url: "/pricing",
  });
  //   - meters_api_credits: prepaid PAYG balance — remedy is adding
  //     credits.
  const PAYG_402_BODY = JSON.stringify({
    error_type: "PAYMENT_REQUIRED",
    error_message: "Your API credit balance is exhausted. Add credits to continue.",
    balance_cents: 0,
  });

  const err402 = (body: string = PAYG_402_BODY) =>
    new DjangoHttpError({
      path: "/api/v1/answer/",
      method: "POST",
      status: 402,
      body,
    });

  it("names the cause and reset-safe retry semantics, and prescribes no surviving move", () => {
    const result = paymentRequiredToolResult(err402(), false);
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("out of credits");
    // Reset-safe phrasing: monthly plan credits regrant each cycle, so an
    // unconditional "retrying will fail" would be false across a reset.
    expect(text).toContain("until the account has credits again");
    // NO surviving-move clause. Two versions of one shipped — first naming
    // `tako_available_data`, then "graph exploration" — and both were
    // unreachable on a `?tools=search` connection, which registers neither.
    // The hazard is reachability, so neither a tool name nor a capability
    // phrasing is safe unfiltered.
    for (const tool of TOOL_REGISTRY) {
      expect(text, tool.name).not.toContain(tool.name);
    }
    expect(text).not.toMatch(/still works?|graph exploration|spend no credits/i);
    // The raw upstream framing must not leak — "Django" is an internal.
    expect(text).not.toContain("Django");
    const detail = result._meta["tako/error"] as {
      kind: string;
      status: number;
      body?: string;
    };
    expect(detail.kind).toBe("payment_required");
    expect(detail.status).toBe(402);
    expect(detail.body).toContain("PAYMENT_REQUIRED");
  });

  it("splices Django's own remedy per account type when commerce copy is allowed", () => {
    // The backend knows which ledger ran dry; a hand-written remedy is
    // wrong for one of the two account types ("add credits" is
    // impossible for FREE/PRO subscribers — their credits regrant
    // monthly and the remedy is a plan change).
    const subscription = paymentRequiredToolResult(
      err402(SUBSCRIPTION_402_BODY),
      true,
    ).content[0]?.text;
    expect(subscription).toContain("Upgrade your plan for more credits.");
    expect(subscription).not.toContain("Add credits");

    const payg = paymentRequiredToolResult(err402(PAYG_402_BODY), true)
      .content[0]?.text;
    expect(payg).toContain("Add credits to continue.");
    expect(payg).not.toContain("Upgrade your plan");

    // Unrecognized body shape → the neutral fallback, never a guess.
    const fallback = paymentRequiredToolResult(err402("not json"), true)
      .content[0]?.text;
    expect(fallback).toContain(PAYMENT_REQUIRED_REMEDY_FALLBACK);
  });

  it("omits ALL remedy copy when commerce copy is not allowed", () => {
    // OpenAI's commerce policy forbids promoting purchases through an
    // app, and Django's remedies name plan upgrades and credit purchases
    // — exactly that copy. Commerce copy keys on the surface, and the
    // chatgpt surface passes `false` here.
    for (const body of [SUBSCRIPTION_402_BODY, PAYG_402_BODY]) {
      const text = paymentRequiredToolResult(err402(body), false).content[0]
        ?.text;
      expect(text).toBe(PAYMENT_REQUIRED_MESSAGE);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/tako\.com/);
      expect(text).not.toMatch(/upgrade|purchas|\bbuy\b|add credits/i);
    }
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  it("names every DEFAULT-surface tool an agent must choose between — and no opt-in tool", () => {
    for (const tool of ["tako_search", "tako_available_data", "tako_contents"]) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
    // The "and no opt-in tool" half is NOT asserted here. Naming one name by
    // hand is the defect `tools/phantom_tool.test.ts` exists to remove; it
    // derives the allowed set from the resolved toolset and covers both
    // instruction strings on both surfaces.
  });

  it("makes no tier-specific claim — the sign-in signal lives in tool results only", () => {
    // A free-tier variant used to name "the tools that run here" and say
    // `tako_contents` needs a Tako account. The host loads instructions once
    // at `initialize`; a sign-in mid-conversation does not reliably refresh
    // them, so the anonymous text outlived the state it described and
    // suppressed the tool sign-in had just unlocked. The dispatch gate's
    // `authRequiredToolResult` is the one place this claim is allowed.
    expect(SERVER_INSTRUCTIONS).not.toMatch(TIER_CLAIM);
  });

  // The instructions sit ABOVE the tool descriptions in the host's system
  // prompt, so when the two disagree the instructions win. They disagreed:
  // the descriptions call `tako_available_data` the recommended first step
  // while the instructions opened by sending every data question to
  // `tako_search` and mentioned `tako_available_data` once, last, behind
  // "if unsure". Observed on claude.ai as search-first routing.
  //
  // The ORDERING assertion that used to live here (free tool introduced
  // ahead of both priced tools) is gone on purpose: the opening paragraph
  // no longer names a tool, so nothing competes for first position, and
  // the free tool reads as a capability rather than an owed step. What
  // survives is the invariant that actually caused the incident, which was
  // never the order but the CONTRADICTION: whatever these instructions say
  // about the free tool must not be something its own description then
  // argues against. Assert the disagreement cannot come back.
  //
  // Asserted as a PAIR, and that distinction is the whole point. Asserting the
  // two halves separately — no sequencing verb here, no hedge there — pins
  // TODAY'S resolution rather than the invariant, and pins it hard enough to
  // block the rollback `mcp.ts` documents: if search-first routing comes back,
  // the fix is to promote this paragraph again, and the promoted version says
  // "ask it for a measure's exact name BEFORE spending a priced call". An
  // unscoped absence assertion fails on that word alone, even though obliging
  // a call NO ONE contradicts is a perfectly coherent position — it is the
  // position this file held one commit ago.
  //
  // The four states, and only one of them is a bug:
  //   neither         → today. Fine.
  //   obliges only    → the documented rollback. Fine, and the old assertion
  //                     blocked it.
  //   denies only     → description carries the routing call on its own. Fine.
  //   BOTH            → the incident. The instructions sit above the tool
  //                     descriptions in the host's system prompt, so the model
  //                     reads an obligation and then reads the tool denying it.
  //                     That is what this test exists to catch.
  it("does not oblige a free-tool call the tool's own description denies", () => {
    const freeToolLine = SERVER_INSTRUCTIONS.split("\n").find((l) =>
      l.includes("`tako_available_data`"),
    );
    expect(freeToolLine).toBeDefined();
    const availableData = TOOL_REGISTRY.find(
      (t) => t.name === "tako_available_data",
    );
    expect(availableData).toBeDefined();

    // Scoped to the sentence that names the tool. Unscoped, this regex fires on
    // any "first"/"before" anywhere in the instructions, including wording that
    // has nothing to do with routing the free tool.
    const obliges = /\b(first|before|start with|begin with)\b/i.test(
      freeToolLine as string,
    );
    // The family of denials, not just the one phrase this PR removed —
    // `skills/tako-*/SKILL.md` carried the same permission in two other
    // wordings, and either could drift into the description.
    const denies =
      /not a required first step|not a warm-?up|straight to `?tako_(answer|search)`?/i.test(
        availableData?.description ?? "",
      );

    expect({ obliges, denies }).not.toEqual({ obliges: true, denies: true });
  });

  // The answer-vs-search routing paragraph left with `tako_answer`, which the
  // answer fold deleted. Synthesis is now `include_answer` on the opt-in
  // `tako_search_advanced`, so the instructions must still not reference it
  // (see "names every DEFAULT-surface tool" above).

  // Inverted deliberately. The pin form USED to be asserted here, and the
  // A/B retired it: pinning happened on 12% of runs with the server-level copy
  // and 11% without, so the third copy of the recipe (tool descriptions and
  // every `next_call` carry the other two) bought tokens on every request and
  // no behaviour. Pinning happens when a result hands over a ready-to-run
  // call, not when the system prompt lectures about parameters.
  //
  // Asserting its ABSENCE is the point: per-tool mechanics drift back into
  // this string precisely because it reads as the authoritative place to put
  // them. `_pin_form.test.ts` still guarantees the form is stated correctly
  // everywhere it does belong.
  it("keeps per-tool call mechanics OUT — no pin recipe at server level", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/strict/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/node[_ ]?ids?/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/METRIC node/i);
  });

  // The discovery trigger. On a host with several servers connected this is
  // the only thing that makes a model reach for Tako at all — a tool
  // description cannot do it, since reading one means already having chosen
  // Tako. Cheap to delete as "filler" during a trim; the most expensive line
  // here to lose.
  it("keeps the domain list that makes the server discoverable", () => {
    for (const domain of ["finance", "economics", "website/app traffic", "elections"]) {
      expect(SERVER_INSTRUCTIONS).toContain(domain);
    }
  });



  // `tako_available_data` answers coverage questions in its own right, not
  // only as a gate in front of the priced tools: "what does Tako have on X"
  // is worth asking on its own, and the answer shapes which metric is worth
  // asking for at all. A draft framed the tool as "start there when unsure",
  // which collapsed it to a precondition and dropped the coverage half to a
  // trailing clause. Assert both jobs by MEANING, not by example strings —
  // the argument examples live in the tool's own description now.
  it("names both of tako_available_data's jobs — coverage AND name resolution", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/what data Tako has/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/canonical name/i);
  });

  // Parameter-shaped guidance (argument examples, the q+metric split, response
  // fields, recovery protocols) belongs in the description of the tool that
  // takes it, read at the moment it applies. Duplicating it here bought a
  // second copy the model pays for on every request, Tako-bound or not.
  it("carries no argument-level examples — those live in the descriptions", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/`q="/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/`metric="/);
  });

  // Register check. "is free and does two jobs" spends the highest-value
  // tokens on the surface describing the shape of the next sentence. Exa's
  // hosted MCP (836 chars across 2 tools, no instructions at all) never does
  // this: one imperative per line, no meta-commentary.
  it("states what to do, not what the tools 'do'", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/does two jobs/i);
  });

  it("stays short enough to sit in a system prompt", () => {
    // Guard against drift: this is prime real estate, not a manual. Ratcheted
    // from 2000 once the parameter-level duplication moved into the tool
    // descriptions — a ceiling only enforces a budget while it is close to
    // actual. For scale: Exa's hosted MCP ships 836 chars of description
    // across 2 tools and no instructions at all (mcp.exa.ai, 2026-07-31).
    // Tako needs more than Exa (4+ tools, non-obvious routing, coverage a
    // model cannot guess) but the gap should be justified per sentence.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1600);
  });
});

/**
 * Stringified array arguments, end to end over the real MCP server.
 *
 * The `looseArray` coercion lives on the tool schemas (`_loose_array.ts`), but
 * what actually has to hold is that it survives `registerTool`: the SDK
 * rebuilds our `.shape` into its own `z.object` and validates `tools/call`
 * arguments there, BEFORE any handler runs. `_loose_array.test.ts` proves the
 * coercion and the published schema; this proves the wiring — a host that
 * sends `sources` as JSON text (observed from OpenBB Copilot) gets a served
 * call instead of:
 *
 *   MCP error -32602: Input validation error: Invalid arguments for tool
 *   tako_search: [… "expected":"array" … "received string"]
 *
 * The example was observed on `tako_answer`, whose two looseArray fields went
 * away with the tool in the answer fold; the coercion and this wiring are
 * unchanged.
 */
describe("stringified array arguments survive SDK input validation", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> {
    const ctx: ToolContext = {
      token: "sk-test",
      env: ENV,
      sendProgress: noopSendProgress,
      surface: "generic",
    };
    // The allowlist REPLACES the defaults, so name every tool called here.
    const server = createMcpServer(ctx, {
      surface: "generic",
      requestedToolNames: new Set([
        "tako_search",
        "tako_contents",
        "tako_agent",
        "tako_visualize",
      ]),
    });
    const mcpClient = new Client(
      { name: "loose-array-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      return (await mcpClient.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  it("tako_search serves a bare-string `sources`", async () => {
    // node_ids left this tool in the D4 split; `sources` is the only looseArray
    // field it still carries, and the coercion is what keeps a host that
    // stringifies the array off a -32602.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-2" }),
    ]);

    const result = await callTool("tako_search", {
      query: "US GDP",
      sources: "data",
    });

    expect(result.isError).not.toBe(true);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const body = (await request.clone().json()) as {
      sources?: { data?: Record<string, unknown>; web?: unknown };
    };
    expect(body.sources?.web).toBeUndefined();
    expect(body.sources?.data).toEqual({});
  });

  // The contract does not move: a value the array schema rejects is still
  // rejected, coerced or not.
  //
  // Asserting on the MESSAGE, not just the code: the SDK answers `-32602`
  // (`InvalidParams`) for an unknown tool name, a disabled tool and output
  // validation too, and `McpError` prefixes all of them with "MCP error
  // -32602" — so a code-only assertion would pass on a typo in the tool name
  // and prove nothing about `sources`.
  it("still rejects an unknown source name, without reaching the backend", async () => {
    const fetchMock = mockFetchSequence([]);

    const result = await callTool("tako_search", {
      query: "x",
      sources: "bing",
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("-32602");
    expect(text).toContain("tako_search");
    // The enum constraint that failed, and where. zod reports the allowed
    // values rather than the received one, so the option list is the specific
    // thing to pin; "sources" alone would also match an unrelated path.
    expect(text).toContain("invalid_value");
    expect(text).toContain('"sources"');
    expect(text).toMatch(/"data",\s*"web"/);
    // Rejection has to happen at validation. If coercion ever widened the enum,
    // this call would bill a live upstream request instead of failing.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A `.strict()` tool schema must reject an unknown TOP-LEVEL key on the wire,
 * not only in a unit test.
 *
 * `registerTool` takes either a `ZodRawShape` or a full schema. Handed a raw
 * shape, the SDK rebuilds it as a plain `z.object`, which STRIPS unknown keys
 * and drops every object-level check — so a tool's `.strict()` and any
 * `.refine()` passed their own `safeParse` tests and never ran against a real
 * call. `tako_search_advanced` shipped a header promising a -32602 for an
 * unexposed top-level field on exactly that basis, and served a silent drop.
 */
describe("object-level schema checks reach the wire", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an unknown top-level key on a strict tool, before any upstream request", async () => {
    const fetchMock = mockFetchSequence([]);
    const ctx: ToolContext = {
      token: "sk-test",
      env: ENV,
      sendProgress: noopSendProgress,
      surface: "generic",
    };
    const server = createMcpServer(ctx, {
      surface: "generic",
      requestedToolNames: new Set(["tako_search_advanced"]),
    });
    const mcpClient = new Client(
      { name: "strict-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    let result: { isError?: boolean; content: Array<{ text?: string }> };
    try {
      result = (await mcpClient.callTool({
        name: "tako_search_advanced",
        arguments: { query: "US GDP", bogus: 1 },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
    } finally {
      await mcpClient.close();
      await server.close();
    }
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("-32602");
    expect(result.content[0]?.text).toContain("bogus");
    // A stripped key would have run the search for real, and this is the
    // assertion that catches it: the pre-fix failure was not a wrong error
    // message, it was a served call reaching the upstream fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


/**
 * The PUBLISHED output schema, per surface.
 *
 * `outputSchemaBySurface` had no test at all: reverting
 * `outputSchemaForSurface(tool, options.surface)` in `mcp.ts` to a bare
 * `tool.outputSchema` left all 1267 tests green while stripping the six
 * widget fields out of the `structuredContent` ChatGPT's bundle reads via
 * `window.openai.toolOutput` — a silently broken chart on the one surface
 * that costs an app resubmission to fix.
 *
 * `tools/list` over a real server, not the module constant, because the SDK
 * republishes the schema and the surface is chosen inside `registerTool`.
 */
describe("published outputSchema per surface", () => {
  const WIDGET_FIELDS = ["pub_id", "embed_url", "image_url", "dark_mode", "width", "height"] as const;

  async function searchOutputProperties(surface: Surface): Promise<string[]> {
    const server = createMcpServer(
      { token: "sk-test", env: { DJANGO_BASE_URL: "https://staging.trytako.com" }, sendProgress: noopSendProgress, surface },
      { surface },
    );
    const mcpClient = new Client(
      { name: "surface-schema-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const listed = await mcpClient.listTools();
      const search = listed.tools.find((t) => t.name === "tako_search");
      expect(search?.outputSchema, "tako_search publishes no outputSchema").toBeDefined();
      return Object.keys(
        (search?.outputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  it("declares the widget fields on chatgpt, where a widget reads them", async () => {
    const props = await searchOutputProperties("chatgpt");
    for (const field of WIDGET_FIELDS) {
      expect(props, `chatgpt outputSchema is missing ${field}`).toContain(field);
    }
  });

  it("omits them on generic, where pickDeclared strips them by construction", async () => {
    const props = await searchOutputProperties("generic");
    for (const field of WIDGET_FIELDS) {
      expect(props, `generic outputSchema declares widget field ${field}`).not.toContain(field);
    }
    // Not an empty schema — the projected fields are on BOTH surfaces, so a
    // schema that lost everything would pass the loop above.
    expect(props).toContain("cards");
    expect(props).toContain("web_results");
  });
});
