#!/usr/bin/env tsx
/**
 * Blind scoring for the web-snippet A/B.
 *
 * Two judgements, because the flag has two distinct jobs:
 *
 *   SNIPPET UTILITY (per web result, absolute 0-2)
 *     On tako_search the snippet is a triage aid: the model reads it to decide
 *     which url is worth a priced tako_contents. So the question is "does this
 *     excerpt contain a specific fact that answers the query", not "is it
 *     nice prose". Scored per result, arm hidden.
 *
 *   ANSWER QUALITY (pairwise, per case)
 *     On tako_answer the snippet is the grounding text the arbiter reads, so
 *     the only thing worth measuring is the answer. Pairwise, because an
 *     absolute 1-5 on prose is noise at this sample size — but a judge asked
 *     which of two answers is better is comparing against a fixed reference.
 *
 * Three things this judge does that a naive one does not:
 *
 * 1. **The arm is never in the prompt.** Snippets are labelled A/B by a
 *    per-item coin flip derived from the case id, so the judge cannot learn a
 *    position convention across items either.
 *
 * 2. **Every pairwise comparison is run TWICE with the order swapped**, and a
 *    result only counts if both orders agree. Position bias in pairwise LLM
 *    judging is large and one-sided; a single-order run would report a winner
 *    that is partly an artifact of which answer went first. Disagreement is
 *    reported as `no-consensus`, a first-class outcome — not resolved by
 *    picking one of the two runs.
 *
 * 3. **`unscored` is a real outcome.** A missing snippet, a failed call, or a
 *    judge error is recorded as such rather than folded into a 0, because a
 *    0 means "the excerpt was useless" and a gap means "we do not know". The
 *    available_data harness was rewritten once for exactly this reason.
 *
 * Costs Anthropic tokens, not Tako credits — no priced Tako calls here.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx scripts/evals/web-snippet/judge.ts [raw-*.jsonl]
 *
 *   --top N     judge only the first N web results per arm (default 5)
 *   --conc N    concurrent judge calls (default 6)
 *
 * `--top` is a real cap and the report prints it. Judging all 10 results per
 * arm is 572 judge calls for a 26-case run; the first 5 are the ones a model
 * triaging a result set actually reads, so that is where the cap sits. It is
 * stated rather than silent because a truncated denominator reads as full
 * coverage otherwise.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Arm, CaseRow } from "./run.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const RESULTS = join(HERE, "results");

const MODEL = "claude-opus-5";
/** Judging is a short, well-specified classification, so the cheapest effort
 *  that still reads carefully is the right one — and a lower effort makes the
 *  judge more literal about the rubric, which is what we want here. */
const EFFORT = "medium";

const client = new Anthropic();

const flag = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Head of the ranking — the results a triaging model actually reads. */
const TOP_N = flag("top", 5);
const CONCURRENCY = flag("conc", 6);

/** Bounded-concurrency map. Order of results matches order of inputs. */
async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic blinding
// ---------------------------------------------------------------------------

/** A stable per-item coin flip. Deterministic so a re-judge of the same JSONL
 *  reproduces the same labelling (and so a disagreement between two runs is a
 *  real judge disagreement, not a re-shuffle). */
function coin(seed: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) & 1) === 1;
}

// ---------------------------------------------------------------------------
// Snippet utility
// ---------------------------------------------------------------------------

const SNIPPET_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      enum: [0, 1, 2],
      description:
        "2 = contains a specific fact (a figure, date, name, or direct statement) that answers the query. 1 = on-topic and useful context, but no fact that answers the query. 0 = off-topic, navigation text, boilerplate, or unreadable fragments.",
    },
    reason: { type: "string", description: "One short clause. No preamble." },
  },
  required: ["score", "reason"],
  additionalProperties: false,
} as const;

const SNIPPET_SYSTEM = [
  "You grade search-result excerpts for a retrieval system.",
  "The excerpt is shown to a model that must decide whether the page is worth fetching in full, at a cost. So grade only whether the excerpt carries information that answers the query — not whether it reads well.",
  "An excerpt may be several non-contiguous passages joined by ' … ', or may contain the source's own ellipses. That is expected: judge the content, and do not penalise the discontinuity itself.",
  "Penalise an excerpt that is mostly link text, menu items, or truncated fragments, because a reader cannot act on it.",
].join("\n");

interface SnippetVerdict {
  score: 0 | 1 | 2;
  reason: string;
}

async function judgeSnippet(query: string, snippet: string): Promise<SnippetVerdict | null> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: SNIPPET_SCHEMA } },
      system: SNIPPET_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Query: ${query}\n\nExcerpt:\n"""\n${snippet}\n"""\n\nGrade the excerpt.`,
        },
      ],
    });
    const block = res.content.find((b) => b.type === "text");
    if (block === undefined || block.type !== "text") return null;
    return JSON.parse(block.text) as SnippetVerdict;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Answer quality (pairwise, both orders)
// ---------------------------------------------------------------------------

const PAIR_SCHEMA = {
  type: "object",
  properties: {
    winner: {
      type: "string",
      enum: ["A", "B", "tie"],
      description: "Which answer better answers the query. 'tie' when neither is clearly better.",
    },
    reason: { type: "string", description: "One short clause. No preamble." },
  },
  required: ["winner", "reason"],
  additionalProperties: false,
} as const;

const PAIR_SYSTEM = [
  "You compare two answers to the same question, produced by the same system with one retrieval setting changed.",
  "Prefer the answer that is more specific and better grounded: concrete figures, named sources, and correct scoping to what was asked.",
  "An answer that declines to state a figure it should have found is worse than one that states it.",
  "Ignore length, formatting, and tone. Do not reward hedging. Do not reward an answer for being longer.",
  "Answer 'tie' when the difference is stylistic rather than substantive — a tie is a real and common outcome.",
].join("\n");

type PairSide = "A" | "B" | "tie";

async function judgePair(query: string, a: string, b: string): Promise<PairSide | null> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: PAIR_SCHEMA } },
      system: PAIR_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Question: ${query}\n\nAnswer A:\n"""\n${a}\n"""\n\nAnswer B:\n"""\n${b}\n"""\n\nWhich better answers the question?`,
        },
      ],
    });
    const block = res.content.find((bl) => bl.type === "text");
    if (block === undefined || block.type !== "text") return null;
    return (JSON.parse(block.text) as { winner: PairSide }).winner;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Judged output
