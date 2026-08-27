/**
 * No copy anywhere in the Worker may call a delivered row free.
 *
 * Why a test and not a convention: tako#29572 (2026-08-21) removed the free
 * row allowance, and the "free 20-row preview" copy it invalidated shipped for
 * four days, billing every delivered row while the tool descriptions promised
 * otherwise. The sweep that fixed the model-visible strings was a hand-written
 * grep for two exact phrases, so it missed the two COMMENTS that sit directly
 * above `INLINE_PREVIEW_ROW_CAP` and `tako_contents`'s row cap — the text the
 * next author reads when rewording the descriptor. That is the recurrence
 * mechanism: the comment reseeds the claim, and the descriptor follows.
 *
 * So this scans SOURCE TEXT, comments included — not just the published
 * descriptors. A published-text check would not have caught either survivor.
 *
 * Runs under the `scripts` vitest project (plain node, filesystem access) —
 * `src/**` runs in workerd and cannot read files.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..");

/**
 * `src/generated/` is excluded: it is regenerated from `openapi/sdk.yaml` by
 * `gen-schemas.ts`, so it carries the BACKEND's wording, which we neither own
 * nor may hand-edit. Its current text is also correct — `free_rows` is
 * documented there as "Deprecated and always 0. Row allowances are gone", and
 * its one other match is a past-tense reference to the removal.
 */
const EXCLUDED_DIRS = new Set(["generated"]);

/** Every .ts under src/, tests included — a test fixture can reseed copy too. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      return EXCLUDED_DIRS.has(e.name) ? [] : sourceFiles(full);
    }
    return e.isFile() && e.name.endsWith(".ts") ? [full] : [];
  });
}

// "free" is legitimate about a CALL (`tako_available_data` is a free call) and
// about the welcome grant ("2,000 free requests"). It is never legitimate about
// a ROW. Match only when a row word sits close by, in either order.
//
// NO `\n` in the gap, because the text is FLATTENED before matching. Matching a
// single physical line missed the shape this guard exists to catch: comments
// here wrap near 76 columns, so "returns the first 20 rows\n * free of charge"
// put the two words on different lines and the guard saw neither half. A
// sentence is the unit a reader reads; a line is an artifact of wrapping.
// The gap stays at 40 characters. Widening it to catch more turned
// `llms.txt`'s correct "rows, billed per 1k), `tako_available_data` (free
// coverage check" — 41 characters, and "free" modifying a CALL — into a
// failure. No threshold separates that from a real violation, because what
// "free" modifies is not a distance.
// ANCHORED, and it must stay anchored. Unanchored, `row` matched inside ordinary
// words — "th\u0072ow", "g\u0072ow", "na\u0072row", "b\u0072owser" — so any sentence
// putting one of those within 40 characters of "free" failed as a row-pricing
// claim. It cost a false failure on slimWebResult's docstring, whose sentence
// reads "returns it free of charge\") and used to throw the result away": 27
// characters from `free` to the `row` in `throw`, and nothing to do with rows.
// The boundaries don't weaken the real catch: "free 20-row preview" still
// matches, because `-` is a word boundary.
const ROW_WORD = String.raw`\b(?:rows?|csv)\b`;
const NEAR_FREE = new RegExp(
  String.raw`(?:\bfree\b[^.]{0,40}?${ROW_WORD}|${ROW_WORD}[^.]{0,40}?\bfree\b)`,
  "i",
);

/**
 * Two exemptions, each one concept rather than a list of allowed phrasings —
 * a phrase allowlist would go stale the first time someone rewords.
 *
 * 1. `free-tier` / `free tier` names the anonymous TIER, not a row price.
 * 2. A sentence citing `tako#29572` is documenting the removal itself, which
 *    is exactly the sentence that has to stay sayable. Requiring the citation
 *    is also the convention worth enforcing: describe the removal, cite it.
 */
