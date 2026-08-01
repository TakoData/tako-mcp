#!/usr/bin/env tsx
/**
 * Does `sources.web.highlights` earn the default?
 *
 * Two arms per case, one variable between them:
 *
 *   ARM text        sources.web = {count, snippet_max_chars}
 *   ARM highlights  sources.web = {count, snippet_max_chars, highlights: true}
 *
 * Run against the BACKEND (`/api/v3/search` and `/api/v1/answer`) rather than
 * through the MCP, for one reason: the lever is a backend field, and the MCP
 * hardcodes it. Measuring at the MCP would need a knob on the tool surface
 * that exists only for the harness — a worse tool contract in exchange for a
 * worse measurement, since the MCP adds nothing to the snippet path (it does
 * not truncate, re-rank, or reformat; the snippet rides verbatim into
 * structuredContent). What the MCP DOES fix is `snippet_max_chars`, so the cap
 * used here mirrors the value the tools send.
 *
 * Collection only — no scoring. `judge.ts` scores the JSONL, `report.ts`
 * renders it. Splitting them means a scoring bug costs a re-analysis rather
 * than another priced sweep.
 *
 * Arm order is ROTATED per case (text-first on even cases, highlights-first on
 * odd). Both arms hit the same upstream cache and the same rate limiter, so a
 * fixed order would hand one arm every cold cache and the other every warm
 * one, and the latency comparison — the metric that actually gates this
 * change — would measure position instead of the flag.
 *
 * Usage:
 *   EVAL_API_BASE=https://staging.tako.com TAKO_EVAL_API_KEY=$TAKO_STAGING_API_KEY \
 *     npx tsx scripts/evals/web-snippet/run.ts
 *
 *   --search-only   skip the /v1/answer arms (halves the spend)
 *   --limit N       first N cases only
 *   --force         overwrite an existing raw-<stamp>.jsonl (refused otherwise)
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WEB_SNIPPET_CASES, type WebSnippetCase } from "./cases.js";
import { refuseToClobber } from "./paths.js";

const apiBase = (process.env.EVAL_API_BASE ?? "https://staging.tako.com").replace(/\/+$/, "");
const apiKey = process.env.TAKO_EVAL_API_KEY ?? process.env.TAKO_STAGING_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error("✘ TAKO_EVAL_API_KEY (or TAKO_STAGING_API_KEY) is required");
  process.exit(1);
}

const searchOnly = process.argv.includes("--search-only");
const force = process.argv.includes("--force");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? undefined : Number(process.argv[limitArg + 1]);

/** Mirrors buildSearchBody / buildAnswerBody in workers/src/tools/. */
const SNIPPET_MAX_CHARS = 2000;
const SEARCH_COUNT = 10;

/** Deliberately slow. A 429 reaches the caller as an empty result set, not as
 *  an error, so an unthrottled sweep produces a run that reads as a coverage
 *  gap. Better to spend the wall-clock than to publish a rate-limited run. */
const THROTTLE_MS = 1_500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Arm = "text" | "highlights";

interface ResultRow {
  url: string;
  title: string | null;
  snippet: string | null;
  publish_date: string | null;
}

export interface CallRow {
  arm: Arm;
  /** Wall clock for the whole exchange, body included. */
  ms: number;
  /** What `ms` covers. Absent on sweeps collected before the timing fix, where
   *  it was time-to-HEADERS and so understated the larger (text) payload more —
   *  the report states which, so the two are never compared as if alike. */
  timing?: "complete" | undefined;
  /** HTTP status; 0 when the request never completed. */
  status: number;
  error?: string | undefined;
  request_id?: string | null | undefined;
  results: ResultRow[];
  /** /v1/answer only: the synthesized prose the arbiter produced. */
  answer?: string | null | undefined;
  /** /v1/answer only: how many data cards came back alongside the web arm. */
  cards?: number | undefined;
  cost_usd?: number | undefined;
}

export interface CaseRow {
  id: string;
  query: string;
  expect: WebSnippetCase["expect"];
  probes: string;
  snippet_max_chars: number;
  /** Which arm was issued first for this case (rotation control). */
  first: Arm;
  search: Record<Arm, CallRow | undefined>;
  answer: Record<Arm, CallRow | undefined>;
}

interface WebSourceBody {
  count?: number;
  include_contents: false;
  snippet_max_chars: number;
  highlights?: true;
}

function webSource(arm: Arm, withCount: boolean): WebSourceBody {
  const web: WebSourceBody = {
    include_contents: false,
    snippet_max_chars: SNIPPET_MAX_CHARS,
  };
  if (withCount) web.count = SEARCH_COUNT;
  // The single variable under test. Absent (not `false`) on the text arm, so
  // the control is byte-identical to what a caller who never heard of the flag
  // sends — a literal `highlights: false` would test a different request.
  if (arm === "highlights") web.highlights = true;
  return web;
}

