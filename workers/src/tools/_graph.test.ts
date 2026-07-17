import { describe, expect, it } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "../django.js";
import type { GraphRelatedResponse } from "../generated/schemas.js";
import { graphErrorMessage, mergeRelatedResponses } from "./_graph.js";

const node = (id: string, name: string) =>
  ({ id, type: "metric" as const, name });

const hub = { id: "tesla-x1", type: "entity" as const, name: "Tesla" };

describe("graphErrorMessage", () => {
  const P = { path: "/api/beta/graph/search", method: "GET" as const };

  it("401 → key/environment guidance", () => {
    const msg = graphErrorMessage(new DjangoUnauthorizedError(P), "search");
    expect(msg).toMatch(/401/);
    expect(msg).toMatch(/production key is rejected on staging/i);
  });

  it("search 400 → lists valid labels and the types constraint", () => {
    const msg = graphErrorMessage(
      new DjangoBadRequestError({ ...P, body: '{"label":["invalid"]}' }),
      "search",
    );
    expect(msg).toMatch(/400/);
    expect(msg).toMatch(/STOCK_TICKER/); // the label enum is spelled out
    expect(msg).toMatch(/"entity" or "metric"/);
    expect(msg).toMatch(/Backend detail/); // the raw body is preserved
  });

  it("related 404 → points at node_id, and clarifies relation is NOT a 404", () => {
    const msg = graphErrorMessage(
      new DjangoNotFoundError({ path: "/api/beta/graph/related", method: "GET" }),
      "related",
      "bogus-node-9",
    );
    expect(msg).toMatch(/no graph node with id "bogus-node-9"/);
    expect(msg).toMatch(/unknown `relation` is NOT a 404/);
  });

  it("node 404 → explains where ids come from and echoes the id", () => {
    const msg = graphErrorMessage(
      new DjangoNotFoundError({ path: "/api/beta/graph/node/x", method: "GET" }),
      "node",
      "not-a-real-id",
    );
    expect(msg).toMatch(/no graph node with id "not-a-real-id"/);
    expect(msg).toMatch(/never a plain name/);
  });

  it("429 → rate-limit backoff guidance", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 429, body: "" }),
      "search",
    );
    expect(msg).toMatch(/rate limited \(429\)/);
    expect(msg).toMatch(/180 requests\/min/);
  });

  it("503 → transient store-unavailable guidance", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 503, body: "" }),
      "related",
      "n1",
    );
    expect(msg).toMatch(/temporarily unavailable \(503\)/);
  });

  it("403 → framed as an edge/WAF infra block, not an input problem", () => {
    const msg = graphErrorMessage(
      new DjangoHttpError({ ...P, status: 403, body: "<html>blocked</html>" }),
      "search",
    );
    expect(msg).toMatch(/blocked \(403\)/);
    expect(msg).toMatch(/edge\/WAF/);
    expect(msg).toMatch(/not a query problem/i);
  });

  it("timeout → retry-once guidance", () => {
    const msg = graphErrorMessage(
      new DjangoTimeoutError({ ...P, timeoutMs: 15_000 }),
      "search",
    );
    expect(msg).toMatch(/timed out/);
  });

  it("non-JSON 2xx (parse error) → unreadable-response guidance", () => {
    const msg = graphErrorMessage(
      new DjangoResponseParseError({ ...P, status: 200, cause: new Error("bad") }),
      "node",
      "n1",
    );
    expect(msg).toMatch(/unreadable \(non-JSON\)/);
  });

  it("non-transport error → surfaced, not masked", () => {
    const msg = graphErrorMessage(new Error("boom"), "search");
    expect(msg).toMatch(/unexpected error — boom/);
  });
});

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

  it("merges 3+ responses (drill), unioning and deduping across all of them", () => {
    const mk = (id: string, name: string): GraphRelatedResponse => ({
      node: hub,
      relation: {
        key: "metrics", kind: "data", label: "Metrics",
        items: [node(id, name), node("shared-9", "Average Wages")],
        total: 2, total_capped: false, next_cursor: null,
      },
    });
    const merged = mergeRelatedResponses([
      mk("rev-1", "Revenue"), mk("sales-2", "Sales"), mk("net-3", "Net Income"),
    ]);
    expect(merged.relation?.items.map((n) => n.id)).toEqual([
      "rev-1", "shared-9", "sales-2", "net-3",
    ]);
    expect(merged.relation?.total).toBe(4);
  });

  it("unions and dedupes inferred_labels", () => {
    const a: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG"] };
    const b: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG", "PRODUCT"] };
    const merged = mergeRelatedResponses([a, b]);
    expect(merged.inferred_labels).toEqual(["ORG", "PRODUCT"]);
  });
});
