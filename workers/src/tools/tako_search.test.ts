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
import type { AnyToolModule, ToolContext } from "./types.js";
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
  surface: "generic",
};

// The one default the handler expects post-zod parse. The MCP framework
// applies schema defaults before invoking the handler, so a direct handler
// call must pass the resolved shape — and after the D4 trim `sources` is the
// only field that has one. Everything else is omitted from the wire body when
// the caller omits it, so there is nothing to pin here.
const DEFAULTS = {
  sources: ["data"] as ("data" | "web")[],
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
    // The projection drops `content` outright on this tool — neither the new
    // `content_format` key nor the legacy `format` can reach the model.
    expect(out.cards[0]).not.toHaveProperty("content");
  });
});

describe("tako_search is the SIMPLE tool (spec D4)", () => {
  it("exposes exactly query, sources, country_code and locale", () => {
    expect(Object.keys(tako_search.inputSchema.shape).sort()).toEqual([
      "country_code",
      "locale",
      "query",
      "sources",
    ]);
  });

  it("declares no defaults of its own beyond sources", () => {
    // `sources` keeps a default because the Worker READS it — to pick which
    // per-source blocks to send and which zero-card guidance branch applies.
    // It is not a value forwarded to the API.
    expect(tako_search.inputSchema.parse({ query: "x" })).toEqual({
      query: "x",
      sources: ["data", "web"],
    });
  });

  it('rejects the retired "tako" source alias', () => {
    expect(tako_search.inputSchema.safeParse({ query: "x", sources: ["tako"] }).success).toBe(false);
    expect(tako_search.inputSchema.safeParse({ query: "x", sources: ["data"] }).success).toBe(true);
  });

  it("runs anonymously with no input gate, because rows come from tako_contents", () => {
    // The property is absent from the literal type once the tool stops
    // declaring it, so read it through the erased view the registry uses.
    const asModule = tako_search as unknown as AnyToolModule;
    expect(asModule.anonymousInputRejects).toBeUndefined();
  });

  it("declares exactly one fixed input: the web highlights override", () => {
    expect(tako_search.fixedInputs).toEqual([
      {
        field: "sources.web.highlights",
        value: "true",
        note: expect.stringContaining("API default is false") as unknown as string,
      },
    ]);
  });
});

