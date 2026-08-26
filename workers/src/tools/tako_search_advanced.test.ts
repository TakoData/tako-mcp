import { describe, expect, it } from "vitest";

import { FREE_TIER_TOOL_NAMES } from "../freetier.js";
import { CHATGPT_TOOL_NAMES, GENERIC_DEFAULT_TOOL_NAMES } from "./_surface.js";
import tako_search_advanced, { buildAdvancedSearchBody } from "./tako_search_advanced.js";

describe("tako_search_advanced surface membership", () => {
  it("is opt-in on /mcp and absent from the chatgpt surface", () => {
    expect(GENERIC_DEFAULT_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
    expect(CHATGPT_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
  });

  it("never executes anonymously — it can bill rows", () => {
    expect(FREE_TIER_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
  });

  it("declares fixedInputs (empty — mirroring the API is the point) and all four hints", () => {
    expect(tako_search_advanced.fixedInputs).toEqual([]);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      expect(typeof tako_search_advanced.annotations[hint]).toBe("boolean");
    }
  });
});

describe("tako_search_advanced mirrors the v3 SearchRequest", () => {
  it("exposes the top level plus the two per-source blocks", () => {
    expect(Object.keys(tako_search_advanced.inputSchema.shape).sort()).toEqual([
      "country_code",
      "data",
      "effort",
      "locale",
      "query",
      "web",
    ]);
  });

  it("declares no defaults of its own — an omitted field never reaches the wire", () => {
    const parsed = tako_search_advanced.inputSchema.parse({ query: "x" });
    expect(parsed).toEqual({ query: "x" });
    expect(buildAdvancedSearchBody(parsed)).toEqual({ query: "x" });
  });

  it("strips no generated default into an empty source block", () => {
    // .partial() must remove the generated .default() too, or naming a block
    // would silently send count:5 / include_contents:false / strict:false and
    // the no-defaults rule would be a lie.
    const parsed = tako_search_advanced.inputSchema.parse({ query: "x", data: {}, web: {} });
    expect(buildAdvancedSearchBody(parsed).sources).toEqual({ data: {}, web: {} });
  });

  it("omits sources entirely when the caller names neither block", () => {
    // Absent sources means the API searches data and web with its own
    // defaults; sending {} would be a different request.
    const body = buildAdvancedSearchBody(tako_search_advanced.inputSchema.parse({ query: "x" }));
    expect("sources" in body).toBe(false);
  });

  it("exposes effort deep, which the simple tool cannot reach", () => {
    expect(tako_search_advanced.inputSchema.safeParse({ query: "x", effort: "deep" }).success).toBe(true);
    expect(tako_search_advanced.inputSchema.safeParse({ query: "x", effort: "nope" }).success).toBe(false);
  });

  it("keeps card_json: advanced means every content_format the API has", () => {
    const parsed = tako_search_advanced.inputSchema.safeParse({
      query: "x",
      data: { include_contents: true, content_format: "card_json" },
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a full SearchRequest", () => {
    const input = tako_search_advanced.inputSchema.parse({
      query: "US CPI",
      effort: "deep",
      country_code: "GB",
      locale: "en-GB",
      data: {
        count: 3,
        include_contents: true,
        max_rows: 500,
        content_format: "json_records",
        node_ids: ["mt::cpi::1"],
        strict: true,
      },
      web: {
        count: 2,
        include_contents: true,
        include_domains: ["bls.gov"],
        exclude_domains: ["example.com"],
        category: "news",
        snippet_max_chars: 1500,
        highlights: true,
      },
    });
    expect(buildAdvancedSearchBody(input)).toEqual({
      query: "US CPI",
      effort: "deep",
      country_code: "GB",
      locale: "en-GB",
      sources: {
        data: {
          count: 3,
          include_contents: true,
          max_rows: 500,
          content_format: "json_records",
          node_ids: ["mt::cpi::1"],
          strict: true,
        },
        web: {
          count: 2,
          include_contents: true,
          include_domains: ["bls.gov"],
          exclude_domains: ["example.com"],
          category: "news",
          snippet_max_chars: 1500,
          highlights: true,
        },
      },
    });
  });

  it("rejects a field the API does not have on a source block", () => {
    // The blocks are picked off the generated settings schemas, which are
    // .strict() — so a typo fails here instead of 400-ing at the backend.
    expect(
      tako_search_advanced.inputSchema.safeParse({ query: "x", data: { counts: 3 } }).success,
    ).toBe(false);
  });
});
