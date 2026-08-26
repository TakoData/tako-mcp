#!/usr/bin/env tsx
/**
 * END-TO-END truth: run the REAL `tako_available_data` handler, then execute
 * the `next_call` it emits, and report whether that handle retrieves.
 *
 * Supersedes `pair-confirm-eval.ts` for any accuracy claim. That harness
 * REIMPLEMENTED the resolution logic and skipped the tool's exact-name
 * promotion (`sameTokens`), so it pinned strictly worse nodes than the tool
 * does — e.g. `Defense Number Of Aircraft Deliveries` where the tool promotes
 * `Deliveries - Aircraft`. Never measure the tool by re-deriving it.
 *
 * The emitted next_call names `tako_answer`; this executes the equivalent
 * `/api/v3/search/` with the same query/node_ids/strict, because the question
 * is whether the HANDLE retrieves, and search is the cheaper way to ask it.
 */
import type { Env } from "../src/env.js";
import type { ToolContext } from "../src/tools/types.js";
import takoAvailableData from "../src/tools/tako_available_data.js";

const BASE = "https://tako.com";
const TOKEN = process.env["TAKO_API_TOKEN"];
if (TOKEN === undefined || TOKEN === "") { console.error("TAKO_API_TOKEN required"); process.exit(1); }
const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const ctx: ToolContext = {
  token: TOKEN, env: { DJANGO_BASE_URL: BASE } as Env,
  sendProgress: async () => {}, surface: "generic",
};

async function cards(query: string, ids: string[], strict: boolean) {
  const data: Record<string, unknown> = { count: 5 };
  if (ids.length > 0) { data["node_ids"] = ids; data["strict"] = strict; }
  const r = await fetch(new URL("/api/v3/search/", BASE), {
    method: "POST", headers, body: JSON.stringify({ query, sources: { data } }),
  });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const b = (await r.json()) as { cards?: Array<{ title?: string }> };
  return { n: (b.cards ?? []).length, titles: (b.cards ?? []).map((c) => c.title ?? "?") };
}

const PAIRS: Array<[string, string, string]> = [
  ["Lockheed Martin", "backlog", "known-zero"],
  ["Shopify", "gross merchandise volume", "known-zero"],
  ["UnitedHealth Group", "change in unearned revenues", "known-zero"],
  ["Carnival Corporation", "passenger cruise days", "known-zero"],
  ["Apple", "P/E ratio", "known-zero"],
  ["Tesla", "vehicle deliveries", "known-zero"],
  ["Novo Nordisk", "revenue", "known-retrieves"],
  ["Apple", "gross margin", "known-retrieves"],
  ["NVIDIA", "net income", "known-retrieves"],
  ["Microsoft", "market cap", "known-retrieves"],
  ["United States", "unemployment rate", "known-retrieves"],
  ["Amazon", "EPS", "known-retrieves"],
  ["Pfizer", "R&D expense", "untuned"],
  ["Chevron", "capex", "untuned"],
  ["Walmart", "total revenue", "untuned"],
  ["JPMorgan Chase", "net interest margin", "untuned"],
  ["Netflix", "paid subscribers", "untuned"],
  ["Delta Air Lines", "available seat miles", "untuned"],
  ["Germany", "inflation rate", "untuned"],
  ["Ford", "free cash flow", "untuned"],
  ["Starbucks", "same store sales", "untuned"],
  ["Boeing", "aircraft deliveries", "untuned"],
  ["Coca-Cola", "operating margin", "untuned"],
  ["Airbnb", "nights booked", "untuned"],
];

interface R { q: string; metric: string; verified: string; found: boolean;
  pinName: string | null; emitted: "pinned" | "unpinned" | "none";
  handleCards: number; titles: string[]; }

async function main(): Promise<void> {
  const rows: R[] = [];
  for (const [q, metric] of PAIRS) {
    const out = await takoAvailableData.handler({ q, metric }, ctx);
    const nc = out.next_call;
    // next_call carries no pin since the D4 split, so the handle is always the
    // unpinned form. This script still exercises the PINNED arm — it is what
    // measured the 11-of-20 result — by taking the metric node from the
    // resolved pair and calling /api/v3/search directly, which still accepts
    // node_ids even though tako_search no longer exposes them.
    const pinId = out.metric?.node_id ?? null;
    const emitted = nc === null ? "none" : "unpinned";
    let handleCards = 0; let titles: string[] = [];
    if (nc !== null) {
      const got = await cards(nc.query, [], false);
      handleCards = got.n; titles = got.titles;
      if (pinId !== null) {
        const pinned = await cards(nc.query, [pinId], true);
        console.log(`         pinned arm: cards=${pinned.n}  ${pinned.titles.slice(0, 1)[0] ?? ""}`);
      }
    }
    rows.push({ q, metric, verified: String(out.verified), found: out.found,
      pinName: out.metric?.name ?? null, emitted, handleCards, titles });
    console.log(`  ${out.found ? "found " : "NOFIND"} ${String(out.verified).padEnd(10)} ${emitted.padEnd(8)} cards=${handleCards}  ${q} / ${metric}`);
    console.log(`         pin: ${out.metric?.name ?? "—"}   ${titles.slice(0, 1)[0] ?? ""}`);
  }

  const n = rows.length;
  const claims = rows.filter((r) => r.found);
  const withHandle = rows.filter((r) => r.emitted !== "none");
  const lands = withHandle.filter((r) => r.handleCards > 0);
  const claimsLand = claims.filter((r) => r.handleCards > 0);
  const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`);

  console.log(`\n${"=".repeat(66)}\nEND-TO-END: does the tool's OWN next_call retrieve? (n=${n})\n`);
  console.log(`  emits a handle:            ${withHandle.length}/${n}`);
  console.log(`  that handle returns cards: ${lands.length}/${withHandle.length}  (${pct(lands.length, withHandle.length)})`);
  console.log(`\n  says found:true:           ${claims.length}/${n}`);
  console.log(`  ...and its handle lands:   ${claimsLand.length}/${claims.length}  (${pct(claimsLand.length, claims.length)})  <- IS THE TOOL RIGHT?`);
  for (const v of ["pair", "unlinked", "resolution"]) {
    const g = rows.filter((r) => r.verified === v);
    const ok = g.filter((r) => r.handleCards > 0);
    console.log(`    verified=${v.padEnd(11)} ${ok.length}/${g.length} land (${pct(ok.length, g.length)})`);
  }
}
await main();
