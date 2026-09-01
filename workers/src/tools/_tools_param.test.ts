import { describe, expect, it } from "vitest";
import { parseToolsParam, readToolsParam } from "./_tools_param.js";

const KNOWN: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_contents",
  "tako_agent",
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
    expect(parseToolsParam("nope,graph,credits,answer", KNOWN)).toBeNull();
  });
});

describe("readToolsParam", () => {
  const read = (search: string) => readToolsParam(new URL(`https://m/mcp${search}`));

  it("returns null when the param is absent", () => {
    expect(read("")).toBeNull();
  });

  it("returns null for a present-but-empty param, the same defaults branch", () => {
    // `parseToolsParam("")` also yielded the defaults, so this collapse
    // changes the path taken, not the surface served.
    expect(read("?tools=")).toBeNull();
  });

  it("reads a single param", () => {
    expect(read("?tools=agent")).toBe("agent");
  });

  it("JOINS repeated params instead of taking the first", () => {
    // `searchParams.get` would return "agent" alone, and under allowlist
    // semantics that registers `tako_agent` with none of the defaults its
    // own description names.
    expect(read("?tools=agent&tools=visualize")).toBe("agent,visualize");
  });

  it("joins repeated params that each carry a comma list", () => {
    expect(read("?tools=search,contents&tools=visualize")).toBe(
      "search,contents,visualize",
    );
  });

  it("hands the joined value to parseToolsParam intact", () => {
    expect(parseToolsParam(read("?tools=agent&tools=search"), KNOWN)).toEqual(
      new Set(["tako_agent", "tako_search"]),
    );
  });
});
