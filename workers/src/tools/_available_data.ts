/**
 * Pure selection + formatting helpers for `tako_available_data`.
 *
 * `tako_available_data` resolves a name to graph node(s) and, for each, reports
 * what data Tako has for it — as a natural-language "Tako has data on X"
 * summary. Everything network-free lives here so it can be unit-tested in
 * isolation; the tool module (`tako_available_data.ts`) only orchestrates the
 * fetches and calls these.
 *
 * Coverage is type-aware, because the graph models the two node kinds
 * differently:
 *   - an ENTITY node (Tesla) → its `metrics` group is the data Tako holds.
 *   - a METRIC node (Inflation Rate) has no `metrics`; its coverage is the
 *     `entities` group — the entities the metric is tracked across.
 * Drilling `relation=metrics` on a metric node returns empty, so reporting
 * "no metrics" there would be a false negative — hence the split.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it — it is a
 * helper, not a tool.
 */
import type { z } from "zod";

import type { graphNodeSchema, graphRelationSchema } from "./_graph.js";

type GraphNode = z.infer<typeof graphNodeSchema>;
type GraphRelation = z.infer<typeof graphRelationSchema>;

/**
 * How many gated candidates we INSPECT, versus how many we RENDER.
 *
 * These were one number (2) and conflated two different costs. Inspecting is
 * cheap — a `graph/related` probe with `limit=1` returns just the coverage
 * `total` (~3.4k chars server-side against ~66k for a full page) and never
 * enters the model's context at all. Rendering is what actually costs: a
 * drilled coverage list is ~8.3k chars of the response, and measured on prod
 * the SECOND match's list was 8,283 of a 19,046-char answer — 43% of the
 * payload spent on an entity the caller did not ask about.
 *
 * So: inspect 4, render 1. Depth 4 is not arbitrary — over 16 resolvable
 * queries the first plausible candidate WITH coverage sat at rank <2 in 14 of
 * them but at rank <4 in all 16. `q="Carnival"` is the case depth-2 misses:
 * ranks 0-2 are zero-coverage name variants and the real answer is at rank 3.
 */
export const SELECT_TOP_N = 4;
export const RENDER_FULL_N = 1;
/**
 * Coverage total at or below which a rank-0 candidate is treated as a SHELL —
 * a name variant, holding company or product stub rather than the subject the
 * caller meant — and loses to a better-covered plausible candidate.
 *
 * Exists because `gateCandidates` prefers a candidate whose OWN NAME matches
 * over an alias-only match (the defence against poisoned aliases, KE-804), and
 * a bare name match is not evidence of relevance. Measured on staging
 * (2026-07-31): `q="US inflation"` name-matches `US Savings Inflation
 * Securities` (1 metric) and rendered it as the answer with `found: true`,
 * burying `United States` (250 metrics) in a one-line receipt; `q="S&P 500
 * earnings"` did the same with `Earnings` (3 entities) over `S&P Global Inc.`
 * (250).
 *
 * 5 rather than a ratio because the failure is degeneracy, not proportion: the
 * losers carried 1 and 3. An absolute floor leaves legitimately-narrow nodes
 * alone, which a ratio would not — `q="Delta"` puts `Delta Air Lines, Inc.`
 * and `Delta Corp Limited` both at the 250 cap, and `q="Inflation Rate"`
 * resolves a 63-entity metric whose rivals are thinner. Both stay on the
 * backend's order, which is the measured-correct outcome for them.
 *
 * Retire this together with the gate once `graph/search` carries a real
 * relevance score (KE-805).
 */
