import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import {
  assertAllToolsDescribed,
  assertLlmsFullCoverage,
  MCP_TOOL_ALLOWLIST,
} from "./gen-registry.js";

describe("registry guards", () => {
  it("every registered tool has a non-empty description", () => {
    expect(() => assertAllToolsDescribed(TOOL_REGISTRY)).not.toThrow();
  });

  it("the allowlist covers exactly the registered tool names", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const name of MCP_TOOL_ALLOWLIST) expect(registered.has(name)).toBe(true);
    expect(registered.size).toBe(MCP_TOOL_ALLOWLIST.length);
  });
});

describe("assertLlmsFullCoverage", () => {
  const tool = (name: string, ...params: string[]) => ({
    name,
    parameters: Object.fromEntries(params.map((p) => [p, {}])),
  });

  it("passes when a sectioned tool documents all its params", () => {
    const doc = "### tako_x\nStuff.\n\nParameters:\n- `query` (string)\n- `limit` (int)\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x", "query", "limit")], doc),
    ).not.toThrow();
  });

  it("fails when a sectioned tool is missing a param", () => {
    const doc = "### tako_x\nParameters:\n- `query` (string)\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x", "query", "node_ids")], doc),
    ).toThrow(/### tako_x.*`node_ids`/);
  });

  it("accepts a prose-only mention (no section) without param checks", () => {
    const doc = "On ChatGPT this is the `tako_x_start` / `tako_x_wait` pair.\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x_start", "query")], doc),
    ).not.toThrow();
  });

  it("fails when a tool is never mentioned at all", () => {
    expect(() => assertLlmsFullCoverage([tool("tako_ghost")], "# Tako\n")).toThrow(
      /tako_ghost.*never mentioned/,
    );
  });

  it("only matches whole `### name` headings, not prefixes", () => {
    // A `### tako_agent` section must not satisfy `tako_agent_start`.
    const doc = "### tako_agent\nParameters:\n- `query`\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_agent_start", "query")], doc),
    ).toThrow(/tako_agent_start.*never mentioned/);
  });
});
