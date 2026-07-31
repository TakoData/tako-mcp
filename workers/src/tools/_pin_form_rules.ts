/**
 * The two patterns that decide whether a piece of model-facing prose advises
 * the pin form measured to WORK.
 *
 * Extracted from `_pin_form.test.ts` because that guard reads only
 * `TOOL_REGISTRY[].description`, and the broken form kept surviving in surfaces
 * it cannot see. Both survivors of the last sweep were outside it: the
 * `values_hint` field `.describe()` (published inside tako_search's
 * outputSchema) and `llms-full.txt`. The docs guard in
 * `scripts/gen-registry.ts` now applies the SAME two patterns, and it can only
 * stay the same by importing them — a second hand-written copy is how the
 * advice drifted in the first place.
 *
 * Patterns, not fixed strings, so rewording the advice is free and only the
 * INVARIANT is pinned: name `strict`, and never point at every node id on a
 * card.
 *
 * `_`-prefixed so the registry codegen skips it — it is a rule set, not a tool.
 */

/**
 * Prose that advises pinning. Deliberately narrow: it matches an instruction to
 * pin, not any mention of the word — descriptions legitimately discuss
 * `node_ids` as a parameter without prescribing a form (e.g. "harvesting node
 * ids and urls to feed tako_answer").
 *
 * The stem is `nodes?` rather than `node`, because the BROKEN form's own
 * phrasing is "the card's `nodes` ids" — with the plural stem, so a `node[_ ]?`
 * pattern misses the very sentence the plural rule exists to catch. Found by the
 * unit test for that rule, which could not make it fire.
 */
export const ADVISES_PINNING =
  /\bpin(?:ning|ned)?\b[^.]{0,120}\bnodes?[_ ]?ids?\b|\bnodes?[_ ]?ids?\b[^.]{0,60}\bpinned\b/i;

/**
 * The broken form: EVERY node id on the card, i.e. plural and unqualified.
 * Measured on prod (2026-07-29) — `strict` is an OR over pinned nodes, so
 * including the entity's id re-admits every other card for that entity, which
 * once turned "no such card" into a plausible-looking WRONG metric.
 */
export const PLURAL_UNQUALIFIED = /\bthe (?:card's|cards') `?nodes`? ids\b/i;

/**
 * A parameter-definition line, e.g. "- `strict` (boolean, default false): …".
 * These DOCUMENT the flag rather than advise a pin form, so the affirmative
 * `strict: true` rule below must not apply: `strict`'s own entry legitimately
 * says "default false", and `node_ids`' entry legitimately describes pinning
 * without prescribing the recipe.
 */
const PARAM_DEFINITION = /^[-*]\s*`[a-z_]+`\s*\(/i;

/**
 * Split prose into the units the rules are applied to: one sentence, roughly.
 * Sentence-level rather than whole-document, because a document can legitimately
 * mention `strict` somewhere far away while a specific sentence still advises
 * the no-op form — which is exactly how `llms-full.txt` passed casual reading
 * while its tako_answer paragraph advised a bare `node_ids` pin.
 */
export const pinAdvisingSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !PARAM_DEFINITION.test(s) && ADVISES_PINNING.test(s));

/**
 * An AFFIRMATIVE mention of the working flag value.
 *
 * Not merely the token `strict`: the first draft of this rule accepted that, and
 * a sentence reading "…pinned to get the figures — pinning every node id on the
 * card, or omitting strict, does not steer retrieval" passed it, because the
 * word appears inside the clause explaining what NOT to do. Requiring
 * `strict: true` means the advice has to actually name the value that works.
 */
const NAMES_STRICT_TRUE = /\bstrict\b\s*[`:=]?\s*:?\s*`?true`?/i;

/**
 * Why a sentence advising a pin is non-compliant, or null when it is fine.
 *
 * `requireStrict` exists because the two rules are not equally safe to apply.
 * `PLURAL_UNQUALIFIED` has no plausible innocent reading — nothing legitimately
 * tells a model to pin every node id on a card — so it applies to any prose.
 * The strict-naming rule is different: `ADVISES_PINNING` matches DESCRIPTIVE
 * mentions too, and README's `sources` guidance has two ("...or you're pinning
 * `node_ids`") that name a precondition rather than instruct. No regex reliably
 * separates "here is how to pin" from "if you happen to be pinning", and the
 * alternative — an allowlist of blessed sentences — rots the first time someone
 * rewords one.
 *
 * So: pass `requireStrict: true` for prose that is uniformly prescriptive about
 * the tool surface (llms-full.txt, tool and field descriptions), false for
 * mixed prose where only the unambiguous rule can be trusted.
 */
export function pinFormProblem(
  sentence: string,
  options: { requireStrict: boolean } = { requireStrict: true },
): string | null {
  if (PLURAL_UNQUALIFIED.test(sentence)) {
    return "advises pinning every node id on the card (the measured no-op); pin the METRIC node id ALONE";
  }
  if (options.requireStrict && !NAMES_STRICT_TRUE.test(sentence)) {
    return "advises pinning without naming `strict: true` (strict:false is the default and does not steer retrieval)";
  }
  return null;
}
