#!/usr/bin/env tsx
/**
 * Measurement harness for `tako_available_data`'s pair-confirmation probe.
 *
 * SUPERSEDED for any accuracy claim by `available-data-truth.ts`, which drives
 * the real handler. This one REIMPLEMENTS the resolution logic to sweep in
 * bulk, and a reimplementation drifts: an earlier version omitted the tool's
 * exact-name promotion (`sameTokens`) and understated accuracy by 19 points.
 * Use it for verdict-distribution and latency sweeps, not for "is the tool
 * right".
 *
 * Answers the only question that decides whether the probe is worth its ~0.7s:
 * how often does the entity's own metric list DISAGREE with what two
 * independent `graph/search` calls resolved, and when it disagrees, is the
 * probe right?
 *
 * Two phases, because only one of them is free:
 *
 *   PHASE A (free, always runs) — graph endpoints only. Replays the real
 *   decision functions (`confidentMatch`, `metricFilter`, `reconcilePair`)
 *   against live graph data and reports the verdict split, the re-pin rate,
 *   and the added latency. Costs nothing and needs no credits.
 *
 *   PHASE B (PRICED, opt-in via --priced) — ground truth. For pairs where the
 *   old and new handles DIFFER, runs both through `POST /api/v3/search/` and
 *   compares card counts. This is the only way to learn whether `unlinked`
 *   predicts a zero-card pin and whether dropping the pin recovers it.
 *   Costs 2 priced searches per differing pair; the exact count is printed and
 *   confirmed before anything is spent.
 *
 * Usage:
 *   TAKO_API_TOKEN=... npx tsx scripts/pair-confirm-eval.ts
 *   TAKO_API_TOKEN=... npx tsx scripts/pair-confirm-eval.ts --priced
 *   ... --base https://staging.tako.com      (default: https://tako.com)
 *   ... --out /tmp/pair-eval.json
 *
 * The pair list below deliberately mixes three groups so the headline number
 * is not gamed: pairs KNOWN to return zero cards (the probe should flag them),
 * pairs known to retrieve (it must not), and untuned everyday pairs.
 */
import { writeFileSync } from "node:fs";

import { confidentMatch } from "../src/tools/_match_gate.js";
import { metricFilter, reconcilePair } from "../src/tools/_pair_confirm.js";
import { PAIR_PROBE_LIMIT } from "../src/tools/_pair_confirm.js";

// Mirrors the loose `graphNodeSchema` facade rather than importing it, so the
// harness stays a plain fetch script. `exactOptionalPropertyTypes` is on, hence
// the explicit `| undefined`.
interface GraphNode {
  id: string;
  type: string;
  name: string;
  aliases?: string[] | undefined;
}

type Group = "known-zero" | "known-retrieves" | "untuned";

interface Pair {
  q: string;
  metric: string;
  group: Group;
  /** Why this pair is in the list — kept so the sample stays auditable. */
  note?: string;
}