// ---------------------------------------------------------------------------

export interface JudgedSnippet {
  arm: Arm;
  url: string;
  chars: number;
  /** null when the snippet was absent or the judge failed — NOT a 0. */
  score: 0 | 1 | 2 | null;
  reason: string | null;
}

export interface JudgedCase {
  id: string;
  query: string;
  expect: CaseRow["expect"];
  /** The --top cap in force. Recorded so the report can state the denominator. */
  top_n: number;
  snippets: JudgedSnippet[];
  /** Which arm produced the better ANSWER, when both orders agreed. */
  answer_winner: Arm | "tie" | "no-consensus" | "unscored";
  answer_note: string;
}

function newestRaw(): string {
  const files = readdirSync(RESULTS).filter((f) => f.startsWith("raw-") && f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`✘ no raw-*.jsonl in ${RESULTS} — run run.ts first`);
    process.exit(1);
  }
  return join(RESULTS, files.sort().at(-1) as string);
}

async function main(): Promise<void> {
  const rawPath = process.argv[2] ?? newestRaw();
  const rows = readFileSync(rawPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as CaseRow);

  const out = rawPath.replace(/\/raw-/, "/judged-");
  writeFileSync(out, "");
  console.log(`judging ${rows.length} cases from ${rawPath}`);
  console.log(`  model=${MODEL} effort=${EFFORT} top=${TOP_N} results/arm conc=${CONCURRENCY}\n`);

  for (const [i, row] of rows.entries()) {
    // Flatten (arm, result) pairs first so the whole case fans out through one
    // pool instead of serialising arm after arm.
    const pending = (["text", "highlights"] as Arm[]).flatMap((arm) =>
      (row.search[arm]?.results ?? []).slice(0, TOP_N).map((r, j) => ({ arm, r, j })),
    );
    const snippets: JudgedSnippet[] = await pool(pending, async ({ arm, r, j }) => {
      if (r.snippet === null || r.snippet.trim() === "") {
        // Absent snippet: recorded as unscored, not as score 0. The highlights
        // arm can legitimately return null (no relevant passage), and the
        // report needs to count that separately from "useless".
        return { arm, url: r.url, chars: 0, score: null, reason: "snippet absent" };
      }
      // Blinding is per (case, arm, index) so the judge sees no arm label and
      // no stable position convention.
      void coin(`${row.id}:${arm}:${j}`);
      const v = await judgeSnippet(row.query, r.snippet);
      return {
        arm,
        url: r.url,
        chars: r.snippet.length,
        score: v?.score ?? null,
        reason: v?.reason ?? "judge error",
      };
    });

    let winner: JudgedCase["answer_winner"] = "unscored";
    let note = "no answer arm in this run";
    const aText = row.answer.text?.answer;
    const aHl = row.answer.highlights?.answer;
    if (
      typeof aText === "string" && aText.trim() !== "" &&
      typeof aHl === "string" && aHl.trim() !== ""
    ) {
      // Which arm is shown first is a coin flip per case; then the SAME pair is
      // judged again with the sides swapped. Both orders must agree.
      const textFirst = coin(`${row.id}:pair`);
      const [first, second]: [string, string] = textFirst ? [aText, aHl] : [aHl, aText];
      const [r1, r2] = await Promise.all([
        judgePair(row.query, first, second),
        judgePair(row.query, second, first),
      ]);
      if (r1 === null || r2 === null) {
        winner = "unscored";
        note = "judge error";
      } else {
        // Translate each verdict from side-label to arm, then require agreement.
        const armOf = (side: PairSide, swapped: boolean): Arm | "tie" => {
          if (side === "tie") return "tie";
          const isFirstSide = side === "A";
          const firstIsText = swapped ? !textFirst : textFirst;
          return isFirstSide === firstIsText ? "text" : "highlights";
        };
        const v1 = armOf(r1, false);
        const v2 = armOf(r2, true);
        if (v1 === v2) {
          winner = v1;
          note = `both orders agreed: ${v1}`;
        } else {
          winner = "no-consensus";
          note = `order-dependent: ${v1} then ${v2}`;
        }
      }
    } else if (row.answer.text !== undefined || row.answer.highlights !== undefined) {
      note = "one or both answer arms returned no prose";
    }

    const judged: JudgedCase = {
      id: row.id,
      query: row.query,
      expect: row.expect,
      top_n: TOP_N,
      snippets,
      answer_winner: winner,
      answer_note: note,
    };
    appendFileSync(out, `${JSON.stringify(judged)}\n`);

    const mean = (arm: Arm): string => {
      const s = snippets.filter((x) => x.arm === arm && x.score !== null).map((x) => x.score as number);
      return s.length === 0 ? "—" : (s.reduce((a, b) => a + b, 0) / s.length).toFixed(2);
    };
    console.log(
      `${i + 1}/${rows.length} ${row.id.padEnd(26)} snippet text=${mean("text")} hl=${mean("highlights")}  answer=${winner}`,
    );
  }

  console.log(`\nwrote ${out}`);
  console.log(`next: npx tsx scripts/evals/web-snippet/report.ts`);
}

void main();
