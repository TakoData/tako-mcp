/**
 * Guards the advertised tool annotations across the WHOLE registry.
 * `openWorldHint` follows the MCP spec's meaning — true when a tool interacts
 * with an open/unpredictable set of external entities (web search and the live
 * data graph), false for a closed domain (rendering caller-supplied data).
 * Iterating `TOOL_REGISTRY` (rather than a hand-listed subset) makes the
 * "every tool declares all three hints" guarantee real and catches a future
 * tool that ships the wrong value.
 */
import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./_registry.js";

// Closed-domain tools per the MCP spec: tako_visualize renders data the caller
// already supplied; get_credit_balance reads Tako's own account state. Every
// other tool reaches the open world (web + the live data graph).
const CLOSED_WORLD = new Set(["tako_visualize", "get_credit_balance"]);

describe("tool annotations", () => {
  it("every tool declares all three hints explicitly (booleans)", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe("boolean");
    }
  });

  it("openWorldHint matches the MCP-spec domain-of-interaction for every tool", () => {
    for (const tool of TOOL_REGISTRY) {
      const expected = !CLOSED_WORLD.has(tool.name);
      expect(tool.annotations.openWorldHint, tool.name).toBe(expected);
    }
  });

  it("tako_visualize is the write/publish tool (readOnlyHint false)", () => {
    const viz = TOOL_REGISTRY.find((t) => t.name === "tako_visualize");
    expect(viz?.annotations.readOnlyHint).toBe(false);
    expect(viz?.annotations.openWorldHint).toBe(false);
  });
});