export const SHELL_COVERAGE_MAX = 5;
// graph/related page size for the coverage drill (the endpoint's maximum).
// The tool paginates with the cursor, so this is a request-shaping knob, not
// a cap on what the agent sees.
export const PAGE_LIMIT = 100;
// Ceiling on the coverage name list across all fetched pages. Coverage names
// are the tool's primary payload — each is a term the agent reuses in a
// follow-up tako_search — so the drill paginates well past the old one-page
// window (which buried anything behind the backend's fixed, boilerplate-first
// order). Matched to the server's OWN counting cap (graph/related stops
// counting related items at 250 and reports `total_capped`) rather than set
// tighter, so this is a genuine ceiling, not a second, lower cap layered on
// top of the server's: a node at or under 250 gets its COMPLETE coverage list.
// Names are reordered headline-first across everything FETCHED before this
// slice is taken, so low-signal accounting names are what a genuine >250 cap
// still drops, and `total`/`truncated` still report when more exist
// server-side — a "250 of 400+" list is explained, not an unexplained second
// cap.
export const MAX_COVERAGE_NAMES = 250;
// Hard ceiling on coverage-drill round-trips per node, independent of the
// item-count target above. Normally ceil(250/100) = 3 pages suffice; the
// slack covers a server that pages smaller than PAGE_LIMIT without letting a
// pathological page size serialize dozens of sequential calls.
export const MAX_COVERAGE_PAGES = 4;
export const OTHER_MATCH_PREVIEW = 5;

// Metric names that read as internal/accounting plumbing rather than the
// headline figures a person expects first. The backend returns metrics in a
// fixed order that mixes these in early (e.g. "Account Code - Inventory
// Valuation (Normalized)"), so we deprioritize them in the name list only —
// they still count toward `total`. Kept deliberately narrow (two observed
// patterns) so a real metric is never hidden, only pushed down.
const LOW_SIGNAL_METRIC = /\(Normalized\)|^Account Code\b/i;

/** What a match's coverage list represents. */
export type CoverageKind = "metrics" | "entities";

/**
 * The graph relation to drill (and the coverage kind it yields) for a node,
 * decided by node type: entity → its metrics; metric → the entities that
 * track it. The relation key and the CoverageKind happen to share a name.
 */
export function coverageKindFor(nodeType: string): CoverageKind {
  return nodeType === "metric" ? "entities" : "metrics";
}

/**
 * One coverage entry: the exact name AND the graph node id behind it.
 *
 * The id is what makes a follow-up land: a `node_ids` pin is only precise with
 * `strict: true`, and (measured on prod, 2026-07-29) pinning the METRIC node
 * under strict returns exactly that metric's card, while the same pin without
 * strict returned the wrong card. `graph/related` has always sent these ids —
 * `selectCoverage` used to drop them with `items.map((i) => i.name)`, leaving
 * the tool able to name a metric but not to hand over the handle that fetches
 * it.
 */
export interface CoverageItem {
  name: string;
  node_id: string;
}

/** One coverage group (metrics of an entity, or entities of a metric). */
export interface CoverageGroup {
  kind: CoverageKind;
  /**
   * Preview entries (name + node id), capped; headline-first for metrics.
   * Canonical — `names` is the text-channel projection of this.
   */
  items: CoverageItem[];
  /**
   * The same names, in the same order — the projection the markdown text
   * channel renders. Kept as its own field (rather than derived at every call
   * site) because the two channels have different jobs: text lists names for
   * the model to read, `structuredContent` carries name+id pairs for it to
   * pin. Both are built once, from `items`, in `selectCoverage`.
   */
  names: string[];
  /** Server-reported total. A floor when `capped` is true. */
  total: number;
  /** More names exist than are shown (`total > names.length`, or `capped`). */
  truncated: boolean;
  /** Server hit its fetch cap — the true count is at least `total` ("N+"). */
  capped: boolean;
}

/** Coverage for one expanded node. */
export interface CoverageMatch {
  node_id: string;
  name: string;
  type: string;
  label?: string | null;
  /** True when the node resolved but its coverage lookup failed. */
  unavailable?: boolean;
  coverage: CoverageGroup;
}

export interface OtherMatch {
  name: string;
  type: string;
  /** Present for candidates we coverage-probed but did not render in full. */
  node_id?: string;
  /** Coverage count from the `limit=1` probe; a floor when `capped`. */
  coverage_total?: number;
  /**
   * The server stopped counting at its own cap, so `coverage_total` is a floor
   * ("250+") rather than an exact count. Carried from the probe because without
   * it the receipt line printed "+" on EVERY non-zero total, which reads as
   * "at least 63 entities" for a node the server counted exactly.
   */
  coverage_capped?: boolean;
}

const emptyGroup = (kind: CoverageKind): CoverageGroup => ({
  kind, items: [], names: [], total: 0, truncated: false, capped: false,
});

