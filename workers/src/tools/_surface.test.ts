import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./_registry.js";
import {
  CHATGPT_TOOL_NAMES,
  FREE_TIER_TOOL_NAMES,
  GENERIC_DEFAULT_TOOL_NAMES,
  isToolOnSurface,
  resolveToolSet,
  toolAnnotationsForSurface,
} from "./_surface.js";

const REGISTRY_NAMES = new Set(TOOL_REGISTRY.map((t) => t.name));

describe("surface membership sets", () => {
  it("every default name is a registered tool (a typo here silently drops a tool)", () => {
    for (const name of [...GENERIC_DEFAULT_TOOL_NAMES, ...CHATGPT_TOOL_NAMES]) {
      expect(REGISTRY_NAMES.has(name), name).toBe(true);
    }
  });

  it("generic default listing is the four tools spec D3 names", () => {
    expect([...GENERIC_DEFAULT_TOOL_NAMES].sort()).toEqual([
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
      "tako_search",
    ]);
  });

  it("the anonymous executable set is tako_search alone, and a subset of the default listing", () => {
    // A free tool that is not default-listed would be executable but
    // invisible; a default tool that is free must be one the shared account
    // can afford. `tako_available_data` fails the second test (see the
    // constant's comment) and left the set.
    expect([...FREE_TIER_TOOL_NAMES]).toEqual(["tako_search"]);
    for (const name of FREE_TIER_TOOL_NAMES) {
      expect(GENERIC_DEFAULT_TOOL_NAMES.has(name), name).toBe(true);
      expect(REGISTRY_NAMES.has(name), name).toBe(true);
    }
  });

  it("chatgpt listing is the five submitted tools (spec D2)", () => {
    expect([...CHATGPT_TOOL_NAMES].sort()).toEqual([
      "tako_available_data",
      "tako_contents",
      "tako_graph_related",
      "tako_search",
      "tako_visualize",
    ]);
  });
});

describe("resolveToolSet", () => {
  it("generic with no allowlist serves the defaults", () => {
    expect(resolveToolSet("generic", null)).toBe(GENERIC_DEFAULT_TOOL_NAMES);
  });

  it("generic with an EMPTY allowlist serves the defaults, not an empty listing", () => {
    // `new Set()` meant "no opt-ins, serve the defaults" before the allowlist
    // (`noOptIns` at four call sites); it must not now mean "register nothing".
    expect(resolveToolSet("generic", new Set())).toBe(GENERIC_DEFAULT_TOOL_NAMES);
    expect(isToolOnSurface("tako_search", "generic", new Set())).toBe(true);
  });

  it("generic with an allowlist serves exactly the allowlist — it replaces the defaults", () => {
    const only = new Set(["tako_agent"]);
    expect(resolveToolSet("generic", only)).toBe(only);
    expect(isToolOnSurface("tako_search", "generic", only)).toBe(false);
    expect(isToolOnSurface("tako_agent", "generic", only)).toBe(true);
  });

  it("chatgpt ignores the allowlist and always serves the fixed set", () => {
    expect(resolveToolSet("chatgpt", null)).toBe(CHATGPT_TOOL_NAMES);
    expect(resolveToolSet("chatgpt", new Set(["tako_agent"]))).toBe(CHATGPT_TOOL_NAMES);
    expect(isToolOnSurface("tako_agent", "chatgpt", new Set(["tako_agent"]))).toBe(false);
    expect(isToolOnSurface("tako_visualize", "chatgpt", null)).toBe(true);
  });

  it("listing never varies by tier: there is no tier parameter", () => {
    expect(isToolOnSurface.length).toBe(3);
    expect(resolveToolSet.length).toBe(2);
  });
});

describe("toolAnnotationsForSurface", () => {
  const tool = {
    annotations: {
      title: "t",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    annotationsBySurface: { chatgpt: { openWorldHint: false } },
  };

  it("generic serves canonical MCP annotations", () => {
    expect(toolAnnotationsForSurface(tool, "generic").openWorldHint).toBe(true);
  });

  it("chatgpt serves the Apps-review override", () => {
    expect(toolAnnotationsForSurface(tool, "chatgpt").openWorldHint).toBe(false);
  });
});

describe("tool descriptions are tier-invariant", () => {
  // Descriptions (like `initialize` instructions) are loaded by the host once
  // and survive a mid-conversation sign-in, so a tier-varying claim in one
  // outlives the state it describes — the sign-in signal belongs only in the
  // dispatch-time `authRequiredToolResult` (`mcp.ts`). `tako_contents` is the
  // one exemption: its sentence ("Requires a signed-in connection; anonymous
  // calls return sign-in instructions") is TRUE on every tier, because the
  // tool is auth-required outright.
  const TIER_CLAIM = /anonymous|signed[- ]in|sign[- ]in|Tako account/i;

  it("no description claims tier-varying availability (tako_contents exempt)", () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.name === "tako_contents") continue;
      expect(TIER_CLAIM.test(tool.description), tool.name).toBe(false);
    }
  });

  it("the tako_contents exemption is still earning its place", () => {
    // If this fails, the sentence was removed — delete the exemption too.
    const contents = TOOL_REGISTRY.find((t) => t.name === "tako_contents");
    expect(contents).toBeDefined();
    expect(TIER_CLAIM.test(contents!.description)).toBe(true);
  });
});
