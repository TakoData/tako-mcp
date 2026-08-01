/**
 * Sweep-file resolution, shared by judge.ts and report.ts.
 *
 * Extracted because both files derived the judged path with the same
 * `rawPath.replace(/\/raw-/, "/judged-")` and both got it wrong the same way:
 * the pattern needs a slash before `raw-`, so a bare basename — the shape
 * `cd results && npx tsx ../judge.ts raw-2026-07-31-full.jsonl` produces —
 * does not match and the "derived" path IS the input. In judge.ts that reached
 * a `writeFileSync(out, "")` and destroyed the 26-case sweep it was about to
 * judge, silently, printing `wrote raw-…jsonl` as it went. In report.ts it
 * parsed the raw rows as judged ones and died in a `.filter` on undefined.
 *
 * One derivation in one place, so the next correction lands on both callers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** `…/raw-<stamp>.jsonl` → `…/judged-<stamp>.jsonl`, on the basename.
 *
 *  Exits rather than returning a path equal to its input. The bug this replaces
 *  was destructive *because* it was silent, so the invariant that made it
 *  possible is asserted rather than assumed — the same refuse-at-the-boundary
 *  posture `assertRawShape` already takes in report.ts. */
export function judgedPathFor(rawPath: string): string {
  const base = basename(rawPath);
  if (!base.startsWith("raw-")) {
    console.error(
      `✘ ${base} is not a raw-*.jsonl, so no judged path can be derived from it.\n` +
        `  Pass the raw sweep; the judged file is named after it.`,
    );
    process.exit(1);
  }
  const out = join(dirname(rawPath), `judged-${base.slice("raw-".length)}`);
  if (resolve(out) === resolve(rawPath)) {
    console.error(`✘ derived judged path equals the input (${rawPath}) — refusing to write over a sweep.`);
    process.exit(1);
  }
  return out;
}

/** The first non-flag argument.
 *
 *  `process.argv[2]` is wrong here because the same argv also carries `--top`
 *  and `--conc`, which the README documents on the same step as the path: a
 *  flag-first invocation set the input path to `"--top"` and died in
 *  `readFileSync` with an ENOENT naming a flag. Skipping only tokens that begin
 *  with `--` is not enough either — that picks the `10` out of `--top 10`, so
 *  the flags that consume a value have to be named. */
export function positionalArg(
  argv: readonly string[],
  valueFlags: readonly string[],
): string | undefined {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      // `--top 10`: skip the flag AND the value it consumes.
      if (valueFlags.includes(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

/** The raw sweep to work on. Refuses to GUESS between candidates, on purpose.
 *
 *  This used to take `files.sort().at(-1)` as "the newest", which is wrong and
 *  quietly so: `-` (0x2D) sorts before `.` (0x2E), so `raw-<stamp>.jsonl` loses
 *  to `raw-<stamp>-full.jsonl` and the default picked a 4-case smoke run over
 *  the 26-case sweep sitting beside it — a run that reads as complete at a
 *  sixth of the denominator. mtime is no better: a fresh clone stamps every
 *  file with checkout order, so the "newest" file is whichever git wrote last.
 *
 *  There is no ordering here that means what the caller wants, so ambiguity is
 *  an error that lists the options rather than a coin flip. */
export function resolveRaw(resultsDir: string, verb: string, script: string): string {
  const files = readdirSync(resultsDir)
    .filter((f) => f.startsWith("raw-") && f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    console.error(`✘ no raw-*.jsonl in ${resultsDir} — run run.ts first`);
    process.exit(1);
  }
  if (files.length === 1) return join(resultsDir, files[0] as string);
  console.error(`✘ ${files.length} raw sweeps in results/ — name the one to ${verb}:\n`);
  for (const f of files) {
    const cases = readFileSync(join(resultsDir, f), "utf8").split("\n").filter((l) => l.trim() !== "").length;
    console.error(`    ${f}  (${cases} case${cases === 1 ? "" : "s"})`);
  }
  console.error(`\n  npx tsx scripts/evals/web-snippet/${script} <path-to-raw.jsonl>`);
  process.exit(1);
}
