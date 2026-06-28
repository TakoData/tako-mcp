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
import takoAnswer from "./tako_answer.js";
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

describe("tako_answer handler", () => {
  it("tool name is tako_answer", () => {
    expect(takoAnswer.name).toBe("tako_answer");
  });

  it("maps query + sources to the per-source sources object, hits /api/v1/answer/", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await takoAnswer.handler(
      {
        query: "What was US GDP in 2024?",
        sources: ["data", "web"],
        include_contents: false,
        country_code: "US",
        locale: "en-US",
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
      { query: "obscure query", sources: ["data"], include_contents: false, country_code: "US", locale: "en-US" },
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
      { query: "test", sources: ["data"], include_contents: false, country_code: "US", locale: "en-US" },
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
      takoAnswer.handler({ query: "q", sources: ["data", "web"], include_contents: false, country_code: "US", locale: "en-US" }, CTX),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("tako_answer input schema", () => {
  it("defaults sources to both tako and web", () => {
    const parsed = takoAnswer.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toEqual(["data", "web"]);
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
      { query: "test", sources: ["data"], include_contents: false, country_code: "GB", locale: "en-GB" },
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
