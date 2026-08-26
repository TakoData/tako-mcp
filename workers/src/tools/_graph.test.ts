import { describe, expect, it } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "../django.js";
import { graphErrorMessage } from "./_graph.js";

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
