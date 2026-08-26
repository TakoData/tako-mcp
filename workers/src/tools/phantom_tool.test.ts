import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FREE_TIER_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  serverInstructionsForTier,
} from "../instructions.js";
import { TOOL_REGISTRY } from "./_registry.js";
import { isToolOnSurface, resolveToolSet } from "./_surface.js";
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
    // Word-boundary match, so one tool name does not match inside a longer
    // name that starts with it.
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Every INPUT parameter name in the registry, and the ones each surface can
 * actually accept. A parameter is reachable on a surface iff some tool listed
 * there declares it — nested properties count, because tako_search_advanced
 * puts `node_ids` and `include_contents` inside its `data` / `web` blocks.
 */
function inputParamNames(tool: (typeof TOOL_REGISTRY)[number]): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties !== null && typeof obj.properties === "object") {
      for (const key of Object.keys(obj.properties as object)) out.add(key);
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(z.toJSONSchema(tool.inputSchema, { io: "input" }));
  return out;
}

/**
 * A tool name is not the only phantom a description can carry. `tako_contents`
 * shipped "a search result carries only a chart and headline (and, with
 * include_contents: true, a rows preview)" — naming a PARAMETER that D4 had
 * removed from `tako_search` and that survives only on two opt-in tools, which
 * the rule above forbids a default-listed tool from naming. The tool-name loops
 * cannot see it: `include_contents` is not a tool.
 *
 * Restricted to MULTI-WORD (snake_case) parameter names, and that restriction is
 * structural rather than a curated list. Measured: the unrestricted form flags
 * `data`, `type`, `rows`, `web`, `count`, `value`, `items`, `source`, `title` and
 * `description` on every tool, because those are ordinary English as well as
 * parameter names somewhere in the registry — 39 "unreachable" names on the
 * generic surface and a hit on all five listed tools. An underscore is the
 * property that separates a parameter reference from prose, and it is read off
 * the schema's own keys, so nothing goes stale when a parameter is renamed.
 *
 * The cost of the restriction, stated so nobody assumes coverage it lacks:
 * single-word phantoms (`effort`, `strict`, `mode`, `count`) are NOT caught here.
 * `strict` is covered by _pin_form.test.ts; the rest are not covered anywhere.
 */
describe("no listed tool names a parameter that is off its surface", () => {
  const multiWordParams = new Set<string>();
  for (const tool of TOOL_REGISTRY) {
    for (const param of inputParamNames(tool)) {
      if (param.includes("_")) multiWordParams.add(param);
    }
  }

  it("finds multi-word parameters to check", () => {
    // Without this the whole block passes vacuously if the walk breaks.
    expect(multiWordParams.size).toBeGreaterThan(8);
  });

  for (const surface of ["generic", "chatgpt"] as const satisfies Surface[]) {
    const listed = TOOL_REGISTRY.filter((t) => isToolOnSurface(t.name, surface, null));
    const reachable = new Set<string>();
    for (const tool of listed) {
      for (const param of inputParamNames(tool)) reachable.add(param);
    }
    const unreachable = [...multiWordParams].filter((p) => !reachable.has(p));

    it(`${surface} has parameters that are off-surface, so the check has teeth`, () => {
      expect(unreachable.length).toBeGreaterThan(0);
    });

    for (const tool of listed) {
      it(`${tool.name} on ${surface} names only parameters reachable there`, () => {
        const named = unreachable.filter((p) =>
          new RegExp(`\\b${p}\\b`).test(publishedText(tool)),
        );
        expect(named, `${tool.name} names off-surface parameters`).toEqual([]);
      });
    }
  }
});

describe("no listed tool names a tool that is off its surface", () => {
  // The DEFAULT listing on each surface: no `?tools=` opt-ins. This is what
  // every connection sees unless the operator opted in by hand.
  for (const surface of ["generic", "chatgpt"] as const satisfies Surface[]) {
    const listed = TOOL_REGISTRY.filter((t) =>
      isToolOnSurface(t.name, surface, null),
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
        ).filter((name) => !isToolOnSurface(name, surface, null));
        expect(offSurface, `${tool.name} (${surface}) names off-surface tools`).toEqual([]);
      });
    }
  }
});

describe("no opt-in tool names a tool outside the defaults plus itself", () => {
  // `?tools=` is an allowlist that REPLACES the defaults (spec D1), so a
  // caller who lists only `tako_agent` gets a description that names
  // `tako_search` with nothing to call — an accepted consequence of the
  // caller's own choice, documented in docs/TOOLS.md. What this guard
  // forbids is an opt-in tool naming ANOTHER opt-in tool: no allowlist a
  // reader would expect to write (defaults + this one tool) reaches it.
  const surface: Surface = "generic"; // chatgpt has no opt-ins: its set is fixed
  const defaults = resolveToolSet(surface, null);
  for (const tool of TOOL_REGISTRY) {
    if (defaults.has(tool.name)) continue; // default-listed; covered above
    const reachable = new Set([...defaults, tool.name]);
    it(`${tool.name} (opt-in) names only default tools or itself`, () => {
      const offSurface = foreignToolNamesIn(publishedText(tool), tool.name).filter(
        (name) => !reachable.has(name),
      );
      expect(offSurface, `${tool.name} (opt-in) names unreachable tools`).toEqual([]);
    });
  }
});

