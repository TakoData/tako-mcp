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
import { TOOL_NAME_PREFIX } from "./_tools_param.js";

// Closed-domain tools per the MCP spec: tako_visualize renders data the caller
// already supplied; tako_credit_balance reads Tako's own account state. Every
// other tool reaches the open world (web + the live data graph).
const CLOSED_WORLD = new Set(["tako_visualize", "tako_credit_balance"]);

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

  it("readOnlyHint is false for exactly the durable-resource writers", () => {
    // The write line (see `annotationsBySurface` in types.ts) is drawn once,
    // for every surface: a call is a WRITE when it creates a durable,
    // user-addressable resource — a chart card with public URLs
    // (tako_visualize) or a queued agent run reachable later via
    // `run_id`/`thread_id` (tako_agent). Everything else is a read.
    const WRITERS = new Set(["tako_visualize", "tako_agent"]);
    for (const tool of TOOL_REGISTRY) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(
        !WRITERS.has(tool.name),
      );
    }
  });

  it("every tool name carries the tako_ namespace prefix", () => {
    // `?tools=` tokens are tool names with the prefix optional (spec D1);
    // one unprefixed name would need a special case in the parser.
    for (const tool of TOOL_REGISTRY) {
      expect(tool.name.startsWith(TOOL_NAME_PREFIX), tool.name).toBe(true);
    }
  });
  it("every tool declares fixedInputs, even when empty, so TOOLS.md never guesses", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(Array.isArray(tool.fixedInputs), tool.name).toBe(true);
      for (const fixed of tool.fixedInputs ?? []) {
        expect(fixed.field.length, `${tool.name}.${fixed.field}`).toBeGreaterThan(0);
        expect(fixed.note.length, `${tool.name}.${fixed.field}`).toBeGreaterThan(0);
      }
    }
  });
});
