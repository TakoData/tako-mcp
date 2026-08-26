/**
 * Pair confirmation for `tako_available_data`'s LOOKUP path — does the entity
 * actually HOLD the metric, or did two independent searches just happen to
 * resolve two nodes?
 *
 * The lookup path resolves its two halves with two independent `graph/search`
 * calls and nothing ever asks whether they are connected. That is enough to
 * emit `found: true` with a pinned, priced `next_call` — and measured on
 * staging, three pairs that resolve cleanly that way return ZERO cards:
 * Lockheed Martin / backlog, Shopify / gross merchandise volume, UnitedHealth
 * Group / change in unearned revenues. All three resolve a metric whose NAME
 * fits perfectly, so no amount of string matching can catch them.
 *
 * `graph/related?node_id=<entity>&relation=metrics` answers a different
 * question — a structural one — and it is the same list the DISCOVERY path
 * already drills and pins from, so the ids reconcile.
 *
 * TWO INDEPENDENT TESTS, BOTH REQUIRED:
 *   - `confidentMatch` (lexical): does this node answer what was asked?
 *   - linkage (structural): does this entity hold it?
 * Linkage never vouches for a node that failed the lexical test. Pfizer really
 * does have `Operating costs and expenses`, so confirming its edge for
 * `metric="R&D expense"` would turn a wrong pin into a CONFIDENT wrong pin.
 *
 * LINKAGE IS EVIDENCE, NEVER A CHOICE. This module deliberately does NOT pick a
 * node off the entity's list to pin. It did, and the branch was removed after
 * measuring it against live prod (24 pairs, 2026-08-04): 4 re-pins, 2 of them
 * catastrophic, because `graph/related` is NOT a curated list of the entity's
 * own metrics —
 *
 *   Netflix / "paid subscribers"  ->  `Disney Core Paid Subscribers`
 *   Walmart / "total revenue"     ->  `5G Telco Edge IoT Revenue Total Revenue`
 *
 * both returned from the QUERIED entity's metrics relation, and both pass
 * `confidentMatch` (the query's tokens are a subset of those names). The same
 * pollution puts `Bombshells Same Store Sales` on Starbucks. Every one of those
 * re-pins fired where rank 0 was unvetted and the tool correctly emits NO
 * handle today, so the branch converted "no handle" into a confidently wrong
 * PRICED call. A relation this noisy can support "is the node you resolved on
 * this list?" and nothing stronger.
 *
 * Direction is deliberate. The symmetric call (pin the metric, drill
 * `relation=entities`, look for the entity) is wrong twice over: a broad metric
 * is tracked across more entities than the server will count (it stops at 250
 * and sets `total_capped`, so absence proves nothing), and metric→entities
 * lists are known-generic — `Passenger Cruise Days` lists NVIDIA, Apple, Amazon
 * and Microsoft, which is already why `exampleSearch` refuses to pair a metric
 * match with its own `coverage.items[0]`.
 *
 * Network-free so it unit-tests in isolation; the tool module runs the fetch.
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import type { z } from "zod";

import type { graphNodeSchema } from "./_graph.js";
import { confidentMatch, matchTokens } from "./_match_gate.js";

type GraphNode = z.infer<typeof graphNodeSchema>;

/**
 * What evidence stands behind a resolved pair. Deliberately NOT folded into
 * `found` — that boolean already means two different things on the two paths,
 * and collapsing "checked, no edge" with "never checked" would repeat the
 * mistake one level down.
 *
 *   "pair"       the metric is on the entity's own metric list
 *   "unlinked"   the probe RAN and the entity's list holds nothing matching
 *   "resolution" no pair evidence: probe skipped, timed out, or errored
 *
 * `"resolution"` covers both probe-failed and probe-skipped because the
 * caller's action is identical in each (pin, retry unpinned on zero cards). A
 * distinct value only earns its place when the recommended action differs.
 */
export type PairVerdict = "pair" | "unlinked" | "resolution";

/**
 * Round-trip ceiling for the confirmation probe.
 *
 * A `graph/related` probe is ~0.7s (measured, staging), so this is a TAIL
 * bound, not a target — set tight enough that a degraded graph service cannot
 * double the lookup path's latency, loose enough that the ordinary call always
 * lands. On timeout the verdict degrades to `"resolution"`, which is today's
 * behaviour exactly.
 */