/**
 * Flatten a value destined for a single-line slot in the rendered markdown.
 *
 * Both the caller's `q`/`metric` and the backend's node names are echoed into
 * the summary, and an embedded newline starts a fresh line the CONTENT
 * controls. Measured: `q="Nvidia\nentity  FAKE  \`ent::evil::1\`"` rendered a
 * line indistinguishable from the tool's own resolved-entity line, and
 * `metric="margin\n## Tako Data (99 cards)"` forged a section header. Shared
 * with the markdown renderer, which flattens node names and ids into their own
 * single-line slots for the same reason.
 */
export const oneLine = (v: string): string => v.replace(/\s*\n\s*/g, " ").trim();

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Stable partition: headline (clean) metric names first, low-signal
 * (accounting/normalized) names after, each keeping the backend's relative
 * order. Only reorders the preview slice — never drops a name.
 */
function partitionLowSignal<T>(xs: readonly T[], nameOf: (x: T) => string): T[] {
  const clean = xs.filter((x) => !LOW_SIGNAL_METRIC.test(nameOf(x)));
  const noisy = xs.filter((x) => LOW_SIGNAL_METRIC.test(nameOf(x)));
  return [...clean, ...noisy];
}

/** Headline-first ordering over name+id pairs. */
export function orderMetricItems(items: readonly CoverageItem[]): CoverageItem[] {
  return partitionLowSignal(items, (i) => i.name);
}

/**
 * Build the CoverageGroup from a drilled relation group. Metrics are reordered
 * headline-first; entities keep the backend's (popularity) order. Caps at
 * MAX_COVERAGE_NAMES and reports the server total + capped flag.
 */
export function selectCoverage(
  group: GraphRelation | null | undefined,
  kind: CoverageKind,
): CoverageGroup {
  if (!group) return emptyGroup(kind);
  // Carry the node id alongside every name — `graph/related` items are graph
  // nodes, so the id is already in hand and is the only thing that makes a
  // pinned follow-up precise (see CoverageItem).
  const raw: CoverageItem[] = group.items.map((i) => ({ name: i.name, node_id: i.id }));
  const ordered = kind === "metrics" ? orderMetricItems(raw) : raw;
  const total = group.total ?? ordered.length;
  const items = ordered.slice(0, MAX_COVERAGE_NAMES);
  const capped = group.total_capped ?? false;
  return {
    kind,
    items,
    names: items.map((i) => i.name),
    total,
    // Capped means the server stopped counting — more names always exist
    // beyond the floor, even if `total` happens to equal the shown count.
    truncated: capped || total > items.length,
    capped,
  };
}

/** Build a `CoverageMatch` from a resolved node + its drilled coverage group. */
export function buildMatch(node: GraphNode, group: GraphRelation | null | undefined): CoverageMatch {
  return {
    node_id: node.id,
    name: node.name,
    type: node.type,
    label: node.label ?? null,
    coverage: selectCoverage(group, coverageKindFor(node.type)),
  };
}

/**
 * Whether a match carries real, loaded coverage — resolved AND its drill
 * succeeded AND the coverage is non-empty. Drives both the summary header and
 * the tool's `found` flag, so "found" always means "Tako has data", never
 * merely "a node matched".
 */
export function hasLiveCoverage(m: CoverageMatch): boolean {
  return !m.unavailable && m.coverage.total > 0;
}

/**
 * A match carrying its RESOLUTION only, with no coverage drilled.
 *
 * Used when the relevance gate failed open: the summary is about to disclaim
 * these resolutions and the renderer suppresses their coverage lists, so
 * drilling them would pay a paginated fetch plus probes for output nobody
 * reads. Distinct from `unavailableMatch`, which claims the lookup FAILED —
 * here it was never attempted, and an empty coverage group is the honest
 * report. Keeps the two channels consistent: prose says nothing confidently
 * matched, and `structuredContent` shows total 0 rather than contradicting it.
 */
export function resolvedOnlyMatch(node: GraphNode): CoverageMatch {
  return {
    node_id: node.id,
    name: node.name,
    type: node.type,
    label: node.label ?? null,
    coverage: emptyGroup(coverageKindFor(node.type)),
  };
}

