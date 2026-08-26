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
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, surface: "generic",
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
    expect(url.pathname).toBe("/api/v1/graph/related");
    expect(url.searchParams.get("node_id")).toBe("tesla-x1");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("relation")).toBe(false);
  });

  it("forwards cursor/limit/label/infer_label as query params", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { node: hub, relation: { key: "metrics", kind: "data", label: "Metrics", items: [], total: 0, total_capped: false, next_cursor: null } }),
    ]);
    await takoGraphRelated.handler(
      {
        node_id: "tesla-x1",
        relation: "metrics",
        cursor: "cur-123",
        limit: 100,
        label: "ORG",
        infer_label: false,
      },
      CTX,
    );
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.get("cursor")).toBe("cur-123");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("label")).toBe("ORG");
    expect(url.searchParams.get("infer_label")).toBe("false");
  });

  it("single q string: one call, forwards q + relation, returns the response", async () => {
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
    expect(out.relation?.total_capped).toBe(true);
  });

  it("rejects an array q (single string only)", () => {
    expect(() =>
      takoGraphRelated.inputSchema.parse({ node_id: "x", q: ["a", "b"] }),
    ).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { node: hub, relations: "nope" })]);
    await expect(
      takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX),
    ).rejects.toThrow(/unexpected shape/);
  });

  // Regression: the live API returns relation groups with kind:"source" (and can
  // return new subtype/label values), which the generated RelationKind /
  // EntityClassName / NerLabel enums don't list. Validating through the loose
  // facade must accept these instead of throwing "unexpected shape". (Verified
  // live on tako.com: Tesla's overview includes a kind:"source" group.)
  it("accepts enum values the generated schema lacks (kind:source, exotic subtype/label)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        node: hub,
        relations: [
          {
            key: "rel:sourced_from",
            kind: "source", // NOT in the generated RelationKind enum
            label: "Sourced from",
            items: [
              {
                id: "ent::x::1",
                type: "entity",
                name: "Some Source",
                subtype: "Brand New Entity Class", // not in EntityClassName
                label: "NEW_NER_LABEL", // not in NerLabel
              },
            ],
            total: 1,
            total_capped: false,
          },
        ],
      }),
    ]);

    const out = await takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX);
    expect(out.relations?.[0]?.kind).toBe("source");
    expect(out.relations?.[0]?.items[0]?.subtype).toBe("Brand New Entity Class");
    expect(out.relations?.[0]?.items[0]?.label).toBe("NEW_NER_LABEL");
  });

  it("maps a 404 into a node_id-focused message that distinguishes it from a bad relation", async () => {
    mockFetchSequence([jsonResponse(404, { detail: "not found" })]);
    await expect(
      takoGraphRelated.handler({ node_id: "bogus-node-9" }, CTX),
    ).rejects.toThrow(/no graph node with id "bogus-node-9" \(404\)/);
  });
});
