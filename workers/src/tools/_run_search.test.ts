/**
 * `runSearch`'s endpoint branch — the part that cannot be tested through either
 * tool's schema, because both tools reach the same function and only the
 * endpoint argument differs.
 *
 * The load-bearing case is the wire guard. `SearchResponse` is a bare
 * `z.object`, so it STRIPS unknown keys: guarding an /v1/answer payload with it
 * returns a working search response with the synthesis silently gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import { jsonResponse, mockFetchSequence, noopSendProgress, requestFrom } from "./__test_helpers.js";
import { runSearch } from "./_run_search.js";
import type { ToolContext } from "./types.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  surface: "generic",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runSearch on the answer endpoint", () => {
  it("POSTs /api/v1/answer/ and keeps the answer — SearchResponse would strip it", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        answer: "US GDP was $29T in 2024.",
        cards: [],
        web_results: [],
        request_id: "req-a",
        structured_output: { gdp_usd_trillions: 29 },
      }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "US GDP 2024" } }, ["data", "web"], null, CTX, "tako_search_advanced");
    expect(requestFrom(fetchMock.mock.calls[0]).url).toContain("/api/v1/answer/");
    expect(out.answer).toBe("US GDP was $29T in 2024.");
    expect(out.structured_output).toEqual({ gdp_usd_trillions: 29 });
  });

  it("surfaces structured_output_error", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "x",
        cards: [],
        web_results: [],
        request_id: "r",
        structured_output_error: { code: "arbiter_failed", message: "no evidence" },
      }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "q" } }, ["data", "web"], null, CTX, "tako_search_advanced");
    expect(out.structured_output_error).toEqual({ code: "arbiter_failed", message: "no evidence" });
  });

  it("zero data cards with web grounding gives the soft data-index verdict, not the search verdict", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [{ title: "w", url: "https://example.com" }],
        request_id: "req-gap",
      }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "hotel RevPAR Q3" } }, ["data", "web"], null, CTX, "tako_search_advanced");
    expect(out.guidance).toContain("No data cards ground this answer");
    expect(out.guidance).toContain("web-grounded only");
    expect(out.guidance).toContain("use the prose if it answers the question");
  });

  it("zero data cards AND zero web results gives the hard anti-retry verdict", async () => {
    mockFetchSequence([
      jsonResponse(200, { answer: "I couldn't find that.", cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "hotel RevPAR Q3" } }, ["data", "web"], null, CTX, "tako_search_advanced");
    expect(out.guidance).toContain("Neither data cards nor web results");
    expect(out.guidance).toContain("rewording alone will not change that");
    // The carve-out on the hardest stop: one narrower WEB attempt is still
    // allowed. Without it the two arms disagree about the single most common
    // Tako-has-nothing path — see the carve-out in buildDataGapGuidance.
    expect(out.guidance).toMatch(/genuinely narrower web question/);
  });

  it("data-only ask with zero cards says nothing about web coverage", async () => {
    // One source's evidence must never produce two sources' worth of verdict.
    mockFetchSequence([
      jsonResponse(200, { answer: "I couldn't find that.", cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "q", sources: { data: {} } } }, ["data"], null, CTX, "tako_search_advanced");
    expect(out.guidance).toContain("searched the data source only");
    expect(out.guidance).not.toMatch(/nor web results/);
  });

  it("a strict pin returning zero cards is a filter artefact, on the answer path too", async () => {
    mockFetchSequence([
      jsonResponse(200, { answer: "Nothing.", cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch(
      { endpoint: "answer", body: { query: "q", sources: { data: { node_ids: ["mt::x"], strict: true } } } },
      ["data"],
      null,
      CTX,
      "tako_search_advanced",
    );
    expect(out.guidance).toContain("hard filter");
    expect(out.guidance).not.toContain("ZERO curated data cards");
  });

  it("refuses output_schema on the search branch, which no type can reject", async () => {
    // `SearchCall` groups the endpoint with its body, but an answer body is
    // still ASSIGNABLE to `z.input<typeof SearchRequest>` — TypeScript does not
    // reject extra properties on assignment from a variable, and `.strict()` is
    // a runtime rule. Without this check the pair reaches /v3/search and comes
    // back a paid 400 on an unknown key.
    await expect(
      runSearch(
        {
          endpoint: "search",
          body: { query: "q", output_schema: { type: "object" } } as never,
        },
        ["data"],
        null,
        CTX,
        "tako_search_advanced",
      ),
    ).rejects.toThrow(/output_schema rides the answer endpoint only/);
  });

  it("keeps the backend's card order when the prose cites by position", async () => {
    // `data_freshness` is a DataFreshness OBJECT on the wire, not a string —
    // AnswerResponse rejects the string form, so the fixture has to be real.
    const fresh = { card_id: "fresh", title: "Fresh", data_freshness: { data_as_of: "2026-06-30" } };
    const stale = { card_id: "stale", title: "Stale", data_freshness: { data_as_of: "2020-01-01" } };
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Revenue was $60.9B [1].",
        cards: [stale, fresh],
        web_results: [],
        request_id: "r",
      }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "q" } }, ["data"], null, CTX, "tako_search_advanced");
    // [1] refers to `stale`; reordering would silently repoint the citation.
    // Projected cards carry no card_id — the title is the identity here.
    expect(out.cards.map((c) => c.title)).toEqual(["Stale", "Fresh"]);
  });

  it("orders by usefulness when the prose carries no positional markers", async () => {
    // `data_freshness` is a DataFreshness OBJECT on the wire, not a string —
    // AnswerResponse rejects the string form, so the fixture has to be real.
    const fresh = { card_id: "fresh", title: "Fresh", data_freshness: { data_as_of: "2026-06-30" } };
    const stale = { card_id: "stale", title: "Stale", data_freshness: { data_as_of: "2020-01-01" } };
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Revenue was $60.9B.",
        cards: [stale, fresh],
        web_results: [],
        request_id: "r",
      }),
    ]);
    const out = await runSearch({ endpoint: "answer", body: { query: "q" } }, ["data"], null, CTX, "tako_search_advanced");
    expect(out.cards.map((c) => c.title)).toEqual(["Fresh", "Stale"]);
  });
});

describe("runSearch on the search endpoint", () => {
  it("POSTs /api/v3/search/ and emits no answer field", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch({ endpoint: "search", body: { query: "q" } }, ["data", "web"], null, CTX, "tako_search_advanced");
    expect(requestFrom(fetchMock.mock.calls[0]).url).toContain("/api/v3/search/");
    expect(out).not.toHaveProperty("answer");
  });
});
