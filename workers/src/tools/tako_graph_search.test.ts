import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoGraphSearch from "./tako_graph_search.js";
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

const RESULTS = {
  results: [
    { id: "tesla-x1", type: "entity", name: "Tesla", subtype: "Companies",
      label: "ORG", aliases: ["TSLA"], description: "EV maker" },
  ],
  inferred_labels: ["ORG"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_graph_search", () => {
  it("tool name is tako_graph_search", () => {
    expect(takoGraphSearch.name).toBe("tako_graph_search");
  });

  it("sends q/types/label/limit as query params to /api/beta/graph/search", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, RESULTS)]);

    const out = await takoGraphSearch.handler(
      { q: "Tesla", types: "entity", label: "ORG", infer_label: true, limit: 5 },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/beta/graph/search");
    expect(req.method).toBe("GET");
    expect(url.searchParams.get("q")).toBe("Tesla");
    expect(url.searchParams.get("types")).toBe("entity");
    expect(url.searchParams.get("label")).toBe("ORG");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(req.headers.get("X-API-Key")).toBe("sk-test");

    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.id).toBe("tesla-x1");
    expect(out.inferred_labels).toEqual(["ORG"]);
  });

  it("omits optional params when not provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    await takoGraphSearch.handler({ q: "Tesla" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.has("types")).toBe(false);
    expect(url.searchParams.has("label")).toBe(false);
  });

  it("rejects q shorter than 2 chars", () => {
    expect(() => takoGraphSearch.inputSchema.parse({ q: "a" })).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { results: "not-an-array" })]);
    await expect(takoGraphSearch.handler({ q: "Tesla" }, CTX)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
