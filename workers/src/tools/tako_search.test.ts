/**
 * Tests for `tako_search`.
 *
 * Fast-only, synchronous search backed by `POST /api/v3/search`. No
 * deep/async path: the handler issues one POST and shapes the response
 * into `{ cards, web_results, request_id }` plus top-level auto-chain
 * widget fields when the top card carries a `card_id`. Zero matches
 * come back as a clean empty result (no throw) — deep/multi-step
 * research is delegated to the Tako agent.
 *
 * Locked properties:
 *   1. `sources` array → per-source `sources` object on the wire (count +
 *      include_contents per source); path is `/api/v3/search`.
 *   2. `sources: ["data","web"]` → both keys present in the object.
 *   3. `effort` omitted → no `effort` key; `effort: "instant"` → passed;
 *      schema rejects `effort: "deep"`.
 *   4. `count` → per-source `count`.
 *   5. v3 card mapping (webpage_url) + `request_id` surfaced.
 *   6. `web_results` surfaced.
 *   7. Top-card auto-chain widget fields populated from `card_id`.
 *   8. Clean empty (0 cards + 0 web_results) → resolves, no throw, no widget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Env } from "../env.js";
import { SearchRequest } from "../generated/schemas.js";
import type { ToolContext } from "./types.js";
import { INLINE_PREVIEW_ROW_CAP, MAX_PREVIEW_ROWS } from "./_search_results.js";
import tako_search, { buildSearchBody } from "./tako_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "claude",
};

// Defaults the handler expects post-zod parse (the MCP framework applies
// schema defaults before invoking the handler, so direct handler calls
// must pass the resolved shape — `sources` included). NOTE: the SCHEMA
// default for include_contents is now `true`; we pin it `false` here so the
// bulk of the request-mapping tests exercise the pointers-only path — the
// default-true + row-preview behavior is covered by its own tests below.
const DEFAULTS = {
  sources: ["data"] as ("data" | "web" | "tako")[],
  count: 10,
  include_contents: false,
  preview_rows: 20,
  country_code: "US",
  locale: "en-US",
  strict: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Regression: the live /api/v3/search response attaches a per-result `content`
// preview object even when include_contents is false, and the backend renamed
// its `format` field to `content_format`. The hand-written resultContentSchema
// must not hard-require the old `format` name — otherwise EVERY result trips the
// handler's second-stage guard and it throws "unexpected shape" (a prod outage
// reproduced against the live API on 2026-07-17). Fixture is the real live shape.
describe("tako_search content-shape regression (format -> content_format)", () => {
  const LIVE_CONTENT = {
    content_format: null,
    cost: 0.001,
    data: null,
    records: null,
    dataset: null,
    url: null,
    expires_at: null,
    total_rows: null,
    truncated: false,
    export_pricing: {
      baseline_usd: 0.001,
      row_cpm_usd: 1,
      free_rows: 20,
      max_rows_ceiling: 2000,
    },
  };

  it("does not throw when results carry the current content shape (content_format, no `format`)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "c1",
            title: "US GDP",
            embed_url: "https://trytako.com/embed/c1/",
            content: LIVE_CONTENT,
          },
        ],
        web_results: [
          { title: "GDP", url: "https://example.com", content: LIVE_CONTENT },
        ],
        request_id: "req-content",
      }),
    ]);

    const out = await tako_search.handler(
      { ...DEFAULTS, query: "US GDP growth", sources: ["data", "web"] },
      CTX,
    );

    expect(out.cards).toHaveLength(1);
    expect(out.web_results).toHaveLength(1);
    // content is surfaced under the new name; the old `format` key is absent.
    expect(out.cards[0]?.content?.content_format).toBeNull();
    expect(
      (out.cards[0]?.content as Record<string, unknown> | undefined)?.format,
    ).toBeUndefined();
  });
});

describe("tako_search input schema", () => {
  it("defaults count to 10", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.count).toBe(10);
  });

  it("defaults sources to [\"data\",\"web\"]", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sources).toEqual(["data", "web"]);
  });

  it("defaults include_contents to true (search is data-first)", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.include_contents).toBe(true);
  });

  it("accepts the legacy \"tako\" synonym in the sources enum", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x", sources: ["tako"] });
    expect(parsed.success).toBe(true);
  });

  it("defaults preview_rows to INLINE_PREVIEW_ROW_CAP and bounds it at 1..MAX_PREVIEW_ROWS", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.preview_rows).toBe(INLINE_PREVIEW_ROW_CAP);
    expect(tako_search.inputSchema.safeParse({ query: "x", preview_rows: MAX_PREVIEW_ROWS }).success).toBe(true);
    expect(tako_search.inputSchema.safeParse({ query: "x", preview_rows: 0 }).success).toBe(false);
    expect(tako_search.inputSchema.safeParse({ query: "x", preview_rows: MAX_PREVIEW_ROWS + 1 }).success).toBe(false);
  });

  it("accepts effort=fast", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "fast",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts effort=instant", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "instant",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects effort=deep", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "deep",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("tako_search request body", () => {
  it("posts to /api/v3/search with a per-source sources object (no flat source_indexes/output_settings)", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "gold price", ...DEFAULTS }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(req.url).pathname).toBe("/api/v3/search/");
    const body = await bodyOf(req);
    expect(body.sources).toEqual({ data: { count: 10, include_contents: false } });
    expect(body.source_indexes).toBeUndefined();
    expect(body.output_settings).toBeUndefined();
    expect(body.query).toBe("gold price");
  });

  it("maps sources [\"data\",\"web\"] to both keys of the sources object", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["data", "web"] },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({
      data: { count: 10, include_contents: false },
      web: { count: 10, include_contents: false, snippet_max_chars: 2000, highlights: true },
    });
  });

  it("folds the legacy \"tako\" synonym onto the data key", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "x", ...DEFAULTS, sources: ["tako"] }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({ data: { count: 10, include_contents: false } });
  });

  it("sets include_contents on the DATA source when requested, but never on web (billed per page)", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["data", "web"], include_contents: true },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({
      data: { count: 10, include_contents: true },
      // web is pinned false regardless of the flag — page text is billed per
      // page and fetched on demand via tako_contents, never auto-inlined.
      web: { count: 10, include_contents: false, snippet_max_chars: 2000, highlights: true },
    });
  });

  it("omits effort from the body when not provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect("effort" in body).toBe(false);
  });

  it("passes effort=instant through to the body", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, effort: "instant" },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.effort).toBe("instant");
  });

  it("maps count into each selected source", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "x", ...DEFAULTS, count: 5 }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({ data: { count: 5, include_contents: false } });
  });
});

describe("tako_search response mapping", () => {
  it("maps a v3 card (webpage_url) and surfaces request_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "abc",
            title: "T",
            description: "d",
            webpage_url: "https://trytako.com/c/abc",
            image_url: "https://trytako.com/img.png",
            embed_url: "https://trytako.com/embed/abc",
          },
        ],
        web_results: [],
        request_id: "req-1",
      }),
    ]);

    const out = await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.webpage_url).toBe("https://trytako.com/c/abc");
    expect(out.request_id).toBe("req-1");
  });

  it("surfaces web_results", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [],
        web_results: [
          {
            title: "A web result",
            url: "https://example.com/a",
            snippet: "snip",
            source_name: "Example",
          },
        ],
        request_id: "req-web",
      }),
    ]);

    const out = await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["web"] },
      CTX,
    );

    expect(out.web_results).toHaveLength(1);
    expect(out.web_results[0]?.url).toBe("https://example.com/a");
    // Zero cards still carries guidance — but this is a WEB-ONLY search, so it
    // must not claim anything about data coverage, and must not ban the one
    // recovery available (refining the query). It previously asserted a blanket
    // "do not re-search", which is the misfire.
    //
    // The assertions below used to be `/Refine and re-search/i` alone, which
    // `REFINE_WEB_FREELY` ("refine and re-search freely") satisfied from the
    // WRONG branch — so the test passed while the claim its own comment names
    // went unchecked, and the rendered guidance really did report a graph
    // verdict. Assert the absence of every data-axis claim, not a string two
    // branches share.
    const g = out.guidance ?? "";
    expect(g).toMatch(/WEB source only/);
    expect(g).toMatch(/refine and re-search/i);
    expect(g).not.toMatch(/do NOT re-search/i);
    // No verdict about a source that was never queried.
    expect(g).not.toMatch(/DATA GRAPH only/);
    expect(g).not.toMatch(/already shown the graph does not hold it/);
    // No data-axis recovery either: the caller narrowed sources deliberately.
    expect(g).not.toMatch(/node_id/);
    expect(g).not.toMatch(/strict/);
    expect(g).not.toMatch(/hard filter/);
  });

  it("populates auto-chain widget fields when the top card has card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          { card_id: "aapl-price", title: "AAPL", webpage_url: "u" },
        ],
        web_results: [],
        request_id: "req-2",
      }),
    ]);

    const out = await tako_search.handler({ query: "AAPL", ...DEFAULTS }, CTX);

    expect(out.pub_id).toBe("aapl-price");
    expect(out.guidance).toBeUndefined();
    expect(out.embed_url).toBe(
      "https://staging.trytako.com/embed/aapl-price/?dark_mode=auto&showShare=true",
    );
    expect(out.image_url).toBe(
      "https://staging.trytako.com/api/v1/image/aapl-price/?dark_mode=true",
    );
    expect(out.dark_mode).toBe(true);
    expect(out.width).toBe(900);
    expect(out.height).toBe(720);
  });

  it("returns a clean empty result (no throw, no widget fields) on zero matches", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-empty" }),
    ]);

    const out = await tako_search.handler(
      { query: "obscure query with no matches", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.cards).toEqual([]);
    expect(out.web_results).toEqual([]);
    expect(out.request_id).toBe("req-empty");
    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
    // Zero results carry the anti-retry recovery protocol.
    expect(out.guidance).toMatch(/tako_available_data/);
  });

  it("omits widget fields when the top card has no card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [{ card_id: null, title: "Metadata only", webpage_url: "u" }],
        web_results: [],
        request_id: "req-3",
      }),
    ]);

    const out = await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    expect(out.cards).toHaveLength(1);
    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
  });
});

describe("tako_search widget + contract guard", () => {
  it("still advertises the inline-chart widget", () => {
    expect(typeof tako_search.appUiResource).toBe("function");
  });

  it("reshapes flat input into a contract-valid search body", () => {
    const body = buildSearchBody(tako_search.inputSchema.parse({ query: "US GDP" }));
    expect(() => SearchRequest.parse(body)).not.toThrow();
  });

  it("documents the snippet contract on the ADVERTISED output schema, where a client can read it", () => {
    // Regression guard for a real miss: the first version of the highlights
    // change put this wording on `webResultSchema.snippet`. That schema is the
    // wire-parse guard and the internal shape — neither is advertised — so the
    // guidance reached no client at all. The advertised schema declares
    // `web_results` as a LOOSE array (deliberate wire-drift protection), which
    // means per-element descriptions are dropped and the array description is
    // the only model-facing slot. Assert against the serialized JSON Schema,
    // because that is what `tools/list` actually ships.
    const schema = z.toJSONSchema(tako_search.outputSchema) as {
      properties?: { web_results?: { description?: string } };
    };
    const json = JSON.stringify(schema);
    const web = schema.properties?.web_results?.description;

    expect(web).toBeDefined();
    // The three properties a reader cannot infer from the value itself.
    expect(web).toMatch(/selected against/i); // not the page's opening text
    expect(web).toContain(" … "); // passages may be non-contiguous
    expect(web).toMatch(/null/); // absence is a legitimate outcome
    // And it has to survive serialization, not just live on the zod object.
    expect(json).toContain("selected against");
  });

  it("asks for Exa highlights as the web snippet, so the excerpt is answer-bearing", () => {
    const body = buildSearchBody(
      tako_search.inputSchema.parse({ query: "nvidia data center revenue", sources: ["web"] }),
    );
    // Not a cosmetic preference: with highlights off the snippet is the page's
    // opening characters (nav chrome, press-release preamble); with it on the
    // snippet is the passage Exa's model selects against the query. The whole
    // point of the excerpt is to let the model pick a url for a priced
    // tako_contents follow-up, and preamble does not support that choice.
    expect(body.sources?.web).toMatchObject({ highlights: true });
  });

  it("keeps a web body with highlights valid against the backend contract", () => {
    // sources.web is extra="forbid" server-side, so an unknown key is a 400 on
    // every web search rather than a degraded one. This is the guard that the
    // key we send is the key the synced spec declares.
    const body = buildSearchBody(
      tako_search.inputSchema.parse({ query: "US GDP", sources: ["data", "web"] }),
    );
    expect(() => SearchRequest.parse(body)).not.toThrow();
  });
});

describe("tako_search graph grounding", () => {
  it("maps node_ids + strict into sources.data", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-g" }),
    ]);

    await tako_search.handler(
      {
        query: "Tesla revenue",
        sources: ["data"],
        count: 10,
        preview_rows: 20,
        include_contents: false,
        country_code: "US",
        locale: "en-US",
        node_ids: ["tesla-x1", "rev-9"],
        strict: true,
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: {
        count: 10,
        include_contents: false,
        node_ids: ["tesla-x1", "rev-9"],
        strict: true,
      },
    });
  });

  it("omits node_ids/strict when not provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-h" }),
    ]);
    await tako_search.handler(
      { query: "q", ...DEFAULTS },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { count: 10, include_contents: false } });
  });

  it("caps a card's inline row preview to the INLINE_PREVIEW_ROW_CAP most-recent rows when include_contents is on", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            webpage_url: "https://trytako.com/c/cpi",
            content: {
              content_format: "json_compact",
              cost: 0.001,
              total_rows: 300,
              truncated: true,
              dataset: {
                columns: [{ name: "t", type: "datetime" }, { name: "v", type: "number" }],
                rows: Array.from({ length: 300 }, (_v, i) => [`d${i}`, i]),
                total_rows: 300,
                truncated: true,
                ref: "cpi-ref",
                sources: [],
                provenance: "query",
              },
            },
          },
        ],
        web_results: [],
        request_id: "req-cap",
      }),
    ]);

    // include_contents defaults true; call without pinning it false.
    const out = await tako_search.handler(
      { query: "cpi", sources: ["data"], count: 10, include_contents: true, preview_rows: INLINE_PREVIEW_ROW_CAP, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );

    const ds = (out.cards[0]?.content as { dataset: { rows: unknown[] } }).dataset;
    expect(ds.rows).toHaveLength(INLINE_PREVIEW_ROW_CAP);
    // Kept the MOST-RECENT rows (tail of the series).
    expect(ds.rows[INLINE_PREVIEW_ROW_CAP - 1]).toEqual(["d299", 299]);
    // Metadata preserved so the model knows more is available (priced).
    expect((out.cards[0]?.content as Record<string, unknown>).total_rows).toBe(300);
    expect((out.cards[0]?.content as Record<string, unknown>).truncated).toBe(true);
  });

  it("preview_rows raises the inline cap per call (50 → 50 most-recent rows survive)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            webpage_url: "https://trytako.com/c/cpi",
            content: {
              content_format: "json_compact",
              cost: 0.001,
              total_rows: 300,
              truncated: true,
              dataset: {
                columns: [{ name: "t", type: "datetime" }, { name: "v", type: "number" }],
                rows: Array.from({ length: 300 }, (_v, i) => [`d${i}`, i]),
                total_rows: 300,
                truncated: true,
                ref: "cpi-ref",
                sources: [],
                provenance: "query",
              },
            },
          },
        ],
        web_results: [],
        request_id: "req-cap-50",
      }),
    ]);

    const out = await tako_search.handler(
      { ...DEFAULTS, query: "cpi", include_contents: true, preview_rows: 50 },
      CTX,
    );

    const ds = (out.cards[0]?.content as { dataset: { rows: unknown[] } }).dataset;
    expect(ds.rows).toHaveLength(50);
    expect(ds.rows[49]).toEqual(["d299", 299]); // still the most-recent tail
  });

  it("preview_rows is inert when include_contents is false (rows still dropped)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            content: {
              content_format: "json_compact",
              cost: 0.001,
              total_rows: 300,
              truncated: true,
              dataset: {
                columns: [{ name: "t", type: "datetime" }],
                rows: [["d0"], ["d1"]],
                total_rows: 300,
                truncated: true,
                ref: "cpi-ref",
                sources: [],
                provenance: "query",
              },
            },
          },
        ],
        web_results: [],
        request_id: "req-inert",
      }),
    ]);
    const out = await tako_search.handler(
      { ...DEFAULTS, query: "cpi", include_contents: false, preview_rows: 250 },
      CTX,
    );
    expect((out.cards[0]?.content as Record<string, unknown>).dataset).toBeNull();
  });

  it("drops card row data entirely when include_contents is false (pointers-only mode)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            webpage_url: "https://trytako.com/c/cpi",
            content: {
              content_format: "json_compact",
              cost: 0.001,
              total_rows: 300,
              truncated: true,
              dataset: {
                columns: [{ name: "t", type: "datetime" }, { name: "v", type: "number" }],
                rows: [["d0", 0]],
                total_rows: 300,
                truncated: true,
                ref: "cpi-ref",
                sources: [],
                provenance: "query",
              },
            },
          },
        ],
        web_results: [],
        request_id: "req-drop",
      }),
    ]);

    const out = await tako_search.handler(
      { query: "cpi", ...DEFAULTS, include_contents: false },
      CTX,
    );

    const content = out.cards[0]?.content as Record<string, unknown>;
    expect(content.dataset).toBeNull();
    expect(content.records).toBeNull();
    expect(content.data).toBeNull();
    // Pointer + "more available" signal still present.
    expect(out.cards[0]?.webpage_url).toBe("https://trytako.com/c/cpi");
    expect(content.total_rows).toBe(300);
  });

  it("always drops inlined web page text (billed per page — fetch via tako_contents)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [],
        web_results: [
          {
            title: "CPI report",
            url: "https://example.com/cpi",
            snippet: "summary",
            content: { content_format: null, cost: 0.02, data: "…full billed page text…" },
          },
        ],
        request_id: "req-webtext",
      }),
    ]);

    const out = await tako_search.handler(
      { query: "cpi", ...DEFAULTS, sources: ["web"], include_contents: true },
      CTX,
    );

    expect((out.web_results[0]?.content as Record<string, unknown>).data).toBeNull();
    expect(out.web_results[0]?.snippet).toBe("summary");
    expect(out.web_results[0]?.url).toBe("https://example.com/cpi");
  });

  it("surfaces each card's graph nodes in the output", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "abc123",
            title: "Tesla Revenue",
            embed_url: "https://trytako.com/embed/abc123/",
            nodes: [
              { id: "tesla-x1", name: "Tesla", type: "entity" },
              { id: "rev-9", name: "Revenue", type: "metric" },
            ],
          },
        ],
        web_results: [],
        request_id: "req-n",
      }),
    ]);
    const out = await tako_search.handler(
      { query: "Tesla revenue", ...DEFAULTS },
      CTX,
    );
    expect(out.cards[0]?.nodes).toEqual([
      { id: "tesla-x1", name: "Tesla", type: "entity" },
      { id: "rev-9", name: "Revenue", type: "metric" },
    ]);
  });
});

// The tier flip, proven THROUGH the handler — the slimCard unit tests can't
// catch a regression in the wiring (dropping the opts argument, passing the
// wrong ctx field), which would ship the old false-export contract while the
// whole unit suite stays green.
describe("tako_search per-connection export markings", () => {
  const EXPORTABLE_CARD = {
    card_id: "c1",
    title: "US GDP",
    description: "Latest value $27.4T",
    exportable: true,
    nodes: [{ id: "mt::gdp::1", name: "GDP", type: "metric" }],
    content: {
      content_format: "json_compact",
      cost: 0.001,
      data: null,
      records: null,
      dataset: {
        columns: [
          { name: "t", type: "datetime", unit: null },
          { name: "v", type: "number", unit: null },
        ],
        rows: [["2026-01-01", 1]],
        total_rows: 40,
        truncated: false,
        ref: "c1",
        sources: [],
      },
      url: null,
      expires_at: null,
      total_rows: 40,
      truncated: false,
      export_pricing: {
        baseline_usd: 0.01,
        row_cpm_usd: 0.05,
        free_rows: 20,
        max_rows_ceiling: 2000,
      },
    },
  };

  const response = () =>
    jsonResponse(200, {
      cards: [EXPORTABLE_CARD],
      web_results: [],
      request_id: "req-tier",
    });

  it("free-tier claude connection re-marks the card and strips export_pricing", async () => {
    mockFetchSequence([response()]);
    const out = await tako_search.handler(
      { ...DEFAULTS, query: "US GDP", include_contents: true },
      { ...CTX, tier: "free" },
    );
    const card = out.cards[0] as Record<string, unknown>;
    expect(card?.exportable).toBe(false);
    expect(card?.content).not.toHaveProperty("export_pricing");
    // `cost` is the prospective /contents quote — the same unreachable
    // export's price — so it is stripped alongside the rate card.
    expect(card?.content).not.toHaveProperty("cost");
    // The CONNECTION-scoped hint, not the license-gated one: default ctx
    // carries no commerceCopyAllowed, so the wording is the commerce-free
    // variant (no account remedy named).
    expect(card?.values_hint).toContain("tako_answer");
    expect(card?.values_hint).toContain("connection");
    expect(card?.values_hint).not.toContain("not exportable");
    expect(card?.values_hint).not.toContain("authenticated");
    // Preview rows survive — they are the free tier's data.
    expect(
      ((card?.content as { dataset?: { rows?: unknown[] } })?.dataset?.rows ?? []).length,
    ).toBe(1);
  });

  it("free-tier connection with commerce copy allowed names the account remedy", async () => {
    // Proves the ctx.commerceCopyAllowed wiring through the handler — the
    // slimCard unit tests cannot catch the handler dropping the flag.
    mockFetchSequence([response()]);
    const out = await tako_search.handler(
      { ...DEFAULTS, query: "US GDP", include_contents: true },
      { ...CTX, tier: "free", commerceCopyAllowed: true },
    );
    const card = out.cards[0] as Record<string, unknown>;
    expect(card?.values_hint).toContain("authenticated Tako connection");
  });

  it("free-tier ChatGPT connection keeps exportable:true (the sign-in funnel)", async () => {
    mockFetchSequence([response()]);
    const out = await tako_search.handler(
      { ...DEFAULTS, query: "US GDP", include_contents: true },
      { ...CTX, client: "chatgpt", tier: "free" },
    );
    const card = out.cards[0] as Record<string, unknown>;
    expect(card?.exportable).toBe(true);
    expect(card?.content).toHaveProperty("export_pricing");
    expect(card).not.toHaveProperty("values_hint");
  });

  it("authenticated connection is untouched (exportable + pricing kept)", async () => {
    mockFetchSequence([response()]);
    const out = await tako_search.handler(
      { ...DEFAULTS, query: "US GDP", include_contents: true },
      { ...CTX, tier: "authenticated" },
    );
    const card = out.cards[0] as Record<string, unknown>;
    expect(card?.exportable).toBe(true);
    expect(card?.content).toHaveProperty("export_pricing");
    expect(card?.content).toHaveProperty("cost");
  });
});
