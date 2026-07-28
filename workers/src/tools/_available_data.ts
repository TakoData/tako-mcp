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

// How many search hits we expand with a coverage drill. Two keeps
// disambiguation ("Tesla, Inc." vs another "Tesla") visible while staying to a
// single parallel batch of related calls.
export const EXPAND_TOP_N = 2;
// graph/related page size for the coverage drill (the endpoint's maximum).
// The tool paginates with the cursor, so this is a request-shaping knob, not
// a cap on what the agent sees.
export const PAGE_LIMIT = 100;
// Ceiling on the coverage name list across all fetched pages. Coverage names
// are the tool's primary payload — each is a term the agent reuses in a
// follow-up tako_search — so the drill paginates well past the old one-page
// window (which buried anything behind the backend's fixed, boilerplate-first
// order), but caps the token cost for the very largest nodes (a metric
// tracked across thousands of entities). Names are reordered headline-first
// across everything FETCHED before this slice is taken, so low-signal
// accounting names are what the cap drops. `total`/`truncated` still report
// when more exist server-side.
export const MAX_COVERAGE_NAMES = 150;
// Hard ceiling on coverage-drill round-trips per node, independent of the
// item-count target above. Normally ceil(150/100) = 2 pages suffice; the
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

/** One coverage group (metrics of an entity, or entities of a metric). */
export interface CoverageGroup {
  kind: CoverageKind;
  /** Preview names, capped; headline-first for metrics. */
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
}

const emptyGroup = (kind: CoverageKind): CoverageGroup => ({
  kind, names: [], total: 0, truncated: false, capped: false,
});

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Stable partition: headline (clean) metric names first, low-signal
 * (accounting/normalized) names after, each keeping the backend's relative
 * order. Only reorders the preview slice — never drops a name.
 */
