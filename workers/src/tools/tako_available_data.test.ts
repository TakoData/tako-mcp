import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import { MAX_COVERAGE_NAMES, MAX_COVERAGE_PAGES, PAGE_LIMIT } from "./_available_data.js";
import takoAvailableData from "./tako_available_data.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, client: "claude",
};

const searchHit = (id: string, name: string, type = "entity", label = "ORG") => ({
  id, type, name, label,
});

// A drilled single-relation response: `relation` carries the one group.
const drill = (
  id: string, name: string, key: string, items: string[],
  total?: number, capped = false, nextCursor: string | null = null,
) => ({
  node: { id, type: key === "metrics" ? "entity" : "metric", name },
  relation: {
    key, kind: key === "metrics" ? "data" : "related", label: key,
    items: items.map((m, i) => ({ id: `${key}-${i}`, type: "node", name: m })),
    total: total ?? items.length, total_capped: capped, next_cursor: nextCursor,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_available_data", () => {
  it("tool name is tako_available_data", () => {
    expect(takoAvailableData.name).toBe("tako_available_data");
  });

  it("empty search → found:false, no related calls, steering summary", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    const out = await takoAvailableData.handler({ q: "zzz" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(1); // search only
    expect(out.found).toBe(false);
    expect(out.matches).toEqual([]);
    expect(out.summary).toContain("no data-graph node");
  });

  it("forwards q + limit + optional types/label to graph/search", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    await takoAvailableData.handler({ q: "apple", types: "entity", label: "ORG" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.pathname).toBe("/api/beta/graph/search");
    expect(url.searchParams.get("q")).toBe("apple");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("types")).toBe("entity");
    expect(url.searchParams.get("label")).toBe("ORG");
  });

  it("omits types and label from graph/search when the caller omits them", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    await takoAvailableData.handler({ q: "apple" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.has("types")).toBe(false);
    expect(url.searchParams.has("label")).toBe(false);
  });

  it("entity hit drills relation=metrics; lists the rest as other_matches", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("apple-inc", "Apple Inc."),
          searchHit("apple-gpe", "Apple", "entity", "GPE"),
          searchHit("apple-records", "Apple Records"),
        ],
      }),
      // Rank 0 gets the FULL paginated drill; the rest get limit=1 probes.
      jsonResponse(200, drill("apple-inc", "Apple Inc.", "metrics", ["Revenue", "Net Income"], 47)),
      jsonResponse(200, drill("apple-gpe", "Apple", "metrics", [], 0)),
      jsonResponse(200, drill("apple-records", "Apple Records", "metrics", ["X"], 5)),
    ]);
    const out = await takoAvailableData.handler({ q: "apple" }, CTX);

    // 1 search + 1 full drill + 2 selection probes.
    expect(fetchMock.mock.calls).toHaveLength(4);
    const drills = fetchMock.mock.calls.slice(1).map((c) => new URL(requestFrom(c).url));
    for (const url of drills) {
      expect(url.pathname).toBe("/api/beta/graph/related");
      expect(url.searchParams.get("relation")).toBe("metrics");
    }
    // Exactly one full-page drill; the others are cheap probes.
    expect(drills.filter((u) => u.searchParams.get("limit") === String(PAGE_LIMIT))).toHaveLength(1);
    expect(drills.filter((u) => u.searchParams.get("limit") === "1")).toHaveLength(2);

    expect(out.found).toBe(true);
    // Render narrow: only the winner carries a full coverage list.
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.node_id).toBe("apple-inc");
    // Probed-but-not-rendered candidates keep their id + count for a switch.
    const probed = out.other_matches.filter((o) => o.node_id !== undefined);
    expect(probed.map((o) => o.node_id)).toEqual(["apple-gpe", "apple-records"]);
    expect(probed[1]?.coverage_total).toBe(5);
    expect(out.matches[0]?.coverage.kind).toBe("metrics");
    expect(out.matches[0]?.coverage.total).toBe(47);
    expect(out.summary).toContain("47 metrics.");
    // Names live once, in coverage.names — the prose never enumerates them.
    expect(out.summary).not.toContain("Net Income");
  });

  it("metric-type hit drills relation=entities and reports coverage, NOT 'no metrics'", async () => {
    // Regression: a metric node returns empty on relation=metrics, so the tool
    // must drill relation=entities instead and report where the metric is tracked.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("inflation-rate", "Inflation Rate", "metric", "METRIC")] }),
      jsonResponse(200, drill("inflation-rate", "Inflation Rate", "entities", ["United States", "United Kingdom", "India"], 63)),
    ]);
    const out = await takoAvailableData.handler({ q: "inflation rate" }, CTX);

    const drillUrl = new URL(requestFrom(fetchMock.mock.calls[1]).url);
    expect(drillUrl.searchParams.get("relation")).toBe("entities"); // NOT metrics
    expect(out.matches[0]?.coverage.kind).toBe("entities");
    expect(out.matches[0]?.coverage.total).toBe(63);
    expect(out.summary).toContain("tracked for 63 entities.");
    expect(out.summary).not.toContain("no metrics");
  });

  it("renders a capped total as 'N+'", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("tsla", "Tesla, Inc.")] }),
      jsonResponse(200, drill("tsla", "Tesla, Inc.", "metrics", ["EV/NTM Revenue", "Gross Margin (%)"], 250, true)),
    ]);
    const out = await takoAvailableData.handler({ q: "tesla" }, CTX);
    expect(out.matches[0]?.coverage.capped).toBe(true);
    expect(out.summary).toContain("250+ metrics.");
  });

  it("isolates a per-node coverage failure as an unavailable match", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        results: [searchHit("a", "Alpha Corp"), searchHit("b", "Alpha Holdings")],
      }),
      jsonResponse(200, drill("a", "Alpha Corp", "metrics", ["Revenue"])),
      jsonResponse(503, { detail: "graph store down" }),
    ]);
    // `q` has to plausibly match BOTH fixtures: a query the relevance gate
    // rejects outright short-circuits before any drill, which is a different
    // path from the per-node failure this test is about.
    const out = await takoAvailableData.handler({ q: "Alpha" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(3);
    // The winner still renders in full; the failed SELECTION probe degrades to
    // a zero count rather than sinking the call.
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.coverage.total).toBe(1);
    expect(out.other_matches.find((o) => o.node_id === "b")?.coverage_total).toBe(0);
  });

  it("promotes a probed candidate when rank 0 has no coverage (the Carnival shape)", async () => {
    // Ranks 0-2 are zero-coverage name variants and the real answer is at
    // rank 3 — the case a depth-2 drill could never reach.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("carnival-inc", "Carnival, Inc."),
          searchHit("carnival-inc2", "Carnival Inc."),
          searchHit("carnival-corp", "Carnival Corporation"),
          searchHit("carnival-ltd", "Carnival Corporation Ltd."),
        ],
      }),
      jsonResponse(200, drill("carnival-inc", "Carnival, Inc.", "metrics", [], 0)), // rank 0: empty
      jsonResponse(200, drill("carnival-inc2", "Carnival Inc.", "metrics", [], 0)),
      jsonResponse(200, drill("carnival-corp", "Carnival Corporation", "metrics", [], 0)),
      jsonResponse(200, drill("carnival-ltd", "Carnival Corporation Ltd.", "metrics", ["X"], 250)),
      // Round 2: the promoted candidate's full drill.
      jsonResponse(200, drill("carnival-ltd", "Carnival Corporation Ltd.", "metrics", ["Passenger Cruise Days"], 250)),
    ]);
    const out = await takoAvailableData.handler({ q: "Carnival" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(6);
    expect(out.found).toBe(true);
    expect(out.matches.map((m) => m.node_id)).toContain("carnival-ltd");
    expect(out.matches.find((m) => m.node_id === "carnival-ltd")?.coverage.names).toEqual([
      "Passenger Cruise Days",
    ]);
  });

  // The `q="US inflation"` shape, reproduced live on staging 2026-07-31: the
  // gate ranks a name-matching SHELL first (`US Savings Inflation Securities`,
  // 1 metric) and buried `United States` (250) in a receipt line, with
  // `found: true` on the shell. Coverage has to outrank the name preference.
  it("promotes a better-covered probe over a name-matching shell at rank 0", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        results: [
          // Rank 0 passes the gate on its own NAME, so the partition puts it
          // first. The two nodes that matter match only through an ALIAS
          // ("US" ⊆ the query), which is what demotes them behind it — the
          // exact mechanism of the live failure.
          searchHit("us-savings", "US Savings Inflation Securities", "entity", "PRODUCT"),
          { ...searchHit("united-states", "United States", "entity", "GPE"), aliases: ["US", "USA"] },
          { ...searchHit("inflation-rate", "Inflation Rate", "metric", "METRIC"), aliases: ["Inflation"] },
        ],
      }),
      // Rank 0's full drill: coverage 1 — non-zero, so the old zero-only
      // promotion never fired here.
      jsonResponse(200, drill("us-savings", "US Savings Inflation Securities", "metrics", ["Average Interest Rate"], 1)),
      jsonResponse(200, drill("united-states", "United States", "metrics", ["CPI"], 250, true)),
      jsonResponse(200, drill("inflation-rate", "Inflation Rate", "entities", ["US"], 63)),
      // Round 2: the promoted candidate's full drill.
      jsonResponse(200, drill("united-states", "United States", "metrics", ["CPI Inflation Rate"], 250, true)),
    ]);
    const out = await takoAvailableData.handler({ q: "US inflation" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(5);
    // argmax, not first-non-zero: `Inflation Rate` (63) also has coverage.
    expect(out.matches.map((m) => m.node_id)).toEqual(["united-states"]);
    expect(out.found).toBe(true);
    // The shell drops to a receipt line carrying its real count, so a caller
    // who actually wanted it can still get there.
    const demoted = out.other_matches.find((o) => o.node_id === "us-savings");
    expect(demoted?.coverage_total).toBe(1);
    // Only ONE full coverage list is rendered — the whole point of
    // RENDER_FULL_N is not paying ~8.3k twice.
    expect(out.matches).toHaveLength(1);
    expect(out.next_call?.node_ids).not.toContain("us-savings");
  });

  it("leaves a well-covered rank 0 alone even when a probe out-covers it", async () => {
    // `q="Delta"` — `Delta Air Lines, Inc.` (correct, rank 0) and
    // `Delta Corp Limited` both sit at the 250 cap, and nothing
    // rank-independent separates them. Promotion must not fire on a rank 0
    // that is above SHELL_COVERAGE_MAX, or the gate's name preference and this
    // rule would fight over ordinary queries.
    mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("delta-air", "Delta Air Lines, Inc."),
          searchHit("delta-corp", "Delta Corp Limited"),
        ],
      }),
      jsonResponse(200, drill("delta-air", "Delta Air Lines, Inc.", "metrics", ["Revenue"], 40)),
      jsonResponse(200, drill("delta-corp", "Delta Corp Limited", "metrics", ["X"], 250, true)),
    ]);
    const out = await takoAvailableData.handler({ q: "Delta" }, CTX);
    expect(out.matches.map((m) => m.node_id)).toEqual(["delta-air"]);
    expect(out.other_matches.find((o) => o.node_id === "delta-corp")?.coverage_total).toBe(250);
  });

  // The mirror of the `rank0Known` guard below: unavailable is not zero in the
  // DEMOTE direction either. If the promoted node's own drill fails there is
  // nothing to render in rank 0's place, so displacing a rank 0 that DID load a
  // thin list would turn `found: true` into `found: false` plus a
  // "couldn't load coverage, retry" line — worse than the ordering it set out
  // to improve.
  it("does NOT demote a loaded rank 0 when the promoted node's drill fails", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("us-savings", "US Savings Inflation Securities", "entity", "PRODUCT"),
          { ...searchHit("united-states", "United States", "entity", "GPE"), aliases: ["US", "USA"] },
        ],
      }),
      // Rank 0 loads a thin (shell-sized) list, so promotion is eligible.
      jsonResponse(200, drill("us-savings", "US Savings Inflation Securities", "metrics", ["Average Interest Rate"], 1)),
      jsonResponse(200, drill("united-states", "United States", "metrics", ["CPI"], 250, true)),
      // Round 2: the promoted candidate's full drill fails.
      jsonResponse(503, { detail: "graph store down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "US inflation" }, CTX);
    expect(out.matches.map((m) => m.node_id)).toEqual(["us-savings"]);
    expect(out.matches[0]?.unavailable).toBeUndefined();
    expect(out.found).toBe(true);
    // The better-covered candidate is still named with its id, so switching to
    // it does not require re-running the tool.
    expect(out.other_matches.find((o) => o.node_id === "united-states")?.coverage_total).toBe(250);
  });

  it("does NOT promote when rank 0's coverage lookup failed (unavailable ≠ zero)", async () => {
    // Observed live: a transient graph/related failure on `Delta Air Lines,
    // Inc.` made rank 0 look coverage-less and promoted `Delta Corp Limited`,
    // an unrelated company, into the answer. A failed lookup is not evidence.
    mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("delta-air", "Delta Air Lines, Inc."),
          searchHit("delta-corp", "Delta Corp Limited"),
        ],
      }),
      jsonResponse(503, { detail: "graph store down" }), // rank 0's drill fails
      jsonResponse(200, drill("delta-corp", "Delta Corp Limited", "metrics", ["X"], 250, true)),
    ]);
    const out = await takoAvailableData.handler({ q: "Delta" }, CTX);
    expect(out.matches.map((m) => m.node_id)).toEqual(["delta-air"]);
    expect(out.matches[0]?.unavailable).toBe(true);
    expect(out.found).toBe(false);
    // The better-covered node is still named in a receipt, so a retry is not
    // the caller's only move.
    expect(out.other_matches.find((o) => o.node_id === "delta-corp")?.coverage_total).toBe(250);
  });

  it("fail-open skips the coverage drill and reports no coverage in either channel", async () => {
    // Nothing plausibly matches, so the summary disclaims the resolutions and
    // the renderer prints only that summary. Drilling would pay a paginated
    // fetch plus probes for output nobody reads, and its totals used to reach
    // structuredContent while the prose said the opposite.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        results: [searchHit("tuesday-morning", "Tuesday Morning Corporation")],
      }),
    ]);
    const out = await takoAvailableData.handler({ q: "the vibes of tuesday" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(1); // search only — no drill, no probes
    expect(out.found).toBe(false);
    expect(out.confident).toBe(false);
    expect(out.next_call).toBeNull();
    // Resolution is still reported — it must not read as "no node matched".
    expect(out.matches.map((m) => m.name)).toEqual(["Tuesday Morning Corporation"]);
    expect(out.matches[0]?.coverage.total).toBe(0);
    expect(out.matches[0]?.unavailable).toBeUndefined(); // never attempted ≠ failed
    expect(out.summary).toContain("No graph node confidently matches");
  });

  it("resolved node with empty coverage → found:false and a gap summary, no coverage claim", async () => {
    // Regression (end-to-end): node resolution alone must not read as "Tako
    // has data" — neither in `found` nor in the summary header.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("tsla", "Tesla, Inc.")] }),
      jsonResponse(200, drill("tsla", "Tesla, Inc.", "metrics", [])),
    ]);
    const out = await takoAvailableData.handler({ q: "tesla" }, CTX);
    expect(out.found).toBe(false);
    expect(out.summary).not.toContain("Tako's proprietary data has");
    expect(out.summary).toContain("no metrics for it yet");
  });

  it("all coverage drills failing → found:false, gap summary over unavailable lines", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        results: [searchHit("a", "Alpha Corp"), searchHit("b", "Alpha Holdings")],
      }),
      jsonResponse(503, { detail: "down" }),
      jsonResponse(503, { detail: "down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "Alpha" }, CTX);
    expect(out.found).toBe(false);
    expect(out.summary).not.toContain("Tako's proprietary data has");
    expect(out.matches.every((m) => m.unavailable)).toBe(true);
  });

  it("a node type that is neither entity nor metric drills relation=metrics end-to-end", async () => {
    // coverageKindFor defaults unknown types to "metrics"; prove the handler
    // routes such a node through the full pipeline, not just the unit helper.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("sp-500", "S&P 500", "index", "PRODUCT")] }),
      jsonResponse(200, drill("sp-500", "S&P 500", "metrics", ["Price", "P/E Ratio"], 12)),
    ]);
    const out = await takoAvailableData.handler({ q: "s&p 500" }, CTX);
    const drillUrl = new URL(requestFrom(fetchMock.mock.calls[1]).url);
    expect(drillUrl.searchParams.get("relation")).toBe("metrics");
    expect(out.found).toBe(true);
    expect(out.matches[0]?.coverage.kind).toBe("metrics");
    expect(out.summary).toContain("12 metrics.");
  });

  it("treats a malformed coverage payload as unavailable, not a hard failure", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "Alpha Corp")] }),
      jsonResponse(200, { totally: "wrong" }),
    ]);
    const out = await takoAvailableData.handler({ q: "Alpha" }, CTX);
    expect(out.matches[0]?.unavailable).toBe(true);
  });

  it("surfaces a search-level auth error labeled as tako_available_data", async () => {
    mockFetchSequence([jsonResponse(401, { detail: "bad key" })]);
    await expect(takoAvailableData.handler({ q: "apple" }, CTX)).rejects.toThrow(
      /tako_available_data: Tako rejected the API key \(401\)/,
    );
  });

  it("throws a self-correcting message when graph/search returns an unexpected shape", async () => {
    mockFetchSequence([jsonResponse(200, { nonsense: true })]);
    await expect(takoAvailableData.handler({ q: "apple" }, CTX)).rejects.toThrow(/unexpected shape/);
  });

  it("paginates the coverage drill with the cursor and concatenates every page's names", async () => {
    // The whole point of pagination: a metric buried past page 1 ("Net
    // charges-off" behind 100 boilerplate normalized-accounting names) must
    // appear in coverage.names of the ONE call — no second fetch, no filter.
    const page1 = drill(
      "cof", "Capital One Financial", "metrics",
      Array.from({ length: PAGE_LIMIT }, (_, i) => `Metric ${i}`), 101, false, "cursor-2",
    );
    const page2 = drill(
      "cof", "Capital One Financial", "metrics",
      ["Net charges-off/(Recoveries) (Quarterly)"], 101,
    );
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("cof", "Capital One Financial")] }),
      jsonResponse(200, page1),
      jsonResponse(200, page2),
    ]);
    const out = await takoAvailableData.handler({ q: "capital one" }, CTX);

    expect(fetchMock.mock.calls).toHaveLength(3); // search + 2 pages
    const firstDrill = new URL(requestFrom(fetchMock.mock.calls[1]).url);
    expect(firstDrill.searchParams.get("limit")).toBe(String(PAGE_LIMIT));
    expect(firstDrill.searchParams.has("cursor")).toBe(false);
    const secondDrill = new URL(requestFrom(fetchMock.mock.calls[2]).url);
    expect(secondDrill.searchParams.get("cursor")).toBe("cursor-2");
    expect(out.matches[0]?.coverage.names).toHaveLength(PAGE_LIMIT + 1);
    expect(out.matches[0]?.coverage.names).toContain("Net charges-off/(Recoveries) (Quarterly)");
    // Every name fetched (101 of 101) → the complete list, nothing truncated.
    expect(out.matches[0]?.coverage.truncated).toBe(false);
  });

  it("stops paginating at MAX_COVERAGE_NAMES and reports truncated", async () => {
    const page = (cursor: string | null) =>
      drill(
        "big", "Big Node", "metrics",
        Array.from({ length: PAGE_LIMIT }, (_, i) => `M ${cursor ?? "p1"} ${i}`),
        1000, false, cursor,
      );
    // Enough pages that an unbounded loop would keep going; the fetched-name
    // count crosses MAX_COVERAGE_NAMES after page ceil(MAX/PAGE_LIMIT) and no
    // further page is requested.
    const pagesNeeded = Math.ceil(MAX_COVERAGE_NAMES / PAGE_LIMIT);
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("big", "Big Node")] }),
      ...Array.from({ length: pagesNeeded + 1 }, (_, i) => jsonResponse(200, page(`c${i + 2}`))),
    ]);
    const out = await takoAvailableData.handler({ q: "big" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(1 + pagesNeeded); // search + pages, never the extra one
    expect(out.matches[0]?.coverage.names).toHaveLength(MAX_COVERAGE_NAMES);
    expect(out.matches[0]?.coverage.truncated).toBe(true);
    expect(out.matches[0]?.coverage.total).toBe(1000);
  });

  it("keeps already-fetched pages when a later page fails (partial beats unavailable)", async () => {
    const p1 = drill("a", "A", "metrics", ["Revenue", "Net Income"], 150, false, "c2");
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      jsonResponse(200, p1),
      jsonResponse(503, { detail: "graph store down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "a" }, CTX);
    expect(out.matches[0]?.unavailable).toBeUndefined();
    expect(out.matches[0]?.coverage.names).toEqual(["Revenue", "Net Income"]);
    expect(out.matches[0]?.coverage.total).toBe(150);
    expect(out.matches[0]?.coverage.truncated).toBe(true);
  });

  it("keeps already-fetched pages when a later page is 200 but malformed (wire-guard path, distinct from HTTP failure)", async () => {
    const p1 = drill("a", "A", "metrics", ["Revenue", "Net Income"], 150, false, "c2");
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      jsonResponse(200, p1),
      jsonResponse(200, { totally: "wrong" }), // parses as JSON, fails the shape guard
    ]);
    const out = await takoAvailableData.handler({ q: "a" }, CTX);
    expect(out.matches[0]?.unavailable).toBeUndefined();
    expect(out.matches[0]?.coverage.names).toEqual(["Revenue", "Net Income"]);
    expect(out.matches[0]?.coverage.truncated).toBe(true);
  });

  it("a 200 with relation:null on the FIRST page is zero coverage, NOT unavailable", async () => {
    // Regression (review finding): the spec allows a successful response with
    // relation:null. Pre-pagination code fed that null into selectCoverage →
    // "no metrics yet". Treating it as "couldn't load coverage; retry" would
    // send the agent into a retry loop over a real answer.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      jsonResponse(200, { node: { id: "a", type: "entity", name: "A" }, relation: null }),
    ]);
    const out = await takoAvailableData.handler({ q: "a" }, CTX);
    expect(out.matches[0]?.unavailable).toBeUndefined();
    expect(out.matches[0]?.coverage.total).toBe(0);
    expect(out.found).toBe(false);
    expect(out.summary).toContain("no metrics for it yet");
    expect(out.summary).not.toContain("couldn't load its coverage");
  });

  it("stops after MAX_COVERAGE_PAGES round-trips even when the server pages tiny", async () => {
    // Hard round-trip ceiling: a server paging 2 items at a time must not let
    // the drill serialize dozens of sequential calls chasing 150 names.
    const tinyPage = (i: number) =>
      drill("a", "A", "metrics", [`M${i}a`, `M${i}b`], 1000, false, `c${i + 1}`);
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      ...Array.from({ length: MAX_COVERAGE_PAGES + 3 }, (_, i) => jsonResponse(200, tinyPage(i))),
    ]);
    const out = await takoAvailableData.handler({ q: "a" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(1 + MAX_COVERAGE_PAGES);
    expect(out.matches[0]?.coverage.names).toHaveLength(MAX_COVERAGE_PAGES * 2);
    expect(out.matches[0]?.coverage.truncated).toBe(true);
  });

  it("never narrows a drill server-side: the drill carries no q (full coverage, always)", async () => {
    // coverage_filter used to thread the caller's term into the drill's `q`.
    // It produced bare negatives the model would not trust, so it re-called
    // this tool unfiltered anyway — the filtered call was pure overhead.
    // Drills are now always unfiltered; a truncated list is the honest cost.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("cof", "Capital One Financial")] }),
      jsonResponse(200, drill("cof", "Capital One Financial", "metrics", ["Net charges-off/(Recoveries) (Quarterly)"], 3)),
    ]);
    const out = await takoAvailableData.handler({ q: "capital one" }, CTX);
    const searchUrl = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(searchUrl.searchParams.get("q")).toBe("capital one");
    const drillUrl = new URL(requestFrom(fetchMock.mock.calls[1]).url);
    expect(drillUrl.searchParams.get("q")).toBeNull();
    expect(out.found).toBe(true);
    expect(out.summary).not.toContain("matching");
  });

  it("empty coverage reads as a genuine gap the agent can act on", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("cof", "Capital One Financial")] }),
      jsonResponse(200, drill("cof", "Capital One Financial", "metrics", [])),
    ]);
    const out = await takoAvailableData.handler({ q: "capital one" }, CTX);
    expect(out.found).toBe(false);
    expect(out.summary).toContain("no metrics for it yet");
  });

  it("returns a ready-to-run next_call handle when the coverage list is small (unambiguous)", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("apple-inc", "Apple Inc.")] }),
      jsonResponse(200, drill("apple-inc", "Apple Inc.", "metrics", ["Revenue", "Net Income"], 2)),
    ]);
    const out = await takoAvailableData.handler({ q: "apple" }, CTX);
    expect(out.next_call).toEqual({
      tool: "tako_search",
      query: "Apple Inc. Revenue",
      node_ids: ["metrics-0"], // the METRIC node, not the entity's
      strict: true,
    });
    expect(out.summary).toContain("next_call");
  });

  it("suppresses next_call for a broad UNFILTERED coverage (names[0] is arbitrary popularity order)", async () => {
    // "Run this verbatim" against a broad entity's top metric would spend a
    // PRICED search on a guess (PR #179 review, comment C6). The summary
    // falls back to the compose-your-own example.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("cof", "Capital One Financial")] }),
      jsonResponse(200, drill(
        "cof", "Capital One Financial", "metrics",
        ["EV/NTM Revenue", "Gross Margin (%)", "Asset Turnover", "Book Value per Share"], 250,
      )),
    ]);
    const out = await takoAvailableData.handler({ q: "capital one" }, CTX);
    expect(out.next_call).toBeNull();
    expect(out.summary).not.toContain("next_call");
    expect(out.summary).toContain('(e.g. "Capital One Financial EV/NTM Revenue")');
  });

  it("next_call is null when no match has coverage (never a handle for data-less names)", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("tsla", "Tesla, Inc.")] }),
      jsonResponse(200, drill("tsla", "Tesla, Inc.", "metrics", [])),
    ]);
    const out = await takoAvailableData.handler({ q: "tesla" }, CTX);
    expect(out.next_call).toBeNull();
  });

  it("stops on the cursor landing items exactly at MAX_COVERAGE_NAMES with more available", async () => {
    const p1 = drill(
      "a", "A", "metrics",
      Array.from({ length: PAGE_LIMIT }, (_, i) => `M1-${i}`), 400, false, "c2",
    );
    const p2 = drill(
      "a", "A", "metrics",
      Array.from({ length: MAX_COVERAGE_NAMES - PAGE_LIMIT }, (_, i) => `M2-${i}`), 400, false, "c3",
    );
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      jsonResponse(200, p1),
      jsonResponse(200, p2),
      jsonResponse(200, drill("a", "A", "metrics", ["never-fetched"], 400)),
    ]);
    const out = await takoAvailableData.handler({ q: "a" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(3); // count-cap stops the loop, not the cursor
    expect(out.matches[0]?.coverage.names).toHaveLength(MAX_COVERAGE_NAMES);
    expect(out.matches[0]?.coverage.truncated).toBe(true);
    expect(out.matches[0]?.coverage.total).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The LOOKUP path (`metric` supplied)
// ---------------------------------------------------------------------------
//
// Two parallel graph/search probes instead of a paginated coverage drill.
// Measured on staging: ~0.63s vs ~3.0s, ~600 chars vs ~8.5k, and the split is
// what keeps it accurate — the combined phrase resolves metrics fine but can
// destroy entity resolution ("Pfizer R&D expense" returns no Pfizer at all).

describe("tako_available_data — lookup path", () => {
  it("resolves the pair and pins the METRIC node with strict:true", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::nvidia::1", "NVIDIA Corporation")] }),
      jsonResponse(200, { results: [searchHit("mt::gross_margin::9", "Gross Margin (%)", "metric", "METRIC")] }),
          // Unfiltered swap-detection probes: entity-first for q, metric-first for
      // `metric`, i.e. the arguments are the right way round.
      jsonResponse(200, { results: [searchHit("ent::q::u", "Quiet Entity")] }),
      jsonResponse(200, { results: [searchHit("mt::m::u", "Quiet Metric", "metric", "METRIC")] }),
]);
    const out = await takoAvailableData.handler({ q: "Nvidia", metric: "gross margin" }, CTX);

    // Two probes, no coverage drill at all.
    expect(fetchMock.mock.calls).toHaveLength(4); // 2 typed probes + 2 detection probes
    for (const call of fetchMock.mock.calls.slice(0, 2)) {
      expect(new URL(requestFrom(call).url).pathname).toBe("/api/beta/graph/search");
    }
    // Each probe is type-scoped — that split is the accuracy mechanism.
    const types = fetchMock.mock.calls.map((c) => new URL(requestFrom(c).url).searchParams.get("types"));
    // The two typed probes carry a filter; the two detection probes are
    // deliberately UNfiltered — that is what recovers the backend's own view
    // of whether a string is an entity or a metric.
    expect(types.slice(0, 2).sort()).toEqual(["entity", "metric"]);
    expect(types.slice(2)).toEqual([null, null]);

    expect(out.entity).toEqual({ node_id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" });
    expect(out.metric).toEqual({ node_id: "mt::gross_margin::9", name: "Gross Margin (%)", type: "metric" });
    // The metric node alone — adding the entity id would widen strict back out.
    expect(out.next_call).toEqual({
      tool: "tako_answer",
      query: "NVIDIA Corporation gross margin",
      node_ids: ["mt::gross_margin::9"],
      strict: true,
    });
    expect(out.matches).toEqual([]);
  });

  it("carries alternates so a wrong top-1 is visible and self-correctable", async () => {
    // The real shape of the failure: metric="total revenue" resolves
    // `Total Odds` first, with the right answer at rank 1.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::walmart::1", "Walmart Inc.")] }),
      jsonResponse(200, {
        results: [
          searchHit("mt::total_odds::1", "Total Odds", "metric", "METRIC"),
          searchHit("mt::revenues::2", "Revenues", "metric", "METRIC"),
          searchHit("mt::rev_share::3", "Revenue per Share", "metric", "METRIC"),
        ],
      }),
          // Unfiltered swap-detection probes: entity-first for q, metric-first for
      // `metric`, i.e. the arguments are the right way round.
      jsonResponse(200, { results: [searchHit("ent::q::u", "Quiet Entity")] }),
      jsonResponse(200, { results: [searchHit("mt::m::u", "Quiet Metric", "metric", "METRIC")] }),
]);
    const out = await takoAvailableData.handler({ q: "Walmart", metric: "total revenue" }, CTX);
    expect(out.metric?.name).toBe("Total Odds");
    expect(out.metric_alternates?.map((a) => a.name)).toEqual(["Revenues", "Revenue per Share"]);
  });

  it("falls back to the coverage drill when the metric does not resolve", async () => {
    // Guessing a metric name that does not exist is exactly when the caller
    // needs to see what DOES exist — so the paths compose.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("apple-inc", "Apple Inc.")] }),
      jsonResponse(200, { results: [] }),
      // Unfiltered swap-detection probes: entity-first for q, metric-first for
      // `metric`, i.e. the arguments are the right way round.
      jsonResponse(200, { results: [searchHit("ent::q::u", "Quiet Entity")] }),
      jsonResponse(200, { results: [searchHit("mt::m::u", "Quiet Metric", "metric", "METRIC")] }),
      jsonResponse(200, drill("apple-inc", "Apple Inc.", "metrics", ["Revenue", "Net Income"], 2)),
]);
    const out = await takoAvailableData.handler({ q: "Apple", metric: "quantum flux capacity" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(5); // 2 typed + 2 detection + 1 drill
    expect(new URL(requestFrom(fetchMock.mock.calls[4]).url).pathname).toBe("/api/beta/graph/related");
    expect(out.metric).toBeNull();
    expect(out.next_call).toBeNull();
    expect(out.matches[0]?.coverage.names).toEqual(["Revenue", "Net Income"]);
    expect(out.summary).toContain("no metric matching");
  });

  it("routes a domain that resolves to nothing at tako_search instead of a dead end", async () => {
    // Measured: openai.com / kagi.com have no graph node while SimilarWeb
    // still covers them, so "no node" must not read as "no data".
    mockFetchSequence([
      jsonResponse(200, { results: [] }),
      jsonResponse(200, { results: [searchHit("mt::visits::1", "Visits", "metric", "METRIC")] }),
    ]);
    const out = await takoAvailableData.handler({ q: "openai.com", metric: "monthly visits" }, CTX);
    expect(out.entity).toBeNull();
    expect(out.summary).toContain("Domains are often not graph nodes");
    expect(out.summary).toContain("tako_search");
  });

  it("gates fuzzy entity matches out of the pair", async () => {
    // q="Carnival Corporation" used to report coverage for Cuscal Limited.
    mockFetchSequence([
      jsonResponse(200, {
        results: [
          searchHit("ent::cuscal::1", "Cuscal Limited"),
          searchHit("ent::carnival::2", "Carnival Corporation Ltd."),
        ],
      }),
      jsonResponse(200, { results: [searchHit("mt::pcd::1", "Passenger Cruise Days", "metric", "METRIC")] }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "Carnival Corporation", metric: "passenger cruise days" }, CTX,
    );
    expect(out.entity?.name).toBe("Carnival Corporation Ltd.");
    expect(out.entity_alternates).toEqual([]);
  });
});

