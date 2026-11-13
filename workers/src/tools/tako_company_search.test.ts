import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanySearchRequest } from "../generated/schemas.js";
import { WITHHELD_CELLS_GUIDANCE } from "./_search_results.js";
import takoCompanySearch from "./tako_company_search.js";
import { CTX, errorTextOf, inputKeys, listCard, OPT_IN_ONLY, surfaceMembership } from "./__enrich_test_helpers.js";
import { bodyOf, inputPropertyDescription, jsonResponse, mockFetchSequence, requestFrom } from "./__test_helpers.js";

const response = (card: unknown, extra: Record<string, unknown> = {}) => ({
  card,
  total: 12,
  total_is_lower_bound: false,
  applied: ["industry=Financial services", "region=New York, US"],
  notes: [],
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_company_search", () => {
  it("is listed only when named in ?tools=, never on chatgpt, and never runs anonymously", () => {
    expect(surfaceMembership("tako_company_search")).toEqual(OPT_IN_ONLY);
  });

  it("takes every request field except the three that inline rows", () => {
    const expected = Object.keys(CompanySearchRequest.shape)
      .filter((key) => !["include_contents", "max_rows", "content_format"].includes(key))
      .sort();
    expect(inputKeys(takoCompanySearch)).toEqual(expected);
    expect(expected).toContain("industry");
  });

  it("rejects an unknown key, the contents fields included", () => {
    expect(takoCompanySearch.inputSchema.safeParse({ country: "US", include_contents: true }).success).toBe(false);
    expect(takoCompanySearch.inputSchema.safeParse({ country: "US", max_rows: 5 }).success).toBe(false);
    expect(takoCompanySearch.inputSchema.safeParse({ country: "US", revenue: 5 }).success).toBe(false);
  });

  it("posts only the filters the caller set", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, response(listCard("Series B fintechs")))]);
    const input = takoCompanySearch.inputSchema.parse({
      industry: "fintech",
      region: "New York",
      country: "US",
      funding_stages: ["series_b"],
      order_by: "-employees",
    });
    await takoCompanySearch.handler(input, CTX);
    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(request.url).pathname).toBe("/api/v1/companies/search");
    expect(request.method).toBe("POST");
    expect(await bodyOf(request)).toEqual({
      industry: "fintech",
      region: "New York",
      country: "US",
      funding_stages: ["series_b"],
      order_by: "-employees",
    });
  });

  it("posts a person's Tako link as person_id, its only filter, to list their employers", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, response(listCard("Jo Doe's employers")))]);
    const link = "https://tako.com/card/pe_4kTqZ2vYb8LmN0pRs7WxAa/";
    await takoCompanySearch.handler(takoCompanySearch.inputSchema.parse({ person_id: link }), CTX);
    expect(await bodyOf(requestFrom(fetchMock.mock.calls[0]))).toEqual({ person_id: link });
  });

  it("sends no default the caller didn't choose", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, response(null, { total: 0 }))]);
    await takoCompanySearch.handler(takoCompanySearch.inputSchema.parse({ country: "US" }), CTX);
    expect(await bodyOf(requestFrom(fetchMock.mock.calls[0]))).toEqual({ country: "US" });
  });

  it("returns the response's fields and the projected card", async () => {
    mockFetchSequence([jsonResponse(200, response(listCard("Series B fintechs")))]);
    const output = await takoCompanySearch.handler({ industry: "fintech" }, CTX);
    expect(output).toEqual({
      total: 12,
      total_is_lower_bound: false,
      applied: ["industry=Financial services", "region=New York, US"],
      notes: [],
      card: {
        exportable: true,
        title: "Series B fintechs",
        description: "Series B fintechs.\n\n| Name |\n| --- |\n| First row |",
        url: "https://tako.com/card/abc/",
        total_rows: 12,
        source: "People Data Labs",
      },
    });
    expect(takoCompanySearch.outputSchema.safeParse(output).success).toBe(true);
    expect(takoCompanySearch.renderText(output, CTX)).toContain("url: https://tako.com/card/abc/");
  });

  it("passes on the premium guidance when the card withholds cells", async () => {
    const card = { ...listCard("Fintechs"), content: { total_rows: 12, premium: false, premium_rows: { company_record: 4 } } };
    mockFetchSequence([jsonResponse(200, response(card))]);
    const output = await takoCompanySearch.handler({ industry: "fintech" }, CTX);
    expect(output.guidance).toBe(WITHHELD_CELLS_GUIDANCE);
    expect(takoCompanySearch.renderText(output, CTX)).toContain(`> ${WITHHELD_CELLS_GUIDANCE}`);
  });

  it("returns a null card as no matches, not as an error", async () => {
    mockFetchSequence([jsonResponse(200, response(null, { total: 0, applied: ["country=AQ"] }))]);
    const output = await takoCompanySearch.handler({ country: "AQ" }, CTX);
    expect(output.card).toBeNull();
    expect(output.total).toBe(0);
    expect(takoCompanySearch.renderText(output, CTX)).toContain("## No companies match");
  });

  it("tells the model which field a 400 names, and the suggestions", async () => {
    mockFetchSequence([
      jsonResponse(400, {
        error_message: "No Tako industry matches 'fintek'.",
        error_type: "BAD_REQUEST",
        code: "unknown_industry",
        field: "industry",
        suggestions: ["fintech", "insurtech"],
      }),
    ]);
    const text = await errorTextOf(() => takoCompanySearch.handler({ industry: "fintek" }, CTX));
    expect(text).toBe(
      "Tako can't run `industry` (unknown_industry): No Tako industry matches 'fintek'. Closest values: fintech, insurtech. Fix the input and call again.",
    );
  });

  it("tells the model why a 403 refused the call", async () => {
    mockFetchSequence([
      jsonResponse(403, { error_message: "The enrichment API isn't open to customers right now.", error_type: "FORBIDDEN" }),
    ]);
    const text = await errorTextOf(() => takoCompanySearch.handler({ country: "US" }, CTX));
    expect(text).toContain("The enrichment API isn't open to customers right now.");
    expect(text).toContain("don't retry");
  });

  it("fails on a response that lost a field, instead of reporting no matches", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetchSequence([jsonResponse(200, { card: null, applied: [], notes: [] })]);
    await expect(takoCompanySearch.handler({ country: "US" }, CTX)).rejects.toThrow(/unexpected shape/);
  });

  it("says in its description what it returns and what it can't do", () => {
    const text = takoCompanySearch.description;
    expect(text.split("\n")[0]).toMatch(/^Screen active companies/);
    expect(text.split("\n")[2]).toMatch(/^Use to /);
    for (const field of ["estimated_revenue*", "linkedin_followers*", "parent*", "subsidiaries*", "naics_codes", "tako_url"]) {
      expect(text, field).toContain(field);
    }
    expect(text).toContain("`total` stops at 500");
    expect(text).toContain("can't filter or sort by revenue");
    expect(text).not.toMatch(/\$|credit|price/i);
  });

  it("describes industry as a name, alias or id, with no other tool or call to make first", () => {
    const industry = inputPropertyDescription(takoCompanySearch.inputSchema, "industry") ?? "";
    expect(industry).toContain("name, alias or id");
    expect(industry).not.toMatch(/facets|\/api\//);
  });
});