/** A match whose coverage lookup failed — resolved, but coverage unavailable. */
export function unavailableMatch(node: GraphNode): CoverageMatch {
  return {
    node_id: node.id,
    name: node.name,
    type: node.type,
    label: node.label ?? null,
    unavailable: true,
    coverage: emptyGroup(coverageKindFor(node.type)),
  };
}

// Counts only — the names themselves are rendered once, under each match in
// the markdown text channel, so listing them here again would double their
// token cost. Capped totals render as "N+" (the total is a floor).
function countStr(g: CoverageGroup): string {
  return `${g.total}${g.capped ? "+" : ""}`;
}

function labelSuffix(m: CoverageMatch): string {
  return m.label ? ` (${m.label})` : "";
}

function coverageClause(g: CoverageGroup): string {
  if (g.kind === "entities") {
    return `tracked for ${countStr(g)} ${plural(g.total, "entity", "entities")}`;
  }
  return `${countStr(g)} ${plural(g.total, "metric", "metrics")}`;
}

// A zero-coverage line is now unambiguous: the drill covers the whole
// coverage, so "none" is a genuine gap the agent can act on and report.
function emptyClause(kind: CoverageKind): string {
  return kind === "entities"
    ? "resolved, but Tako isn't tracking it against any entities yet"
    : "resolved, but Tako holds no metrics for it yet";
}

function matchLine(m: CoverageMatch): string {
  const head = `**${oneLine(m.name)}${labelSuffix(m)}**`;
  if (m.unavailable) {
    return `${head} — resolved, but Tako couldn't load its coverage right now (temporary); retry.`;
  }
  if (m.coverage.total === 0) {
    return `${head} — ${emptyClause(m.coverage.kind)}.`;
  }
  return `${head} — ${coverageClause(m.coverage)}.`;
}

/**
 * A directly runnable follow-up fetch, ready to copy.
 *
 * `strict` is not decoration. Measured on staging (2026-07-29): pinning
 * `node_ids` at the default `strict: false` did not steer retrieval at all — a
 * deliberately WRONG node changed nothing, and pinning a metric node without
 * strict returned a DIFFERENT metric's card. The same metric node WITH
 * `strict: true` returned exactly that metric's card. A handle without strict
 * is the variant that does nothing.
 *
 * `node_ids` carries the METRIC node alone. `strict` is an OR over the pinned
 * nodes, so adding the entity id re-admits every other card for that entity
 * and undoes the filter — measured, it turned "no such card" into a
 * plausible-looking WRONG metric (`Unearned Premiums` for a question about
 * `Unearned Revenues`). The entity rides in the query TEXT instead.
 */
export interface NextCall {
  tool: "tako_search" | "tako_answer";
  query: string;
  node_ids: string[];
  strict: boolean;
}

// A coverage list at or under this size is treated as unambiguous enough for
// a ready-to-run handle: with 3 names the top one is a meaningful pick; with
// a broad entity's dozens, names[0] is just backend popularity order and a
// handle would invite an off-target PRICED search.
export const NEXT_CALL_MAX_NAMES = 3;

// The example query + node id the summary and next_call share: first match
// with real coverage, entity match → "Tesla, Inc. Revenue", metric match →
// "United States Inflation Rate".
function exampleSearch(matches: CoverageMatch[]): NextCall | null {
  const m = matches.find((x) => !x.unavailable && x.coverage.items.length > 0);
  if (!m) return null;
  const first = m.coverage.items[0] as CoverageItem;
  // Which node is the METRIC depends on what resolved. An entity match's
  // coverage lists metrics (so the metric is the coverage entry); a metric
  // match's coverage lists entities (so the metric is the match itself).
  // Pinning the metric — never the entity — is what makes `strict` precise.
  const entityMatch = m.coverage.kind === "metrics";
  if (entityMatch) {
    // Both halves come from the SAME match — the entity and one of its own
    // metrics — so the pairing is real.
    return {
      tool: "tako_search",
      query: `${m.name} ${first.name}`,
      node_ids: [first.node_id],
      strict: true,
    };
  }
  // METRIC match: the caller named the measure. Do NOT pair it with
  // coverage.items[0] — a metric's entity list is frequently generic rather
  // than a list of real trackers (`Passenger Cruise Days` lists NVIDIA, Apple,
  // Amazon and Microsoft), which produced "NVIDIA Corporation Passenger Cruise
  // Days" as something to run verbatim. Query the metric alone and let the pin
  // do the narrowing; the caller can add an entity themselves.
  return { tool: "tako_search", query: m.name, node_ids: [m.node_id], strict: true };
}