// Regressions caught by running the new code against LIVE staging data — each
// of these passed unit tests and still misbehaved end to end.
describe("tako_available_data — lookup path, live-caught regressions", () => {
  it("emits NO next_call when the metric only matched via fail-open", async () => {
    // metric="number of unicorns" resolved `Concentra Number Of Visits` and
    // emitted a runnable PRICED call for it.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::tesla::1", "Tesla, Inc.")] }),
      jsonResponse(200, {
        results: [searchHit("mt::concentra::1", "Concentra Number Of Visits", "metric", "METRIC")],
      }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "Tesla", metric: "number of unicorns" }, CTX,
    );
    expect(out.next_call).toBeNull();
    expect(out.found).toBe(false);
    expect(out.summary).toContain("NO metric confidently matches");
  });

  it("emits NO next_call when the entity did not resolve (would contradict the routing)", async () => {
    // openai.com has no graph node; the summary routes to tako_search, so a
    // tako_answer handle alongside it was a contradiction.
    mockFetchSequence([
      jsonResponse(200, { results: [] }),
      jsonResponse(200, { results: [searchHit("mt::visits::1", "Visits", "metric", "METRIC")] }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "openai.com", metric: "monthly visits" }, CTX,
    );
    expect(out.entity).toBeNull();
    expect(out.next_call).toBeNull();
    expect(out.found).toBe(false); // a metric with no entity is not a usable pair
  });

  it("prefers the real entity over a node carrying its name as a poisoned alias", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        results: [
          { ...searchHit("ent::cuscal::1", "Cuscal Limited"), aliases: ["Carnival Corporation"] },
          { ...searchHit("ent::carnival::2", "Carnival Corporation"), aliases: ["Carnival"] },
        ],
      }),
      jsonResponse(200, { results: [searchHit("mt::pcd::1", "Passenger Cruise Days", "metric", "METRIC")] }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "Carnival Corporation", metric: "passenger cruise days" }, CTX,
    );
    expect(out.entity?.name).toBe("Carnival Corporation");
  });
});

