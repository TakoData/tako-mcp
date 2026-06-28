import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import { assertAllToolsDescribed, MCP_TOOL_ALLOWLIST } from "./gen-registry.js";

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
