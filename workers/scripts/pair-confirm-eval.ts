#!/usr/bin/env tsx
/**
 * Measurement harness for `tako_available_data`'s pair-confirmation probe.
 *
 * Answers the only question that decides whether the probe is worth its ~0.7s:
 * how often does the entity's own metric list DISAGREE with what two
 * independent `graph/search` calls resolved, and when it disagrees, is the
 * probe right?
 *
 * Two phases, because only one of them is free:
 *
 *   PHASE A (free, always runs) — graph endpoints only. Replays the real
 *   decision functions (`confidentMatch`, `filterVariants`, `reconcilePair`)
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
 *   ... --base https://staging.trytako.com   (default: https://trytako.com)
 *   ... --out /tmp/pair-eval.json
 *
 * The pair list below deliberately mixes three groups so the headline number
 * is not gamed: pairs KNOWN to return zero cards (the probe should flag them),
 * pairs known to retrieve (it must not), and untuned everyday pairs.
 */
import { writeFileSync } from "node:fs";

import { confidentMatch } from "../src/tools/_match_gate.js";
import { filterVariants, reconcilePair } from "../src/tools/_pair_confirm.js";
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
const BASE = flag("--base") ?? "https://trytako.com";
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

async function scopedMetrics(entityId: string, variants: string[]): Promise<GraphNode[] | null> {
  const pages = await Promise.all(
    variants.map(async (variant) => {
      const url = new URL("/api/beta/graph/related", BASE);
      url.searchParams.set("node_id", entityId);
      url.searchParams.set("relation", "metrics");
      url.searchParams.set("q", variant);
      url.searchParams.set("limit", String(PAIR_PROBE_LIMIT));
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const body = (await res.json()) as { relation?: { items?: GraphNode[] } | null };
      return body.relation?.items ?? [];
    }),
  );
  if (pages.some((p) => p === null)) return null;
  const seen = new Set<string>();
  return pages.flat().filter((n): n is GraphNode => {
    if (n === null || seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

/** Ground truth: how many cards does this handle actually retrieve? PRICED. */
async function cardCount(query: string, nodeIds: string[], strict: boolean): Promise<number> {
  const res = await fetch(new URL("/api/v3/search/", BASE), {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: query,
      ...(nodeIds.length > 0 ? { node_ids: nodeIds, strict } : {}),
    }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const body = (await res.json()) as { outputs?: { knowledge_cards?: unknown[] } };
  return body.outputs?.knowledge_cards?.length ?? 0;
}

interface Row {
  q: string;
  metric: string;
  group: Group;
  entity: string | null;
  /** What today's code would pin. */
  oldPin: { id: string; name: string } | null;
  oldConfident: boolean;
  /** What the new code pins, and on what evidence. */
  newPin: { id: string; name: string } | null;
  verified: "pair" | "unlinked" | "resolution";
  repinned: boolean;
  /** True when old and new would issue different priced calls. */
  differs: boolean;
  probeMs: number;
  baseMs: number;
  entityMetricMatches: string[];
  oldCards?: number;
  newCards?: number;
}

async function evaluate(pair: Pair): Promise<Row> {
  const t0 = Date.now();
  const [entityHits, metricHits] = await Promise.all([
    graphSearch(pair.q, "entity"),
    graphSearch(pair.metric, "metric").catch(() => [] as GraphNode[]),
  ]);
  const baseMs = Date.now() - t0;

  // The entity gate is reproduced in spirit — rank 0 of the typed probe. The
  // harness deliberately does NOT re-run gateCandidates: the question under
  // measurement is the METRIC half, and holding the entity fixed keeps the
  // two arms comparable.
  const entity = entityHits[0] ?? null;
  const rank0 = metricHits[0] ?? null;
  const oldConfident = rank0 !== null && confidentMatch(pair.metric, rank0);

  let verified: Row["verified"] = "resolution";
  let newPin = rank0;
  let repinned = false;
  let entityMetricMatches: GraphNode[] = [];
  let probeMs = 0;
  if (entity !== null) {
    const t1 = Date.now();
    const scoped = await scopedMetrics(
      entity.id,
      filterVariants({
        metricQuery: pair.metric,
        resolvedName: rank0?.name ?? null,
        confident: oldConfident,
      }),
    );
    probeMs = Date.now() - t1;
    if (scoped !== null) {
      const r = reconcilePair({ metricQuery: pair.metric, globalMetric: rank0, scoped });
      verified = r.verified;
      newPin = r.metric;
      repinned = r.repinned;
      entityMetricMatches = r.entityMetricMatches;
    }
  }

  // Today: pin rank 0 with strict when confident, else emit nothing.
  // New: pin the (possibly re-pinned) node, UNPINNED when unlinked.
  const oldEmits = oldConfident && entity !== null && rank0 !== null;
  const newConfident = newPin !== null && confidentMatch(pair.metric, newPin);
  const newEmits = newConfident && entity !== null;
  const differs =
    oldEmits !== newEmits ||
    (oldEmits && newEmits && (verified === "unlinked" || rank0?.id !== newPin?.id));

  return {
    q: pair.q,
    metric: pair.metric,
    group: pair.group,
    entity: entity?.name ?? null,
    oldPin: rank0 === null ? null : { id: rank0.id, name: rank0.name },
    oldConfident,
    newPin: newPin === null ? null : { id: newPin.id, name: newPin.name },
    verified,
    repinned,
    differs,
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
      const mark =
        row.verified === "pair" ? (row.repinned ? "REPIN" : "pair ") :
        row.verified === "unlinked" ? "UNLNK" : "resol";
      console.log(
        `  ${mark}  ${pair.q} / ${pair.metric}\n` +
        `         entity=${row.entity ?? "—"}  old=${row.oldPin?.name ?? "—"}` +
        `${row.repinned ? `  new=${row.newPin?.name ?? "—"}` : ""}  (+${row.probeMs}ms)`,
      );
    } catch (err) {
      console.error(`  ERROR  ${pair.q} / ${pair.metric}: ${String(err)}`);
    }
  }

  // ---- Phase A summary ----
  const n = rows.length;
  const byVerdict = (v: string) => rows.filter((r) => r.verified === v).length;
  const inGroup = (g: Group) => rows.filter((r) => r.group === g);
  console.log(`\n${"=".repeat(64)}\nPHASE A — free graph signal (n=${n})\n`);
  console.log(`  pair       ${byVerdict("pair")}  (${pct(byVerdict("pair"), n)})`);
  console.log(`  unlinked   ${byVerdict("unlinked")}  (${pct(byVerdict("unlinked"), n)})`);
  console.log(`  resolution ${byVerdict("resolution")}  (${pct(byVerdict("resolution"), n)})  <- probe failed`);
  console.log(`  re-pinned  ${rows.filter((r) => r.repinned).length}`);
  console.log(`  handles that DIFFER from today: ${rows.filter((r) => r.differs).length}`);

  console.log(`\n  By group — does the verdict track reality?`);
  for (const g of ["known-zero", "known-retrieves", "untuned"] as Group[]) {
    const gr = inGroup(g);
    const flagged = gr.filter((r) => r.verified === "unlinked").length;
    console.log(`    ${g.padEnd(16)} n=${String(gr.length).padStart(2)}  flagged unlinked: ${flagged} (${pct(flagged, gr.length)})`);
  }
  console.log(
    `\n  Read: on "known-zero" a HIGH flag rate is the probe working; on\n` +
    `  "known-retrieves" ANY flag is a false positive, and each one costs a\n` +
    `  working pinned handle. Those two numbers together decide this change.`,
  );

  const probeTimes = rows.map((r) => r.probeMs).filter((m) => m > 0).sort((a, b) => a - b);
  if (probeTimes.length > 0) {
    const med = probeTimes[Math.floor(probeTimes.length / 2)] ?? 0;
    const p90 = probeTimes[Math.floor(probeTimes.length * 0.9)] ?? 0;
    const baseMed = rows.map((r) => r.baseMs).sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0;
    console.log(`\n  Latency: resolution ~${baseMed}ms median; probe adds ~${med}ms median, ~${p90}ms p90.`);
  }

  // ---- Phase B ----
  const differing = rows.filter((r) => r.differs);
  if (!PRICED) {
    console.log(
      `\n${"=".repeat(64)}\nPHASE B — skipped (add --priced to run)\n\n` +
      `  ${differing.length} pairs would need 2 priced searches each = ` +
      `${differing.length * 2} calls (~$${(differing.length * 2 * 0.007).toFixed(3)}).\n` +
      `  Without it, Phase A shows only that the signals DISAGREE — not which is right.`,
    );
  } else {
    console.log(`\n${"=".repeat(64)}\nPHASE B — ground truth on ${differing.length} differing pairs\n`);
    for (const row of differing) {
      try {
        const subject = row.entity ?? row.q;
        const query = `${subject} ${row.metric}`;
        row.oldCards = row.oldPin === null || !row.oldConfident
          ? 0
          : await cardCount(query, [row.oldPin.id], true);
        row.newCards =
          row.verified === "unlinked"
            ? await cardCount(query, [], false)
            : row.newPin === null
              ? 0
              : await cardCount(query, [row.newPin.id], true);
        const delta = (row.newCards ?? 0) - (row.oldCards ?? 0);
        console.log(
          `  ${delta > 0 ? "BETTER" : delta < 0 ? "WORSE " : "same  "}  ` +
          `${row.q} / ${row.metric}: old=${row.oldCards} new=${row.newCards}`,
        );
      } catch (err) {
        console.error(`  ERROR  ${row.q} / ${row.metric}: ${String(err)}`);
      }
    }
    const scored = differing.filter((r) => r.oldCards !== undefined);
    const better = scored.filter((r) => (r.newCards ?? 0) > (r.oldCards ?? 0)).length;
    const worse = scored.filter((r) => (r.newCards ?? 0) < (r.oldCards ?? 0)).length;
    console.log(
      `\n  net: ${better} better, ${worse} worse, ${scored.length - better - worse} unchanged` +
      ` (of ${scored.length} scored, ${n} total)`,
    );
    console.log(
      `\n  Read: "worse" is the number that should kill this change — it means\n` +
      `  the probe unpinned or re-pinned a handle that was working.`,
    );
  }

  if (OUT !== undefined) {
    writeFileSync(OUT, JSON.stringify({ base: BASE, priced: PRICED, rows }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

await main();