describe("tako_available_data — label scoping", () => {
  it("sends `label` to the entity probe only, never the metric probe", async () => {
    // `label` is an NER label for the ENTITY. Forwarding it to the metric
    // probe measurably degraded that half: with label=METRIC the resolved
    // metric went from `Gross Margin (%)` to `Product Gross Margin`.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::nvidia::1", "NVIDIA Corporation")] }),
      jsonResponse(200, { results: [searchHit("mt::gm::1", "Gross Margin (%)", "metric", "METRIC")] }),
    ]);
    await takoAvailableData.handler(
      { q: "Nvidia", metric: "gross margin", label: "ORG" }, CTX,
    );
    const urls = fetchMock.mock.calls.map((c) => new URL(requestFrom(c).url));
    const entityProbe = urls.find((u) => u.searchParams.get("types") === "entity");
    const metricProbe = urls.find((u) => u.searchParams.get("types") === "metric");
    expect(entityProbe?.searchParams.get("label")).toBe("ORG");
    expect(metricProbe?.searchParams.get("label")).toBeNull();
  });

  it("still forwards `label` on the discovery path", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    await takoAvailableData.handler({ q: "apple", label: "ORG" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.get("label")).toBe("ORG");
  });
});

describe("tako_available_data — metric confidence is judged on what is shown", () => {
  it("a deep-rank plausible candidate does NOT vouch for an unvetted primary", async () => {
    // Confidence used to be judged over the whole result list, so something at
    // rank 5 could make a rank-0 nobody vetted read as found:true.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::acme::1", "Acme Corp")] }),
      jsonResponse(200, {
        results: [
          searchHit("mt::a::1", "Employment Index", "metric", "METRIC"),
          searchHit("mt::b::2", "GDP Price Index", "metric", "METRIC"),
          searchHit("mt::c::3", "Political Corruption Index", "metric", "METRIC"),
          // Plausible by containment, but far below the three we display.
          // Deliberately NOT an exact token match — an exact one is promoted
          // to primary by design, which is a different rule.
          searchHit("mt::d::4", "Global Index Level Composite", "metric", "METRIC"),
        ],
      }),
    ]);
    const out = await takoAvailableData.handler({ q: "Acme", metric: "index level" }, CTX);
    expect(out.metric?.name).toBe("Employment Index");
    expect(out.found).toBe(false);
    expect(out.next_call).toBeNull();
  });

  it("an abbreviation is vouched for by its expansion's OWN alias, at rank 0", async () => {
    // This case used to be cited as proof that rank 0 alone could not be the
    // test — `capex` shares no NAME token with `Capital Expenditure`, so a
    // confident alternate had to carry it. That premise is false on live data:
    // measured on staging, `Capital Expenditure` carries the aliases
    // ["CAPEX", "CapEx", "Capex", "Capital Expenditure Actual",
    //  "Capital Spending"], so rank 0 passes on its own via `alias ⊆ query`,
    // which is exactly the shape confidentMatch documents for abbreviations.
    // Verified the same way for `ROA` → `Return on Assets` (alias "ROA") and
    // `revenue` → `Revenues` (alias "Revenue"). Fixture now carries the real
    // alias lists.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::cvx::1", "Chevron Corporation")] }),
      jsonResponse(200, {
        results: [
          {
            ...searchHit("mt::a::1", "Capital Expenditure", "metric", "METRIC"),
            aliases: ["CAPEX", "CapEx", "Capex", "Capital Expenditure Actual", "Capital Spending"],
          },
          { ...searchHit("mt::b::2", "CapEx to Revenue", "metric", "METRIC"), aliases: [] },
        ],
      }),
    ]);
    const out = await takoAvailableData.handler({ q: "Chevron", metric: "capex" }, CTX);
    expect(out.metric?.name).toBe("Capital Expenditure");
    expect(out.found).toBe(true);
    expect(out.next_call?.node_ids).toEqual(["mt::a::1"]);
  });

  it("WITHHOLDS the handle when rank 0 is unvetted, even if an alternate passes", async () => {
    // TAKO-3754, live on staging: `q="Pfizer", metric="R&D expense"`. Rank 0
    // fails confidentMatch and rank 2 passes, and the verdict used to be
    // `.some()` over the window while the pin still took rank 0 — so rank 2's
    // confidence licensed a "run verbatim" handle pinning OPERATING COSTS for an
    // R&D question. Real alias lists, so the containment outcomes are the live
    // ones.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::pfizer::1", "Pfizer Inc.")] }),
      jsonResponse(200, {
        results: [
          {
            ...searchHit("mt::opex::1", "Operating costs and expenses", "metric", "METRIC"),
            aliases: ["Expenses", "Total Operating Expenses", "costs", "expenditures", "spending"],
          },
          {
            ...searchHit("mt::rd_norm::2", "R&D Expenses (Normalized)", "metric", "METRIC"),
            aliases: ["R&D Exp", "r&d costs", "research and development expenses"],
          },
          searchHit("mt::rd_amer::3", "Research & development expense (R&D) - Americas", "metric", "METRIC"),
        ],
      }),
    ]);
    const out = await takoAvailableData.handler({ q: "Pfizer", metric: "R&D expense" }, CTX);

    // No priced handle for a node nobody vetted.
    expect(out.next_call).toBeNull();
    expect(out.found).toBe(false);
    // Backend order is preserved — confidentMatch decides confidence, never
    // order (promoting rank 2 was measured to pick ratios over real metrics).
    expect(out.metric?.node_id).toBe("mt::opex::1");
    // The recovery has to stay available: every candidate keeps its node id, so
    // the caller can pin one deliberately. This is what a live agent run did on
    // its own, choosing R&D Expenses (Normalized).
    expect(out.metric_alternates?.map((m) => m.node_id)).toEqual([
      "mt::rd_norm::2",
      "mt::rd_amer::3",
    ]);
    expect(out.summary).toContain("NO metric confidently matches");
    expect(out.summary).toContain("Pick one deliberately");
  });
});

