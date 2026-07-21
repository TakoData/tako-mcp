import { describe, expect, it } from "vitest";

import {
  buildMatch,
  buildSummary,
  coverageKindFor,
  hasLiveCoverage,
  OTHER_MATCH_PREVIEW,
  orderMetricNames,
  PREVIEW,
  selectCoverage,
  unavailableMatch,
  type CoverageMatch,
} from "./_available_data.js";

// --- fixtures -------------------------------------------------------------

const entityNode = (over: Partial<{ id: string; name: string; label: string }> = {}) => ({
  id: over.id ?? "apple-inc",
  type: "entity",
  name: over.name ?? "Apple Inc.",
  label: over.label ?? "ORG",
});

const metricNode = (over: Partial<{ id: string; name: string; label: string }> = {}) => ({
  id: over.id ?? "inflation-rate",
  type: "metric",
  name: over.name ?? "Inflation Rate",
  label: over.label ?? "METRIC",
});

const group = (key: string, names: string[], total?: number, capped = false) => ({
  key,
  kind: key === "metrics" ? "data" : "related",
  label: key,
  items: names.map((n, i) => ({ id: `${key}-${i}`, type: "node", name: n })),
  total: total ?? names.length,
  total_capped: capped,
  next_cursor: null,
});

// --- coverageKindFor ------------------------------------------------------

describe("coverageKindFor", () => {
  it("entity node → metrics, metric node → entities", () => {
    expect(coverageKindFor("entity")).toBe("metrics");
    expect(coverageKindFor("metric")).toBe("entities");
    expect(coverageKindFor("anything-else")).toBe("metrics");
  });
});

// --- orderMetricNames -----------------------------------------------------

describe("orderMetricNames", () => {
  it("pushes low-signal (Normalized / Account Code) names below clean ones, stable within each bucket", () => {
    const input = [
      "EV/NTM Revenue",
      "Account Code - Inventory Valuation (Normalized)",
      "Gross Margin (%)",
      "Accounts Receivable Long-Term (Normalized)",
      "Revenue per Share",
    ];
    expect(orderMetricNames(input)).toEqual([
      "EV/NTM Revenue",
      "Gross Margin (%)",
      "Revenue per Share",
      "Account Code - Inventory Valuation (Normalized)",
      "Accounts Receivable Long-Term (Normalized)",
    ]);
  });

  it("leaves an all-clean list untouched", () => {
    const input = ["Revenue", "Net Income", "Market Cap"];
    expect(orderMetricNames(input)).toEqual(input);
  });
});

// --- selectCoverage -------------------------------------------------------

describe("selectCoverage", () => {
  it("returns an empty group of the requested kind for a missing group", () => {
    expect(selectCoverage(null, "metrics")).toEqual({
      kind: "metrics", names: [], total: 0, truncated: false, capped: false,
    });
    expect(selectCoverage(null, "entities").kind).toBe("entities");
  });

  it("metrics kind reorders headline-first and reports total + capped", () => {
    const g = selectCoverage(
      group("metrics", ["Account Code - X (Normalized)", "Revenue", "Net Income"], 250, true),
      "metrics",
    );
    expect(g.names[0]).toBe("Revenue"); // noisy pushed down
    expect(g.total).toBe(250);
    expect(g.capped).toBe(true);
    expect(g.truncated).toBe(true);
  });

  it("entities kind keeps backend order (no metric reordering)", () => {
    const g = selectCoverage(
      group("entities", ["United States", "Account Code - foo (Normalized)", "India"], 63),
      "entities",
    );
    // "Account Code…" is NOT a metric name here — must not be reshuffled.
    expect(g.names).toEqual(["United States", "Account Code - foo (Normalized)", "India"]);
    expect(g.kind).toBe("entities");
  });

  it("caps the preview at PREVIEW", () => {
    const many = Array.from({ length: 20 }, (_, i) => `M${i}`);
    const g = selectCoverage(group("metrics", many, 20), "metrics");
    expect(g.names).toHaveLength(PREVIEW);
    expect(g.truncated).toBe(true);
  });

  it("no truncation when total equals shown names", () => {
    const g = selectCoverage(group("metrics", ["Revenue", "Net Income"], 2), "metrics");
    expect(g.truncated).toBe(false);
    expect(g.capped).toBe(false);
  });

  it("capped always implies truncated, even when total equals the shown count", () => {
    // A capped total is a floor — more names exist beyond it by definition,
    // so `truncated` must hold even in the degenerate total === shown case.
    const g = selectCoverage(group("metrics", ["Revenue", "Net Income"], 2, true), "metrics");
    expect(g.truncated).toBe(true);
  });
});

