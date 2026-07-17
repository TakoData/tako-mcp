import { describe, expect, it } from "vitest";

import type { GraphRelatedResponse } from "../generated/schemas.js";
import { mergeRelatedResponses } from "./_graph.js";

const node = (id: string, name: string) =>
  ({ id, type: "metric" as const, name });

const hub = { id: "tesla-x1", type: "entity" as const, name: "Tesla" };

describe("mergeRelatedResponses — drill mode", () => {
  it("unions and dedupes relation.items by node id across responses", () => {
    const a: GraphRelatedResponse = {
      node: hub,
      relation: {
        key: "metrics", kind: "data", label: "Metrics",
        items: [node("rev-1", "Revenue"), node("shared-9", "Average Wages")],
        total: 2, total_capped: false, next_cursor: null,
      },
    };
    const b: GraphRelatedResponse = {
      node: hub,
      relation: {
        key: "metrics", kind: "data", label: "Metrics",
        items: [node("sales-2", "Sales"), node("shared-9", "Average Wages")],
        total: 2, total_capped: true, next_cursor: null,
      },
    };

    const merged = mergeRelatedResponses([a, b]);

    expect(merged.relation?.items.map((n) => n.id)).toEqual([
      "rev-1", "shared-9", "sales-2",
    ]);
    expect(merged.relation?.total).toBe(3);
    expect(merged.relation?.total_capped).toBe(true); // OR of inputs
    expect(merged.relation?.next_cursor).toBeNull();
  });
});

describe("mergeRelatedResponses — overview mode", () => {
  it("unions groups by key and items within a group by id", () => {
    const a: GraphRelatedResponse = {
      node: hub,
      relations: [
        { key: "metrics", kind: "data", label: "Metrics",
          items: [node("rev-1", "Revenue")], total: 1, total_capped: false },
      ],
    };
    const b: GraphRelatedResponse = {
      node: hub,
      relations: [
        { key: "metrics", kind: "data", label: "Metrics",
          items: [node("rev-1", "Revenue"), node("sales-2", "Sales")],
          total: 2, total_capped: false },
        { key: "entities", kind: "data", label: "Entities",
          items: [node("ford-3", "Ford")], total: 1, total_capped: false },
      ],
    };

    const merged = mergeRelatedResponses([a, b]);

    const metrics = merged.relations?.find((g) => g.key === "metrics");
    const entities = merged.relations?.find((g) => g.key === "entities");
    expect(metrics?.items.map((n) => n.id)).toEqual(["rev-1", "sales-2"]);
    expect(metrics?.total).toBe(2);
    expect(entities?.items.map((n) => n.id)).toEqual(["ford-3"]);
    // first-seen order preserved
    expect(merged.relations?.map((g) => g.key)).toEqual(["metrics", "entities"]);
  });

  it("unions and dedupes inferred_labels", () => {
    const a: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG"] };
    const b: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG", "PRODUCT"] };
    const merged = mergeRelatedResponses([a, b]);
    expect(merged.inferred_labels).toEqual(["ORG", "PRODUCT"]);
  });
});
