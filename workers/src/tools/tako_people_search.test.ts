import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonSearchRequest } from "../generated/schemas.js";
import takoPeopleSearch from "./tako_people_search.js";
import { CTX, errorTextOf, inputKeys, listCard, OPT_IN_ONLY, surfaceMembership } from "./__enrich_test_helpers.js";
import { bodyOf, inputPropertyDescription, jsonResponse, mockFetchSequence, requestFrom } from "./__test_helpers.js";

const response = (card: unknown, extra: Record<string, unknown> = {}) => ({
  card,
  total: 500,
  total_is_lower_bound: true,
  applied: ["role=head of sales"],
  unresolved: [],
  failed: [],
  notes: [],
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_people_search", () => {
  it("is listed only when named in ?tools=, never on chatgpt, and never runs anonymously", () => {
    expect(surfaceMembership("tako_people_search")).toEqual(OPT_IN_ONLY);
  });

  it("takes every request field except the three that inline rows", () => {
    const expected = Object.keys(PersonSearchRequest.shape)
      .filter((key) => !["include_contents", "max_rows", "content_format"].includes(key))
      .sort();
    expect(inputKeys(takoPeopleSearch)).toEqual(expected);
    expect(expected).toContain("company_industry");
  });

  it("rejects an unknown key, the contents fields included", () => {
    expect(takoPeopleSearch.inputSchema.safeParse({ role: ["cfo"], include_contents: true }).success).toBe(false);
    expect(takoPeopleSearch.inputSchema.safeParse({ role: ["cfo"], content_format: "csv" }).success).toBe(false);
  });

  it("posts only the filters the caller set", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, response(listCard("Heads of sales in Texas")))]);
    const input = takoPeopleSearch.inputSchema.parse({
      role: ["head of sales"],
      person_region: "Texas",
      company_industry: "fintech",
      company_domains: ["stripe.com"],
    });
    await takoPeopleSearch.handler(input, CTX);
    const request = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(request.url).pathname).toBe("/api/v1/people/search");
    expect(await bodyOf(request)).toEqual({
      role: ["head of sales"],
      person_region: "Texas",
      company_industry: "fintech",
      company_domains: ["stripe.com"],
    });
  });

  it("returns the count as a lower bound, with unresolved and failed inputs", async () => {
    mockFetchSequence([
      jsonResponse(
        200,
        response(listCard("Heads of sales"), { unresolved: ["company_domains=nope.example"], failed: ["emails=a@b.co"] }),
      ),
    ]);
    const output = await takoPeopleSearch.handler({ role: ["head of sales"] }, CTX);
    expect(output).toMatchObject({
      total: 500,
      total_is_lower_bound: true,
      unresolved: ["company_domains=nope.example"],
      failed: ["emails=a@b.co"],
      card: { url: "https://tako.com/card/abc/", total_rows: 12 },
    });
    expect(takoPeopleSearch.outputSchema.safeParse(output).success).toBe(true);
    const text = takoPeopleSearch.renderText(output, CTX);
    expect(text).toContain("## people: at least 500");
    expect(text).toContain("company_domains=nope.example");
    expect(text).toContain("emails=a@b.co");
  });

  it("returns a null card as no matches, not as an error", async () => {
    mockFetchSequence([jsonResponse(200, response(null, { total: 0, total_is_lower_bound: false }))]);
    const output = await takoPeopleSearch.handler({ role: ["chief yak officer"] }, CTX);
    expect(output.card).toBeNull();
    expect(takoPeopleSearch.renderText(output, CTX)).toContain("## No people match");
  });

  it("points a contacts-only 400 at a tool the connection has, never at a REST path", async () => {
    const body = {
      error_message:
        "Contact identifiers narrow a search; add at least one other filter. To look people up by email, phone or LinkedIn URL, use POST /api/v1/people/enrich.",
      error_type: "BAD_REQUEST",
      code: "contacts_need_a_filter",
      field: "emails",
      suggestions: [],
    };
    mockFetchSequence([jsonResponse(400, body), jsonResponse(400, body)]);
    const withEnrich = { ...CTX, registeredTools: new Set(["tako_people_search", "tako_person_enrich"]) };
    const named = await errorTextOf(() => takoPeopleSearch.handler({ emails: ["a@b.co"] }, withEnrich));
    expect(named).toContain("`emails` (contacts_need_a_filter)");
    expect(named).toContain("use `tako_person_enrich`.");
    const plain = await errorTextOf(() => takoPeopleSearch.handler({ emails: ["a@b.co"] }, CTX));
    expect(plain).not.toMatch(/tako_person_enrich|\/api\//);
  });

  it("passes a 503's advice through instead of a bare status", async () => {
    mockFetchSequence([
      jsonResponse(503, {
        error_message: "The filters' lookups didn't finish in time. Pass fewer values and try again.",
        error_type: "SERVICE_UNAVAILABLE",
      }),
    ]);
    const text = await errorTextOf(() => takoPeopleSearch.handler({ role: ["cfo"] }, CTX));
    expect(text).toBe("The filters' lookups didn't finish in time. Pass fewer values and try again.");
  });

  it("says in its description what it returns", () => {
    const text = takoPeopleSearch.description;
    expect(text.split("\n")[0]).toMatch(/^Screen employees/);
    expect(text.split("\n")[2]).toMatch(/^Use to /);
    for (const field of ["work_email*", "phone*", "personal_email*", "all_emails*", "skills", "employer_{industry"]) {
      expect(text, field).toContain(field);
    }
    expect(text).toContain("except schools");
    expect(text).toContain("`total` stops at 500");
    expect(text).not.toMatch(/\$|credit|price/i);
  });

  it("describes every input, and company_industry as a name, alias or id", () => {
    for (const key of inputKeys(takoPeopleSearch)) {
      expect(inputPropertyDescription(takoPeopleSearch.inputSchema, key) ?? "", key).not.toBe("");
    }
    const industry = inputPropertyDescription(takoPeopleSearch.inputSchema, "company_industry") ?? "";
    expect(industry).toContain("name, alias or id");
    expect(industry).not.toMatch(/facets|\/api\//);
  });
});
