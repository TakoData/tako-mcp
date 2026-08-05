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
 * Page size for the probe. The filter is doing the narrowing, so this only
 * needs to be wide enough that a metric matching the filter is not paged out
 * of view — it is not a coverage list and is never rendered.
 */
export const PAIR_PROBE_LIMIT = 20;

/**
 * Shortest useful substring filter. `q` is a raw substring match, so a one- or
 * two-character filter matches most of a metric list and answers nothing.
 */
const MIN_FILTER_CHARS = 3;

/** Near-miss metrics shown to the caller when the verdict is `unlinked`. */
export const ENTITY_MATCHES_SHOWN = 3;

/**
 * THE substring filter to send as `graph/related`'s `q` — exactly one, so the
 * probe is one round trip.
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
 * A SECOND variant was implemented and measured (24 pairs, prod, 2026-08-04):
 * it changed the verdict on 0 of them, adding only extra near-miss entries, at
 * the cost of a second `graph/related` on every probed call. Removed.
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

export interface PairReconciliation {
  /** `"pair"` or `"unlinked"`; the caller substitutes `"resolution"` if the probe never ran. */
  verified: Exclude<PairVerdict, "resolution">;
  /** The entity's own metrics that matched the filter — context for an `unlinked` verdict. */
  entityMetricMatches: GraphNode[];
}

/**
 * Is this scoped node the same metric the global search resolved?
 *
 * Id equality is the intended test — `graph/search` and `graph/related` return
 * nodes from the same graph. Name equality is a deliberate backstop: if those
 * id spaces ever diverge, an id-only test would report `unlinked` for EVERY
 * pair, which is a systematic false negative that would quietly unpin every
 * handle the tool emits. Two cheap tests beat one silent failure mode.
 */
const sameNode = (a: GraphNode, b: GraphNode): boolean =>
  a.id === b.id || a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

/**
 * Decide the pair verdict from the global metric candidate and the entity's own
 * (filtered) metric list. See the module header for why both the lexical and
 * the structural test must pass before this returns `"pair"`.
 */
export function reconcilePair(input: {
  metricQuery: string;
  globalMetric: GraphNode | null;
  scoped: readonly GraphNode[];
}): PairReconciliation {
  const { metricQuery, globalMetric } = input;
  const scoped = [...input.scoped];
  const entityMetricMatches = scoped.slice(0, ENTITY_MATCHES_SHOWN);

  // Rank 0 already answers the question lexically — the only open question is
  // whether the entity holds it. NOTE this NEVER changes which node is pinned;
  // see the module header for the measurement that removed that branch.
  if (globalMetric !== null && confidentMatch(metricQuery, globalMetric)) {
    const linked = scoped.some((n) => sameNode(n, globalMetric));
    return { verified: linked ? "pair" : "unlinked", entityMetricMatches };
  }

  // Rank 0 is absent or unvetted, and the entity's list holds nothing that
  // vouches for it either. The caller still sees rank 0 as an unvetted
  // candidate with its alternates; what this adds is that the entity's OWN
  // list was checked too, which is firmer ground for reporting a gap.
  return { verified: "unlinked", entityMetricMatches };
}
