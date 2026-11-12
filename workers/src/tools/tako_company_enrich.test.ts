import { afterEach, describe, expect, it, vi } from "vitest";

import takoCompanyEnrich from "./tako_company_enrich.js";
import { CTX, errorTextOf, inputKeys, listCard, OPT_IN_ONLY, surfaceMembership } from "./__enrich_test_helpers.js";
import { bodyOf, jsonResponse, mockFetchSequence, requestFrom } from "./__test_helpers.js";

const matched = { status: "matched", match_id: "co_1", confidence: "exact", matched_on: "domain", alternates: 0, unresolved: [], failed: [] };
const missed = { status: "no_match", match_id: null, confidence: null, matched_on: null, alternates: 0, unresolved: ["name=Nope Co"], failed: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_company_enrich", () => {
  it("is listed only when named in ?tools=, never on chatgpt, and never runs anonymously", () => {
    expect(surfaceMembership("tako_company_enrich")).toEqual(OPT_IN_ONLY);
  });

  it("takes items alone, 1 to 25, and rejects an unknown key at either level", () => {
    expect(inputKeys(takoCompanyEnrich)).toEqual(["items"]);
    const item = { domain: "stripe.com" };
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: Array.from({ length: 25 }, () => item) }).success).toBe(true);
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: Array.from({ length: 26 }, () => item) }).success).toBe(false);
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: [item], include_contents: true }).success).toBe(false);
    expect(takoCompanyEnrich.inputSchema.safeParse({ items: [{ domain: "stripe.com", ticker: "X" }] }).success).toBe(false);
  });

  it("posts the items and nothing else", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [matched, missed], card: listCard("2 companies") })]);
    const items = [{ domain: "stripe.com" }, { name: "Nope Co", country: "US" }];
    await takoCompanyEnrich.handler(takoCompanyEnrich.inputSchema.parse({ items }), CTX);
    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(request.url).pathname).toBe("/api/v1/companies/enrich");
    expect(await bodyOf(request)).toEqual({ items });
  });

  it("posts an item named only by its id or Tako link", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [matched, matched], card: listCard("2 companies") })]);
    const items = [{ id: "co_4kTqZ2vYb8LmN0pRs7WxAa" }, { id: "/card/co_0000000000000000000001/" }];
    await takoCompanyEnrich.handler(takoCompanyEnrich.inputSchema.parse({ items }), CTX);
    expect(await bodyOf(requestFrom(fetchMock.mock.calls[0]))).toEqual({ items });
  });

  it("lines each result up with its item, in request order", async () => {
    mockFetchSequence([jsonResponse(200, { results: [matched, missed], card: listCard("1 company") })]);
    const output = await takoCompanyEnrich.handler(
      { items: [{ domain: "stripe.com" }, { name: "Nope Co", country: "US" }] },
      CTX,
    );
    expect(output.results).toEqual([
      {
        index: 0, input: { domain: "stripe.com" }, status: "matched", match_id: "co_1", confidence: "exact",
        matched_on: "domain", alternates: 0, unresolved: [], failed: [],
      },
      {
        index: 1, input: { name: "Nope Co", country: "US" }, status: "no_match", alternates: 0,
        unresolved: ["name=Nope Co"], failed: [],
      },
    ]);
    expect(output.card).toMatchObject({ title: "1 company", url: "https://tako.com/card/abc/" });
    expect(takoCompanyEnrich.outputSchema.safeParse(output).success).toBe(true);
    const text = takoCompanyEnrich.renderText(output, CTX);
    expect(text).toContain("## Results: 1 of 2 matched");
    expect(text).toContain("0. domain=stripe.com → matched");
    expect(text).toContain("1. name=Nope Co, country=US → no_match · unresolved: name=Nope Co");
  });

  it("returns a missing card as no match, not as an error", async () => {
    mockFetchSequence([jsonResponse(200, { results: [missed] })]);
    const output = await takoCompanyEnrich.handler({ items: [{ name: "Nope Co" }] }, CTX);
    expect(output.card).toBeNull();
    expect(takoCompanyEnrich.renderText(output, CTX)).toContain("No company matched, so there's no card.");
  });

  it("fails when the results don't cover the items one for one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetchSequence([jsonResponse(200, { results: [matched], card: null })]);
    await expect(
      takoCompanyEnrich.handler({ items: [{ domain: "a.com" }, { domain: "b.com" }] }, CTX),
    ).rejects.toThrow(/unexpected shape/);
  });

  it("tells the model which item a 400 names", async () => {
    mockFetchSequence([
      jsonResponse(400, {
        error_message: "items.1: Value error, give at least one of domain, name or linkedin_url",
        error_type: "BAD_REQUEST",
        code: "invalid_value",
        field: "items.1",
        suggestions: [],
      }),
    ]);
    const text = await errorTextOf(() =>
      takoCompanyEnrich.handler({ items: [{ domain: "a.com" }, { city: "Paris" }] }, CTX),
    );
    expect(text).toContain("`items.1` (invalid_value)");
    expect(text).toContain("give at least one of domain, name or linkedin_url");
  });

  it("says in its description what each result and the card carry", () => {
    const text = takoCompanyEnrich.description;
    expect(text.split("\n")[0]).toMatch(/^Match up to 25 known companies/);
    expect(text.split("\n")[2]).toMatch(/^Use to /);
    for (const field of ["status (matched, no_match, failed)", "confidence (exact, high, ambiguous)", "match_id", "matched_on", "alternates", "estimated_revenue*", "funding_rounds"]) {
      expect(text, field).toContain(field);
    }
    expect(text).not.toMatch(/\$|credit|price/i);
  });
});