const TIER_NAME = /\bfree[-\s]tier\b/gi;
const CITES_REMOVAL = /tako#29572/;

/**
 * The text to test for the line at `lines[0]`, with a wrapped comment joined
 * into the sentence a human reads.
 *
 * A comment line is joined to the comment lines that FOLLOW it — `*` or `//`
 * as the first non-space characters, a syntax rule rather than a guess. A code
 * line is tested alone.
 *
 * Both halves of that matter, and each was learned from a false failure.
 * Testing a single physical line missed the shape this guard exists to catch:
 * comments here wrap near 76 columns, so "returns the first 20 rows\n * free of
 * charge" split the claim across lines and neither half matched. Joining every
 * neighbour instead fused things that are not one sentence — a `source_url:
 * z.string()` line with the citation-bearing comment below it, and two
 * separate README bullets ("inlines the rows" / "free and fast").
 */
const COMMENT_LINE = /^\s*(?:\*|\/\/)/;

function readableClaim(lines: readonly string[]): string {
  const first = lines[0] ?? "";
  if (!COMMENT_LINE.test(first)) return first;
  const parts = [first.trim()];
  for (const line of lines.slice(1)) {
    if (!COMMENT_LINE.test(line)) break;
    parts.push(line.replace(COMMENT_LINE, "").trim());
  }
  return parts.join(" ");
}

/**
 * The citation exemption is scoped to the SENTENCE carrying the claim, not to
 * a line window. A ±2-line exemption let any free-row claim within two lines
 * of a `tako#29572` mention through untouched — a hole in the direction that
 * matters, since the sentence describing the removal is exactly the neighbour
 * a reseeded claim would sit beside.
 */
function offendingText(contextLines: readonly string[]): boolean {
  const claim = readableClaim(contextLines).replace(
    TIER_NAME,
    "anonymous-tier",
  );
  for (const sentence of claim.split(/(?<=[.!?])\s+/)) {
    if (!NEAR_FREE.test(sentence)) continue;
    if (CITES_REMOVAL.test(sentence)) continue;
    return true;
  }
  return false;
}

describe("the row-proximity rule itself", () => {
  // This guard's whole value is its regex, and the regex has been wrong in both
  // directions: too narrow (a wrapped claim split across lines) and too broad
  // (`row` inside `throw`). Pin both directions here, or the next reword of
  // ROW_WORD lands with no signal either way.
  it("catches a real free-row claim however it is spelled", () => {
    for (const claim of [
      "returns the first 20 rows free of charge",
      "a free 20-row preview",
      "the csv is free",
      "rows are delivered free",
    ]) {
      expect(NEAR_FREE.test(claim), claim).toBe(true);
    }
  });

  it("doesn't fire on `row` inside an ordinary word", () => {
    for (const innocent of [
      'returns it free of charge") and used to throw the result away',
      "free, and the list can grow without bound",
      "a free call with a narrow query",
      "free page text in the browser",
    ]) {
      expect(NEAR_FREE.test(innocent), innocent).toBe(false);
    }
  });

  it("leaves `free` about a CALL or a TIER alone", () => {
    expect(NEAR_FREE.test("tako_available_data is free")).toBe(false);
  });
});

describe("no copy calls a delivered row free", () => {
  const files = sourceFiles(SRC);

  it("finds source files to scan", () => {
    // Without this, a bad SRC path turns the whole suite into a silent pass.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    it(`${rel} does not call a row free`, () => {
      const offending = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i, all) => ({
          line,
          n: i + 1,
          // The matched line plus the two after it: a wrapped claim continues
          // FORWARD, and looking back re-tests lines already tested as their
          // own starting point.
          context: all.slice(i, i + 3),
        }))
        .filter(({ context }) => offendingText(context))
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
      expect(
        offending,
        "tako#29572 removed the free row allowance — every delivered row bills per 1k",
      ).toEqual([]);
    });
  }
});
