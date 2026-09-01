import { describe, expect, it } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "../django.js";
import {
  FOCAL_ALIASES_MAX,
  FOCAL_DESCRIPTION_MAX,
  graphErrorMessage,
  kindOf,
  OVERVIEW_PREVIEW_N,
  projectItem,
  projectRelated,
} from "./_graph.js";

describe("graphErrorMessage", () => {
  const P = { path: "/api/v1/graph/search", method: "GET" as const };
  // `toolName` is required so nothing can synthesize `tako_graph_${op}` — that
  // fallback named `tako_graph_search`, a tool no surface registers. These
  // cases assert the guidance text, not the prefix, so any real name serves.
  const TOOL = "tako_graph_related";

  it("401 → key/environment guidance", () => {
    const msg = graphErrorMessage(new DjangoUnauthorizedError(P), "search", undefined, TOOL);
    expect(msg).toMatch(/401/);
    expect(msg).toMatch(/production key is rejected on staging/i);
  });

  it("search 400 → lists valid labels and the types constraint", () => {
    const msg = graphErrorMessage(
      new DjangoBadRequestError({ ...P, body: '{"label":["invalid"]}' }),
      "search",
      undefined,
      TOOL,
    );
    expect(msg).toMatch(/400/);
    expect(msg).toMatch(/STOCK_TICKER/); // the label enum is spelled out
    expect(msg).toMatch(/"entity" or "metric"/);
    expect(msg).toMatch(/Backend detail/); // the raw body is preserved
  });

  it("related 404 → points at node_id, and clarifies relation is NOT a 404", () => {
    const msg = graphErrorMessage(
      new DjangoNotFoundError({ path: "/api/v1/graph/related", method: "GET" }),
      "related",
      "bogus-node-9",
      TOOL,
    );
    expect(msg).toMatch(/no graph node with id "bogus-node-9"/);
    expect(msg).toMatch(/unknown `relation` is NOT a 404/);
  });

  it("429 → rate-limit backoff guidance", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 429, body: "" }),
      "search",
      undefined,
      TOOL,
    );
    expect(msg).toMatch(/rate limited \(429\)/);
    expect(msg).toMatch(/180 requests\/min/);
  });

  it("503 → transient store-unavailable guidance", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 503, body: "" }),
      "related",
      "n1",
      TOOL,
    );
    expect(msg).toMatch(/temporarily unavailable \(503\)/);
  });

  it("403 → framed as an edge/WAF infra block, not an input problem", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 403, body: "<html>blocked</html>" }),
      "search",
      undefined,
      TOOL,
    );
    expect(msg).toMatch(/blocked \(403\)/);
    expect(msg).toMatch(/edge\/WAF/);
    expect(msg).toMatch(/not a query problem/i);
  });

  it("timeout → retry-once guidance", () => {
    const msg = graphErrorMessage(
      new DjangoTimeoutError({ ...P, timeoutMs: 15_000 }),
      "search",
      undefined,
      TOOL,
    );
    expect(msg).toMatch(/timed out/);
  });

  it("non-JSON 2xx (parse error) → unreadable-response guidance", () => {
    const msg = graphErrorMessage(
      new DjangoResponseParseError({ ...P, status: 200, cause: new Error("bad") }),
      "related",
      "n1",
      TOOL,
    );
    expect(msg).toMatch(/unreadable \(non-JSON\)/);
  });

  it("non-transport error → surfaced, not masked", () => {
    const msg = graphErrorMessage(new Error("boom"), "search", undefined, TOOL);
    expect(msg).toMatch(/unexpected error — boom/);
  });
});

const fat = (i: number) => ({
  id: `ent::n${i}::1`,
  type: "entity",
  name: `Node ${i}`,
  subtype: "Companies",
  label: "ORG",
  aliases: [`N${i}`, `Node-${i}`],
  description: "x".repeat(900),
});