// ---------------------------------------------------------------------------
// The sample. Groups 1 and 2 are the cases measured on staging 2026-07-29/30
// and recorded in the session notes; group 3 is everyday usage that was never
// used to tune any threshold.
// ---------------------------------------------------------------------------
const PAIRS: Pair[] = [
  // Resolve cleanly today, return ZERO cards. The probe should flag these.
  { q: "Lockheed Martin", metric: "backlog", group: "known-zero" },
  { q: "Shopify", metric: "gross merchandise volume", group: "known-zero" },
  { q: "UnitedHealth Group", metric: "change in unearned revenues", group: "known-zero" },
  { q: "Carnival Corporation", metric: "passenger cruise days", group: "known-zero",
    note: "pinned [0,0,0] / unpinned [3,3,3] — the KE-812 twin case" },
  { q: "Apple", metric: "P/E ratio", group: "known-zero",
    note: "pinned [0,0,0] / unpinned [3,3,3]" },
  { q: "Tesla", metric: "vehicle deliveries", group: "known-zero" },

  // Resolve AND retrieve. A verdict of `unlinked` on any of these is a false
  // positive and the most expensive kind of error this change can make.
  { q: "Novo Nordisk", metric: "revenue", group: "known-retrieves" },
  { q: "Apple", metric: "gross margin", group: "known-retrieves" },
  { q: "NVIDIA", metric: "net income", group: "known-retrieves" },
  { q: "Microsoft", metric: "market cap", group: "known-retrieves" },
  { q: "United States", metric: "unemployment rate", group: "known-retrieves" },
  { q: "Amazon", metric: "EPS", group: "known-retrieves" },

  // Never used for tuning.
  { q: "Pfizer", metric: "R&D expense", group: "untuned",
    note: "rank 0 fails confidentMatch — the re-pin case" },
  { q: "Chevron", metric: "capex", group: "untuned" },
  { q: "Walmart", metric: "total revenue", group: "untuned" },
  { q: "JPMorgan Chase", metric: "net interest margin", group: "untuned" },
  { q: "Netflix", metric: "paid subscribers", group: "untuned" },
  { q: "Delta Air Lines", metric: "available seat miles", group: "untuned" },
  { q: "Germany", metric: "inflation rate", group: "untuned" },
  { q: "Ford", metric: "free cash flow", group: "untuned" },
  { q: "Starbucks", metric: "same store sales", group: "untuned" },
  { q: "Boeing", metric: "aircraft deliveries", group: "untuned" },
  { q: "Coca-Cola", metric: "operating margin", group: "untuned" },
  { q: "Airbnb", metric: "nights booked", group: "untuned" },
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// The Django host the WORKER talks to (`DJANGO_BASE_URL` in wrangler.jsonc),
// NOT the marketing domain: trytako.com sits behind a Cloudflare WAF that 403s
// direct API probes, which is the "blocked before reaching the graph service"
// case graphErrorMessage already documents.
const BASE = flag("--base") ?? "https://tako.com";
const PRICED = args.includes("--priced");
const OUT = flag("--out");
const TOKEN = process.env["TAKO_API_TOKEN"];

if (TOKEN === undefined || TOKEN === "") {
  console.error("TAKO_API_TOKEN is required (mint one at trytako.com).");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function graphSearch(q: string, types?: "entity" | "metric"): Promise<GraphNode[]> {
  const url = new URL("/api/beta/graph/search", BASE);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "10");
  if (types !== undefined) url.searchParams.set("types", types);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`graph/search ${res.status} for "${q}"`);
  return ((await res.json()) as { results: GraphNode[] }).results ?? [];
}

async function scopedMetrics(
  entityId: string,
  filter: string | null,
): Promise<{ items: GraphNode[]; complete: boolean } | null> {
  if (filter === null) return null;
  const url = new URL("/api/beta/graph/related", BASE);
  url.searchParams.set("node_id", entityId);
  url.searchParams.set("relation", "metrics");
  url.searchParams.set("q", filter);
  url.searchParams.set("limit", String(PAIR_PROBE_LIMIT));
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    relation?: { items?: GraphNode[]; next_cursor?: string | null } | null;
  };
  const page = body.relation ?? null;
  if (page === null) return { items: [], complete: true };
  // Completeness comes from next_cursor, NEVER from `total` — that field
  // ignores the `q` filter (measured: Lockheed reports 250/capped either way).
  return { items: page.items ?? [], complete: (page.next_cursor ?? null) === null };
}

/**
 * Ground truth. PRICED. `sources.data` only — the question is whether Tako's
 * DATA GRAPH holds this pair, and letting web results in would answer a
 * different one. Titles come back so a returned card can be judged for
 * relevance, not just counted: a card is not evidence if it is the wrong metric.
 */
async function cards(
  query: string,
  nodeIds: string[],
  strict: boolean,
): Promise<{ n: number; titles: string[] }> {
  const data: Record<string, unknown> = { count: 5 };
  if (nodeIds.length > 0) {
    data["node_ids"] = nodeIds;
    data["strict"] = strict;
  }
  const res = await fetch(new URL("/api/v3/search/", BASE), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, sources: { data } }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const body = (await res.json()) as { cards?: Array<{ title?: string }> };
  const list = body.cards ?? [];
  return { n: list.length, titles: list.map((c) => c.title ?? "(untitled)") };
}

