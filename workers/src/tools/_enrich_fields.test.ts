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

// A made-up card, so these tests check the functions, not the spec's lists.
// `registry:check` catches a description change and `scripts/smoke.ts` checks
// the API's columns.
const CARD: ListCardFields = {
  record: "widget",
  columns: ["name", "price", "owner", "notes", "badge", "tako_url"],
  preview: [["name", "Name"], ["price", "Price"], ["badge", "Badge"], ["tako_url", "Tako link"]],
  cardOnly: ["badge"],
  premium: ["price", "owner"],
};

describe("list card fields", () => {
  it("names the row columns tako_contents returns, in order, without the card-only ones", () => {
    expect(rowColumns(CARD)).toEqual(["name", "price", "owner", "notes", "tako_url"]);
  });

  it("names the preview table's header, in order", () => {
    expect(previewLabels(CARD)).toEqual(["Name", "Price", "Badge", "Tako link"]);
  });

  it("splits the fields between the preview, the rows and the premium mark", () => {
    expect(describeListFields(CARD)).toBe(
      "Card `description` previews 10 rows: name, price*, badge, tako_url. " +
        "`tako_contents` on its `url` returns every row: those fields except badge, plus owner*, notes. " +
        "* is premium: null unless that call sets `premium: true`.",
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
    const previewed = new Set(fields.preview.map(([key]) => key));
    for (const key of fields.columns) {
      if (fields.cardOnly.includes(key) && !previewed.has(key)) continue;
      expect(named.has(premium.has(key) ? `${key}*` : key), key).toBe(true);
      expect(named.has(premium.has(key) ? key : `${key}*`), key).toBe(false);
    }
  });

  it("says which previewed fields the rows leave out", () => {
    const dropped = fields.preview.map(([key]) => key).filter((key) => fields.cardOnly.includes(key));
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