async function call(path: string, query: string, arm: Arm, withCount: boolean): Promise<CallRow> {
  const body = { query, sources: { web: webSource(arm, withCount) } };
  const t0 = Date.now();
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "X-API-Key": apiKey as string, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // The clock closes AFTER the body is read, not when `fetch` resolves.
    // `fetch` resolves at headers, and the arms differ ~18% in payload (1896 vs
    // 1556 mean chars × 10 results), so timing to headers would exclude a
    // component that is systematically LARGER on the text arm — inflating the
    // `highlights − text` delta that the report calls the gating metric.
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { arm, ms, timing: "complete", status: res.status, error: text.slice(0, 300), results: [] };
    }
    const data = JSON.parse(text) as {
      web_results?: ResultRow[];
      cards?: unknown[];
      answer?: string | null;
      request_id?: string | null;
      usage?: { total_cost_usd?: number };
    };
    const row: CallRow = {
      arm,
      ms,
      timing: "complete",
      status: res.status,
      request_id: data.request_id ?? null,
      results: (data.web_results ?? []).map((r) => ({
        url: r.url,
        title: r.title ?? null,
        snippet: r.snippet ?? null,
        publish_date: r.publish_date ?? null,
      })),
    };
    if (data.answer !== undefined) row.answer = data.answer;
    if (Array.isArray(data.cards)) row.cards = data.cards.length;
    if (typeof data.usage?.total_cost_usd === "number") row.cost_usd = data.usage.total_cost_usd;
    return row;
  } catch (err) {
    return { arm, ms: Date.now() - t0, timing: "complete", status: 0, error: String(err).slice(0, 300), results: [] };
  }
}

async function main(): Promise<void> {
  const cases = limit === undefined ? WEB_SNIPPET_CASES : WEB_SNIPPET_CASES.slice(0, limit);
  const perCase = searchOnly ? 2 : 4;
  console.log(`target: ${apiBase}  cases: ${cases.length}  arms: text | highlights`);
  console.log(
    `  ${cases.length * perCase} priced calls, ~$${(cases.length * (searchOnly ? 0.014 : 0.032)).toFixed(2)}`,
  );
  console.log(`  snippet_max_chars=${SNIPPET_MAX_CHARS} (mirrors the MCP tools), throttle=${THROTTLE_MS}ms\n`);

  const outDir = join(dirname(new URL(import.meta.url).pathname), "results");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `raw-${process.env.EVAL_STAMP ?? "latest"}.jsonl`);
  // Before the first priced call, and before the truncating open below.
  refuseToClobber(out, force);
  writeFileSync(out, "");

  let spend = 0;
  for (const [i, c] of cases.entries()) {
    // Rotation: alternate which arm pays the cold-cache cost.
    const first: Arm = i % 2 === 0 ? "text" : "highlights";
    const order: Arm[] = first === "text" ? ["text", "highlights"] : ["highlights", "text"];

    const row: CaseRow = {
      id: c.id,
      query: c.query,
      expect: c.expect,
      probes: c.probes,
      snippet_max_chars: SNIPPET_MAX_CHARS,
      first,
      search: { text: undefined, highlights: undefined },
      answer: { text: undefined, highlights: undefined },
    };

    for (const arm of order) {
      row.search[arm] = await call("/api/v3/search/", c.query, arm, true);
      spend += row.search[arm]?.cost_usd ?? 0;
      await sleep(THROTTLE_MS);
    }
    if (!searchOnly) {
      for (const arm of order) {
        // No `count`: /v1/answer resolves its own default (3), and pinning one
        // here would change breadth as well as the snippet — two variables.
        row.answer[arm] = await call("/api/v1/answer", c.query, arm, false);
        spend += row.answer[arm]?.cost_usd ?? 0;
        await sleep(THROTTLE_MS);
      }
    }

    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const st = row.search.text;
    const sh = row.search.highlights;
    const nulls = (sh?.results ?? []).filter((r) => r.snippet === null).length;
    console.log(
      `${i + 1}/${cases.length} ${c.id.padEnd(26)} ` +
        `search text=${st?.results.length ?? "✘"}/${st?.ms ?? "-"}ms ` +
        `hl=${sh?.results.length ?? "✘"}/${sh?.ms ?? "-"}ms ` +
        `nullsnips=${nulls}  ($${spend.toFixed(3)})`,
    );
  }

  console.log(`\nwrote ${out}`);
  console.log(`spent $${spend.toFixed(3)}`);
  console.log(`next: npx tsx scripts/evals/web-snippet/judge.ts   # then report.ts`);
}

void main();