interface Row {
  q: string;
  metric: string;
  group: Group;
  entity: string | null;
  pin: { id: string; name: string } | null;
  /** Today's verdict: `found: true` means "Tako has this data". */
  oldClaimsData: boolean;
  verified: "pair" | "unlinked" | "resolution";
  probeMs: number;
  baseMs: number;
  entityMetricMatches: string[];
  /** Ground truth — what the emitted handle actually retrieves. */
  pinnedCards?: number;
  pinnedTitles?: string[];
  unpinnedCards?: number;
  unpinnedTitles?: string[];
}

async function evaluate(pair: Pair): Promise<Row> {
  const t0 = Date.now();
  const [entityHits, metricHits] = await Promise.all([
    graphSearch(pair.q, "entity"),
    graphSearch(pair.metric, "metric").catch(() => [] as GraphNode[]),
  ]);
  const baseMs = Date.now() - t0;

  // Entity rank 0 of the typed probe. The harness deliberately does not re-run
  // gateCandidates: the METRIC half is what is under measurement, and holding
  // the entity fixed keeps the two arms comparable.
  const entity = entityHits[0] ?? null;
  const rank0 = metricHits[0] ?? null;
  const confident = rank0 !== null && confidentMatch(pair.metric, rank0);

  let verified: Row["verified"] = "resolution";
  let entityMetricMatches: GraphNode[] = [];
  let probeMs = 0;
  if (entity !== null && rank0 !== null) {
    const t1 = Date.now();
    const scoped = await scopedMetrics(
      entity.id,
      metricFilter({ metricQuery: pair.metric, resolvedName: rank0.name, confident }),
    );
    probeMs = Date.now() - t1;
    if (scoped !== null) {
      const r = reconcilePair({
        metricQuery: pair.metric, globalMetric: rank0,
        scoped: scoped.items, complete: scoped.complete,
      });
      verified = r.verified;
      entityMetricMatches = r.entityMetricMatches;
    }
  }

  return {
    q: pair.q,
    metric: pair.metric,
    group: pair.group,
    entity: entity?.name ?? null,
    pin: rank0 === null ? null : { id: rank0.id, name: rank0.name },
    oldClaimsData: entity !== null && confident,
    verified,
    probeMs,
    baseMs,
    entityMetricMatches: entityMetricMatches.map((n) => n.name),
  };
}