/**
 * Build the ready-to-run follow-up handle — but ONLY when the target is
 * unambiguous: the caller filtered the coverage (so names reflect intent),
 * or the coverage list is small (≤ NEXT_CALL_MAX_NAMES). Otherwise null:
 * "run this verbatim" against a broad entity's arbitrary top metric would
 * spend a priced search on a guess — the opposite of discovery-first. Also
 * null when no match has coverage (a handle for a name just reported as
 * data-less would steer the agent into a search that misses).
 */
export function buildNextCall(matches: CoverageMatch[]): NextCall | null {
  const m = matches.find((x) => !x.unavailable && x.coverage.names.length > 0);
  if (!m) return null;
  // A METRIC match means the caller NAMED the measure (`q="Inflation Rate"`).
  // We know exactly what to pin, so the handle is meaningful however many
  // entities track it — and pinning that metric node under `strict` returns
  // its card or nothing, so a wrong guess is impossible.
  //
  // An ENTITY match is different: the caller named a company and nothing else,
  // so items[0] is whatever sorted first among (often 250+) metrics. A "run
  // verbatim" handle for an arbitrary metric would spend a priced call on a
  // guess, so it stays gated to a coverage list small enough that the top
  // entry is the obvious pick. To get a handle for a named measure on an
  // entity, pass the `metric` argument — that is the path built for it.
  const namedTheMetric = m.coverage.kind === "entities";
  if (!namedTheMetric && m.coverage.names.length > NEXT_CALL_MAX_NAMES) return null;
  return exampleSearch(matches);
}

// ---------------------------------------------------------------------------
// The LOOKUP path: caller named the metric, so resolve the pair directly
// ---------------------------------------------------------------------------

/** One resolved graph node, reduced to what a follow-up call needs. */
export interface ResolvedRef {
  node_id: string;
  name: string;
  type: string;
}

/**
 * The resolved (entity, metric) pair plus the runners-up.
 *
 * Alternates are not padding. Measured over 44 scored cases, the top-1 metric
 * is right ~80% of the time while the top THREE contain the right one ~93-95%
 * of the time — and the wrong top-1 is wrong in a way a model spots instantly
 * (`metric="total revenue"` → `Total Odds`, with `Revenues` at rank 1). Naming
 * the runners-up converts that into a free self-correction; auto-picking the
 * top one would hand over a confidently wrong pair.
 */
export interface PairResolution {
  entity: ResolvedRef | null;
  metric: ResolvedRef | null;
  entity_alternates: ResolvedRef[];
  metric_alternates: ResolvedRef[];
}

export const ALTERNATES_SHOWN = 2;

export const toRef = (n: { id: string; name: string; type: string }): ResolvedRef => ({
  node_id: n.id,
  name: n.name,
  type: n.type,
});

/**
 * The runnable handle for a resolved pair: `tako_answer` with the METRIC node
 * pinned and `strict: true`, the entity named in the query text.
 *
 * `tako_answer` rather than `tako_search` because the lookup path answers a
 * specific question ("what is X's Y?") and answer returns the synthesised
 * value alongside its cited cards. Null when no metric resolved — a handle
 * pointing at a metric we could not find would spend a priced call on a guess.
 */
