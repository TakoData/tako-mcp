import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./_registry.js";
import {
  CHATGPT_TOOL_NAMES,
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
