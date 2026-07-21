import { describe, expect, it } from "vitest";

import {
  OPTIONAL_TOOL_NAMES,
  parseEnabledOptionalToolNames,
} from "./_optional.js";

// The three tool files the `agent` alias spans: the single-call tool plus the
// ChatGPT split pair. Kept as a local constant so a change to the alias
// mapping fails these tests loudly rather than silently passing.
const AGENT_TOOLS = ["tako_agent", "tako_agent_start", "tako_agent_wait"];

// The single-tool aliases: context-heavy or rarely-needed tools kept off the
// default surface. Same loud-failure rationale as AGENT_TOOLS.
const SINGLE_TOOL_ALIASES: Record<string, string> = {
  visualize: "tako_visualize",
  credits: "get_credit_balance",
};

const ALL_OPTIONAL_TOOLS = [
  ...AGENT_TOOLS,
  ...Object.values(SINGLE_TOOL_ALIASES),
];

describe("OPTIONAL_TOOL_NAMES", () => {
  it("is the flattened union of every alias's tool names", () => {
    expect([...OPTIONAL_TOOL_NAMES].sort()).toEqual(
      [...ALL_OPTIONAL_TOOLS].sort(),
    );
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

  it.each(Object.entries(SINGLE_TOOL_ALIASES))(
    "expands the `%s` alias to %s",
    (alias, toolName) => {
      expect([...parseEnabledOptionalToolNames(alias)]).toEqual([toolName]);
    },
  );

  it("composes multiple aliases in one list", () => {
    expect(
      [...parseEnabledOptionalToolNames("agent,visualize,credits")].sort(),
    ).toEqual(
      [...AGENT_TOOLS, "tako_visualize", "get_credit_balance"].sort(),
    );
  });

  it("trims surrounding whitespace and lowercases tokens", () => {
    expect([...parseEnabledOptionalToolNames("  Agent ")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
    expect([...parseEnabledOptionalToolNames(" Visualize ")]).toEqual([
      "tako_visualize",
    ]);
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
    // `tako_agent` and `tako_visualize` are tool names, not alias keys;
    // alias-only recognition means they resolve to nothing. Enabling a tool
    // requires its alias (`agent`, `visualize`, ...).
    expect(parseEnabledOptionalToolNames("tako_agent").size).toBe(0);
    expect(parseEnabledOptionalToolNames("tako_visualize").size).toBe(0);
    expect(parseEnabledOptionalToolNames("get_credit_balance").size).toBe(0);
  });

  it("keeps recognized aliases and drops unknown tokens in a mixed list", () => {
    expect([...parseEnabledOptionalToolNames("agent,nope")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });
});
