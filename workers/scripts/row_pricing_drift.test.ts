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
const ROW_WORD = String.raw`(?:rows?|csv)`;
const NEAR_FREE = new RegExp(
  String.raw`(?:\bfree\b[^.\n]{0,40}?${ROW_WORD}|${ROW_WORD}[^.\n]{0,40}?\bfree\b)`,
  "i",
);

/**
 * Two exemptions, each one concept rather than a list of allowed phrasings —
 * a phrase allowlist would go stale the first time someone rewords.
 *
 * 1. `free-tier` / `free tier` names the anonymous TIER, not a row price.
 * 2. A line citing `tako#29572` is documenting the removal itself, which is
 *    exactly the sentence that has to stay sayable. Requiring the citation is
 *    also the convention worth enforcing: describe the removal, cite it.
 */
const TIER_NAME = /\bfree[-\s]tier\b/gi;
const CITES_REMOVAL = /tako#29572/;

/**
 * `context` is the matched line plus its neighbours: a wrapped comment puts
 * the citation on the next physical line ("(the free" / "row allowance was
 * removed in tako#29572"), and a per-line check would call that a violation.
 */
function offendingText(line: string, context: string): boolean {
  if (CITES_REMOVAL.test(context)) return false;
  return NEAR_FREE.test(line.replace(TIER_NAME, "anonymous-tier"));
}

describe("no copy calls a delivered row free", () => {
  const files = sourceFiles(SRC);

  it("finds source files to scan", () => {
    // Without this, a bad SRC path turns the whole suite into a silent pass.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(path.join(SRC, ".."), file);
    it(`${rel} does not call a row free`, () => {
      const offending = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i, all) => ({
          line,
          n: i + 1,
          context: all.slice(Math.max(0, i - 2), i + 3).join("\n"),
        }))
        .filter(({ line, context }) => offendingText(line, context))
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
      expect(
        offending,
        "tako#29572 removed the free row allowance — every delivered row bills per 1k",
      ).toEqual([]);
    });
  }
});