export const PAIR_PROBE_TIMEOUT_MS = 2_500;

/**
 * Page size for the probe — the endpoint's MAXIMUM, deliberately.
 *
 * A metric paged out of view is indistinguishable from one that is absent, and
 * the probe only ever gets one page (no pagination: this is a fast check, not a
 * coverage drill). At 20 that mattered: measured on prod, `q="Backlog"` scoped
 * to Lockheed Martin returns a full page and a `next_cursor`, because the filter
 * is a SUBSTRING match and the entity holds `12 Month Backlog`, `90 Day
 * Backlog`, `AA&S Backlog` and many more. 100 makes truncation rare; when it
 * still happens, `reconcilePair` refuses to call it absence.
 *
 * The list is never rendered — only searched for one id and sliced to
 * ENTITY_MATCHES_SHOWN — so the wider page costs bandwidth, not context.
 */
export const PAIR_PROBE_LIMIT = 100;

/**
 * Shortest useful substring filter. `q` is a raw substring match, so a one- or
 * two-character filter matches most of a metric list and answers nothing.
 */
const MIN_FILTER_CHARS = 3;

/** Shortest token that may match by PREFIX in the display ordering below. */
const MIN_PREFIX_CHARS = 3;

/** Near-miss metrics shown to the caller when the verdict is `unlinked`. */
export const ENTITY_MATCHES_SHOWN = 3;

/**
 * THE VERDICT filter to send as `graph/related`'s `q` — the one whose hits
 * decide `pair` vs `unlinked`. It is no longer the only filter on the wire:
 * `metricFilters` also sends the caller's verbatim phrase, which buys the
 * browse LIST and never a verdict.
 *
 * `q` is a case-insensitive SUBSTRING filter on name+aliases — a stricter,
 * different test from the token containment used everywhere else in this tool.
 * That is what makes the choice matter:
 *
 *   confirm (rank 0 passed the name test) — the resolved node's OWN name. It is
 *   the only string guaranteed to substring-match the node being confirmed, and
 *   the caller's phrase is NOT a safe substitute: measured, `"aircraft
 *   deliveries"` is not a substring of Boeing's `"Deliveries - Aircraft"`, so
 *   filtering by the phrase would report a false `unlinked` and unpin a handle
 *   that retrieves.
 *
 *   diagnose (rank 0 failed) — the resolved name is the WRONG metric, so
 *   filtering by it would check the wrong thing and then report "the entity's
 *   list holds nothing matching" about a metric nobody asked for. Use the
 *   query's longest token instead: no handle is emitted on this path, so the
 *   only payload is the near-miss list, and recall is what matters. Measured,
 *   `"R&D expense"` matches nothing on Pfizer while `"expense"` surfaces its
 *   real R&D metrics.
 *
 * A SECOND VERDICT variant was implemented and measured (24 pairs, prod,
 * 2026-08-04): it changed the verdict on 0 of them, adding only extra
 * near-miss entries, at the cost of a second `graph/related` on every probed
 * call. Removed, and that still holds — the second filter this module now
 * sends is the caller's VERBATIM phrase, and it buys the list, not a verdict.
 * See `metricFilters`, which collapses the two to one call when they agree.
 */
export function metricFilter(input: {
  metricQuery: string;
  resolvedName?: string | null;
  confident: boolean;
}): string | null {
  const clean = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length < MIN_FILTER_CHARS ? null : trimmed;
  };
  if (input.confident) return clean(input.resolvedName);
  // Longest token: the distinctive half of a phrase is almost always the longer
  // word ("expense" over "R&D", "merchandise" over "gross"). Noise tokens are
  // already stripped by `matchTokens`.
  const longest = [...matchTokens(input.metricQuery)].sort((a, b) => b.length - a.length)[0];
  return clean(longest) ?? clean(input.metricQuery);
}

/**
 * How many gated entity candidates the lookup path coverage-probes, in the
 * same round trip as the pair probe. Two: the stub-over-real pairs measured
 * in the spec (`Duolingo` PRODUCT over `Duolingo, Inc.`, `croc` over
 * `Crocs, Inc.`) are adjacent in gate order. `relation.total` ignores the
 * `q` filter, so each probe returns the entity's full metric count for free
 * — the coverage evidence fix 2 binds the pair with. This is NOT the entity
 * probe the module header in tako_available_data.ts records as a 6.4x
 * regression: that one added a second round trip; these run alongside the
 * probe that already exists.
 */