describe("tako_available_data — lookup probe failure isolation", () => {
  it("degrades to the coverage drill when the METRIC probe fails", async () => {
    // The discovery path isolates per-node drill failures so one bad node never
    // sinks the answer. The metric probe deserves the same: a transient failure
    // there has a graceful landing already built — the entity resolved, so fall
    // through to "no metric matched" and show what the entity actually has.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("apple-inc", "Apple Inc.")] }),
      jsonResponse(503, { detail: "graph store down" }),
      jsonResponse(200, { results: [searchHit("ent::q::u", "Quiet Entity")] }),
      jsonResponse(200, { results: [searchHit("mt::m::u", "Quiet Metric", "metric", "METRIC")] }),
      jsonResponse(200, drill("apple-inc", "Apple Inc.", "metrics", ["Revenue"], 1)),
    ]);
    const out = await takoAvailableData.handler({ q: "Apple", metric: "revenue" }, CTX);
    expect(out.entity?.name).toBe("Apple Inc.");
    expect(out.metric).toBeNull();
    expect(out.next_call).toBeNull();
    expect(out.matches[0]?.coverage.names).toEqual(["Revenue"]);
  });

  it("still throws when the ENTITY probe fails (nothing to fall back to)", async () => {
    mockFetchSequence([
      jsonResponse(503, { detail: "graph store down" }),
      jsonResponse(200, { results: [] }),
    ]);
    await expect(
      takoAvailableData.handler({ q: "Apple", metric: "revenue" }, CTX),
    ).rejects.toThrow();
  });
});