describe("graph projection", () => {
  it("projectItem keeps id, name and kind — and drops type, aliases and description", () => {
    // `type` goes because the `ent::`/`mt::` id prefix carries it; `label`
    // folds into `kind` via `kindOf`.
    expect(projectItem(fat(1))).toEqual({ id: "ent::n1::1", name: "Node 1", kind: "Companies" });
  });

  it("projectItem omits kind entirely when the node has neither subtype nor label", () => {
    expect(projectItem({ id: "mt::x::1", type: "metric", name: "Revenue" })).toEqual({
      id: "mt::x::1", name: "Revenue",
    });
  });

  it("kindOf prefers subtype, falls back to label, and drops a label that only restates type", () => {
    expect(kindOf({ type: "entity", subtype: "Companies", label: "ORG" })).toBe("Companies");
    // The 13-of-134 case measured on tako_available_data: a subtype-less
    // entity whose label is the only kind hint.
    expect(kindOf({ type: "entity", subtype: null, label: "PRODUCT" })).toBe("PRODUCT");
    // ...and the case that made every metric render as "metric · METRIC".
    expect(kindOf({ type: "metric", subtype: null, label: "METRIC" })).toBeUndefined();
    expect(kindOf({ type: "entity", subtype: null, label: null })).toBeUndefined();
  });

  it("the focal node keeps capped aliases and a truncated description", () => {
    const n = { ...fat(1), aliases: Array.from({ length: FOCAL_ALIASES_MAX + 4 }, (_v, i) => `a${i}`) };
    const out = projectRelated({ node: n }).node;
    expect(out.aliases).toHaveLength(FOCAL_ALIASES_MAX);
    expect(out.description?.length).toBe(FOCAL_DESCRIPTION_MAX + 1); // the cap plus the ellipsis
    expect(out.description?.endsWith("…")).toBe(true);
  });

  it("the focal node leaves a description at or under the cap whole", () => {
    const ordinary = "Z".repeat(FOCAL_DESCRIPTION_MAX);
    expect(projectRelated({ node: { ...fat(1), description: ordinary } }).node.description).toBe(ordinary);
    expect(projectRelated({ node: { ...fat(1), description: "Short." } }).node.description).toBe("Short.");
  });

  const group = (key: string, n: number) => ({
    key, kind: "related", label: key, total: n, total_capped: n > 250,
    items: Array.from({ length: n }, (_v, i) => fat(i)),
  });

  it("map: each group previews NAMES only, keeps its counts, and carries no ids", () => {
    // Ids on a map cost 1,920 chars per NVIDIA call for handles the drill
    // returns anyway — measured 6,710 → 2,760 chars.
    const out = projectRelated({
      node: fat(0),
      relations: [group("rel:competes_with", 40), group("metrics", 2)],
    });
    expect(out.relations?.[0]?.preview).toEqual(["Node 0", "Node 1", "Node 2"]);
    expect(out.relations?.[0]?.preview).toHaveLength(OVERVIEW_PREVIEW_N);
    expect(out.relations?.[0]).not.toHaveProperty("items");
    expect(out.relations?.[0]?.total).toBe(40);
    expect(out.relations?.[1]?.preview).toHaveLength(2);
    expect(JSON.stringify(out.relations)).not.toContain("ent::n0::1");
  });

  it("map: the group's own `kind` is dropped — nothing renders it", () => {
    const out = projectRelated({ node: fat(0), relations: [group("metrics", 2)] });
    expect(out.relations?.[0]).not.toHaveProperty("kind");
  });

  it("drill: the whole page survives as items WITH ids, cursor kept", () => {
    const out = projectRelated({
      node: fat(0),
      relation: {
        key: "metrics", kind: "data", label: "Metrics", total: 300, total_capped: true,
        items: Array.from({ length: 50 }, (_v, i) => fat(i)), next_cursor: "c2",
      },
    });
    expect(out.relation?.items).toHaveLength(50);
    expect(out.relation?.items?.[7]).not.toHaveProperty("description");
    expect(out.relation?.items?.[7]?.id).toBe("ent::n7::1");
    expect(out.relation).not.toHaveProperty("preview");
    expect(out.relation?.next_cursor).toBe("c2");
  });

  it("a null next_cursor is dropped, so an absent field is the only 'no more pages' signal", () => {
    const out = projectRelated({
      node: fat(0),
      relation: { ...group("metrics", 2), next_cursor: null },
    });
    expect(out.relation).not.toHaveProperty("next_cursor");
  });

  it("drops inferred_labels and never invents a relations array on a drill", () => {
    const out = projectRelated({ node: fat(0), relation: null, inferred_labels: ["ORG"] });
    expect(out).not.toHaveProperty("inferred_labels");
    expect(out).not.toHaveProperty("relations");
    expect(out.relation).toBeNull();
  });
});
