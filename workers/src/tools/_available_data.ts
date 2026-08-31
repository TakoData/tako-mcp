/**
 * Pure selection + formatting helpers for `tako_available_data`.
 *
 * `tako_available_data` resolves a name to graph node(s) and, for each, reports
 * what data Tako has for it. Everything network-free lives here so it can be
 * unit-tested in isolation; the tool module (`tako_available_data.ts`) only
 * orchestrates the fetches and calls these. The markdown rendering lives in
 * `_render_markdown.ts`, not here.
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
import { sameTokens } from "./_match_gate.js";
import type { MatchCandidate } from "./_match_gate.js";

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
 *
 * The top of each kind is inspected too, even past this depth, so fix 1 can
 * compare their coverage.
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
// How many coverage entries reach the model — the SAME number in both
// channels (spec, text-channel template: nothing renders that structured does
// not carry). It used to be 250 in text and 25 in structuredContent, so the
// two channels disagreed about what Tako holds.
//
// 25, not more, because depth cannot fix the miss it looks like it fixes.
// Measured on prod 2026-08-31: 15 of 16 live coverage lists exceed 25 entries
// and 13 exceed 100, so the cap is the normal path, not an edge case — and the
// browse order puts Dividend Yield at #36-44, EBITDA Margin at #29-47, P/E
// Annual at #53-61 and Enterprise Value at #59-77 across NVIDIA, Apple, Tesla
// and Crocs. Raising the cap to 50 doubles the payload (3,798 → 7,043 chars
// for NVIDIA across both channels) and still misses P/E and EV. The answer to
// "does Tako hold X" is the `metric` filter, which is free and ~0.6s; this
// list is orientation. Names are reordered headline-first across everything
// FETCHED before the slice, so the accounting names are what a cut drops.
export const COVERAGE_ITEMS_SHOWN = 25;
// Hard ceiling on coverage-drill round-trips per node. ONE page of PAGE_LIMIT
// (100) items is a deep enough pool to take a headline-first slice of
// COVERAGE_ITEMS_SHOWN from, and `total`/`total_capped` come off the page
// itself rather than from counting rows — so the three extra pages this used
// to fetch bought 225 names that no channel now renders.
export const MAX_COVERAGE_PAGES = 1;
/**
 * How many candidates `graph/search` returns, and so how many the tool lists.
 * The default is today's fixed request. The cap is OURS, not the endpoint's:
 * `openapi/sdk.yaml` documents `limit` as "default 20, max 50", so 20 is where
 * the endpoint STARTS, and a caller could ask for 50. 20 is chosen instead
 * because rank 20 is already past where a name match means anything, and
 * because `limit` reaches the metric probe too (see the `limit` description in
 * `tako_available_data.ts`) — a 50-wide window can promote a rank-40 exact
 * name into the pin.
 * Only SELECT_TOP_N (plus the top of each kind) are coverage-checked — a
 * `graph/related` probe per candidate at 20 would spend the ~180 req/min
 * budget on receipts nobody reads. The rest are listed with id, kind, and
 * aliases so the model can switch or explore them without another call: this
 * is the residual job of the deleted graph search tool.
 *
 * `limit` does NOT widen the probe fan-out — `SELECT_TOP_N` plus the two
 * kind-tops caps the discovery path at ~6 inspected nodes whatever `limit`
 * says. The LOOKUP path spends its own budget and is the one that grew:
 * PAIR_ENTITY_PROBES entities x up to 2 filters, plus one unfiltered verify
 * when the binding is about to move. That is bounded, but it was never
 * measured end to end against the figure above — do that before raising
 * either cap.
 */
export const MAX_CANDIDATES = 20;
export const DEFAULT_CANDIDATES = 10;
/** Aliases shown per candidate line — enough to recognize a ticker or abbreviation. */
export const ALIASES_SHOWN = 3;

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
   * The entries, capped at COVERAGE_ITEMS_SHOWN; headline-first for metrics.
   * ONE list, rendered identically by both channels — the `names` projection
   * that used to sit beside this is gone with the channel split it served.
   */
  items: CoverageItem[];
  /** Server-reported total. A floor when `capped` is true. */
  total: number;
  /** More names exist than are shown (`total > names.length`, or `capped`). */
  truncated: boolean;
  /** Server hit its fetch cap — the true count is at least `total` ("N+"). */
  capped: boolean;
}