describe("tako_available_data — exact metric name promotion", () => {
  it("promotes a verbatim metric name the backend ranked low", async () => {
    // Live: metric="CPI Inflation Rate (Seasonally Adjusted)" returns that
    // exact node at rank 3, below the generic `Inflation Rate`, so it fell
    // outside the three candidates the response shows.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::us::1", "United States")] }),
      jsonResponse(200, {
        results: [
          searchHit("mt::a::1", "Inflation Rate", "metric", "METRIC"),
          searchHit("mt::b::2", "CPI Inflation Rate (Not Seasonally Adjusted)", "metric", "METRIC"),
          searchHit("mt::c::3", "Core CPI Inflation Rate", "metric", "METRIC"),
          searchHit("mt::d::4", "CPI Inflation Rate (Seasonally Adjusted)", "metric", "METRIC"),
        ],
      }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "United States", metric: "CPI Inflation Rate (Seasonally Adjusted)" }, CTX,
    );
    expect(out.metric?.name).toBe("CPI Inflation Rate (Seasonally Adjusted)");
    expect(out.next_call?.node_ids).toEqual(["mt::d::4"]);
  });

  it("is a no-op when no candidate matches exactly (the ordinary shapes)", async () => {
    // `revenue` vs `Revenues` is a plural, `capex` vs `Capital Expenditure` an
    // abbreviation — neither is an exact set match, so backend order stands.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::apple::1", "Apple Inc.")] }),
      jsonResponse(200, {
        results: [
          searchHit("mt::a::1", "Revenues", "metric", "METRIC"),
          searchHit("mt::b::2", "Avnet Revenue Total Revenue", "metric", "METRIC"),
        ],
      }),
    ]);
    const out = await takoAvailableData.handler({ q: "Apple", metric: "revenue" }, CTX);
    expect(out.metric?.name).toBe("Revenues");
  });
});

