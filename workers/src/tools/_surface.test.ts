import { describe, expect, it } from "vitest";
import { isToolOnSurface, toolAnnotationsForSurface } from "./_surface.js";

const none = new Set<string>();

describe("isToolOnSurface", () => {
  it("generic default surface is search, available_data, contents", () => {
    for (const name of [
      "tako_search",
      "tako_available_data",
      "tako_contents",
    ]) {
      expect(isToolOnSurface(name, "generic", none)).toBe(true);
    }
    for (const name of [
      "tako_answer",
      "tako_visualize",
      "tako_agent",
      "get_credit_balance",
      "tako_graph_search",
    ]) {
      expect(isToolOnSurface(name, "generic", none)).toBe(false);
    }
  });

  it("chatgpt default surface adds tako_visualize", () => {
    expect(isToolOnSurface("tako_visualize", "chatgpt", none)).toBe(true);
    expect(isToolOnSurface("tako_answer", "chatgpt", none)).toBe(false);
  });

  it("agent alias resolves the split pair on chatgpt, single tool on generic", () => {
    const agent = new Set(["tako_agent", "tako_agent_start", "tako_agent_wait"]);
    expect(isToolOnSurface("tako_agent", "generic", agent)).toBe(true);
    expect(isToolOnSurface("tako_agent_start", "generic", agent)).toBe(false);
    expect(isToolOnSurface("tako_agent", "chatgpt", agent)).toBe(false);
    expect(isToolOnSurface("tako_agent_start", "chatgpt", agent)).toBe(true);
    expect(isToolOnSurface("tako_agent_wait", "chatgpt", agent)).toBe(true);
  });

  it("listing never varies by tier: there is no tier parameter", () => {
    expect(isToolOnSurface.length).toBe(3);
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
