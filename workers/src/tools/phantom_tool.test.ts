import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_REGISTRY } from "./_registry.js";
import { OPTIONAL_TOOL_ALIASES } from "./_optional.js";
import { isToolOnSurface } from "./_surface.js";
import type { Surface } from "../surface.js";

/**
 * No listed tool may name a tool that is not on its own surface.
 *
 * A tool name in a description, a field `.describe()`, or a schema enum is an
 * INSTRUCTION: the model reads it and calls it. When the named tool is not
 * registered for that connection, the call resolves to the SDK's bare "tool
 * not found" and the recovery path the copy promised does not exist.
 *
 * This has already shipped twice. `tako_answer` moved behind `?tools=answer`
 * while `tako_available_data` kept emitting `next_call: {tool: "tako_answer"}`
 * under a descriptor that says "run it verbatim", and while three opt-in tools
 * kept naming it in their descriptions. `_pin_form.test.ts` shows the rule was
 * known at the time; a hand-checked sweep still missed six sites.
 *
 * The allowed set is DERIVED from the resolved toolset, never hand-written —
 * a hand-written allowlist is the same defect one level up, and goes stale the
 * next time a tool moves surface.
 */

const ALL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((t) => t.name),
);

/** Every model-visible string a tool publishes on `tools/list`. */
function publishedText(tool: (typeof TOOL_REGISTRY)[number]): string {
  const parts: string[] = [tool.description];
  // Serialize through the same `z.toJSONSchema` the MCP SDK publishes, so
  // field `.describe()` text AND enum literals are both in scope — an enum
  // value naming a tool steers the model exactly like prose does.
  parts.push(JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" })));
  if (tool.outputSchema !== undefined) {
    parts.push(
      JSON.stringify(
        z.toJSONSchema(tool.outputSchema as z.ZodType, { io: "output" }),
      ),
    );
  }
  return parts.join("\n");
}

/** Tool names the text mentions, other than the tool's own. */
function foreignToolNamesIn(text: string, ownName: string): string[] {
  const found = new Set<string>();
  for (const name of ALL_TOOL_NAMES) {
    if (name === ownName) continue;
    // Word-boundary match: `tako_agent` must not match inside
    // `tako_agent_start`.
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(name);
  }
  return [...found].sort();
}

describe("no listed tool names a tool that is off its surface", () => {
  // The DEFAULT listing on each surface: no `?tools=` opt-ins. This is what
  // every connection sees unless the operator opted in by hand.
  for (const surface of ["generic", "chatgpt"] as const satisfies Surface[]) {
    const noOptIns: ReadonlySet<string> = new Set();
    const listed = TOOL_REGISTRY.filter((t) =>
      isToolOnSurface(t.name, surface, noOptIns),
    );

    it(`${surface} default listing is non-empty`, () => {
      // Guards against the whole suite passing vacuously if surface
      // membership ever returns nothing.
      expect(listed.length).toBeGreaterThan(0);
    });

    for (const tool of listed) {
      it(`${tool.name} on ${surface} names only tools on that surface`, () => {
        const offSurface = foreignToolNamesIn(
          publishedText(tool),
          tool.name,
        ).filter((name) => !isToolOnSurface(name, surface, noOptIns));
        expect(offSurface, `${tool.name} (${surface}) names off-surface tools`).toEqual([]);
      });
    }
  }
});

/**
 * The tools a single `?tools=<alias>` registers, for every alias naming
 * `toolName`. Keyed on the ALIAS, not the tool: `?tools=graph` turns on all
 * three graph primitives together, so a graph tool naming its own sibling is
 * correct, not a phantom. Reading the aliases from `OPTIONAL_TOOL_ALIASES`
 * keeps that grouping in one place.
 */
function enabledByOwnAliases(toolName: string): ReadonlySet<string> {
  const enabled = new Set<string>();
  for (const names of Object.values(OPTIONAL_TOOL_ALIASES)) {
    if (names.includes(toolName)) for (const n of names) enabled.add(n);
  }
  return enabled;
}

describe("no opt-in tool names a tool its own alias does not enable", () => {
  // An opt-in tool is read by a connection that enabled ITS alias and
  // nothing else. `?tools=graph` must not produce descriptions pointing at
  // `tako_answer`, which only `?tools=answer` registers.
  for (const surface of ["generic", "chatgpt"] as const satisfies Surface[]) {
    for (const tool of TOOL_REGISTRY) {
      if (isToolOnSurface(tool.name, surface, new Set())) continue; // default-listed; covered above
      const ownAlias = enabledByOwnAliases(tool.name);
      if (!isToolOnSurface(tool.name, surface, ownAlias)) continue; // not on this surface at all
      it(`${tool.name} on ${surface} names only tools reachable alongside it`, () => {
        const offSurface = foreignToolNamesIn(
          publishedText(tool),
          tool.name,
        ).filter((name) => !isToolOnSurface(name, surface, ownAlias));
        expect(offSurface, `${tool.name} (${surface}, opt-in) names unreachable tools`).toEqual([]);
      });
    }
  }
});