// Swapped arguments used to fail CONFIDENTLY: q="gross margin" resolved the
// entity `Gross`, metric="Nvidia" resolved `Nvidia Corporation Revenue
// Percentage`, and the call returned found:true with a runnable next_call.
describe("tako_available_data — swapped argument detection", () => {
  const quietDetection = [
    jsonResponse(200, { results: [searchHit("ent::q::u", "Quiet Entity")] }),
    jsonResponse(200, { results: [searchHit("mt::m::u", "Quiet Metric", "metric", "METRIC")] }),
  ];

  it("diagnoses a swap and refuses to look anything up", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::gross::1", "Gross")] }),
      jsonResponse(200, { results: [searchHit("mt::nv::1", "Nvidia Corporation Revenue Percentage", "metric", "METRIC")] }),
      // Unfiltered: the backend ranks a METRIC first for "gross margin" and an
      // ENTITY first for "Nvidia" — the arguments are inverted.
      jsonResponse(200, { results: [searchHit("mt::gm::1", "Gross Margin (%)", "metric", "METRIC")] }),
      jsonResponse(200, { results: [searchHit("ent::nv::1", "NVIDIA Corporation")] }),
    ]);
    const out = await takoAvailableData.handler({ q: "gross margin", metric: "Nvidia" }, CTX);
    expect(out.found).toBe(false);
    expect(out.next_call).toBeNull();
    expect(out.entity).toBeNull();
    expect(out.metric).toBeNull();
    expect(out.summary).toContain("look swapped");
    // Names the corrected call rather than silently reinterpreting intent.
    expect(out.summary).toContain('q="Nvidia"');
    expect(out.summary).toContain('metric="gross margin"');
  });

  // `probe` used to fall back to `input.types` whenever its own `types`
  // argument was omitted, and the ONLY callers that omit it are the two
  // detection probes — which are useless filtered, because `types=entity`
  // returns an entity for "gross margin" no matter how entity-unlike it is.
  // So passing `types` silently disabled the detector: measured on this exact
  // fixture, the swap stopped being diagnosed and the call returned
  // found:true with a runnable PRICED next_call for the inverted pair.
  it("still diagnoses a swap when the caller also passed `types`", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::gross::1", "Gross")] }),
      jsonResponse(200, { results: [searchHit("mt::nv::1", "Nvidia Corporation Revenue Percentage", "metric", "METRIC")] }),
      jsonResponse(200, { results: [searchHit("mt::gm::1", "Gross Margin (%)", "metric", "METRIC")] }),
      jsonResponse(200, { results: [searchHit("ent::nv::1", "NVIDIA Corporation")] }),
    ]);
    const out = await takoAvailableData.handler(
      { q: "gross margin", metric: "Nvidia", types: "entity" }, CTX,
    );
    expect(out.summary).toContain("look swapped");
    expect(out.found).toBe(false);
    expect(out.next_call).toBeNull();
  });

  it("does NOT fire when only the type looks inverted but the match is weak", async () => {
    // `Block` (the company) ranks the metric `Blocked Shots` first, so a
    // type-only rule would flag a correct call. `Blocked Shots` is not a
    // confident match for "Block", so the confidence guard suppresses it.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::block::1", "Block, Inc.")] }),
      jsonResponse(200, { results: [searchHit("mt::ssg::1", "Same Store Sales Growth", "metric", "METRIC")] }),
      jsonResponse(200, { results: [searchHit("mt::bs::1", "Blocked Shots", "metric", "METRIC")] }),
      jsonResponse(200, { results: [searchHit("ent::sales::1", "Sales and Related Occupations")] }),
    ]);
    const out = await takoAvailableData.handler({ q: "Block", metric: "same store sales" }, CTX);
    expect(out.summary).not.toContain("look swapped");
    expect(out.entity?.name).toBe("Block, Inc.");
  });

  it("stays quiet on ordinary correct usage", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::nv::1", "NVIDIA Corporation")] }),
      jsonResponse(200, { results: [searchHit("mt::gm::1", "Gross Margin (%)", "metric", "METRIC")] }),
      ...quietDetection,
    ]);
    const out = await takoAvailableData.handler({ q: "Nvidia", metric: "gross margin" }, CTX);
    expect(out.summary).not.toContain("look swapped");
    expect(out.found).toBe(true);
    expect(out.next_call).not.toBeNull();
  });

  it("a failing detection probe cannot sink the call", async () => {
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("ent::nv::1", "NVIDIA Corporation")] }),
      jsonResponse(200, { results: [searchHit("mt::gm::1", "Gross Margin (%)", "metric", "METRIC")] }),
      jsonResponse(503, { detail: "down" }),
      jsonResponse(503, { detail: "down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "Nvidia", metric: "gross margin" }, CTX);
    expect(out.found).toBe(true);
    expect(out.metric?.name).toBe("Gross Margin (%)");
  });
});