describe("tako_search request body sends only what the caller asked for", () => {
  const emptyResponse = () =>
    mockFetchSequence([jsonResponse(200, { cards: [], web_results: [], request_id: "r" })]);

  it("posts to /api/v3/search with a per-source sources object", async () => {
    const fetchMock = emptyResponse();
    await tako_search.handler({ query: "gold price", sources: ["data"] }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(req.url).pathname).toBe("/api/v3/search/");
    const body = await bodyOf(req);
    expect(body.query).toBe("gold price");
    expect(body.source_indexes).toBeUndefined();
    expect(body.output_settings).toBeUndefined();
  });

  it("sends each per-source block EMPTY except the one opinionated web override", async () => {
    // The deleted overrides: count 10 on both sources (API default 5) and
    // snippet_max_chars 2000 (API default 4000 on /v3/search). Both were tuned
    // when inlining was free and neither had a rationale in the tree.
    const fetchMock = emptyResponse();
    await tako_search.handler({ query: "x", sources: ["data", "web"] }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({ data: {}, web: { highlights: true } });
  });

  it("omits the web block entirely on a data-only search", async () => {
    const fetchMock = emptyResponse();
    await tako_search.handler({ query: "x", sources: ["data"] }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({ data: {} });
  });

  it("omits country_code, locale and effort when the caller omits them", () => {
    const body = buildSearchBody({ query: "x", sources: ["data", "web"] });
    expect("country_code" in body).toBe(false);
    expect("locale" in body).toBe(false);
    expect("effort" in body).toBe(false);
  });

  it("passes country_code and locale through when the caller sets them", () => {
    const body = buildSearchBody({
      query: "x",
      sources: ["data"],
      country_code: "GB",
      locale: "en-GB",
    });
    expect(body.country_code).toBe("GB");
    expect(body.locale).toBe("en-GB");
  });

  it("never inlines rows: the card keeps its pointer, not its payload", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "abc123",
            title: "US GDP",
            // `exportable: true` explicitly: the generated TakoCard defaults it
            // to FALSE, and SearchResponse runs before takoCardSchema, so a card
            // that omits the flag is classified locked no matter what `content`
            // holds — and a locked card reports no row count (see projectCard).
            exportable: true,
            webpage_url: "https://trytako.com/charts/us-gdp",
            content: {
              content_format: "json_compact",
              cost: 0.001,
              data: null,
              records: null,
              dataset: {
                columns: [
                  { name: "date", type: "date" },
                  { name: "v", type: "number" },
                ],
                rows: [["2024-01-01", 29]],
                total_rows: 1,
                truncated: false,
                ref: "https://trytako.com/charts/us-gdp",
                sources: [{ name: "FRED", index: "data" }],
                provenance: "query",
              },
              url: null,
              expires_at: null,
              total_rows: 1,
              truncated: false,
              export_pricing: null,
              source_url: "https://trytako.com/charts/us-gdp",
            },
          },
        ],
        web_results: [],
        request_id: "r-rows",
      }),
    ]);

    const out = await tako_search.handler({ query: "x", sources: ["data"] }, CTX);
    // The projection drops `content` — no row payload channel exists on this
    // tool — but lifts the row count so the model knows the fetch is worth it.
    expect(out.cards[0]).not.toHaveProperty("content");
    expect(out.cards[0]).not.toHaveProperty("rows");
    expect(out.cards[0]?.total_rows).toBe(1);
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
    expect(out.cards[0]?.url).toBe("https://trytako.com/c/abc");
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
    expect(g).toMatch(/web source only/i);
    expect(g).not.toMatch(/do not re-?search/i);
    // No verdict about a source that was never queried.
    expect(g).not.toMatch(/data graph does not cover/i);
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
    // The projection made the element schema REAL (typed fields), so the
    // contract now lives on `snippet` itself instead of the array wrapper.
    const schema = z.toJSONSchema(tako_search.outputSchema) as {
      properties?: {
        web_results?: { items?: { properties?: { snippet?: { description?: string } } } };
      };
    };
    const json = JSON.stringify(schema);
    const snippet = schema.properties?.web_results?.items?.properties?.snippet?.description;

    expect(snippet).toBeDefined();
    // The three properties a reader cannot infer from the value itself.
    expect(snippet).toMatch(/selected against/i); // not the page's opening text
    expect(snippet).toContain(" … "); // passages may be non-contiguous
    expect(snippet).toMatch(/null/); // absence is a legitimate outcome
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

  it("sends exactly what fixedInputs declares, so TOOLS.md cannot publish a stale constant", () => {
    // `fixedInputs` is a hand-written declaration that `docs/TOOLS.md` renders
    // verbatim, and nothing links it to `buildSearchBody`. The handler literal
    // is already pinned by the body tests above, so a retune breaks those and
    // gets fixed there — leaving this declaration stale and the published doc
    // asserting a value the server no longer sends. Derived from the
    // declaration rather than restating the constants a fourth time.
    const body = buildSearchBody(
      tako_search.inputSchema.parse({ query: "US GDP", sources: ["data", "web"] }),
    );
    // A value starting with "=" names another input (`= count`), not a constant.
    const constants = tako_search.fixedInputs.filter((f) => !f.value.startsWith("="));
    expect(constants.length).toBeGreaterThan(0);
    for (const { field, value } of constants) {
      const actual = field.split(".").reduce<unknown>(
        (o, key) => (o as Record<string, unknown> | undefined)?.[key],
        body as unknown,
      );
      expect(actual, field).toEqual(JSON.parse(value));
    }
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

describe("tako_search takes no graph pin (moved to tako_search_advanced)", () => {
  it("strips node_ids and strict rather than 400-ing a caller that still sends them", () => {
    // z.object() strips unknown keys, so a client written against the old
    // schema keeps working — it just stops pinning. That is the friendlier
    // break for a pre-launch surface than a -32602 on every call.
    const parsed = tako_search.inputSchema.parse({
      query: "q",
      node_ids: ["tesla-x1"],
      strict: true,
    });
    expect(parsed).toEqual({ query: "q", sources: ["data", "web"] });
  });

  it("never sends node_ids or strict on the wire", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-h" }),
    ]);
    await tako_search.handler({ query: "q", ...DEFAULTS }, CTX);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: {} });
  });
});

describe("tako_search never inlines rows", () => {
  it("drops card row data on every call — rows are a tako_contents fetch", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            // `exportable: true` explicitly: the generated TakoCard defaults it
            // to FALSE, and SearchResponse runs before takoCardSchema, so a card
            // that omits the flag is classified locked no matter what `content`
            // holds — and a locked card reports no row count (see projectCard).
            exportable: true,
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

    const out = await tako_search.handler({ query: "cpi", ...DEFAULTS }, CTX);

    // The projection carries no row channel at all on this tool.
    expect(out.cards[0]).not.toHaveProperty("content");
    expect(out.cards[0]).not.toHaveProperty("rows");
    // Pointer + "more available" signal still present.
    expect(out.cards[0]?.url).toBe("https://trytako.com/c/cpi");
    expect(out.cards[0]?.total_rows).toBe(300);
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
      { query: "cpi", ...DEFAULTS, sources: ["web"] },
      CTX,
    );

    // No content key at all: the page text (and its billing descriptor)
    // never reaches the model on this tool.
    expect(out.web_results[0]).not.toHaveProperty("content");
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
