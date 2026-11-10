import { afterEach, describe, expect, it, vi } from "vitest";

import takoPersonEnrich from "./tako_person_enrich.js";
import { CTX, errorTextOf, inputKeys, listCard, OPT_IN_ONLY, surfaceMembership } from "./__enrich_test_helpers.js";
import { bodyOf, jsonResponse, mockFetchSequence, requestFrom } from "./__test_helpers.js";

const byEmail = { status: "matched", match_id: "pe_1", confidence: "exact", matched_on: "email", alternates: 0, unresolved: [], failed: [] };
const byName = { status: "matched", match_id: "pe_2", confidence: "ambiguous", matched_on: "name", alternates: 2, unresolved: [], failed: [] };
const failed = { status: "failed", alternates: 0, unresolved: [], failed: ["phone=+1 415 555 0100"] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_person_enrich", () => {
  it("is listed only when named in ?tools=, never on chatgpt, and never runs anonymously", () => {
    expect(surfaceMembership("tako_person_enrich")).toEqual(OPT_IN_ONLY);
  });

  it("takes items alone, 1 to 25, and rejects an unknown key at either level", () => {
    expect(inputKeys(takoPersonEnrich)).toEqual(["items"]);
    const item = { email: "a@b.co" };
    expect(takoPersonEnrich.inputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(takoPersonEnrich.inputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(takoPersonEnrich.inputSchema.safeParse({ items: Array.from({ length: 26 }, () => item) }).success).toBe(false);
    expect(takoPersonEnrich.inputSchema.safeParse({ items: [item], max_rows: 5 }).success).toBe(false);
    expect(takoPersonEnrich.inputSchema.safeParse({ items: [{ email: "a@b.co", domain: "b.co" }] }).success).toBe(false);
  });

  it("posts the items and nothing else", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [byEmail], card: listCard("1 person") })]);
    const items = [{ email: "a@b.co" }];
    await takoPersonEnrich.handler(takoPersonEnrich.inputSchema.parse({ items }), CTX);
    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(request.url).pathname).toBe("/api/v1/people/enrich");
    expect(await bodyOf(request)).toEqual({ items });
  });

  it("lines each result up with its item, a failed lookup included", async () => {
    mockFetchSequence([jsonResponse(200, { results: [byEmail, byName, failed], card: listCard("2 people") })]);
    const output = await takoPersonEnrich.handler(
      {
        items: [
          { email: "a@b.co" },
          { name: "Jo Doe", company_name: "Acme", title: "CFO" },
          { phone: "+1 415 555 0100" },
        ],
      },
      CTX,
    );
    expect(output.results.map((row) => [row.index, row.input, row.status, row.match_id])).toEqual([
      [0, { email: "a@b.co" }, "matched", "pe_1"],
      [1, { name: "Jo Doe", company_name: "Acme", title: "CFO" }, "matched", "pe_2"],
      [2, { phone: "+1 415 555 0100" }, "failed", undefined],
    ]);
    expect(output.results[1]).toMatchObject({ confidence: "ambiguous", alternates: 2 });
    expect(takoPersonEnrich.outputSchema.safeParse(output).success).toBe(true);
    const text = takoPersonEnrich.renderText(output, CTX);
    expect(text).toContain("## Results: 2 of 3 matched");
    expect(text).toContain("1. name=Jo Doe, company_name=Acme, title=CFO → matched · confidence ambiguous");
    expect(text).toContain("2. phone=+1 415 555 0100 → failed · failed, retry: phone=+1 415 555 0100");
  });

  it("returns a null card as no match, not as an error", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [{ status: "no_match", alternates: 0, unresolved: ["name=Nobody"], failed: [] }], card: null }),
    ]);
    const output = await takoPersonEnrich.handler({ items: [{ name: "Nobody" }] }, CTX);
    expect(output.card).toBeNull();
    expect(takoPersonEnrich.renderText(output, CTX)).toContain("No person matched, so there's no card.");
  });

  it("tells the model which item and value a 400 names", async () => {
    mockFetchSequence([
      jsonResponse(400, {
        error_message: "items.0.phone: Value error, isn't a valid phone number; give it with its country code, such as +1 415 555 0100",
        error_type: "BAD_REQUEST",
        code: "invalid_value",
        field: "items.0.phone",
        suggestions: [],
      }),
    ]);
    const text = await errorTextOf(() => takoPersonEnrich.handler({ items: [{ phone: "555" }] }, CTX));
    expect(text).toContain("`items.0.phone` (invalid_value)");
    expect(text).toContain("give it with its country code");
  });

  it("tells the model why a 403 refused the call", async () => {
    mockFetchSequence([
      jsonResponse(403, {
        error_message: "Your account doesn't have access to People Data Labs data, which these endpoints serve.",
        error_type: "FORBIDDEN",
      }),
    ]);
    const text = await errorTextOf(() => takoPersonEnrich.handler({ items: [{ email: "a@b.co" }] }, CTX));
    expect(text).toContain("doesn't have access to People Data Labs data");
  });

  it("says in its description what each result and the card carry", () => {
    const text = takoPersonEnrich.description;
    expect(text.split("\n")[0]).toMatch(/^Match up to 25 known people/);
    expect(text.split("\n")[2]).toMatch(/^Use to /);
    for (const field of ["status (matched, no_match, failed)", "confidence (exact, high, ambiguous)", "work_email*", "phone*", "experience"]) {
      expect(text, field).toContain(field);
    }
    expect(text).not.toMatch(/\$|credit|price/i);
  });
});