/**
 * The `initialize` instructions are the widest phantom surface in the repo and
 * the only one not published by a tool: `mcp.ts` returns one string per TIER,
 * never per surface, and the host puts it in the model's system prompt. So a
 * tool name here is read by every connection on every surface, including the
 * connections that do not register it.
 *
 * That is not hypothetical. `mcp.ts` carries a comment recording that this
 * string "used to carry a second half about `tako_answer`" and telling the
 * next author "do not restore it while answer is opt-in" — a rule held by
 * prose, whose only test was a hand-written `not.toContain("tako_answer")`.
 * One name, checked by hand, in the file this suite exists to replace.
 *
 * The allowed set is the INTERSECTION of the default listings, not either
 * surface's own: one string serves both, so a name has to be reachable on
 * both to be safe. That is strictly tighter than the per-tool checks above —
 * `tako_visualize` is default-on for chatgpt and off for generic, so naming
 * it here would be a phantom for every `/mcp` client.
 */
describe("server instructions name no tool a connection may not have", () => {
  const surfaces = ["generic", "chatgpt"] as const satisfies Surface[];
  const universal = [...ALL_TOOL_NAMES].filter((name) =>
    surfaces.every((surface) => isToolOnSurface(name, surface, null)),
  );

  it("the cross-surface default set is non-empty", () => {
    // Without this the filters below pass vacuously if surface membership
    // ever returns nothing.
    expect(universal.length).toBeGreaterThan(0);
  });

  for (const [label, text] of [
    ["SERVER_INSTRUCTIONS", SERVER_INSTRUCTIONS],
    ["FREE_TIER_SERVER_INSTRUCTIONS", FREE_TIER_SERVER_INSTRUCTIONS],
  ] as const) {
    it(`${label} names only tools every surface registers by default`, () => {
      // `ownName` is empty: instructions belong to no tool, so every name in
      // them is foreign and none gets the self-reference exemption.
      const unreachable = foreignToolNamesIn(text, "").filter(
        (name) => !universal.includes(name),
      );
      expect(unreachable, `${label} names unreachable tools`).toEqual([]);
    });
  }
});

/**
 * The block above pins the UNFILTERED constants against the cross-surface
 * default set, which passes only because `tako_search`,
 * `tako_available_data` and `tako_contents` are default on both surfaces.
 * It says nothing about `?tools=`, and `?tools=` REPLACES the default listing
 * (spec D1) — so `?tools=agent` used to serve a system prompt naming three
 * tools the connection had not registered. This block is the derived guard:
 * for any allowlist, every tool the instructions name must be in the set the
 * request actually registers.
 */
describe("server instructions name no tool outside the resolved ?tools= set", () => {
  const allowlists: ReadonlySet<string>[] = [
    new Set(["tako_agent"]),
    new Set(["tako_search"]),
    new Set(["tako_search", "tako_contents"]),
    new Set(["tako_visualize", "tako_graph_related"]),
    new Set(["tako_search", "tako_available_data", "tako_contents"]),
  ];

  for (const requested of allowlists) {
    const label = [...requested].join(",");
    for (const tier of ["authenticated", "free"] as const) {
      it(`?tools=${label} (${tier}) names only what it registers`, () => {
        const resolved = resolveToolSet("generic", requested);
        const text = serverInstructionsForTier(tier, resolved);
        const named = foreignToolNamesIn(text, "");
        const phantom = named.filter((name) => !resolved.has(name));
        expect(phantom, `instructions for ?tools=${label}`).toEqual([]);
      });
    }
  }

  it("a single-tool allowlist that names no instruction tool keeps the shared paragraph", () => {
    // The fallback must stay non-empty: an empty `instructions` would drop
    // the routing guidance that makes hosts reach for Tako at all.
    const text = serverInstructionsForTier(
      "authenticated",
      resolveToolSet("generic", new Set(["tako_agent"])),
    );
    expect(foreignToolNamesIn(text, "")).toEqual([]);
    expect(text).toContain("proprietary live-data graph");
  });

  // POSITIVE, because every case above asserts only an ABSENCE. Over-filtering
  // a partial allowlist is invisible to them: make `assembleInstructions` drop
  // one extra sentence whenever any sentence is dropped and all of them still
  // pass, because the result still names no phantom. The `unfiltered` case
  // below catches only wholesale over-filtering of the DEFAULT set. This pins
  // the half nothing else does — what a partial allowlist KEEPS.
  it("?tools=search,contents keeps its own sentences and drops the others", () => {
    const resolved = resolveToolSet("generic", new Set(["tako_search", "tako_contents"]));
    const text = serverInstructionsForTier("authenticated", resolved);
    // Kept: both sentences whose tools are entirely inside the allowlist. The
    // tako_search sentence is "retrieves the cards and web links" since D4 —
    // it used to be "set `include_contents: true`", a parameter the tool no
    // longer takes.
    expect(text).toContain("`tako_contents` reads one source in full");
    expect(text).toContain("`tako_search` retrieves the cards and web links");
    // Dropped: the one sentence naming a tool the allowlist leaves out.
    expect(text).not.toContain("tako_available_data");
    // And the shared routing paragraph is never a casualty of filtering.
    expect(text).toContain("proprietary live-data graph");
  });

  it("the default listing still names all three, unfiltered", () => {
    // Guards the other direction: over-filtering would silently strip
    // guidance from every default connection.
    const resolved = resolveToolSet("generic", null);
    expect(serverInstructionsForTier("authenticated", resolved)).toBe(
      SERVER_INSTRUCTIONS,
    );
    expect(serverInstructionsForTier("free", resolved)).toBe(
      FREE_TIER_SERVER_INSTRUCTIONS,
    );
  });
});
