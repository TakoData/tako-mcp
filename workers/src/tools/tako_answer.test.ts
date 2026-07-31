/**
 * Tests for the `tako_answer` tool.
 *
 * The handler is a single POST + re-parse: it maps the tool input onto
 * the backend's `/api/v1/answer/` request body (v3 SearchRequest shape:
 * top-level `query` + a per-source `sources` object, NOT `inputs.text` and
 * NOT the old flat `source_indexes`) and re-validates the response through
 * the output schema. The interesting behavior is:
 *   - request mapping (`query`→`query`, `sources` array → `sources` object)
 *   - the defensive defaulting of missing fields (cards/web_results → [])
 *   - the loud failure on a mis-shaped backend payload
 *   - the absence of grounding-era fields (tako_selected, confidence)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoAnswer, { buildAnswerBody } from "./tako_answer.js";
import { SearchRequest } from "../generated/schemas.js";
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

const FULL_RESPONSE = {
  answer: "US GDP was about $29 trillion in 2024.",
  cards: [
    {
      card_id: "abc123",
      title: "US GDP",
      description: "Gross Domestic Product of the United States",
      webpage_url: "https://trytako.com/charts/us-gdp",
      image_url: "https://trytako.com/api/v1/image/abc123/",
      embed_url: "https://trytako.com/embed/abc123/",
    },
  ],
  web_results: [
    { title: "US GDP 2024", url: "https://example.com/gdp", snippet: "..." },
  ],
  request_id: "req-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Regression: same root cause as the tako_search content-shape outage — cards
// and web results carry a `content` preview object whose backend field `format`
// was renamed to `content_format`. tako_answer reuses takoCardSchema /
// webResultSchema, so a hard-required `format` there also made every
// content-bearing answer throw. Fixture is the real live content shape.
describe("tako_answer content-shape regression (format -> content_format)", () => {
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
    export_pricing: null,
  };

  it("does not throw when cards/web results carry the current content shape", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "US GDP was about $29 trillion.",
        cards: [
          {
            card_id: "abc123",
            title: "US GDP",
            embed_url: "https://trytako.com/embed/abc123/",
            content: LIVE_CONTENT,
          },
        ],
        web_results: [
          { title: "US GDP", url: "https://example.com/gdp", content: LIVE_CONTENT },
        ],
        request_id: "req-content",
      }),
    ]);

    const out = await takoAnswer.handler(
      {
        query: "US GDP",
        sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US",
        locale: "en-US",
        strict: false,
      },
      CTX,
    );

    expect(out.cards).toHaveLength(1);
    expect(out.web_results).toHaveLength(1);
    expect(out.cards[0]?.content?.content_format).toBeNull();
  });
});

describe("tako_answer handler", () => {
  it("tool name is tako_answer", () => {
    expect(takoAnswer.name).toBe("tako_answer");
  });

  it("maps query + sources to the per-source sources object, hits /api/v1/answer/", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await takoAnswer.handler(
      {
        query: "What was US GDP in 2024?",
        sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US",
        locale: "en-US",
        strict: false,
      },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toBe("https://staging.trytako.com/api/v1/answer/");
    const body = await bodyOf(req);
    // v3 SearchRequest: top-level `query` + per-source `sources` object
    expect(body.query).toBe("What was US GDP in 2024?");
    expect(body.sources).toEqual({
      data: { include_contents: false },
      web: { include_contents: false, snippet_max_chars: 2000 },
    });
    // old flat shape + grounding-era nested inputs must NOT be present
    expect(body.source_indexes).toBeUndefined();
    expect(body.inputs).toBeUndefined();

    expect(out.answer).toContain("$29 trillion");
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.card_id).toBe("abc123");
    expect(out.web_results).toHaveLength(1);
    expect(out.request_id).toBe("req-1");
  });

  it("defaults missing optional fields to empty arrays rather than leaking undefined", async () => {
    // A minimal valid backend payload — only the required scalar. The
    // handler should default cards/web_results to [].
    mockFetchSequence([
      jsonResponse(200, {
        answer: "No strong match.",
        request_id: "req-2",
      }),
    ]);

    const out = await takoAnswer.handler(
      { query: "obscure query", sources: ["tako"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );

    expect(out.cards).toEqual([]);
    expect(out.web_results).toEqual([]);
    expect(out.answer).toBe("No strong match.");
    expect(out.request_id).toBe("req-2");
  });

  it("output does NOT contain grounding-era fields (tako_selected, confidence)", async () => {
    mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await takoAnswer.handler(
      { query: "test", sources: ["tako"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    ) as Record<string, unknown>;

    expect(out.tako_selected).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  it("throws an actionable error when the backend returns an unexpected shape (cards not an array)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "ok",
        cards: "not-an-array",
        web_results: [],
        request_id: "req-bad",
      }),
    ]);

    await expect(
      takoAnswer.handler({ query: "q", sources: ["tako", "web"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false }, CTX),
    ).rejects.toThrow(/unexpected wire shape/);
  });
});

describe("tako_answer input schema", () => {
  it("defaults sources to both data and web", () => {
    const parsed = takoAnswer.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toEqual(["data", "web"]);
  });

  it("accepts the legacy \"tako\" synonym and folds it onto the data key", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      { query: "q", sources: ["tako"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });

  it("rejects an empty sources array", () => {
    expect(() =>
      takoAnswer.inputSchema.parse({ query: "hello", sources: [] }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      takoAnswer.inputSchema.parse({ query: "hello", sources: ["bing"] }),
    ).toThrow();
  });

  it("includes country_code and locale in the POST body", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    await takoAnswer.handler(
      { query: "test", sources: ["tako"], include_contents: false, preview_rows: 50, country_code: "GB", locale: "en-GB", strict: false },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]!);
    const body = await bodyOf(req);
    expect(body.country_code).toBe("GB");
    expect(body.locale).toBe("en-GB");
  });

  it("defaults country_code to US and locale to en-US", () => {
    const parsed = takoAnswer.inputSchema.parse({ query: "hello" });
    expect(parsed.country_code).toBe("US");
    expect(parsed.locale).toBe("en-US");
  });
});

describe("tako_answer contract guards", () => {
  it("keeps a flat sources array on the advertised input", () => {
    const shape = takoAnswer.inputSchema.shape as Record<string, unknown>;
    expect(shape).toHaveProperty("sources");
    const parsed = takoAnswer.inputSchema.parse({ query: "US GDP" });
    expect(parsed.sources).toEqual(["data", "web"]); // mirrors backend default
  });

  it("reshapes the flat input into a body that satisfies the backend contract", () => {
    const body = buildAnswerBody({
      query: "US GDP", sources: ["data", "web"], include_contents: false, preview_rows: 50,
      country_code: "US", locale: "en-US", strict: false,
    });
    // The generated backend contract must accept the reshaped body.
    expect(() => SearchRequest.parse(body)).not.toThrow();
  });
});

describe("tako_answer graph grounding", () => {
  it("maps node_ids + strict into sources.data", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    await takoAnswer.handler(
      {
        query: "Tesla revenue",
        sources: ["data"],
        include_contents: false,
        preview_rows: 50,
        country_code: "US",
        locale: "en-US",
        node_ids: ["tesla-x1"],
        strict: true,
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: { include_contents: false, node_ids: ["tesla-x1"], strict: true },
    });
  });

  it("omits node_ids/strict when not provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      { query: "q", sources: ["data"], include_contents: false, preview_rows: 50,
        country_code: "US", locale: "en-US", strict: false },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });
});

describe("tako_answer strips inline row data when include_contents is false", () => {
  // A card the backend attached a full data preview to, plus a web result with
  // inlined page text. answer must drop both — the synthesized prose is the
  // payload — while keeping metadata (total_rows/content_format) + pointers.
  const CARD_WITH_ROWS = {
    card_id: "cpi-1",
    title: "US Core CPI",
    webpage_url: "https://trytako.com/c/cpi-1",
    embed_url: "https://trytako.com/embed/cpi-1/",
    nodes: [{ id: "cpi-x1", name: "Core CPI", type: "metric" }],
    content: {
      content_format: "json_compact",
      cost: 0.001,
      total_rows: 300,
      truncated: true,
      data: null,
      records: null,
      dataset: {
        columns: [{ name: "Timestamp", type: "datetime" }, { name: "v", type: "number" }],
        rows: Array.from({ length: 300 }, (_v, i) => [`2000-01-${i}`, i]),
        total_rows: 300,
        truncated: true,
        ref: "cpi-ref",
        sources: [],
        provenance: "query",
      },
    },
  };

  it("nulls dataset/records/data on cited cards and drops web page text", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Core CPI was 2.6% in Jun 2026.",
        cards: [CARD_WITH_ROWS],
        web_results: [
          {
            title: "CPI report",
            url: "https://example.com/cpi",
            snippet: "summary",
            content: { content_format: null, cost: 0.02, data: "…full page text…" },
          },
        ],
        request_id: "req-slim",
      }),
    ]);

    const out = await takoAnswer.handler(
      { query: "US core CPI", sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );

    const content = out.cards[0]?.content as Record<string, unknown>;
    // Row payload dropped from all three shapes...
    expect(content.dataset).toBeNull();
    expect(content.records).toBeNull();
    expect(content.data).toBeNull();
    // ...but the "more data available, priced" signal + pointers survive.
    expect(content.total_rows).toBe(300);
    expect(content.content_format).toBe("json_compact");
    expect(out.cards[0]?.webpage_url).toBe("https://trytako.com/c/cpi-1");
    expect(out.cards[0]?.nodes).toHaveLength(1);
    // Web page text dropped; snippet/url kept.
    expect((out.web_results[0]?.content as Record<string, unknown>).data).toBeNull();
    expect(out.web_results[0]?.snippet).toBe("summary");
  });
});

describe("tako_answer series-in-first-response (the punt-and-retry fix)", () => {
  const CARD_300_ROWS = {
    card_id: "cpi-1",
    title: "US Core CPI",
    content: {
      content_format: "json_compact",
      cost: 0.001,
      total_rows: 300,
      truncated: true,
      dataset: {
        columns: [{ name: "Timestamp", type: "datetime" }, { name: "v", type: "number" }],
        rows: Array.from({ length: 300 }, (_v, i) => [`d${i}`, i]),
        total_rows: 300,
        truncated: true,
        ref: "cpi-ref",
        sources: [],
        provenance: "query",
      },
    },
  };

  it("defaults include_contents to true and preview_rows to the free inline allowance (20)", () => {
    // 20 mirrors the backend's CSV_FREE_ROWS inline cap — the server never
    // ships more than the account's allowance, so a larger default would
    // promise rows that never arrive (PR #179 review, comment C1).
    const parsed = takoAnswer.inputSchema.parse({ query: "x" });
    expect(parsed.include_contents).toBe(true);
    expect(parsed.preview_rows).toBe(20);
  });

  it("requests include_contents on the DATA source only; web stays pinned false", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "US GDP", sources: ["data", "web"] }),
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: { include_contents: true },
      web: { include_contents: false, snippet_max_chars: 2000 },
    });
  });

  it("keeps the preview_rows most-recent rows on cited cards instead of stripping them", async () => {
    // The teaser that triggers the cascade: "card exists, latest value 59.2%"
    // with the series absent. With include_contents on (the default), the
    // capped series must survive to the model.
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Core CPI was 2.6% in Jun 2026.",
        cards: [CARD_300_ROWS],
        web_results: [],
        request_id: "req-dense",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "US core CPI", preview_rows: 40 }),
      CTX,
    );
    const ds = (out.cards[0]?.content as { dataset: { rows: unknown[] } }).dataset;
    expect(ds.rows).toHaveLength(40);
    expect(ds.rows[39]).toEqual(["d299", 299]); // most-recent tail kept
    expect(out.guidance).toBeUndefined(); // cards grounded it — no verdict
  });

  it("zero data cards + data searched → deterministic 'not in the data index' guidance", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [{ title: "w", url: "https://example.com" }],
        request_id: "req-gap",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3" }),
      CTX,
    );
    // Web results ground the answer → the SOFT branch: the verdict scopes
    // itself to the data index instead of impugning a possibly-correct
    // web-cited answer (PR #179 review, comment C3).
    expect(out.guidance).toContain("ZERO curated data cards");
    expect(out.guidance).toContain("web-grounded only");
    expect(out.guidance).toContain("If the prose answers the question, use it as-is");
    expect(out.guidance).toContain("tako_available_data");
  });

  it("zero data cards AND zero web results → the hard anti-retry verdict", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [],
        request_id: "req-gap-hard",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3" }),
      CTX,
    );
    expect(out.guidance).toContain("zero web results");
    expect(out.guidance).toContain("Do NOT rephrase-and-retry");
    expect(out.guidance).not.toContain("web-grounded only");
    // The ban names what it is about. A flat "do not retry" reads as "stop
    // working", and on a web-shaped question one narrower ask is the right move.
    expect(out.guidance).toContain("hoping the same question lands a data series");
    expect(out.guidance).toMatch(/WEB axis only/);
  });

  // tako_answer synthesizes ONE answer per call, so a multi-entity web question
  // ("how does each of these handle X") returns one blended answer. Re-asking
  // the same broad question is the loop that does not converge; asking it once
  // per entity is not a retry at all. The guidance has to say so, or the
  // anti-retry sentence reads as "stop after one call".
  it("tells a web-grounded answer to DECOMPOSE rather than re-ask", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Per the docs, both support it.",
        cards: [],
        web_results: [{ title: "docs", url: "https://example.com/docs" }],
        request_id: "req-gap-web",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "how do these APIs handle pagination" }),
      CTX,
    );
    const g = out.guidance ?? "";
    expect(g).toContain("web-grounded only");
    expect(g).toContain("DECOMPOSE");
    expect(g).toMatch(/One narrow question per entity, provider or site/);
    // Scoped, not blanket: the ban is about hunting a data series.
    expect(g).toContain("do NOT rephrase-and-retry tako_answer for it");
  });

  // The default sources are ["data","web"], so this branch is only reached by a
  // caller who narrowed to ["data"] — meaning the web was never queried. The
  // verdict used to be built from `hasWebResults` alone and therefore claimed
  // "and no web results", reporting a second source's outcome from the first
  // source's evidence, then told the model to treat the metric as absent.
  it("does not claim the web came back empty when the web was never searched", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [],
        request_id: "req-gap-data-only",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3", sources: ["data"] }),
      CTX,
    );
    const g = out.guidance ?? "";
    expect(g).not.toContain("zero web results");
    expect(g).toContain("DATA source only");
    // Names the cheap next step instead of declaring the figure unavailable.
    expect(g).toMatch(/sources:\["data","web"\]/);
    expect(g).not.toMatch(/genuinely absent/);
  });

  it("no guidance on a web-only ask (no data verdict to render)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Some news summary.",
        cards: [],
        web_results: [{ title: "w", url: "https://example.com" }],
        request_id: "req-webonly",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "latest news", sources: ["web"] }),
      CTX,
    );
    expect(out.guidance).toBeUndefined();
  });
});
