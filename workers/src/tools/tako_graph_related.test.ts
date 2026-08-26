import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import {
  FIXED_RELATION_KEYS,
  graphNodeSchema,
  graphRelatedOutputShape,
  graphRelationSchema,
} from "./_graph.js";
import { TOOL_REGISTRY } from "./_registry.js";
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
    expect(out.relations?.[0]?.items[0]).not.toHaveProperty("description");
  });

  it("maps a 404 into a node_id-focused message that distinguishes it from a bad relation", async () => {
    mockFetchSequence([jsonResponse(404, { detail: "not found" })]);
    await expect(
      takoGraphRelated.handler({ node_id: "bogus-node-9" }, CTX),
    ).rejects.toThrow(/no graph node with id "bogus-node-9" \(404\)/);
  });

  const fatItem = (i: number) => ({
    id: `ent::c${i}::1`, type: "entity", name: `Competitor ${i}`, subtype: "Companies", label: "ORG",
    aliases: [`C${i}`], description: "d".repeat(800),
  });

  it("overview: slims every group to its first three items and the focal node to a truncated description", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        node: { ...hub, aliases: ["TSLA"], description: "x".repeat(1000) },
        relations: [
          { key: "rel:competes_with", kind: "related", label: "Competes with", total: 40, total_capped: false,
            items: Array.from({ length: 40 }, (_v, i) => fatItem(i)) },
          { key: "metrics", kind: "data", label: "Metrics", total: 250, total_capped: true,
            items: Array.from({ length: 50 }, (_v, i) => ({ id: `mt::m${i}::1`, type: "metric", name: `Metric ${i}`, description: "y".repeat(500) })) },
        ],
      }),
    ]);
    const out = await takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX);
    expect(out.relations?.[0]?.items).toHaveLength(3);
    expect(out.relations?.[0]?.items[0]).toEqual({ id: "ent::c0::1", type: "entity", name: "Competitor 0", subtype: "Companies", label: "ORG" });
    expect(out.relations?.[0]?.total).toBe(40);
    expect(out.relations?.[1]?.items).toHaveLength(3);
    expect(out.node.description?.length).toBe(601); // FOCAL_DESCRIPTION_MAX + the ellipsis
    expect(out.node.aliases).toEqual(["TSLA"]);
    // The payload the model reads: under 2k for a two-group overview that came in at ~60k.
    const text = takoGraphRelated.renderText(out, CTX);
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("`rel:competes_with` — Competes with — 40:");
    expect(text).toContain("Competitor 0, Competitor 1, Competitor 2, …");
    expect(text).toContain("`metrics` — Metrics — 250+:");
    expect(text).toContain('relation: "<key>"');
  });

  it("overview stays LINEAR in group count — the two-group bound above does not cover a wide node", async () => {
    // Spec explore 2 named "under 2k" for Anthropic's 17-group overview. That
    // target is met only up to ~10 groups: measured here, the rendered text is
    // ~750 chars of focal node and instructions plus ~125 per group, so 17
    // groups is ~2.8k from an ~840k wire payload — a 99.7% cut, and over the
    // number the spec quoted.
    //
    // The SLOPE is the bound worth guarding. An absolute ceiling needs
    // retuning every time a node's group count changes; a field added to every
    // group line is what actually turns a wide node back into an overflow, and
    // only the per-group cost catches that at any width.
    const overview = (groups: number) => ({
      node: {
        id: "anthropic-1", type: "entity", name: "Anthropic PBC", subtype: "Companies",
        label: "ORG", aliases: ["Anthropic"], description: "z".repeat(1_200),
      },
      relations: Array.from({ length: groups }, (_v, g) => ({
        key: g === 0 ? "metrics" : `rel:relation_number_${g}`,
        kind: "related", label: `Relation Group ${g}`,
        total: 50, total_capped: g % 2 === 0, next_cursor: g % 3 === 0 ? "cur" : null,
        items: Array.from({ length: 50 }, (_w, i) => ({
          id: `ent::g${g}i${i}::1`, type: "entity", name: `Group ${g} Node ${i}`,
          subtype: "Companies", label: "ORG", aliases: ["AL"], description: "x".repeat(850),
        })),
      })),
    });
    const render = async (groups: number): Promise<number> => {
      mockFetchSequence([jsonResponse(200, overview(groups))]);
      const out = await takoGraphRelated.handler({ node_id: "anthropic-1" }, CTX);
      return takoGraphRelated.renderText(out, CTX).length;
    };
    const two = await render(2);
    const wide = await render(17);
    expect(wide).toBeLessThan(3_500); // measured 2,843
    expect((wide - two) / 15).toBeLessThan(200); // measured ~123 per group
  });

  it("drill: keeps the whole page, slims each item, and prints the cursor", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        node: hub,
        relation: { key: "metrics", kind: "data", label: "Metrics", total: 250, total_capped: true, next_cursor: "cur-2",
          items: Array.from({ length: 50 }, (_v, i) => ({ id: `mt::m${i}::1`, type: "metric", name: `Metric ${i}`, description: "y".repeat(500) })) },
      }),
    ]);
    const out = await takoGraphRelated.handler({ node_id: "tesla-x1", relation: "metrics" }, CTX);
    expect(out.relation?.items).toHaveLength(50);
    expect(out.relation?.items[0]).toEqual({ id: "mt::m0::1", type: "metric", name: "Metric 0" });
    const text = takoGraphRelated.renderText(out, CTX);
    expect(text).toContain("`metrics` — Metrics — 250+ total, 50 on this page; more: pass cursor \"cur-2\"");
    expect(text).toContain("- Metric 0 (`mt::m0::1`)");
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
    expect(text).not.toContain("X".repeat(50));
    // This fixture's first group is COMPLETE (20 items, total 20), so the
    // overview carries its ids and the model can act without drilling.
    expect(text).toContain("ent::co0");
    // On the real path the handler has already previewed each group to three
    // items, so a 20-item group is no longer complete: names orient, and the
    // ids ride the drill, which prints one line per item.
    const slimmed = takoGraphRelated.slimStructured(fatOverview as never);
    const slimText = takoGraphRelated.renderText(slimmed as never, undefined as never);
    expect(slimText).not.toContain("ent::co0");
    const drill = takoGraphRelated.renderText(
      { node: fatOverview.node, relation: fatOverview.relations[1] } as never,
      undefined as never,
    );
    expect(drill).toContain("ent::co100");
  });

  it("renderText surfaces the cursor for a capped group", () => {
    const text = takoGraphRelated.renderText(fatOverview as never, undefined as never);
    expect(text).toContain("cur::2");
    expect(text).toContain('relation: "metrics"');
  });

  // The `N of M` / `N of M+` marker is the ONLY thing telling the model whether
  // a group is complete. Without it a 10-of-40 page reads as the whole set and
  // the model stops drilling — a silent wrong answer, not a visible failure.
  // `cur::2` and `relation: "metrics"` (asserted above) survive its removal.
  it("renderText marks each group complete or truncated", () => {
    const text = takoGraphRelated.renderText(fatOverview as never, undefined as never);
    // Complete: 20 shown of 20 total, not capped — no trailing `+`.
    expect(text).toContain("20 of 20");
    expect(text).not.toContain("20 of 20+");
    // Truncated: 10 shown of a capped 40, so the total carries the `+`.
    expect(text).toContain("10 of 40+");
  });

  // THE DRILL, which every fixture above skips. `relations` is the overview;
  // `relation` (singular) is the paginated drill at `limit: 100` of full node
  // records — the largest response this tool returns, and the one the slimming
  // exists for. Both hooks branch on it (`slimStructured` and
  // `renderRelatedMarkdown`), and neither branch ran in any test.
  const fatDrill = {
    node: { id: "ent::nvda", type: "entity", name: "NVIDIA", description: "Y".repeat(400) },
    relation: {
      key: "metrics", kind: "data", label: "Metrics",
      items: Array.from({ length: 100 }, (_, i) => fatItem(200 + i)),
      total: 250, total_capped: true, next_cursor: "cur::9",
    },
  };

  it("slimStructured slims the drilled relation, not just the overview", () => {
    const slim = takoGraphRelated.slimStructured(fatDrill as never) as {
      relation: {
        key: string; total: number; total_capped: boolean; next_cursor: string | null;
        items: Record<string, unknown>[];
      };
      relations?: unknown;
    };
    // The overview key must not appear — the branches are exclusive.
    expect(slim.relations).toBeUndefined();
    expect(slim.relation.items).toHaveLength(100);
    for (const item of slim.relation.items) {
      expect(item).not.toHaveProperty("description");
      expect(item).not.toHaveProperty("aliases");
      expect(item.id).toBeTruthy();
    }
    // Paging metadata survives, or the caller cannot fetch page 2.
    expect(slim.relation).toMatchObject({
      key: "metrics", total: 250, total_capped: true, next_cursor: "cur::9",
    });
    expect(takoGraphRelated.outputSchema.safeParse(slim).success).toBe(true);
  });

  it("renderText renders the drilled relation and cuts it hardest", () => {
    const text = takoGraphRelated.renderText(fatDrill as never, undefined as never);
    expect(text).toContain("Metrics");
    expect(text).toContain("100 of 250+");
    expect(text).toContain("cur::9");
    expect(text).toContain("ent::co200");
    expect(text).not.toContain("X".repeat(50));
    // 100 items x ~849 chars is the worst case the slimming was added for.
    expect(text.length * 10).toBeLessThan(JSON.stringify(fatDrill, null, 2).length);
  });

  it("renderText handles an empty overview", () => {
    const text = takoGraphRelated.renderText(
      { node: { id: "n1", type: "entity", name: "Nobody" }, relations: [] } as never,
      undefined as never,
    );
    expect(text).toContain("No related nodes.");
  });
});

