/**
 * Guards ONE invariant across every model-facing surface: the pin form we
 * advertise is the one measured to work.
 *
 * Measured on prod (2026-07-29): a pin at the default `strict:false` does not
 * steer retrieval at all — a deliberately WRONG node changed nothing — and
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

import { PINNED_FROM_CARD, PINNED_RETRY, takoCardSchema } from "./_search_results.js";
import { TOOL_REGISTRY } from "./_registry.js";

/**
 * Prose that advises pinning. Deliberately narrow: it matches an instruction
 * to pin, not any mention of the word — descriptions legitimately discuss
 * `node_ids` as a parameter without prescribing a form (e.g. "harvesting node
 * ids and urls to feed tako_answer").
 */
const ADVISES_PINNING = /\bpin(?:ning|ned)?\b[^.]{0,120}\bnode[_ ]?ids?\b|\bnode[_ ]?ids?\b[^.]{0,60}\bpinned\b/i;

/** The broken form: EVERY node id on the card, i.e. plural and unqualified. */
const PLURAL_UNQUALIFIED = /\bthe (?:card's|cards') `?nodes`? ids\b/i;

describe("advertised pin form", () => {
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

  it("covers the field descriptions that actually carry pin advice today", () => {
    // Same vacuous-pass guard as the registry loop below.
    const shape = (takoCardSchema as unknown as { shape: Record<string, unknown> }).shape;
    const hint = z.toJSONSchema(shape.values_hint as z.ZodType, { io: "output" }) as {
      description?: string;
    };
    expect(hint.description ?? "").toMatch(ADVISES_PINNING);
  });

  it("covers the tools that actually carry pin advice today", () => {
    // Without this, the loops above pass vacuously if a refactor drops the
    // advice entirely — silence is not the same as correctness here.
    const advising = TOOL_REGISTRY.filter((t) => ADVISES_PINNING.test(t.description)).map(
      (t) => t.name,
    );
    expect(advising).toContain("tako_search");
    expect(advising).toContain("tako_answer");
    expect(advising).toContain("tako_contents");
  });
});
