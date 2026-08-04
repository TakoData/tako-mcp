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
 * Linkage only ever rescues by finding a DIFFERENT node that passes.
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
 * How many substring filters to try. Each is a separate `graph/related` call;
 * they run in parallel so the wall-clock cost is one round trip either way, but
 * every variant is real load against a ~180 req/min budget.
 */
export const MAX_FILTER_VARIANTS = 2;

/**
 * Shortest useful substring filter. `q` is a raw substring match, so a one- or
 * two-character filter matches most of a metric list and answers nothing.
 */
const MIN_VARIANT_CHARS = 3;

/** Near-miss metrics shown to the caller when the verdict is `unlinked`. */
export const ENTITY_MATCHES_SHOWN = 3;

/**
 * The substring filters to send as `graph/related`'s `q`.
 *
 * `q` is a case-insensitive SUBSTRING filter on name+aliases — a stricter,
 * different test from the token containment used everywhere else in this tool.
 * `"R&D expense"` is not a substring of
 * `"Research & development expense (R&D) - Americas"`, so the caller's phrase
 * alone is not enough to find what the entity actually has.
 *
 * The variants differ by what we are trying to learn, which is why `confident`
 * is an input rather than something inferred here:
 *
 *   confirm (rank 0 passed the name test) — lead with the resolved node's OWN
 *   name, the one string guaranteed to substring-match the node we are
 *   confirming. The caller's phrase rides second to surface near-duplicate
 *   siblings (KE-812), which is exactly the context an `unlinked` verdict needs.
 *
 *   rescue (rank 0 failed) — the resolved name is the WRONG metric, so
 *   filtering by it would confirm the wrong thing. Lead with the caller's
 *   phrase, fall back to its longest token, which is what survives the
 *   substring filter on real metric names.
 */
export function filterVariants(input: {
  metricQuery: string;
  resolvedName?: string | null;
  confident: boolean;
}): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_VARIANT_CHARS) return;
    if (out.length >= MAX_FILTER_VARIANTS) return;
    // Case-insensitive: `q` is case-insensitive server-side, so two variants
    // differing only in case would spend a second round trip on the same query.
    if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
    out.push(trimmed);
  };

  if (input.confident) {
    push(input.resolvedName);
    push(input.metricQuery);
    return out;
  }

  push(input.metricQuery);
  // Longest token first: the distinctive half of a phrase is almost always the
  // longer word ("expense" over "R&D", "merchandise" over "gross"). Noise
  // tokens are already stripped by `matchTokens`.
  const longest = [...matchTokens(input.metricQuery)].sort((a, b) => b.length - a.length)[0];
  push(longest);
  return out;
}

export interface PairReconciliation {
  /** The metric to pin — rank 0, a re-pinned scoped node, or null. */
  metric: GraphNode | null;
  /** `"pair"` or `"unlinked"`; the caller substitutes `"resolution"` if the probe never ran. */
  verified: Exclude<PairVerdict, "resolution">;
  /** True when the pinned node came from the entity's list rather than the global search. */
  repinned: boolean;
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
  // whether the entity holds it. A node that FAILS the name test is never
  // confirmed here, however solid its edge (see the module header).
  if (globalMetric !== null && confidentMatch(metricQuery, globalMetric)) {
    const linked = scoped.some((n) => sameNode(n, globalMetric));
    return {
      metric: globalMetric,
      verified: linked ? "pair" : "unlinked",
      repinned: false,
      entityMetricMatches,
    };
  }

  // Rank 0 is absent or unvetted. A node on the entity's OWN list that passes
  // the name test is better evidence than either signal alone, so it takes the
  // pin — this is the case the global search gets wrong by ranking a generic
  // metric above the entity's specific one.
  const rescued = scoped.find((n) => confidentMatch(metricQuery, n));
  if (rescued !== undefined) {
    return { metric: rescued, verified: "pair", repinned: true, entityMetricMatches };
  }

  // Nothing vetted anywhere. Keep whatever rank 0 was (the caller still shows
  // it as an unvetted candidate with its alternates) and report that the
  // entity's list was checked and came up empty.
  return {
    metric: globalMetric,
    verified: "unlinked",
    repinned: false,
    entityMetricMatches,
  };
}
