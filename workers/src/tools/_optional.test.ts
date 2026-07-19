import { describe, expect, it } from "vitest";

import {
  OPTIONAL_TOOL_NAMES,
  parseEnabledOptionalToolNames,
} from "./_optional.js";

// The three tool files the `agent` alias spans: the single-call tool plus the
// ChatGPT split pair. Kept as a local constant so a change to the alias
// mapping fails these tests loudly rather than silently passing.
const AGENT_TOOLS = ["tako_agent", "tako_agent_start", "tako_agent_wait"];

describe("OPTIONAL_TOOL_NAMES", () => {
  it("is the flattened union of every alias's tool names", () => {
    expect([...OPTIONAL_TOOL_NAMES].sort()).toEqual([...AGENT_TOOLS].sort());
  });
});

describe("parseEnabledOptionalToolNames", () => {
  it("returns an empty set when the param is absent (null)", () => {
    expect(parseEnabledOptionalToolNames(null).size).toBe(0);
  });

  it("returns an empty set for empty or whitespace-only input", () => {
    expect(parseEnabledOptionalToolNames("").size).toBe(0);
    expect(parseEnabledOptionalToolNames("   ").size).toBe(0);
  });

  it("expands the `agent` alias to all three agent tools", () => {
    expect([...parseEnabledOptionalToolNames("agent")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });

  it("trims surrounding whitespace and lowercases tokens", () => {
    expect([...parseEnabledOptionalToolNames("  Agent ")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });

  it("de-duplicates a repeated alias", () => {
    expect([...parseEnabledOptionalToolNames("agent,agent")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });

  it("ignores an unknown token", () => {
    expect(parseEnabledOptionalToolNames("nope").size).toBe(0);
  });

  it("ignores raw tool names — only aliases are recognized", () => {
    // `tako_agent` is a tool name, not an alias key; alias-only recognition
    // means it resolves to nothing. Enabling the agent requires `agent`.
    expect(parseEnabledOptionalToolNames("tako_agent").size).toBe(0);
  });

  it("keeps recognized aliases and drops unknown tokens in a mixed list", () => {
    expect([...parseEnabledOptionalToolNames("agent,nope")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });
});
