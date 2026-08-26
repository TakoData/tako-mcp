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
  OVERVIEW_PREVIEW_N,
  slimFocalNode,
  slimNode,
  slimRelatedResponse,
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

describe("graph slimming", () => {
  it("slimNode keeps id, name, type, subtype, label and drops aliases and description", () => {
    expect(slimNode(fat(1))).toEqual({
      id: "ent::n1::1", type: "entity", name: "Node 1", subtype: "Companies", label: "ORG",
    });
  });

  it("slimNode omits subtype and label when the wire has none (no null padding)", () => {
    expect(slimNode({ id: "mt::x::1", type: "metric", name: "Revenue" })).toEqual({
      id: "mt::x::1", type: "metric", name: "Revenue",
    });
  });

  it("slimFocalNode keeps capped aliases and a truncated description", () => {
    const n = { ...fat(1), aliases: Array.from({ length: FOCAL_ALIASES_MAX + 4 }, (_v, i) => `a${i}`) };
    const out = slimFocalNode(n);
    expect(out.aliases).toHaveLength(FOCAL_ALIASES_MAX);
    expect(out.description?.length).toBe(FOCAL_DESCRIPTION_MAX + 1); // the cap plus the ellipsis
    expect(out.description?.endsWith("…")).toBe(true);
  });

  it("slimFocalNode leaves an ordinary graph description whole", () => {
    // Measured descriptions run ~300-450 chars; the bound is for the
    // pathological case, not for the ordinary one.
    const ordinary = "Z".repeat(400);
    expect(slimFocalNode({ ...fat(1), description: ordinary }).description).toBe(ordinary);
  });

  it("slimFocalNode leaves a short description alone", () => {
    expect(slimFocalNode({ ...fat(1), description: "Short." }).description).toBe("Short.");
  });

  it("overview: every group keeps key/kind/label/total and only the first OVERVIEW_PREVIEW_N slim items", () => {
    const group = (key: string, n: number) => ({
      key, kind: "related", label: key, total: n, total_capped: n > 250,
      items: Array.from({ length: n }, (_v, i) => fat(i)),
    });
    const out = slimRelatedResponse({
      node: fat(0),
      relations: [group("rel:competes_with", 40), group("metrics", 2)],
    });
    expect(out.relations?.[0]?.items).toHaveLength(OVERVIEW_PREVIEW_N);
    expect(out.relations?.[0]?.items[0]).toEqual(slimNode(fat(0)));
    expect(out.relations?.[0]?.total).toBe(40);
    expect(out.relations?.[1]?.items).toHaveLength(2);
    expect(out.node.description?.endsWith("…")).toBe(true);
    expect(out.node.aliases).toEqual(["N0", "Node-0"]);
  });

  it("drill: the whole page survives, each item slimmed, cursor kept", () => {
    const out = slimRelatedResponse({
      node: fat(0),
      relation: {
        key: "metrics", kind: "data", label: "Metrics", total: 300, total_capped: true,
        items: Array.from({ length: 50 }, (_v, i) => fat(i)), next_cursor: "c2",
      },
    });
    expect(out.relation?.items).toHaveLength(50);
    expect(out.relation?.items[7]).not.toHaveProperty("description");
    expect(out.relation?.next_cursor).toBe("c2");
  });

  it("passes inferred_labels through and never invents a relations array on a drill", () => {
    const out = slimRelatedResponse({ node: fat(0), relation: null, inferred_labels: ["ORG"] });
    expect(out.inferred_labels).toEqual(["ORG"]);
    expect(out).not.toHaveProperty("relations");
  });
});
