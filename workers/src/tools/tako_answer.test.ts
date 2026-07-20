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
        sources: ["data", "web"],        country_code: "US",
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
        sources: ["data", "web"],        country_code: "US",
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
      web: { include_contents: false },
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
      { query: "obscure query", sources: ["tako"], country_code: "US", locale: "en-US", strict: false },
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
      { query: "test", sources: ["tako"], country_code: "US", locale: "en-US", strict: false },
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
      takoAnswer.handler({ query: "q", sources: ["tako", "web"], country_code: "US", locale: "en-US", strict: false }, CTX),
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
      { query: "q", sources: ["tako"], country_code: "US", locale: "en-US", strict: false },
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
      { query: "test", sources: ["tako"], country_code: "GB", locale: "en-GB", strict: false },
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
      query: "US GDP", sources: ["data", "web"],
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
      { query: "q", sources: ["data"],
        country_code: "US", locale: "en-US", strict: false },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });
});

describe("tako_answer strips inline row data (prose-first, fetch rows via tako_contents)", () => {
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
      { query: "US core CPI", sources: ["data", "web"], country_code: "US", locale: "en-US", strict: false },
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