// --- hasLiveCoverage --------------------------------------------------------

describe("hasLiveCoverage", () => {
  it("true only for a resolved match with non-empty coverage", () => {
    expect(hasLiveCoverage(buildMatch(entityNode(), group("metrics", ["Revenue"], 1)))).toBe(true);
    expect(hasLiveCoverage(buildMatch(entityNode(), group("metrics", [], 0)))).toBe(false);
    expect(hasLiveCoverage(unavailableMatch(entityNode()))).toBe(false);
  });
});

// --- buildMatch / unavailableMatch ---------------------------------------

describe("buildMatch", () => {
  it("entity node → metrics coverage", () => {
    const m = buildMatch(entityNode(), group("metrics", ["Revenue"], 250, true));
    expect(m.node_id).toBe("apple-inc");
    expect(m.coverage.kind).toBe("metrics");
    expect(m.coverage.total).toBe(250);
    expect(m.coverage.capped).toBe(true);
  });

  it("metric node → entities coverage", () => {
    const m = buildMatch(metricNode(), group("entities", ["United States", "India"], 63));
    expect(m.coverage.kind).toBe("entities");
    expect(m.coverage.names).toEqual(["United States", "India"]);
    expect(m.coverage.total).toBe(63);
  });

  it("null label when the node has none", () => {
    const m = buildMatch({ id: "x", type: "entity", name: "X" }, null);
    expect(m.label).toBeNull();
    expect(m.coverage.total).toBe(0);
  });
});

describe("unavailableMatch", () => {
  it("flags unavailable with an empty coverage group of the node's kind", () => {
    expect(unavailableMatch(entityNode()).coverage.kind).toBe("metrics");
    expect(unavailableMatch(metricNode()).unavailable).toBe(true);
    expect(unavailableMatch(metricNode()).coverage.kind).toBe("entities");
  });
});

// --- buildSummary ---------------------------------------------------------

