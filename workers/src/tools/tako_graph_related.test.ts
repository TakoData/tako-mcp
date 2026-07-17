import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoGraphRelated from "./tako_graph_related.js";
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

const hub = { id: "tesla-x1", type: "entity", name: "Tesla" };
const metricsPage = (items: { id: string; name: string }[], capped = false) => ({
  node: hub,
  relation: {
    key: "metrics", kind: "data", label: "Metrics",
    items: items.map((i) => ({ id: i.id, type: "metric", name: i.name })),
    total: items.length, total_capped: capped, next_cursor: null,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_graph_related", () => {
  it("tool name is tako_graph_related", () => {
    expect(takoGraphRelated.name).toBe("tako_graph_related");
  });

  it("overview: sends only node_id when no relation/q", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { node: hub, relations: [] }),
    ]);
    await takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.pathname).toBe("/api/beta/graph/related");
    expect(url.searchParams.get("node_id")).toBe("tesla-x1");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("relation")).toBe(false);
  });

  it("single q string: one call, response returned unchanged", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, metricsPage([{ id: "rev-1", name: "Revenue" }], true)),
    ]);
    const out = await takoGraphRelated.handler(
      { node_id: "tesla-x1", relation: "metrics", q: "revenue" }, CTX,
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.get("q")).toBe("revenue");
    expect(url.searchParams.get("relation")).toBe("metrics");
    expect(out.relation?.total_capped).toBe(true); // unchanged passthrough
  });

  it("multi q array: fans out one call per value and unions/dedupes items", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, metricsPage([
        { id: "rev-1", name: "Revenue" }, { id: "shared-9", name: "Average Wages" },
      ])),
      jsonResponse(200, metricsPage([
        { id: "sales-2", name: "Sales" }, { id: "shared-9", name: "Average Wages" },
      ])),
    ]);
    const out = await takoGraphRelated.handler(
      { node_id: "tesla-x1", relation: "metrics", q: ["revenue", "sales"] }, CTX,
    );
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(out.relation?.items.map((n) => n.id)).toEqual([
      "rev-1", "shared-9", "sales-2",
    ]);
    expect(out.relation?.total).toBe(3);
  });

  it("rejects an empty q array", () => {
    expect(() =>
      takoGraphRelated.inputSchema.parse({ node_id: "x", q: [] }),
    ).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { node: hub, relations: "nope" })]);
    await expect(
      takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX),
    ).rejects.toThrow(/unexpected shape/);
  });
});