export const PAIR_ENTITY_PROBES = 2;

export interface MetricFilters {
  /** The caller's `metric` phrase, as typed — the browse filter (fix 3). */
  verbatim: string | null;
  /** Today's confirm-or-diagnose filter (`metricFilter`); null when it would repeat `verbatim`. */
  fallback: string | null;
}

/**
 * The substring filters the lookup probe sends, in parallel. `verbatim`
 * returns the entity's own metrics whose name or alias contains what the
 * caller typed — `metric="data center"` on NVIDIA returns 13 named metrics
 * with ids, which the tool returns as a list instead of a 25-of-250 sample.
 * `fallback` keeps today's verdict logic byte-for-byte. A second filter was
 * measured to change 0 of 24 VERDICTS (see `metricFilter`); that still
 * holds — this one buys the list, not a verdict. When the two strings agree
 * (a single-token confident metric like `backlog`), only one call is made.
 */
export function metricFilters(input: {
  metricQuery: string;
  resolvedName?: string | null;
  confident: boolean;
}): MetricFilters {
  const fallback = metricFilter(input);
  const trimmed = input.metricQuery.trim();
  const verbatim = trimmed.length < MIN_FILTER_CHARS ? null : trimmed;
  if (verbatim !== null && fallback !== null && verbatim.toLowerCase() === fallback.toLowerCase()) {
    return { verbatim, fallback: null };
  }
  return { verbatim, fallback };
}

export interface PairReconciliation {
  /** `"pair"` or `"unlinked"`; the caller substitutes `"resolution"` if the probe never ran. */
  verified: PairVerdict;
  /**
   * The entity's own metrics that matched the filter, capped. Useful on ANY
   * verdict that withholds a handle — the caller's next move is to pick one of
   * these deliberately — so it is populated even when `verified` is
   * `"resolution"`.
   */
  entityMetricMatches: GraphNode[];
  /**
   * The entity's own metrics that contain the caller's phrase (the verbatim
   * filter's hits), backend order, deduped by id. Returned to the caller as a
   * coverage list with ids — the browse view. Never used to choose a pin.
   */
  metricList: GraphNode[];
}

/**
 * Decide the pair verdict from the global metric candidate and the entity's own
 * (filtered) metric list.
 *
 * Returns `"pair"` ONLY when both tests pass: the lexical one (`confidentMatch`
 * — does this node answer the question) and the structural one (is its id on
 * the entity's list). See the module header for why linkage alone must never
 * vouch for a node.
 *
 * Matching is by ID ONLY. A name-equality arm was carried here as a backstop
 * against the two id spaces diverging; measured on prod (24 pairs, 2026-08-04)
 * all 18 `pair` verdicts matched by id and NONE by name alone, so the arm was
 * empirically dead — while still able to fire on the near-duplicate metric
 * twins this file cites (KE-812: same name, different id, only one carrying
 * cards). That would report `"pair"` for a node whose id is not the id
 * `next_call` pins, which is precisely the confirmation the caller must not be
 * given. If `graph/search` and `graph/related` ever do diverge, this returns
 * `"resolution"` rather than a false `"unlinked"` only because of the
 * completeness rule below — worth re-measuring if verdicts collapse to
 * `"resolution"` en masse.
 */
/**
 * Order the entity's filtered metrics by how much of the QUERY each name
 * accounts for, most first, ties keeping the backend's order.
 *
 * Display-only: it never decides a verdict and never changes the pin (see the
 * removed re-pin branch in the module header). It exists because the list is
 * sliced to ENTITY_MATCHES_SHOWN, and in the backend's own order that slice is
 * frequently the wrong three — measured, `q="expense"` on Pfizer returns
 * `Operating costs and expenses, Advertising Expense (Normalized), Change in
 * Accrued Expenses` first, dropping the `R&D Expenses (Normalized)` the caller
 * asked about. On this path the list is the entire payload, so the three shown
 * are the whole value of the call.
 */
