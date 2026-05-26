/**
 * Tests for the `grounding` tool.
 *
 * The handler is a single POST + re-parse: it maps the tool input onto
 * the backend's `/api/v1/grounding/` request body and re-validates the
 * response through the output schema. The interesting behavior is the
 * request mapping (`query`→`inputs.text`, `sources`→`source_indexes`),
 * the defensive defaulting of missing fields, and the loud failure on a
 * mis-shaped backend payload.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import grounding from "./grounding.js";
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
  tako_selected: true,
  confidence: 4,
  knowledge_cards: [{ card_id: "abc123", title: "US GDP" }],
  sources: [
    { source_name: "World Bank", source_index: "tako", url: "https://data.worldbank.org" },
  ],
  web_results: [
    { title: "US GDP 2024", url: "https://example.com/gdp", snippet: "…" },
  ],
  request_id: "req-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grounding handler", () => {
  it("maps query→inputs.text and sources→source_indexes, hits /api/v1/grounding/", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await grounding.handler(
      {
        query: "What was US GDP in 2024?",
        sources: ["tako", "web"],
        country_code: "US",
        locale: "en-US",
      },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toBe("https://staging.trytako.com/api/v1/grounding/");
    const body = await bodyOf(req);
    expect(body.inputs).toEqual({ text: "What was US GDP in 2024?" });
    expect(body.source_indexes).toEqual(["tako", "web"]);
    expect(body.country_code).toBe("US");
    expect(body.locale).toBe("en-US");

    expect(out.answer).toContain("$29 trillion");
    expect(out.tako_selected).toBe(true);
    expect(out.confidence).toBe(4);
    expect(out.knowledge_cards).toHaveLength(1);
    expect(out.sources[0]?.source_name).toBe("World Bank");
    expect(out.web_results).toHaveLength(1);
    expect(out.request_id).toBe("req-1");
  });

  it("defaults missing optional fields rather than leaking undefined", async () => {
    // A minimal valid backend payload — only the required scalars. The
    // handler should default knowledge_cards/sources to [] and
    // web_results to null.
    mockFetchSequence([
      jsonResponse(200, {
        answer: "No strong match.",
        tako_selected: false,
        confidence: 2,
        request_id: "req-2",
      }),
    ]);

    const out = await grounding.handler(
      { query: "obscure query", sources: ["tako"], country_code: "US", locale: "en-US" },
      CTX,
    );

    expect(out.knowledge_cards).toEqual([]);
    expect(out.sources).toEqual([]);
    expect(out.web_results).toBeNull();
    expect(out.tako_selected).toBe(false);
    expect(out.confidence).toBe(2);
  });

  it("throws an actionable error when confidence is out of the 1-5 range (contract breach)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "x",
        tako_selected: true,
        confidence: 9,
        request_id: "req-3",
      }),
    ]);

    await expect(
      grounding.handler(
        { query: "q", sources: ["tako", "web"], country_code: "US", locale: "en-US" },
        CTX,
      ),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("grounding input schema", () => {
  it("defaults sources to both tako and web", () => {
    const parsed = grounding.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toEqual(["tako", "web"]);
    expect(parsed.country_code).toBe("US");
    expect(parsed.locale).toBe("en-US");
  });

  it("rejects an empty sources array", () => {
    expect(() =>
      grounding.inputSchema.parse({ query: "hello", sources: [] }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      grounding.inputSchema.parse({ query: "hello", sources: ["bing"] }),
    ).toThrow();
  });
});