export function buildPairNextCall(
  metricQuery: string,
  pair: PairResolution,
  opts?: {
    /**
     * Emit the handle WITHOUT the pin. Set on an `unlinked` verdict — the
     * entity's own metric list holds nothing matching, so the pinned form is
     * the one we expect to return 0 cards. Measured (staging 2026-07-31, 20
     * handles × 3 repeats): 11 of 20 retrieved FEWER cards pinned than
     * unpinned, because `strict` is a hard filter over a graph holding
     * near-duplicate metric nodes where only one twin carries cards (KE-812).
     * On `unlinked` we skip straight to the form that works rather than
     * spending the caller's priced call on the one two signals say will miss.
     */
    unpinned?: boolean;
  },
): NextCall | null {
  // No entity → the summary is routing the caller elsewhere (a bare-domain
  // tako_search); a handle here would contradict it.
  if (pair.metric === null || pair.entity === null) return null;
  // The RESOLVED entity name, not the caller's `q`: it is the canonical form
  // the graph knows ("Carnival Corporation Ltd." for `q="Carnival"`), which is
  // what makes the query text line up with the pinned metric node.
  const subject = pair.entity.name;
  // `strict` without a pin steers nothing (measured), so the unpinned form
  // drops both together rather than leaving a flag that does no work.
  if (opts?.unpinned === true) {
    return { tool: "tako_answer", query: `${subject} ${metricQuery}`, node_ids: [], strict: false };
  }
  return {
    tool: "tako_answer",
    query: `${subject} ${metricQuery}`,
    node_ids: [pair.metric.node_id],
    strict: true,
  };
}

/**
 * The lookup path's prose: what was asked, what each half resolved to, and
 * what a zero-card follow-up means. Node ids are NOT repeated here — the
 * renderer prints them beside each name once.
 */
export function buildPairSummary(input: {
  entityQuery: string;
  metricQuery: string;
  pair: PairResolution;
  domainShaped: boolean;
  metricConfident?: boolean;
  /** What the pair-confirmation probe found; undefined when it never ran. */
  verified?: "pair" | "unlinked" | "resolution" | undefined;
  /** Names of the entity's own metrics that matched the filter (context on `unlinked`). */
  entityMetricMatches?: string[];
}): string {
  const {
    pair, domainShaped, metricConfident = true, verified, entityMetricMatches = [],
  } = input;
  const entityQuery = oneLine(input.entityQuery);
  const metricQuery = oneLine(input.metricQuery);
  if (pair.entity === null) {
    // A domain that resolves to nothing is a routing answer, not a dead end:
    // measured, `openai.com` and `kagi.com` have no graph node at all while
    // SimilarWeb still covers them, so the recovery is a direct search.
    return domainShaped
      ? `No graph node matches "${entityQuery}". Domains are often not graph nodes even when Tako has their traffic data — call tako_search directly with the bare domain (e.g. "${entityQuery} monthly visits") instead of looking it up here.`
      : `No graph node matches "${entityQuery}". Tako may still have relevant public/web data — try tako_search directly, or rephrase the name.`;
  }
  if (pair.metric === null) {
    // `oneLine` on the resolved name for the same reason as the queries above:
    // it is upstream content in a single-line slot, and a newline inside it
    // renders a line indistinguishable from this tool's own match lines.
    return `Resolved the entity but no metric matching "${metricQuery}". The metrics Tako actually holds for ${oneLine(pair.entity.name)} are listed below — pick one and re-run with it.`;
  }
  if (!metricConfident) {
    // Two signals agreeing is a firmer basis for stopping than one. When the
    // entity's OWN list was checked and came up empty, say so — that is the
    // difference between "we could not vet the name" and "this entity does not
    // have it", and only the second justifies reporting a gap.
    const checked =
      verified === "unlinked"
        ? ` ${oneLine(pair.entity.name)}'s own metric list was also checked for "${metricQuery}" and holds nothing matching.`
        : "";
    return `Resolved the entity, but NO metric confidently matches "${metricQuery}" — the closest names Tako holds are shown below and are probably NOT what you asked for.${checked} Pick one deliberately (pin its node_id with strict:true), or conclude Tako does not track this measure.`;
  }
  if (verified === "unlinked") {
    // The failure this whole probe exists to catch: the NAME fits perfectly and
    // the entity does not hold it. Measured on staging — Lockheed Martin /
    // backlog, Shopify / gross merchandise volume and UnitedHealth Group /
    // change in unearned revenues all resolve cleanly here and return 0 cards.
    const near =
      entityMetricMatches.length > 0
        ? ` The nearest metrics ${oneLine(pair.entity.name)} DOES have: ${entityMetricMatches.map(oneLine).join(", ")}.`
        : "";
    return `Resolved "${entityQuery}" + "${metricQuery}", but ${oneLine(pair.metric.name)} is NOT on ${oneLine(pair.entity.name)}'s own metric list — the name fits, the graph holds no edge, so a pinned call will probably return 0 cards.${near} The next_call below therefore drops the pin. If it is also empty, Tako has no card for this pair: report the gap rather than rephrasing further.`;
  }
  if (verified === "pair") {
    return `Resolved "${entityQuery}" + "${metricQuery}", and ${oneLine(pair.metric.name)} IS on ${oneLine(pair.entity.name)}'s own metric list — the strongest free confirmation available, though it still does not guarantee a chart exists. Run the next_call below verbatim. If it returns 0 cards, run the SAME query once more with \`node_ids\` removed — the pin is a hard filter and Tako sometimes holds the data under a sibling metric node.`;
  }
  // The zero-card advice used to read "Tako has no card for this pair — that is
  // the definitive answer, do not rephrase and retry". Measured on staging
  // 2026-07-31 with matched arms — same tool, same query text, 20 handles, 3
  // repeats each, the only variable being whether the resolved node is pinned —
  // that is false: 11 of 20 retrieve FEWER cards pinned than unpinned, because
  // `strict` is a hard filter and the graph holds near-duplicate metric nodes
  // where only one twin carries cards (KE-812). Dropping the pin recovers the
  // REAL metric, verified by card title, not a lookalike:
  //
  //   "Carnival Corporation passenger cruise days"  pinned [0,0,0]  unpinned [3,3,3]
  //     -> Passenger Cruise Days 2 (Annual), Passenger cruise days (PCD) (Quarterly)
  //   "Apple Inc. P/E ratio"       pinned [0,0,0]  unpinned [3,3,3]  -> P/E Annual, 32.55x
  //   "United States CPI"          pinned [0,0,0]  unpinned [3,3,3]  -> 98.7% of GDP
  //
  // So the retry worth prescribing is not "the same call again" but "the same
  // query WITHOUT the pin". It stays bounded — one specific retry, still no
  // rephrase-and-vary loop, which is the thrash the old wording existed to stop
  // (after a zero-card answer agents called tako_contents 56 times).
  //
  // The run itself was driven by hand against staging and is NOT checked in, so
  // the per-handle table above is the record — treat it as the citation, not as a
  // pointer to a script. Root cause (the near-duplicate metric nodes) is KE-812.
  return `Resolved "${entityQuery}" + "${metricQuery}". Run the next_call below verbatim. If it returns 0 cards, run the SAME query once more with \`node_ids\` removed — the pin is a hard filter and Tako sometimes holds the data under a sibling metric node. If that is also empty, Tako has no card for this pair: report the gap rather than rephrasing further.`;
}