function byQueryOverlap(query: string, nodes: readonly GraphNode[]): GraphNode[] {
  const q = matchTokens(query);
  const score = (n: GraphNode): number => {
    const name = matchTokens(n.name);
    let hits = 0;
    for (const t of q) {
      // PREFIX-aware, unlike `confidentMatch`'s exact token equality. Exact
      // scoring cannot separate the case this ordering exists for: "R&D
      // expense" scores 1 against BOTH `Advertising Expense (Normalized)` and
      // `R&D Expenses (Normalized)` — `expense` is not `expenses` — so the tie
      // falls back to backend order and buries the right answer. Loosening is
      // safe HERE and nowhere else in this file: this decides DISPLAY ORDER for
      // a list of suggestions, never a verdict and never the pin, so a wrong
      // guess costs a suboptimal ordering rather than a wrong priced call.
      for (const nt of name) {
        // Prefix matching needs a floor, or a stray single-letter token scores
        // as a hit: `Aggregate ... Underwriting Expense R` tokenises to
        // [..., "r"], and "rd".startsWith("r") ranked that junk ABOVE
        // `R&D Expenses (Normalized)` for `metric="R&D expense"`. Exact
        // equality stays unguarded so genuine short tokens ("rd", "eps") match.
        const prefixable = Math.min(nt.length, t.length) >= MIN_PREFIX_CHARS;
        if (nt === t || (prefixable && (nt.startsWith(t) || t.startsWith(nt)))) {
          hits += 1;
          break;
        }
      }
    }
    return hits;
  };
  // `sort` is stable in every runtime this targets, so equal scores keep the
  // backend's relative order rather than being reshuffled.
  return [...nodes].sort((a, b) => score(b) - score(a));
}

export function reconcilePair(input: {
  metricQuery: string;
  globalMetric: GraphNode | null;
  /** Hits from the caller's verbatim phrase — the list returned to the caller (fix 3). */
  verbatim: readonly GraphNode[];
  scoped: readonly GraphNode[];
  /**
   * The filtered list was exhausted — `graph/related` returned no
   * `next_cursor`. NOT derivable from `total`: measured on prod, `relation.
   * total` IGNORES the `q` filter (Lockheed reports 250/capped both with and
   * without `q=Backlog`), so a `total > items.length` test would fire on almost
   * every entity and degrade nearly every verdict.
   */
  complete: boolean;
}): PairReconciliation {
  const { metricQuery, globalMetric, complete } = input;
  // Both filters answer the same structural question, so the id check reads
  // their UNION: a `pair` verdict must not depend on which of the two happened
  // to return the pinned node.
  const seen = new Set<string>();
  const union: GraphNode[] = [];
  for (const n of [...input.verbatim, ...input.scoped]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    union.push(n);
  }
  // One `graph/related` page cannot repeat an id, so this needs no dedupe of
  // its own — the union above dedupes because it MERGES two pages.
  const metricList = [...input.verbatim];
  const entityMetricMatches = byQueryOverlap(metricQuery, union).slice(0, ENTITY_MATCHES_SHOWN);

  // Rank 0 is absent or unvetted. NOTHING about linkage is established here —
  // there is no pinned node to check, and the filter that ran was chosen to
  // surface near-misses rather than to confirm anything. Reporting `"unlinked"`
  // would claim "the entity's list holds nothing matching" while
  // `entityMetricMatches` frequently holds several (measured: Pfizer returns 20
  // entries for `q="expense"`). The near-misses still ride along — they are the
  // whole payload on this path.
  if (globalMetric === null || !confidentMatch(metricQuery, globalMetric)) {
    return { verified: "resolution", entityMetricMatches, metricList };
  }

  // Found: linkage is proven, and a truncated page cannot un-prove it.
  if (union.some((n) => n.id === globalMetric.id)) {
    return { verified: "pair", entityMetricMatches, metricList };
  }

  // Not found. That is only ABSENCE if the whole filtered list was seen. On a
  // truncated page the node may sit on page 2, and `"unlinked"` would drop the
  // pin and print "the graph holds no edge ... report the gap" on evidence we
  // do not have — the same absence-of-evidence error the `null`-vs-`[]` rule in
  // `pairProbe` exists to prevent, one level up.
  return { verified: complete ? "unlinked" : "resolution", entityMetricMatches, metricList };
}
