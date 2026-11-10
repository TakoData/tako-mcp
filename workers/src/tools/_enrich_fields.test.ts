import { describe, expect, it } from "vitest";

import {
  COMPANY_LIST_FIELDS,
  describeListFields,
  joinFieldKeys,
  type ListCardFields,
  PERSON_LIST_FIELDS,
  previewLabels,
  rowColumns,
} from "./_enrich_fields.js";

// The `columns` that `tako_contents` returned for one card of each kind on
// production, 2026-11-10, and the header of the table in each card's
// description. Recorded by hand, so these fail when someone edits a constant
// without checking the API; `scripts/smoke.ts` checks the API itself.
const COMPANY_ROW_COLUMNS = [
  "name", "status", "company_type", "estimated_revenue", "headcount", "linkedin_followers", "industry",
  "funding_stage", "total_raised", "location", "website", "linkedin_url", "ticker", "established", "parent",
  "subsidiaries", "description", "headcount_range", "tags", "metro", "naics_codes", "postcode",
  "funding_round_count", "funding_rounds", "sic_codes", "also_known_as", "other_domains", "street_address",
  "twitter_url", "facebook_url", "sources", "tako_url",
];
const PERSON_ROW_COLUMNS = [
  "name", "title", "department", "seniority", "employer", "in_role_since", "location", "linkedin_url",
  "work_email", "phone", "personal_email", "description", "education", "experience", "registry_seats",
  "sub_role", "business_area", "occupation", "job_summary", "skills", "industry", "metro", "job_verified_on",
  "twitter_url", "github_url", "all_emails", "all_personal_emails", "employer_industry",
  "employer_tako_industries", "employer_tags", "employer_size", "employer_funding_stage", "employer_founded",
  "employer_location", "employer_listing", "sources", "tako_url",
];

describe("list card fields", () => {
  it("names the row columns tako_contents returns, in order", () => {
    expect(rowColumns(COMPANY_LIST_FIELDS)).toEqual(COMPANY_ROW_COLUMNS);
    expect(rowColumns(PERSON_LIST_FIELDS)).toEqual(PERSON_ROW_COLUMNS);
  });

  it("names the preview table's header, in order", () => {
    expect(previewLabels(COMPANY_LIST_FIELDS)).toEqual([
      "Name", "Status", "Estimated revenue", "Headcount", "Industry", "Funding stage", "Total raised",
      "Last funding date", "Investors", "Location", "Website", "Tako link",
    ]);
    expect(previewLabels(PERSON_LIST_FIELDS)).toEqual([
      "Name", "Title", "Department", "Employer", "Schools", "In role since", "Location", "LinkedIn",
      "Work email", "Phone", "Personal email", "Tako link",
    ]);
  });

  it("marks the premium fields the API withholds", () => {
    expect([...COMPANY_LIST_FIELDS.premium].sort()).toEqual(
      ["estimated_revenue", "linkedin_followers", "parent", "subsidiaries"],
    );
    expect([...PERSON_LIST_FIELDS.premium].sort()).toEqual(
      ["all_emails", "all_personal_emails", "personal_email", "phone", "work_email"],
    );
  });
});

describe("joinFieldKeys", () => {
  const plain = (key: string): string => key;

  it("writes a run of three prefixed neighbours once", () => {
    expect(joinFieldKeys(["name", "employer_size", "employer_tags", "employer_founded", "sources"], plain)).toBe(
      "name, employer_{size, tags, founded}, sources",
    );
  });

  it("leaves a run of two alone", () => {
    expect(joinFieldKeys(["funding_round_count", "funding_rounds", "tags"], plain)).toBe(
      "funding_round_count, funding_rounds, tags",
    );
  });

  it("keeps a mark inside a group", () => {
    expect(joinFieldKeys(["all_a", "all_b", "all_c"], (key) => (key === "all_b" ? `${key}*` : key))).toBe(
      "all_{a, b*, c}",
    );
  });
});

/** Every field key a description's field sentences name, with groups expanded. */
function namedFields(text: string): Set<string> {
  const expanded = text.replace(/(\w+_)\{([^}]*)\}/g, (_match, prefix: string, rest: string) =>
    rest.split(", ").map((suffix) => `${prefix}${suffix}`).join(", "),
  );
  return new Set(expanded.match(/[a-z][a-z_]*[a-z]\*?/g) ?? []);
}

describe.each([
  ["company", COMPANY_LIST_FIELDS],
  ["person", PERSON_LIST_FIELDS],
] as ReadonlyArray<[string, ListCardFields]>)("describeListFields: %s", (_name, fields) => {
  const text = describeListFields(fields);
  const named = namedFields(text);
  const premium = new Set<string>(fields.premium);

  it("names every column, with * on exactly the premium ones", () => {
    for (const [key] of fields.columns) {
      if (fields.cardOnly.includes(key) && !fields.preview.includes(key)) continue;
      expect(named.has(premium.has(key) ? `${key}*` : key), key).toBe(true);
      expect(named.has(premium.has(key) ? key : `${key}*`), key).toBe(false);
    }
  });

  it("says which previewed fields the rows leave out", () => {
    const dropped = fields.preview.filter((key) => fields.cardOnly.includes(key));
    expect(dropped.length).toBeGreaterThan(0);
    expect(text).toContain(`except ${dropped.join(" and ")}`);
  });

  it("tells the three places a field comes from apart", () => {
    expect(text).toContain("`description` previews 10 rows");
    expect(text).toContain("`tako_contents` on its `url` returns every row");
    expect(text).toContain("* is premium");
    expect(text).toContain("`premium: true`");
  });
});
