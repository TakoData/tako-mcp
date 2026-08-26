import { describe, expect, it } from "vitest";

import {
  OPTIONAL_TOOL_NAMES,
  parseEnabledOptionalToolNames,
} from "./_optional.js";

// The three tool files the `agent` alias spans: the single-call tool plus the
// ChatGPT split pair. Kept as a local constant so a change to the alias
// mapping fails these tests loudly rather than silently passing.
const AGENT_TOOLS = ["tako_agent", "tako_agent_start", "tako_agent_wait"];

// The three low-level graph primitives the `graph` alias spans — the
// power-user escape hatch behind `tako_available_data`. Same loud-failure
// rationale as AGENT_TOOLS.
const GRAPH_TOOLS = ["tako_graph_search", "tako_graph_related", "tako_graph_node"];

// The single-tool aliases: context-heavy or rarely-needed tools kept off the
// default surface. Same loud-failure rationale as AGENT_TOOLS.
const SINGLE_TOOL_ALIASES: Record<string, string> = {
  answer: "tako_answer",
  visualize: "tako_visualize",
  credits: "tako_credit_balance",
};

const ALL_OPTIONAL_TOOLS = [
  ...AGENT_TOOLS,
  ...GRAPH_TOOLS,
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

  it("expands the `answer` alias to tako_answer, which is opt-in", () => {
    expect(parseEnabledOptionalToolNames("answer")).toEqual(
      new Set(["tako_answer"]),
    );
    expect(OPTIONAL_TOOL_NAMES.has("tako_answer")).toBe(true);
  });

  it("expands the `graph` alias to all three graph primitives", () => {
    expect([...parseEnabledOptionalToolNames("graph")].sort()).toEqual(
      [...GRAPH_TOOLS].sort(),
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
      [...AGENT_TOOLS, "tako_visualize", "tako_credit_balance"].sort(),
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
    expect(parseEnabledOptionalToolNames("tako_credit_balance").size).toBe(0);
  });

  it("keeps recognized aliases and drops unknown tokens in a mixed list", () => {
    expect([...parseEnabledOptionalToolNames("agent,nope")].sort()).toEqual(
      [...AGENT_TOOLS].sort(),
    );
  });

  // The alias table is an object literal, so every `Object.prototype` key is
  // reachable by a `?tools=` token that survives `toLowerCase()`. Before the
  // `Object.hasOwn` guard, `?tools=constructor` and `?tools=__proto__` each
  // resolved an inherited value, slipped past the `undefined` check, and threw
  // `TypeError: toolNames is not iterable` — on the anonymous path that lands
  // before `handleMcpRequest`'s outer `try`, so an unauthenticated request
  // got a bare 500 instead of a JSON-RPC error.
  //
  // The token list is DERIVED, not written out: only `constructor` and
  // `__proto__` are lowercase-stable today (`toString` mangles to `tostring`,
  // which no prototype has), but a runtime or `lib` change that adds another
  // must fail here rather than in production.
  const prototypeTokens = Object.getOwnPropertyNames(Object.prototype).map(
    (key) => key.toLowerCase(),
  );

  it.each(prototypeTokens)(
    "treats the Object.prototype key %s as an unknown token",
    (token) => {
      expect(() => parseEnabledOptionalToolNames(token)).not.toThrow();
      expect(parseEnabledOptionalToolNames(token).size).toBe(0);
    },
  );

  it("still parses a real alias when a prototype key rides along", () => {
    expect(
      [...parseEnabledOptionalToolNames("constructor,agent,__proto__")].sort(),
    ).toEqual([...AGENT_TOOLS].sort());
  });
});