/** A `q` that looks like a hostname (has a dot, no spaces). */
export const isDomainShaped = (q: string): boolean => /^[^\s]+\.[a-z]{2,}$/i.test(q.trim());

/**
 * The natural-language coverage summary — the narrative shell of
 * `tako_available_data`'s output: header, per-match counts, gap/unavailable
 * phrasing, and the next-step instruction. The coverage names themselves are
 * NOT repeated here — the markdown renderer lists them once, under each
 * match. Node ids never appear in this prose; they ride in
 * `structuredContent.matches[].coverage.items[]`.
 */
export function buildSummary(input: {
  query: string;
  matches: CoverageMatch[];
  otherMatches: OtherMatch[];
  /** False when the relevance gate found nothing plausible and failed open. */
  confident?: boolean;
}): string {
  const { matches, otherMatches, confident = true } = input;
  const query = oneLine(input.query);

  if (matches.length === 0) {
    return `Tako has no data-graph node matching "${query}". Tako may still have relevant public/web data — try tako_search directly, or rephrase the entity or metric name.`;
  }

  const n = matches.length;
  // The header only claims coverage for matches that actually have some — a
  // resolved node with no coverage (or a failed drill) must not be advertised
  // as data, per the tool's contract ("a match with no coverage is a real
  // answer — report the gap"). "Tako's proprietary data" is the grammatical
  // subject on purpose: downstream models echo this header nearly verbatim to
  // the user, and this framing keeps them from attributing the answer to a
  // generic "dataset".
  // Fail-open means NOTHING plausibly matched and we drilled the top hits
  // anyway. Saying "Tako has live coverage of X" there is how
  // `q="the vibes of tuesday"` came to report 250+ metrics on Tuesday Morning
  // Corporation. Name what actually resolved and let the caller judge.
  if (!confident) {
    const names = matches.map((m) => `**${oneLine(m.name)}${labelSuffix(m)}**`).join(", ");
    return `No graph node confidently matches "${query}". The closest resolutions are ${names} — almost certainly NOT what you asked for. Rephrase with the exact entity or metric name, or use tako_search directly.`;
  }
  const withData = matches.filter(hasLiveCoverage).length;
  const matchesOf = `${n} ${plural(n, "match", "matches")} for "${query}"`;
  const covers = "Tako's proprietary data has live, continuously-updated coverage of";
  let header: string;
  if (withData === 0) {
    header = `Resolved ${matchesOf}, but none with live data coverage:`;
  } else if (withData < n) {
    header = `${covers} ${withData} of ${matchesOf}:`;
  } else {
    header = `${covers} ${matchesOf}:`;
  }
  const lines = matches.map((m) => matchLine(m));

  const blocks: string[] = [header, "", lines.join("\n\n")];

  // Candidates we probed get a one-line receipt carrying their node id and
  // coverage count — enough to switch to one without re-running this tool, and
  // ~110 chars instead of the ~8.3k a second full coverage list costs.
  const probed = otherMatches.filter((o) => o.node_id !== undefined);
  if (probed.length > 0) {
    const lines = probed.map((o) => {
      const count = o.coverage_total ?? 0;
      // The noun follows the node's OWN coverage direction — a metric node's
      // coverage is the ENTITIES tracking it, not metrics. Hardcoding "metrics"
      // mislabelled every metric-node receipt (`Inflation Rate — 63+ metrics`),
      // which reads as a nonsense claim about the graph's shape.
      const kind = coverageKindFor(o.type);
      const noun =
        kind === "metrics" ? plural(count, "metric", "metrics") : plural(count, "entity", "entities");
      // "+" means "the server stopped counting, this is a floor" — the same
      // meaning it carries in `countStr` for a rendered match. It used to print
      // on every non-zero total, which claimed a floor for counts the server
      // reported exactly (`Inflation Rate — 63+ entities` for exactly 63).
      const floor = o.coverage_capped === true ? "+" : "";
      return `- ${oneLine(o.name)} — ${count}${floor} ${noun} (\`${oneLine(o.node_id as string)}\`)`;
    });
    blocks.push(
      "",
      `Also resolved (not listed in full — re-run with the one you want, or pin its node_id):\n${lines.join("\n")}`,
    );
  }
  const unprobed = otherMatches.filter((o) => o.node_id === undefined);
  if (unprobed.length > 0) {
    // Flattened: every other slot that echoes an upstream name does the same,
    // and this one is a bare comma-joined list where a newline is free to start
    // a line that mimics the match lines above it.
    const names = unprobed.slice(0, OTHER_MATCH_PREVIEW).map((o) => oneLine(o.name));
    const rest = unprobed.length - names.length;
    const tail = rest > 0 ? `, and ${rest} more` : "";
    blocks.push("", `Also matched: ${names.join(", ")}${tail}.`);
  }

  // Mirror the tool's next_call gate: advertise the ready-made handle only
  // when one is actually emitted; otherwise steer to composing a precise
  // entity + metric query (still showing a concrete example).
  const handle = buildNextCall(matches);
  const example = exampleSearch(matches);
  if (handle) {
    blocks.push(
      "",
      `The exact names are listed under each match above, and their node ids ride in structuredContent.matches[].coverage.items[]. To pull one as a chart or dataset, run the ready-made \`next_call\` verbatim — tako_search with query "${handle.query}", the METRIC node pinned and strict:true — or compose your own entity + metric query the same way.`,
    );
  } else if (example) {
    blocks.push(
      "",
      `The exact names are listed under each match above. Pick the one you actually need and pull it with tako_search or tako_answer as entity + metric (e.g. "${example.query}"). To land on exactly that metric, pin ITS node id ALONE from structuredContent.matches[].coverage.items[] with strict:true — adding the entity's node id widens the filter back out.`,
    );
  }

  return blocks.join("\n");
}
