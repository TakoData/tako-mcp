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

describe("tako_graph_related output slimming", () => {
  // Shaped after the measured overview in the design spike: every related
  // item arrives carrying the FULL node record, and the description is what
  // makes the payload 82,741 chars for Nvidia at `limit: 5` (~849/item).
  const fatItem = (n: number) => ({
    id: `ent::co${n}`,
    type: "entity",
    name: `Competitor ${n}`,
    subtype: "Company",
    label: "ORG",
    aliases: [`Comp ${n}`, `C${n} Inc.`, `C${n} Corporation`],
    description: "X".repeat(800),
  });
  const fatOverview = {
    node: { id: "ent::nvda", type: "entity", name: "NVIDIA", description: "Y".repeat(400) },
    relations: [
      {
        key: "rel:competes_with", kind: "related", label: "Competes with",
        items: Array.from({ length: 20 }, (_, i) => fatItem(i)),
        total: 20, total_capped: false, next_cursor: null,
      },
      {
        key: "metrics", kind: "data", label: "Metrics",
        items: Array.from({ length: 10 }, (_, i) => fatItem(100 + i)),
        total: 40, total_capped: true, next_cursor: "cur::2",
      },
    ],
  };

  it("drops description and aliases from related items", () => {
    const slim = takoGraphRelated.slimStructured(fatOverview as never) as {
      relations: { items: Record<string, unknown>[] }[];
    };
    for (const group of slim.relations) {
      for (const item of group.items) {
        expect(item).not.toHaveProperty("description");
        expect(item).not.toHaveProperty("aliases");
        // The identity fields the model needs to make a follow-up call survive.
        expect(item.id).toBeTruthy();
        expect(item.name).toBeTruthy();
        expect(item.type).toBeTruthy();
      }
    }
  });

  it("keeps the top-level node's own description — one record, the one asked for", () => {
    const slim = takoGraphRelated.slimStructured(fatOverview as never) as {
      node: { description?: string };
    };
    expect(slim.node.description).toBe("Y".repeat(400));
  });

  it("preserves paging metadata so the model can still drill", () => {
    const slim = takoGraphRelated.slimStructured(fatOverview as never) as {
      relations: { key: string; total: number; total_capped: boolean; next_cursor: string | null }[];
    };
    expect(slim.relations[1]).toMatchObject({
      key: "metrics", total: 40, total_capped: true, next_cursor: "cur::2",
    });
  });

  it("still conforms to the advertised outputSchema", () => {
    // The whole reason the reduction is possible without a schema change:
    // `description` and `aliases` are optional on graphNodeSchema.
    const slim = takoGraphRelated.slimStructured(fatOverview as never);
    expect(takoGraphRelated.outputSchema.safeParse(slim).success).toBe(true);
  });

  it("cuts the payload by at least 5x", () => {
    // Measured on this fixture: 29,534 -> 3,494 chars, an 8.4x cut. The bound
    // is 5x so the test tracks "descriptions are gone" rather than the exact
    // fixture size; drop the `description` omission and it fails at ~1.1x.
    const full = JSON.stringify(fatOverview).length;
    const slim = JSON.stringify(takoGraphRelated.slimStructured(fatOverview as never)).length;
    expect(full).toBeGreaterThan(25_000);
    expect(slim * 5).toBeLessThan(full);
  });

  it("renderText replaces the JSON dump on the text channel", () => {
    // Without `renderText`, mcp.ts stringifies the FULL output for the model's
    // text channel — the slim above would fix `structuredContent` only, and
    // the 83k would still arrive pretty-printed. Both hooks are required.
    const text = takoGraphRelated.renderText(fatOverview as never, undefined as never);
    expect(text.length * 10).toBeLessThan(JSON.stringify(fatOverview, null, 2).length);
    expect(text).toContain("NVIDIA");
    expect(text).toContain("Competitor 0");
    expect(text).toContain("ent::co0");
    expect(text).not.toContain("X".repeat(50));
  });

  it("renderText surfaces the cursor for a capped group", () => {
    const text = takoGraphRelated.renderText(fatOverview as never, undefined as never);
    expect(text).toContain("cur::2");
    expect(text).toContain('relation: "metrics"');
  });

  it("renderText handles an empty overview", () => {
    const text = takoGraphRelated.renderText(
      { node: { id: "n1", type: "entity", name: "Nobody" }, relations: [] } as never,
      undefined as never,
    );
    expect(text).toContain("No related nodes.");
  });
});