describe("tako_graph_related description is derived from the API's own relation contract", () => {
  it("FIXED_RELATION_KEYS is read from the generated schema, not hand-written", () => {
    // Guards the parser: an OpenAPI rewording that breaks the regex must fail
    // loudly here rather than silently emptying the description.
    expect(FIXED_RELATION_KEYS.length).toBeGreaterThanOrEqual(5);
    expect(FIXED_RELATION_KEYS).toContain("metrics");
    expect(FIXED_RELATION_KEYS).toContain("members");
    expect(FIXED_RELATION_KEYS).not.toContain("rel:<phrase>"); // the placeholder form is not a key
  });

  it("names every fixed key the API emits and no other bare key", () => {
    for (const key of FIXED_RELATION_KEYS) {
      expect(takoGraphRelated.description, key).toContain(`\`${key}\``);
    }
    // Any other backticked single-word key in the description would be a phantom
    // relation the model tries and gets empty items for.
    //
    // The allowed set is DERIVED, not written down: the fixed keys, this tool's
    // own parameter names, the response field names, and the registered tool
    // names. A hand-written list fails on the next description edit that
    // backticks a legitimate word, and fails with a message about phantom
    // relations — sending the reader after a bug that isn't there.
    const bare = [...takoGraphRelated.description.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
    const known = new Set<string>([
      ...FIXED_RELATION_KEYS,
      ...Object.keys(takoGraphRelated.inputSchema.shape),
      ...Object.keys(graphNodeSchema.shape),
      ...Object.keys(graphRelationSchema.shape),
      ...Object.keys(graphRelatedOutputShape),
      ...TOOL_REGISTRY.map((t) => t.name),
    ]);
    expect(bare.filter((k) => !known.has(k))).toEqual([]);
  });

  it("says plainly that q is a substring match", () => {
    expect(takoGraphRelated.description).toMatch(/`q` is a case-insensitive SUBSTRING match/);
  });
});
