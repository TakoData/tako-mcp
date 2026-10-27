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
import { WITHHELD_CELLS_GUIDANCE } from "./_search_results.js";
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
    const out = await runSearch({ endpoint: "answer", body: { query: "US GDP 2024" } }, null, CTX, "tako_search_advanced");
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
    const out = await runSearch({ endpoint: "answer", body: { query: "q" } }, null, CTX, "tako_search_advanced");
    expect(out.structured_output_error).toEqual({ code: "arbiter_failed", message: "no evidence" });
  });

  it("zero data cards carry no guidance, whatever the web returned", async () => {
    for (const [sources, web_results] of [
      [undefined, [{ title: "w", url: "https://example.com" }]],
      [undefined, []],
      [{ data: {} }, []],
    ] as const) {
      mockFetchSequence([
        jsonResponse(200, { answer: "I couldn't find that.", cards: [], web_results, request_id: "r" }),
      ]);
      const out = await runSearch(
        { endpoint: "answer", body: { query: "hotel RevPAR Q3", ...(sources ? { sources } : {}) } },
        null,
        CTX,
        "tako_search_advanced",
      );
      expect(out.guidance, `sources=${JSON.stringify(sources)} web=${web_results.length}`).toBeUndefined();
    }
  });

  it("a strict pin returning zero cards is a filter artefact, on the answer path too", async () => {
    mockFetchSequence([
      jsonResponse(200, { answer: "Nothing.", cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch(
      { endpoint: "answer", body: { query: "q", sources: { data: { node_ids: ["mt::x"], strict: true } } } },
      null,
      CTX,
      "tako_search_advanced",
    );
    expect(out.guidance).toContain("hard filter");
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
        null,
        CTX,
        "tako_search_advanced",
      ),
    ).rejects.toThrow(/output_schema rides the answer endpoint only/);
  });

  it("keeps the backend's card order", async () => {
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
    const out = await runSearch({ endpoint: "answer", body: { query: "q" } }, null, CTX, "tako_search_advanced");
    expect(out.cards.map((c) => c.title)).toEqual(["Stale", "Fresh"]);
  });
});

describe("runSearch withheld-cells guidance", () => {
  const peopleCard = {
    card_id: "people",
    title: "Jane Doe",
    content: { cost: 0.001, total_rows: 2, truncated: false, premium: false, premium_rows: { person_contact: 2 } },
  };
  const search = (registeredTools: ReadonlySet<string>, surface: ToolContext["surface"] = "generic") => {
    mockFetchSequence([jsonResponse(200, { cards: [peopleCard], web_results: [], request_id: "r" })]);
    return runSearch({ endpoint: "search", body: { query: "Jane Doe" } }, null, { ...CTX, surface, registeredTools }, "tako_search");
  };

  it("points to tako_contents premium when the connection registers tako_contents", async () => {
    const out = await search(new Set(["tako_search", "tako_contents"]));
    expect(out.guidance).toBe(WITHHELD_CELLS_GUIDANCE);
  });

  it("gives /mcp/chatgpt the same premium guidance as /mcp", async () => {
    const out = await search(new Set(["tako_search", "tako_contents"]), "chatgpt");
    expect(out.guidance).toBe(WITHHELD_CELLS_GUIDANCE);
  });

  it("names no tako_contents on a connection that registers tako_search alone", async () => {
    const out = await search(new Set(["tako_search"]));
    expect(out.guidance).toBeUndefined();
  });
});

describe("runSearch on the search endpoint", () => {
  it("POSTs /api/v3/search/ and emits no answer field", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await runSearch({ endpoint: "search", body: { query: "q" } }, null, CTX, "tako_search_advanced");
    expect(requestFrom(fetchMock.mock.calls[0]).url).toContain("/api/v3/search/");
    expect(out).not.toHaveProperty("answer");
  });

  it("flat mode empties the two lists runSearch reads", async () => {
    // THE REASON `output_settings.flat_results` IS WITHHELD from
    // tako_search_advanced's input schema. Not a behavior anyone wants — a
    // record of what selecting the mode costs, so the omission cannot outlive
    // it. `wire.results` is the only place the rows exist and nothing here
    // reads it, so the caller pays for a search and gets an empty projection.
    //
    // WHEN THIS FAILS, runSearch has learned to read `wire.results`. That is
    // the signal to expose the field in tako_search_advanced.ts — with a
    // FLAT_RESULTS_DESCRIBES override, because the generated `max_results`
    // describe is 610 chars against gen-registry's 320-char cap — and to
    // rewrite this test into the mapping's coverage.
    //
    // The wire payload is the shape tako's api_surface contract test
    // (test_search_semantics.py, "flat mode must empty cards") asserts the
    // backend returns.
    mockFetchSequence([
      jsonResponse(200, {
        cards: [],
        web_results: [],
        results: [
          { type: "data", title: "US CPI", url: "https://trytako.com/c/1", relevance: "High" },
          { type: "web", title: "CPI report", url: "https://bls.gov/cpi" },
        ],
        request_id: "r",
      }),
    ]);
    const out = await runSearch(
      { endpoint: "search", body: { query: "q", output_settings: { flat_results: {} } } },
      null,
      CTX,
      "tako_search_advanced",
    );
    expect(out.cards, "runSearch reads wire.results now: revisit the flat_results omission").toEqual([]);
    expect(out.web_results, "runSearch reads wire.results now: revisit the flat_results omission").toEqual([]);
  });
});