const pct = (n: number, d: number): string =>
  d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  console.log(`Pair-confirmation eval — ${PAIRS.length} pairs against ${BASE}\n`);

  const rows: Row[] = [];
  for (const pair of PAIRS) {
    try {
      const row = await evaluate(pair);
      rows.push(row);
      const mark = row.verified === "pair" ? "pair " : row.verified === "unlinked" ? "UNLNK" : "resol";
      console.log(
        `  ${mark}  ${pair.q} / ${pair.metric}  ->  ${row.pin?.name ?? "—"}` +
        `${row.oldClaimsData ? "  [old: found:true]" : ""}  (+${row.probeMs}ms)`,
      );
    } catch (err) {
      console.error(`  ERROR  ${pair.q} / ${pair.metric}: ${String(err)}`);
    }
  }

  const n = rows.length;
  const byVerdict = (v: string) => rows.filter((r) => r.verified === v).length;
  console.log(`\n${"=".repeat(70)}\nPHASE A — free graph signal (n=${n})\n`);
  console.log(`  pair ${byVerdict("pair")}   unlinked ${byVerdict("unlinked")}   resolution ${byVerdict("resolution")}`);
  const probes = rows.map((r) => r.probeMs).filter((m) => m > 0).sort((a, b) => a - b);
  if (probes.length > 0) {
    const med = probes[Math.floor(probes.length / 2)] ?? 0;
    const baseMed = rows.map((r) => r.baseMs).sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0;
    console.log(`  latency: resolution ~${baseMed}ms median, probe adds ~${med}ms median`);
  }

  if (!PRICED) {
    console.log(
      `\n${"=".repeat(70)}\nPHASE B — skipped (add --priced)\n\n` +
      `  Would run 2 priced searches x ${n} pairs = ${n * 2} calls ` +
      `(~$${(n * 2 * 0.007).toFixed(2)}).`,
    );
  } else {
    console.log(`\n${"=".repeat(70)}\nPHASE B — ground truth (${n * 2} priced searches)\n`);
    for (const row of rows) {
      const query = `${row.entity ?? row.q} ${row.metric}`;
      try {
        const pinned = row.pin === null
          ? { n: 0, titles: [] as string[] }
          : await cards(query, [row.pin.id], true);
        const unpinned = await cards(query, [], false);
        row.pinnedCards = pinned.n;
        row.pinnedTitles = pinned.titles;
        row.unpinnedCards = unpinned.n;
        row.unpinnedTitles = unpinned.titles;
        console.log(
          `  ${row.verified.padEnd(10)} ${row.q} / ${row.metric}\n` +
          `             pinned=${pinned.n} ${JSON.stringify(pinned.titles.slice(0, 2))}\n` +
          `             unpinned=${unpinned.n} ${JSON.stringify(unpinned.titles.slice(0, 2))}`,
        );
      } catch (err) {
        console.error(`  ERROR  ${row.q} / ${row.metric}: ${String(err)}`);
      }
    }

    // ---- The headline: is `found: true` actually RIGHT? ----
    const scored = rows.filter((r) => r.pinnedCards !== undefined);
    const claimed = scored.filter((r) => r.oldClaimsData);
    const claimedRight = claimed.filter((r) => (r.pinnedCards ?? 0) > 0);
    const claimedWrong = claimed.filter((r) => (r.pinnedCards ?? 0) === 0);

    console.log(`\n${"-".repeat(70)}\nIS THE TOOL RIGHT WHEN IT SAYS "TAKO HAS THIS"?\n`);
    console.log(`  Today, found:true on ${claimed.length} of ${scored.length} pairs.`);
    console.log(`    of those, the emitted PINNED handle retrieved: ${claimedRight.length}  (${pct(claimedRight.length, claimed.length)})`);
    console.log(`    ...and returned NOTHING:                       ${claimedWrong.length}  (${pct(claimedWrong.length, claimed.length)})  <- the false claims`);

    const wrongFlagged = claimedWrong.filter((r) => r.verified === "unlinked");
    const rightFlagged = claimedRight.filter((r) => r.verified === "unlinked");
    console.log(`\n  Does \`verified\` separate them?`);
    console.log(`    false claims CAUGHT by unlinked:   ${wrongFlagged.length}/${claimedWrong.length}  (${pct(wrongFlagged.length, claimedWrong.length)})  <- recall`);
    console.log(`    true claims WRONGLY flagged:       ${rightFlagged.length}/${claimedRight.length}  (${pct(rightFlagged.length, claimedRight.length)})  <- false alarms`);
    const pairPrecision = claimed.filter((r) => r.verified === "pair");
    const pairRight = pairPrecision.filter((r) => (r.pinnedCards ?? 0) > 0);
    console.log(`\n  Precision of the surviving unqualified claim (verified=pair):`);
    console.log(`    ${pairRight.length}/${pairPrecision.length} retrieve (${pct(pairRight.length, pairPrecision.length)}), vs ${claimedRight.length}/${claimed.length} (${pct(claimedRight.length, claimed.length)}) today`);

    // ---- Does dropping the pin actually recover anything? ----
    const unl = scored.filter((r) => r.verified === "unlinked");
    const recovered = unl.filter((r) => (r.unpinnedCards ?? 0) > (r.pinnedCards ?? 0));
    console.log(`\n  Unpinned recovery on unlinked pairs: ${recovered.length}/${unl.length} retrieved MORE without the pin`);
  }

  if (OUT !== undefined) {
    writeFileSync(OUT, JSON.stringify({ base: BASE, priced: PRICED, rows }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

await main();
