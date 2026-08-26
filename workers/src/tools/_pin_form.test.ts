/**
 * Guards ONE invariant across every model-facing surface: the pin form we
 * advertise is the one measured to work.
 *
 * Measured on prod (2026-07-29): a pin at the default `strict:false` did not
 * change which card came back — a deliberately WRONG node changed nothing — and
 * because `strict` is an OR over pinned nodes, including the entity's id
 * re-admits every other card for that entity, which once turned "no such card"
 * into a plausible-looking WRONG metric. Only the METRIC node ALONE, with
 * `strict:true`, works.
 *
 * Why a whole file for one rule: the recipe is long enough that people restate
 * it in prose instead of importing the constant, and every hand-restatement so
 * far has drifted back to the broken variant. `tako_search`'s description
 * carried it in two places — including one that claimed a card's `values_hint`
 * "says exactly this" while `valuesHint` had already been corrected to the
 * metric-only form. Unit tests could not see it: the text was never asserted.
 *
 * Registry-wide (rather than a hand-listed subset) so a future tool that
 * advises pinning is covered the day it is added.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ADVISES_PINNING, PLURAL_UNQUALIFIED } from "./_pin_form_rules.js";
import { PINNED_FROM_CARD, PINNED_RETRY, takoCardSchema } from "./_search_results.js";
import { TOOL_REGISTRY } from "./_registry.js";

// The two patterns live in `_pin_form_rules.ts` so this guard and the
// llms-full.txt guard in scripts/gen-registry.ts apply the IDENTICAL rule. They
// were a hand-written pair once and the copies drifted, which is how the broken
// form survived in two surfaces this file cannot reach.

describe("advertised pin form", () => {
  // A pinned zero is NOT proof of absence. Measured on staging 2026-07-31 (20
  // handles, matched arms): 11 of 20 retrieve fewer cards pinned than unpinned,
  // because `strict` is a hard filter over a graph holding near-duplicate metric
  // nodes where only one twin carries cards. `tako_available_data` says so in
  // its summary and description; if PINNED_RETRY does not, then search and
  // answer tell the model to pin while available_data tells it to unpin.
  it("PINNED_RETRY carries the unpin escape hatch, not just the pin form", () => {
    expect(PINNED_RETRY).toMatch(/`node_ids` removed|without `?node_ids`?/i);
    expect(PINNED_RETRY).toMatch(/hard filter/i);
    // The claim that had to go: a pinned zero being conclusive on its own.
    expect(PINNED_RETRY).not.toMatch(/definitive/i);
  });

  it("the two canonical strings both name the metric node alone, with strict", () => {
    for (const [label, s] of [
      ["PINNED_RETRY", PINNED_RETRY],
      ["PINNED_FROM_CARD", PINNED_FROM_CARD],
    ] as const) {
      expect(s, label).toMatch(/METRIC/);
      expect(s, label).toMatch(/\bALONE\b/);
      expect(s, label).toMatch(/strict\s*:\s*true/);
    }
  });

  it("no tool description advises pinning every node id on a card", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.description, tool.name).not.toMatch(PLURAL_UNQUALIFIED);
    }
  });

  it("every description that advises pinning also names strict", () => {
    // `strict:false` is the default, so advice that omits `strict` describes
    // the no-op. Naming it is what makes the advice actionable.
    for (const tool of TOOL_REGISTRY) {
      if (!ADVISES_PINNING.test(tool.description)) continue;
      expect(tool.description, `${tool.name} advises pinning without strict`).toMatch(
        /strict/,
      );
    }
  });

  // TOOL_REGISTRY carries tool DESCRIPTIONS only, so the loops above cannot see
  // pin advice that lives in a schema field's `.describe()` — and that is
  // exactly where a stale copy survived this sweep: `values_hint`'s description
  // still read "via tako_answer with node_ids pinned" while `valuesHint()`, the
  // function producing the value it documents, had already been corrected. The
  // model reads both. Walk the published field descriptions too.
  it("no published field description advises pinning without strict", () => {
    const shape = (takoCardSchema as unknown as { shape: Record<string, unknown> }).shape;
    const described: Array<[string, string]> = [];
    for (const [field, schema] of Object.entries(shape)) {
      const text = z.toJSONSchema(schema as z.ZodType, { io: "output" }) as {
        description?: string;
      };
      if (typeof text.description === "string") described.push([field, text.description]);
    }
    expect(described.length).toBeGreaterThan(0);
    for (const [field, text] of described) {
      expect(text, `takoCardSchema.${field}`).not.toMatch(PLURAL_UNQUALIFIED);
      if (!ADVISES_PINNING.test(text)) continue;
      expect(text, `takoCardSchema.${field} advises pinning without strict`).toMatch(/strict/);
    }
  });

  it("covers the tools that actually carry pin advice today", () => {
    // Without this, the loops above pass vacuously if a refactor drops the
    // advice entirely — silence is not the same as correctness here.
    //
    // `tako_answer` is the only tool left that both ADVISES a pin and ACCEPTS
    // one. `tako_search` dropped out with the D4 split: it no longer takes
    // `node_ids` / `strict`, so pin advice in its description would prescribe
    // parameters it rejects. (`tako_contents` and the card's `values_hint`
    // dropped out earlier, when their advice routed to `tako_answer` and answer
    // went opt-in — naming an unregistered tool sends the model into "tool not
    // found".)
    const advising = TOOL_REGISTRY.filter((t) => ADVISES_PINNING.test(t.description)).map(
      (t) => t.name,
    );
    expect(advising).toContain("tako_answer");
    expect(advising).not.toContain("tako_search");
    // Every tool that advises a pin must also accept one, or the advice is a
    // phantom parameter. Derived, never hand-listed.
    //
    // Checked against the PUBLISHED JSON Schema, not the top-level zod shape:
    // tako_search_advanced carries node_ids nested inside its `data` source
    // block, mirroring the API, and a shape-key check called that a phantom.
    for (const name of advising) {
      const tool = TOOL_REGISTRY.find((t) => t.name === name);
      const published = JSON.stringify(
        z.toJSONSchema(tool!.inputSchema, { io: "input" }),
      );
      expect(published.includes('"node_ids"'), `${name} advises a pin it does not accept`).toBe(true);
    }
  });

  // The CONVERSE of the rule above, and it catches what that rule structurally
  // cannot. `ADVISES_PINNING` matches an INSTRUCTION to pin; it doesn't match
  // prose that merely DESCRIBES one. "both halves resolved and the pinned metric
  // passed the name test" names no node id, so the loops above read it as
  // innocent — and two strings of exactly that shape shipped in
  // tako_available_data's published OUTPUT schema, a channel the field walk
  // above cannot reach either (it reads takoCardSchema alone). A tool that
  // cannot accept a pin has no business naming one, whatever the grammar.
  //
  // Pin-capability is DERIVED, never listed: a tool accepts a pin iff its
  // published input schema carries `node_ids`. Nested counts —
  // tako_search_advanced puts it inside `data`, mirroring the API. Today the
  // pin-capable set is tako_answer and tako_search_advanced, both opt-in.
  //
  // Two deliberate narrowings, each load-bearing:
  //   `\bstrict`, not `strict` — the unanchored form matches "Restrict web
  //     results to a category", tako_search_advanced's own `category` text.
  //   `node_ids`, not `node_id` — the SINGULAR is legitimate everywhere. It is
  //     the traversal handle tako_graph_related takes and tako_available_data
  //     emits, and banning it would forbid the correct advice.
  it("no tool that cannot accept a pin publishes pin vocabulary", () => {
    const PIN_VOCAB = /\bnode_ids\b|\bstrict\b|\bpin(?:ned|ning|s)?\b/i;
    const describedIn = (json: string): string[] =>
      [...json.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string);

    let checked = 0;
    for (const tool of TOOL_REGISTRY) {
      const inputJson = JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" }));
      if (inputJson.includes('"node_ids"')) continue;
      checked += 1;
      const published: Array<[string, string]> = [
        ["description", tool.description],
        ...describedIn(inputJson).map((d): [string, string] => ["inputSchema", d]),
      ];
      if (tool.outputSchema !== undefined) {
        const outputJson = JSON.stringify(
          z.toJSONSchema(tool.outputSchema as z.ZodType, { io: "output" }),
        );
        published.push(
          ...describedIn(outputJson).map((d): [string, string] => ["outputSchema", d]),
        );
      }
      for (const [channel, text] of published) {
        expect(text, `${tool.name}.${channel} names a pin it cannot accept`).not.toMatch(
          PIN_VOCAB,
        );
      }
    }
    // Not vacuous: most of the registry cannot accept a pin.
    expect(checked).toBeGreaterThan(4);
  });
});