export function orderMetricNames(names: string[]): string[] {
  const clean = names.filter((n) => !LOW_SIGNAL_METRIC.test(n));
  const noisy = names.filter((n) => LOW_SIGNAL_METRIC.test(n));
  return [...clean, ...noisy];
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
  const raw = group.items.map((i) => i.name);
  const ordered = kind === "metrics" ? orderMetricNames(raw) : raw;
  const total = group.total ?? ordered.length;
  const names = ordered.slice(0, MAX_COVERAGE_NAMES);
  const capped = group.total_capped ?? false;
  return {
    kind,
    names,
    total,
    // Capped means the server stopped counting — more names always exist
    // beyond the floor, even if `total` happens to equal the shown count.
    truncated: capped || total > names.length,
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

// Counts only — the names themselves live once, in `matches[].coverage.names`
// (the whole output object is serialized into the model-visible text block, so
// listing names here again would double their token cost). Capped totals
// render as "N+" (the total is a floor).
function countStr(g: CoverageGroup): string {
  return `${g.total}${g.capped ? "+" : ""}`;
}

function labelSuffix(m: CoverageMatch): string {
  return m.label ? ` (${m.label})` : "";
}

function coverageClause(g: CoverageGroup, filter?: string): string {
  const matching = filter !== undefined ? ` matching "${filter}"` : "";
  if (g.kind === "entities") {
    return `tracked for ${countStr(g)} ${plural(g.total, "entity", "entities")}${matching}`;
  }
  return `${countStr(g)} ${plural(g.total, "metric", "metrics")}${matching}`;
}

// A zero-coverage line means two different things with and without a
// coverage_filter: unfiltered it is a genuine gap; filtered it only means the
// FILTER matched nothing — the entity may still hold hundreds of metrics, so
// the phrasing must steer the agent to drop the filter, not to conclude "no
// data" and walk away.
function emptyClause(kind: CoverageKind, filter?: string): string {
  if (filter !== undefined) {
    const what = kind === "entities" ? "tracked entities" : "metrics";
    return `resolved, but no ${what} match coverage_filter "${filter}" — the coverage itself may be non-empty; re-call without coverage_filter (or with a different word from the metric's name) to see it`;
  }
  return kind === "entities"
    ? "resolved, but Tako isn't tracking it against any entities yet"
    : "resolved, but Tako holds no metrics for it yet";
}

function matchLine(m: CoverageMatch, filter?: string): string {
  const head = `**${m.name}${labelSuffix(m)}**`;
  if (m.unavailable) {
    return `${head} — resolved, but Tako couldn't load its coverage right now (temporary); retry.`;
  }
  if (m.coverage.total === 0) {
    return `${head} — ${emptyClause(m.coverage.kind, filter)}.`;
  }
  return `${head} — ${coverageClause(m.coverage, filter)}.`;
}

/** A directly runnable follow-up fetch: tako_search args, ready to copy. */
export interface NextCall {
  tool: "tako_search";
  query: string;
  node_ids: string[];
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
  const m = matches.find((x) => !x.unavailable && x.coverage.names.length > 0);
  if (!m) return null;
  const first = m.coverage.names[0] as string;
  const query = m.coverage.kind === "entities" ? `${first} ${m.name}` : `${m.name} ${first}`;
  return { tool: "tako_search", query, node_ids: [m.node_id] };
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
  filtered: boolean,
): NextCall | null {
  const m = matches.find((x) => !x.unavailable && x.coverage.names.length > 0);
  if (!m) return null;
  if (!filtered && m.coverage.names.length > NEXT_CALL_MAX_NAMES) return null;
  return exampleSearch(matches);
}

/**
 * The natural-language coverage summary — the narrative shell of
 * `tako_available_data`'s output: header, per-match counts, gap/unavailable
 * phrasing, and the next-step instruction. The coverage names themselves are
 * NOT repeated here — they live once, in `matches[].coverage.names`, which
 * rides in the same serialized text block. Node ids never appear here.
 */
export function buildSummary(input: {
  query: string;
  matches: CoverageMatch[];
  otherMatches: OtherMatch[];
  /** The caller's coverage_filter, when one was applied to the drills. */
  coverageFilter?: string | undefined;
}): string {
  const { query, matches, otherMatches, coverageFilter } = input;

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
  const withData = matches.filter(hasLiveCoverage).length;
  const matchesOf = `${n} ${plural(n, "match", "matches")} for "${query}"`;
  const covers = "Tako's proprietary data has live, continuously-updated coverage of";
  let header: string;
  if (withData === 0) {
    // Under a coverage_filter, "none" only means the filter matched nothing —
    // don't let the header claim a total coverage gap the tool didn't check.
    // But only claim a pure filter-miss when every drill actually LOADED: if
    // any match is unavailable (transient failure), the filter verdict is
    // unproven — fall back to the generic header and let the per-match lines
    // explain which drill failed.
    const anyUnavailable = matches.some((m) => m.unavailable === true);
    header = coverageFilter !== undefined && !anyUnavailable
      ? `Resolved ${matchesOf}, but no coverage matching coverage_filter "${coverageFilter}":`
      : `Resolved ${matchesOf}, but none with live data coverage:`;
  } else if (withData < n) {
    header = `${covers} ${withData} of ${matchesOf}:`;
  } else {
    header = `${covers} ${matchesOf}:`;
  }
  const lines = matches.map((m) => matchLine(m, coverageFilter));

  const blocks: string[] = [header, "", lines.join("\n\n")];

  if (otherMatches.length > 0) {
    const names = otherMatches.slice(0, OTHER_MATCH_PREVIEW).map((o) => o.name);
    const rest = otherMatches.length - names.length;
    const tail = rest > 0 ? `, and ${rest} more` : "";
    blocks.push("", `Also matched: ${names.join(", ")}${tail}.`);
  }

  // Mirror the tool's next_call gate: advertise the ready-made handle only
  // when one is actually emitted; otherwise steer to composing a precise
  // entity + metric query (still showing a concrete example).
  const handle = buildNextCall(matches, coverageFilter !== undefined);
  const example = exampleSearch(matches);
  if (handle) {
    blocks.push(
      "",
      `The exact names are listed in each match's coverage.names. To pull one as a chart or dataset, run the ready-made \`next_call\` (tako_search with query "${handle.query}" + its node_ids pinned), or compose your own entity + metric query the same way.`,
    );
  } else if (example) {
    blocks.push(
      "",
      `The exact names are listed in each match's coverage.names. Pick the one you actually need and pull it with tako_search as entity + metric (e.g. "${example.query}"), pinning the match's node_id.`,
    );
  }

  return blocks.join("\n");
}
