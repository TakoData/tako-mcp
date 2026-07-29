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
      jsonResponse(200, drill("apple-inc", "Apple Inc.", "metrics", ["Revenue", "Net Income"], 47)),
      jsonResponse(200, drill("apple-gpe", "Apple", "metrics", [])),
    ]);
    const out = await takoAvailableData.handler({ q: "apple" }, CTX);

    expect(fetchMock.mock.calls).toHaveLength(3);
    const drills = fetchMock.mock.calls.slice(1).map((c) => new URL(requestFrom(c).url));
    for (const url of drills) {
      expect(url.pathname).toBe("/api/beta/graph/related");
      expect(url.searchParams.get("relation")).toBe("metrics");
      expect(url.searchParams.get("limit")).toBe(String(PAGE_LIMIT));
    }
    expect(out.found).toBe(true);
    expect(out.matches[0]?.node_id).toBe("apple-inc");
    expect(out.matches[0]?.coverage.kind).toBe("metrics");
    expect(out.matches[0]?.coverage.total).toBe(47);
    expect(out.other_matches).toEqual([{ name: "Apple Records", type: "entity" }]);
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
      jsonResponse(200, { results: [searchHit("a", "A"), searchHit("b", "B")] }),
      jsonResponse(200, drill("a", "A", "metrics", ["Revenue"])),
      jsonResponse(503, { detail: "graph store down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "x" }, CTX);
    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(out.matches).toHaveLength(2);
    expect(out.matches.find((m) => m.node_id === "b")?.unavailable).toBe(true);
    expect(out.matches.find((m) => m.node_id === "a")?.coverage.total).toBe(1);
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
      jsonResponse(200, { results: [searchHit("a", "A"), searchHit("b", "B")] }),
      jsonResponse(503, { detail: "down" }),
      jsonResponse(503, { detail: "down" }),
    ]);
    const out = await takoAvailableData.handler({ q: "x" }, CTX);
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
      jsonResponse(200, { results: [searchHit("a", "A")] }),
      jsonResponse(200, { totally: "wrong" }),
    ]);
    const out = await takoAvailableData.handler({ q: "x" }, CTX);
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
      node_ids: ["apple-inc"],
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
