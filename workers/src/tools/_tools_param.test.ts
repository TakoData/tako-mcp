import { describe, expect, it } from "vitest";
import { parseToolsParam } from "./_tools_param.js";

const KNOWN: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_contents",
  "tako_agent",
  "tako_credit_balance",
]);

describe("parseToolsParam", () => {
  it("returns null when the param is absent", () => {
    expect(parseToolsParam(null, KNOWN)).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(parseToolsParam("", KNOWN)).toBeNull();
    expect(parseToolsParam("  , ,", KNOWN)).toBeNull();
  });

  it("accepts full tool names", () => {
    expect(parseToolsParam("tako_search,tako_contents", KNOWN)).toEqual(
      new Set(["tako_search", "tako_contents"]),
    );
  });

  it("accepts names without the tako_ prefix", () => {
    expect(parseToolsParam("search,contents", KNOWN)).toEqual(
      new Set(["tako_search", "tako_contents"]),
    );
    expect(parseToolsParam("credit_balance", KNOWN)).toEqual(
      new Set(["tako_credit_balance"]),
    );
  });

  it("trims whitespace, lowercases, and de-duplicates", () => {
    expect(parseToolsParam(" Search , TAKO_SEARCH ,agent", KNOWN)).toEqual(
      new Set(["tako_search", "tako_agent"]),
    );
  });

  it("drops unknown tokens and keeps the rest", () => {
    expect(parseToolsParam("nope,agent", KNOWN)).toEqual(new Set(["tako_agent"]));
  });

  it("returns null when every token is unknown — the caller falls back to defaults", () => {
    expect(parseToolsParam("nope,graph,credits", KNOWN)).toBeNull();
  });

  it("does not recognize the old group aliases", () => {
    // `graph` and `credits` were alias tokens before spec D1; a stale URL
    // must fall back to the defaults, not silently enable something else.
    expect(parseToolsParam("graph", KNOWN)).toBeNull();
    expect(parseToolsParam("credits", KNOWN)).toBeNull();
  });
});