/** What every resolved node carries, rendered or not: enough to pin it, explore it, or tell it from a same-named node. */
export interface CandidateRef {
  node_id: string;
  name: string;
  type: string;
  subtype: string | null;
  label: string | null;
  aliases: string[];
}

export function candidateRef(node: GraphNode): CandidateRef {
  return {
    node_id: node.id,
    name: node.name,
    type: node.type,
    subtype: node.subtype ?? null,
    label: node.label ?? null,
    aliases: (node.aliases ?? []).slice(0, ALIASES_SHOWN),
  };
}

/** Coverage for one expanded node. */
export interface CoverageMatch extends CandidateRef {
  /** True when the node resolved but its coverage lookup failed. */
  unavailable?: boolean;
  /** Present on a list built by filtering the entity's metrics by the caller's phrase (lookup path, fix 3). */
  filter?: string;
  coverage: CoverageGroup;
}

/** A candidate that was not rendered in full: a receipt line. */
export type OtherMatch = CandidateRef & {
  /** Coverage count from the `limit=1` probe; absent when the candidate was never inspected. A floor when `coverage_capped`. */
  coverage_total?: number;
  /**
   * The server stopped counting at its own cap, so `coverage_total` is a floor
   * ("250+") rather than an exact count. Carried from the probe because without
   * it the receipt line printed "+" on EVERY non-zero total, which reads as
   * "at least 63 entities" for a node the server counted exactly.
   */
  coverage_capped?: boolean;
};

