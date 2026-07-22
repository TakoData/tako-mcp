import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import { PREVIEW } from "./_available_data.js";
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
const drill = (id: string, name: string, key: string, items: string[], total?: number, capped = false) => ({
  node: { id, type: key === "metrics" ? "entity" : "metric", name },
  relation: {
    key, kind: key === "metrics" ? "data" : "related", label: key,
    items: items.map((m, i) => ({ id: `${key}-${i}`, type: "node", name: m })),
    total: total ?? items.length, total_capped: capped, next_cursor: null,
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
      expect(url.searchParams.get("limit")).toBe(String(PREVIEW));
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

  it("resolved node with empty coverage → found:false and a gap summary, not 'live data'", async () => {
    // Regression (end-to-end): node resolution alone must not read as "Tako
    // has data" — neither in `found` nor in the summary header.
    mockFetchSequence([
      jsonResponse(200, { results: [searchHit("tsla", "Tesla, Inc.")] }),
      jsonResponse(200, drill("tsla", "Tesla, Inc.", "metrics", [])),
    ]);
    const out = await takoAvailableData.handler({ q: "tesla" }, CTX);
    expect(out.found).toBe(false);
    expect(out.summary).not.toContain("live data on");
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
    expect(out.summary).not.toContain("live data on");
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
});