describe("buildSummary", () => {
  const appleMatch: CoverageMatch = buildMatch(
    entityNode(),
    group("metrics", ["Revenue", "Net Income", "Market Cap"], 47),
  );
  const inflationMatch: CoverageMatch = buildMatch(
    metricNode(),
    group("entities", ["United States", "United Kingdom", "India"], 63),
  );

  it("empty matches → no-node message naming the query and steering to tako_search", () => {
    const s = buildSummary({ query: "wat", matches: [], otherMatches: [] });
    expect(s).toContain('no data-graph node matching "wat"');
    expect(s).toContain("tako_search");
  });

  it("entity match → metrics-forward line with a +N more tail", () => {
    const s = buildSummary({ query: "apple", matches: [appleMatch], otherMatches: [] });
    expect(s).toContain('Tako has live data on 1 match for "apple":');
    expect(s).toContain("**Apple Inc. (ORG)** — 47 metrics incl. Revenue, Net Income, Market Cap (+44 more).");
  });

  it("metric match → 'tracked for N entities' line (not 'no metrics')", () => {
    const s = buildSummary({ query: "inflation", matches: [inflationMatch], otherMatches: [] });
    expect(s).toContain("**Inflation Rate (METRIC)** — tracked for 63 entities incl. United States, United Kingdom, India (+60 more).");
    expect(s).not.toContain("no metrics");
  });

  it("capped total renders as 'N+' and drops the misleading numeric tail", () => {
    const capped = buildMatch(entityNode({ name: "Tesla, Inc." }), group("metrics", ["EV/NTM Revenue", "Gross Margin (%)"], 250, true));
    const s = buildSummary({ query: "tesla", matches: [capped], otherMatches: [] });
    expect(s).toContain("**Tesla, Inc. (ORG)** — 250+ metrics incl. EV/NTM Revenue, Gross Margin (%).");
    expect(s).not.toContain("more)"); // no "(+N more)" when capped
  });

  it("does NOT put node ids in the prose", () => {
    const s = buildSummary({ query: "apple", matches: [appleMatch], otherMatches: [] });
    expect(s).not.toContain("apple-inc");
  });

  it("pluralizes the header for multiple matches", () => {
    const s = buildSummary({ query: "apple", matches: [appleMatch, inflationMatch], otherMatches: [] });
    expect(s).toContain('Tako has live data on 2 matches for "apple":');
  });

  it("entity node with no metrics gets the 'no metrics yet' line", () => {
    const bare = buildMatch(entityNode({ name: "Tesla", label: "" }), group("metrics", [], 0));
    const s = buildSummary({ query: "tesla", matches: [bare], otherMatches: [] });
    expect(s).toContain("**Tesla** — resolved, but Tako holds no metrics for it yet.");
  });

  it("metric node with no entities gets the 'not tracking against any entities' line", () => {
    const bare = buildMatch(metricNode({ name: "Obscure Metric" }), group("entities", [], 0));
    const s = buildSummary({ query: "obscure", matches: [bare], otherMatches: [] });
    expect(s).toContain("**Obscure Metric (METRIC)** — resolved, but Tako isn't tracking it against any entities yet.");
  });

  it("unavailable node renders the temporary-failure line", () => {
    const s = buildSummary({ query: "apple", matches: [unavailableMatch(entityNode())], otherMatches: [] });
    expect(s).toContain("couldn't load its coverage right now");
  });

  it("all matches empty → header reports the gap, never 'live data'", () => {
    // Regression: the header used to assert "Tako has live data on N matches"
    // over a body saying there is none — contradicting the tool's contract.
    const bare = buildMatch(entityNode({ name: "Tesla", label: "" }), group("metrics", [], 0));
    const s = buildSummary({ query: "tesla", matches: [bare], otherMatches: [] });
    expect(s).not.toContain("live data on");
    expect(s).toContain('Resolved 1 match for "tesla", but none with live data coverage:');
  });

  it("all matches unavailable → header reports the gap, never 'live data'", () => {
    const s = buildSummary({
      query: "apple",
      matches: [unavailableMatch(entityNode()), unavailableMatch(metricNode())],
      otherMatches: [],
    });
    expect(s).not.toContain("live data on");
    expect(s).toContain('Resolved 2 matches for "apple", but none with live data coverage:');
  });

  it("mixed coverage → header counts only the matches with data", () => {
    const bare = buildMatch(entityNode({ id: "tsla", name: "Tesla", label: "" }), group("metrics", [], 0));
    const s = buildSummary({ query: "apple", matches: [appleMatch, bare], otherMatches: [] });
    expect(s).toContain('Tako has live data on 1 of 2 matches for "apple":');
  });

  it("suppresses the tako_search next-step hint when no match has coverage", () => {
    // Regression: the fallback used to suggest a priced tako_search for the
    // very entity the summary just reported as having no data.
    const bare = buildMatch(entityNode({ name: "Tesla", label: "" }), group("metrics", [], 0));
    const s = buildSummary({ query: "tesla", matches: [bare], otherMatches: [] });
    expect(s).not.toContain("call tako_search using");
  });

  it("lists other matches capped at OTHER_MATCH_PREVIEW with a tail", () => {
    const others = Array.from({ length: 8 }, (_, i) => ({ name: `Other${i}`, type: "entity" }));
    const s = buildSummary({ query: "apple", matches: [appleMatch], otherMatches: others });
    expect(s).toContain("Also matched: Other0, Other1, Other2, Other3, Other4, and 3 more.");
  });

  it("next-step example: entity → 'Name Metric', metric → 'Entity Name'", () => {
    expect(buildSummary({ query: "apple", matches: [appleMatch], otherMatches: [] }))
      .toContain('(e.g. "Apple Inc. Revenue")');
    expect(buildSummary({ query: "inflation", matches: [inflationMatch], otherMatches: [] }))
      .toContain('(e.g. "United States Inflation Rate")');
  });

  it("keeps the preview constants positive", () => {
    expect(OTHER_MATCH_PREVIEW).toBeGreaterThan(0);
    expect(PREVIEW).toBeGreaterThan(0);
  });
});