const emptyGroup = (kind: CoverageKind): CoverageGroup => ({
  kind, items: [], total: 0, truncated: false, capped: false,
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
 * COVERAGE_ITEMS_SHOWN and reports the server total + capped flag.
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
  const items = ordered.slice(0, COVERAGE_ITEMS_SHOWN);
  const capped = group.total_capped ?? false;
  return {
    kind,
    items,
    total,
    // Capped means the server stopped counting — more names always exist
    // beyond the floor, even if `total` happens to equal the shown count.
    truncated: capped || total > items.length,
    capped,
  };
}

/** Build a `CoverageMatch` from a resolved node + its drilled coverage group. */
export function buildMatch(node: GraphNode, group: GraphRelation | null | undefined): CoverageMatch {
  return { ...candidateRef(node), coverage: selectCoverage(group, coverageKindFor(node.type)) };
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
 * May `candidate` be promoted over a rank 0 that has no coverage?
 *
 * Coverage promotion exists for same-named stubs: `Carnival, Inc.` (0) hides
 * `Carnival Corporation Ltd.` (250), `Duolingo` PRODUCT (0) hides
 * `Duolingo, Inc.` (10). It was never meant to swap subjects, and it did:
 * measured on prod (spec Appendix B, 2026-08-25) `q="Jerome Powell"` padded a
 * data-less exact match with 4k chars of `Jerome, ID` housing metrics, and
 * `LeBron James` got `James Outman`. Both passed the gate on one shared token.
 *
 * The rule: when the query is an EXACT token match for rank 0 (its name or an
 * alias), the query is fully accounted for, so only a node that is itself
 * same-named with rank 0 may take its place. When the query is not exact —
 * `US inflation` against `US Savings Inflation Securities` — every plausible
 * candidate stays eligible, which is the measured-correct `United States`
 * promotion. Same token sets the gate uses, no new constants.
 */
export function promotionEligible(
  query: string,
  rank0: MatchCandidate,
  candidate: MatchCandidate,
): boolean {
  const surfaces = (c: MatchCandidate): string[] =>
    [c.name, ...(c.aliases ?? [])].filter((s): s is string => typeof s === "string" && s !== "");
  const exact = surfaces(rank0).some((s) => sameTokens(query, s));
  if (!exact) return true;
  const rank0Surfaces = surfaces(rank0);
  return surfaces(candidate).some((c) => rank0Surfaces.some((r) => sameTokens(r, c)));
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
  return { ...candidateRef(node), coverage: emptyGroup(coverageKindFor(node.type)) };
}

/** A match whose coverage lookup failed — resolved, but coverage unavailable. */
export function unavailableMatch(node: GraphNode): CoverageMatch {
  return { ...candidateRef(node), unavailable: true, coverage: emptyGroup(coverageKindFor(node.type)) };
}

/** The first entity and the first metric in gate order — the two the tool must never silently choose between. */
export function topOfEachKind(
  kept: readonly GraphNode[],
): { entity: GraphNode | null; metric: GraphNode | null } {
  return {
    entity: kept.find((n) => n.type === "entity") ?? null,
    metric: kept.find((n) => n.type === "metric") ?? null,
  };
}

/**
 * A match rendered as a CANDIDATE: kind, coverage count, aliases, and no list.
 * `total` is real (from the limit=1 probe or the drill), so `hasLiveCoverage`
 * and `found` read it as data; `names` is empty, so the renderer prints no
 * list and `buildNextCall` emits no handle. Used when the tool declines to
 * pick between an entity and a metric (fix 1).
 */
export function candidateMatch(
  node: GraphNode,
  probe: { total: number; capped: boolean },
): CoverageMatch {
  const kind = coverageKindFor(node.type);
  return {
    ...candidateRef(node),
    coverage: {
      kind, items: [], total: probe.total,
      truncated: probe.total > 0, capped: probe.capped,
    },
  };
}

/**
 * The entity's own metrics that contain the caller's `metric` phrase, as a
 * coverage list with ids. `total` is the number of hits, not the entity's
 * metric count; `truncated`/`capped` say the filtered page was cut (a
 * `next_cursor` came back), so "not here" is not "absent".
 */
export function metricListMatch(
  node: GraphNode,
  list: readonly GraphNode[],
  complete: boolean,
  filter: string,
): CoverageMatch {
  const hits: CoverageItem[] = list.map((n) => ({ name: n.name, node_id: n.id }));
  const items = hits.slice(0, COVERAGE_ITEMS_SHOWN);
  return {
    ...candidateRef(node),
    filter,
    coverage: {
      kind: "metrics", items,
      total: hits.length,
      truncated: !complete || items.length < hits.length,
      capped: !complete,
    },
  };
}

// ---------------------------------------------------------------------------
// Guidance (spec D3: "guidance lives in the result, once")
//
// This replaces `summary`, a 383-1,469-char prose blob that did three jobs at
// once: it re-listed the fields in sentences, it taught static lessons, and it
// gave a verdict. Each job moved to where it belongs — the fields render
// themselves (`renderAvailableDataMarkdown`), the static lessons live in the
// tool description, and what is left is this: TWO SENTENCES per branch, the
// verdict plus the one next action. A branch that cannot survive at two
// sentences does not get one. The happy path gets none — nothing there is a
// verdict, and `summary` spent 1,282 chars on Nvidia saying what `matches`,
// `candidates` and `coverage` already said.
// ---------------------------------------------------------------------------

/**
 * The search tool THIS connection can actually call.
 *
 * `?tools=` is an allowlist that REPLACES the defaults (spec D1), so
 * `?tools=available_data,search_advanced` registers no `tako_search` — and
 * every handle and every guidance sentence that hardcoded the name shipped a
 * dead end there, resolving to the SDK's bare "tool not found".
 * `phantom_tool.test.ts` cannot catch it: it walks descriptions and schemas,
 * not values built at runtime.
 *
 * `undefined` means a non-HTTP caller (tests, scripts) with no surface to
 * resolve against; the defaults carry `tako_search`, so that is the answer.
 * `null` means this connection registered no search tool at all — callers must
 * then omit the handle rather than invent one.
 */
export function searchToolFor(
  registered: ReadonlySet<string> | undefined,
): "tako_search" | "tako_search_advanced" | null {
  if (registered === undefined) return "tako_search";
  if (registered.has("tako_search")) return "tako_search";
  if (registered.has("tako_search_advanced")) return "tako_search_advanced";
  return null;
}

/** "Search the web with `tako_search`" — or, with no search tool registered, no pointer at all. */
function webFallback(searchTool: string | null): string {
  return searchTool === null
    ? "Re-run with the exact entity or metric name."
    : `Search the web with \`${searchTool}\`, or re-run with the exact entity or metric name.`;
}

/** Nothing in the graph resolved the query at all. */
export function guidanceNoMatch(query: string, searchTool: string | null): string {
  return `Nothing in Tako's graph resolves "${oneLine(query)}". ${webFallback(searchTool)}`;
}

/**
 * Names resolved but the gate rejected them all. The candidates still ship —
 * a model may recognize one — so the verdict has to say what they are, or a
 * near-spelling reads as an answer.
 */
export function guidanceLowConfidence(query: string, searchTool: string | null): string {
  return `Nothing in the graph confidently matches "${oneLine(
    query,
  )}"; the candidates below are near-spellings, not answers. ${webFallback(searchTool)}`;
}

/** The query names an entity AND a metric. Only the caller knows which. */
export function guidanceTie(query: string, entityName: string, metricName: string): string {
  return `"${oneLine(query)}" names both an entity (${oneLine(entityName)}) and a metric (${oneLine(
    metricName,
  )}), and only you know which. Re-run with \`types\` set to the one you meant, or with \`metric\` set to get one measure on the entity.`;
}

/** The pair resolved but the graph holds no edge between the halves. */
export function guidanceUnlinked(
  entityName: string,
  metricName: string,
  searchTool: string | null,
): string {
  const action =
    searchTool === null
      ? "Report the pair as unconfirmed rather than rephrasing."
      : "Run `next_call` anyway to be sure, and say Tako has no card for the pair if it comes back empty.";
  return `${oneLine(metricName)} is not on ${oneLine(
    entityName,
  )}'s own metric list, so a card for this pair is unlikely. ${action}`;
}

/** The entity half did not resolve, so there is nothing to look a metric up on. */
export function guidanceEntityUnresolved(entityQuery: string, searchTool: string | null): string {
  return `"${oneLine(entityQuery)}" does not resolve to a graph node, so no pair could be looked up. ${
    searchTool === null
      ? "Re-run with the entity's exact name."
      : `Search the web with \`${searchTool}\`, or re-run with the entity's exact name.`
  }`;
}

/** The metric phrase resolved nowhere, so the entity's whole list is the answer. */
export function guidanceMetricUnresolved(entityName: string, metricQuery: string): string {
  return `No metric matches "${oneLine(metricQuery)}", so this is everything ${oneLine(
    entityName,
  )} tracks instead. Pick a canonical name from the list and search on it exactly.`;
}

/** Drilled, and the node genuinely holds nothing. */
export function guidanceNoCoverage(name: string, kind: CoverageKind, searchTool: string | null): string {
  const what = kind === "entities" ? "is not tracked against any entity yet" : "has no metrics yet";
  return `${oneLine(name)} resolved, but it ${what}. ${
    searchTool === null ? "Say Tako holds no data for it rather than rephrasing." : `Search the web with \`${searchTool}\` rather than rephrasing.`
  }`;
}

/** The coverage lookup failed. Transient, and the caller can retry. */
export function guidanceUnavailable(name: string): string {
  return `${oneLine(name)} resolved, but Tako couldn't load its coverage. Retry once; this is transient, not a gap in the data.`;
}

/** The arguments look swapped, so nothing was looked up. */
export function guidanceSwapped(q: string, metricQuery: string): string {
  return `The arguments look swapped: "${oneLine(q)}" resolves to a metric and "${oneLine(
    metricQuery,
  )}" to an entity, so nothing was looked up. Re-run the other way round: q="${oneLine(
    metricQuery,
  )}", metric="${oneLine(q)}".`;
}

/**
 * A directly runnable follow-up fetch, ready to copy.
 *
 * `strict` is not decoration. Measured on staging (2026-07-29): pinning
 * `node_ids` at the default `strict: false` did not change which card came back
 * — a deliberately WRONG node changed nothing, and pinning a metric node without
 * strict returned a DIFFERENT metric's card. The same metric node WITH
 * `strict: true` returned exactly that metric's card. A handle without strict is
 * the WEAKER variant, not an inert one: the backend applies the pin (a dedicated
 * MatchBucket plus a deliberately non-dominant score — see pinned_nodes.py), it
 * just does not outrank the organic winner.
 *
 * `node_ids` carries the METRIC node alone. `strict` is an OR over the pinned
 * nodes, so adding the entity id re-admits every other card for that entity
 * and undoes the filter — measured, it turned "no such card" into a
 * plausible-looking WRONG metric (`Unearned Premiums` for a question about
 * `Unearned Revenues`). The entity rides in the query TEXT instead.
 */
export interface NextCall {
  /**
   * The search tool THIS connection registers — see `searchToolFor`. Not a
   * constant: `?tools=available_data,search_advanced` registers no
   * `tako_search`, and the hardcoded name this used to carry made every
   * handle on such a connection resolve to "tool not found".
   */
  tool: "tako_search" | "tako_search_advanced";
  /**
   * The EXACT canonical name of each half. `tako_search` matches the graph's
   * own names, so the caller's phrasing is the thing that misses.
   *
   * No pin rides along. `tako_search` takes no `node_ids` / `strict` after the
   * D4 split, so a handle carrying them would be rejected by the very tool it
   * names — and the measurement says the name is the better arm anyway: a pin
   * returned FEWER cards than the same query unpinned on 11 of 20 pairs
   * (staging 2026-07-31), because the graph holds near-duplicate metric nodes
   * where only one twin carries cards.
   */
  query: string;
}

// A coverage list at or under this size is treated as unambiguous enough for
// a ready-to-run handle: with 3 entries the top one is a meaningful pick; with
// a broad entity's dozens, names[0] is just backend popularity order and a
// handle would invite an off-target PRICED search.
export const NEXT_CALL_MAX_NAMES = 3;

// The example query + node id the summary and next_call share: first match
// with real coverage, entity match → "Tesla, Inc. Revenue", metric match →
// "United States Inflation Rate".
function exampleSearch(matches: CoverageMatch[], tool: NextCall["tool"]): NextCall | null {
  const m = matches.find((x) => !x.unavailable && x.coverage.items.length > 0);
  if (!m) return null;
  const first = m.coverage.items[0] as CoverageItem;
  // An entity match's coverage lists metrics; a metric match's lists entities.
  // Both name sources are the graph's own canonical strings, which is what the
  // handle is for now that no pin rides along.
  const entityMatch = m.coverage.kind === "metrics";
  if (entityMatch) {
    // Both halves come from the SAME match — the entity and one of its own
    // metrics — so the pairing is real.
    return { tool, query: `${m.name} ${first.name}` };
  }
  // METRIC match: the caller named the measure. Do NOT pair it with
  // coverage.items[0] — a metric's entity list is frequently generic rather
  // than a list of real trackers (`Passenger Cruise Days` lists NVIDIA, Apple,
  // Amazon and Microsoft), which produced "NVIDIA Corporation Passenger Cruise
  // Days" as something to run verbatim. Query the metric alone; the caller can
  // add an entity themselves.
  return { tool, query: m.name };
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
export function buildNextCall(
  matches: CoverageMatch[],
  tool: NextCall["tool"] | null,
): NextCall | null {
  if (tool === null) return null;
  const m = matches.find((x) => !x.unavailable && x.coverage.items.length > 0);
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
  if (!namedTheMetric && m.coverage.items.length > NEXT_CALL_MAX_NAMES) return null;
  return exampleSearch(matches, tool);
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
 * The runnable handle for a resolved pair: the connection's search tool, with
 * both halves named by their canonical graph names. No pin — see the
 * measurement on `NextCall.query`.
 *
 * The tool NAME is resolved per connection (`searchToolFor`), not hardcoded.
 * `?tools=` is an allowlist that REPLACES the defaults (spec D1), so
 * `?tools=available_data` registers this tool with no follow-up target at all
 * and `?tools=available_data,search_advanced` registers a different one. A
 * connection with neither gets `null` — no handle beats a handle that names a
 * tool the caller cannot call.
 *
 * Null when no metric resolved: a handle pointing at a metric we could not
 * find would spend a priced call on a guess.
 */
export function buildPairNextCall(
  pair: PairResolution,
  tool: NextCall["tool"] | null,
): NextCall | null {
  if (tool === null) return null;
  // No entity → the summary is routing the caller elsewhere (a bare-domain
  // tako_search); a handle here would contradict it.
  if (pair.metric === null || pair.entity === null) return null;
  // BOTH halves are the graph's RESOLVED names, never the caller's `q` or
  // `metric` strings: "Carnival Corporation Ltd." for q="Carnival", "Gross
  // Margin (%)" for metric="gross margin".
  //
  // The metric half used to be the caller's phrase, because the pinned node
  // carried the precision. With tako_search taking no pin, the canonical name
  // is the ONLY steering signal left — and it is the arm the measurement
  // favors: the canonical name recovered cards on 9 of 15 pairs, while a pin
  // returned FEWER cards than the same query unpinned on 11 of 20 (staging
  // 2026-07-31, 20 handles × 3 repeats, KE-812) because the graph holds
  // near-duplicate metric nodes where only one twin carries cards.
  //
  // That measurement is also why there is no longer an `unpinned` variant for
  // the `unlinked` verdict: with no pin on any path, both arms collapsed into
  // this one.
  return { tool, query: `${pair.entity.name} ${pair.metric.name}` };
}

/** A `q` that looks like a hostname (has a dot, no spaces). */
export const isDomainShaped = (q: string): boolean => /^[^\s]+\.[a-z]{2,}$/i.test(q.trim());

// ---------------------------------------------------------------------------
// The model-facing projection (spec D3/D4: the advertised shape IS the
// projection, so an unknown key cannot leak and the schema can be typed field
// by field). Everything above this line is the tool's internal vocabulary.
// ---------------------------------------------------------------------------

/** A resolved node, reduced to a name to search on and a handle to explore. */
export interface ProjectedRef {
  id: string;
  name: string;
}

/** A node the tool resolved but did not drill: `coverage` only when probed. */
export interface ProjectedCandidate extends ProjectedRef {
  type: string;
  kind?: string;
  coverage?: ProjectedCoverage;
  // Index signature, like every projected shape in this tree: the advertised
  // element schemas are `looseObject`, so the inferred type carries one and a
  // plain interface is not assignable to it.
  [key: string]: unknown;
}

export interface ProjectedCoverage {
  total: number;
  total_capped: boolean;
  truncated?: boolean;
  /** `id`, not `node_id` — one name for one thing across all three tools. */
  items?: Array<{ name: string; id: string }>;
  [key: string]: unknown;
}

/** A node the tool drilled, with the list it holds. */
export interface ProjectedMatch extends ProjectedCandidate {
  aliases?: string[];
  unavailable?: boolean;
  filter?: string;
  coverage: ProjectedCoverage;
}

export interface AvailableDataOutput {
  found: boolean;
  verified?: "coverage" | "pair" | "unlinked" | "resolution";
  guidance?: string;
  matches: ProjectedMatch[];
  candidates: ProjectedCandidate[];
  next_call: NextCall | null;
  entity?: ProjectedRef | null;
  metric?: ProjectedRef | null;
  entity_candidates?: ProjectedRef[];
  metric_candidates?: ProjectedRef[];
  [key: string]: unknown;
}

export const projectRef = (r: ResolvedRef): ProjectedRef => ({ id: r.node_id, name: r.name });

/**
 * `subtype ?? label`, the same rule `_graph.ts` applies — one name for one
 * thing across both graph tools. Kept as its own copy rather than imported to
 * avoid a module cycle (`_graph` ← `tako_available_data` → `_available_data`);
 * `kind_definition_unit_test` pins the two against each other.
 */
function kindOf(c: { type: string; subtype: string | null; label: string | null }): string | undefined {
  if (c.subtype !== null && c.subtype !== "") return c.subtype;
  if (c.label === null || c.label === "") return undefined;
  // A label that only restates `type` is noise: every subtype-less metric
  // carries `label: "METRIC"`, which rendered as "metric · METRIC".
  return c.label.toLowerCase() === c.type.toLowerCase() ? undefined : c.label;
}

/**
 * A candidate: enough to recognize it, search it, and explore it.
 *
 * `aliases` are DROPPED here and kept only on `matches`. They used to render
 * in the text channel and not in the structured one, so the two channels
 * disagreed about the same node; a candidate a caller acts on is re-resolved
 * anyway, and on `q="Nvidia"` this is ~300 chars of a 1,250-char block.
 */
export function projectCandidate(c: OtherMatch): ProjectedCandidate {
  const out: ProjectedCandidate = { id: c.node_id, name: c.name, type: c.type };
  const kind = kindOf(c);
  if (kind !== undefined) out.kind = kind;
  if (c.coverage_total !== undefined) {
    out.coverage = { total: c.coverage_total, total_capped: c.coverage_capped ?? false };
  }
  return out;
}

/**
 * A drilled match. `coverage.kind` is NOT carried: it is
 * `type === "metric" ? "entities" : "metrics"` — `coverageKindFor` exactly —
 * so `type` already says it, and the word `kind` is spent on the node's own
 * class instead.
 */
export function projectMatch(m: CoverageMatch): ProjectedMatch {
  const out: ProjectedMatch = {
    id: m.node_id,
    name: m.name,
    type: m.type,
    coverage: { total: m.coverage.total, total_capped: m.coverage.capped },
  };
  const kind = kindOf(m);
  if (kind !== undefined) out.kind = kind;
  if (m.aliases.length > 0) out.aliases = m.aliases;
  if (m.unavailable === true) out.unavailable = true;
  if (m.filter !== undefined) out.filter = m.filter;
  if (m.coverage.items.length > 0) {
    out.coverage.items = m.coverage.items.map((i) => ({ name: i.name, id: i.node_id }));
  }
  if (m.coverage.truncated) out.coverage.truncated = true;
  return out;
}
