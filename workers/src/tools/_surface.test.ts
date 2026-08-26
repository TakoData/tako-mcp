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

  // The four tools `chatgpt-app-submission.json` declares. `registry:check`
  // enforces the same set via `assertChatgptSubmissionParity`, but only for
  // the submission file — this pins the membership rule itself, so a change
  // here fails before the codegen notices.
  it("chatgpt default surface is search, available_data, contents, visualize", () => {
    for (const name of [
      "tako_search",
      "tako_available_data",
      "tako_contents",
      "tako_visualize",
    ]) {
      expect(isToolOnSurface(name, "chatgpt", none)).toBe(true);
    }
    for (const name of [
      "tako_answer",
      "tako_agent",
      "tako_agent_start",
      "get_credit_balance",
      "tako_graph_search",
    ]) {
      expect(isToolOnSurface(name, "chatgpt", none)).toBe(false);
    }
  });

  // `_optional.test.ts` covers `answer` -> ["tako_answer"]; this covers the
  // consequence, which is the half that decides what a connection lists.
  it("?tools=answer restores tako_answer on both surfaces", () => {
    const answer = new Set(["tako_answer"]);
    expect(isToolOnSurface("tako_answer", "generic", answer)).toBe(true);
    expect(isToolOnSurface("tako_answer", "chatgpt", answer)).toBe(true);
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
