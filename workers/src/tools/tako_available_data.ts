/**
 * `tako_available_data` — the one-shot "what data does Tako have on X?" tool.
 *
 * Runs graph/search → graph/related as a single free, low-latency pipeline and
 * returns a natural-language coverage summary. It is the entry point that
 * RESOLVES a name to a node; `tako_graph_related` is the one primitive left,
 * for drilling into a node this tool already resolved.
 *
 * Pipeline (discovery): one graph/search, then SELECT_TOP_N candidates are
 * inspected with cheap `limit=1` coverage probes while the top one's FULL
 * paginated drill runs in parallel; only RENDER_FULL_N of them is rendered in
 * full — unless the query names both an entity and a metric, when both come
 * back as candidates and neither is rendered (fix 1). The lookup path probes
 * the top two gated entities and binds the pair to the one with data; the
 * caller's `metric` phrase is also sent as the API's substring filter and the
 * hits come back as a list. The drill is type-aware: an entity node → its
 * `metrics` (the data Tako holds); a metric node → the `entities` it is tracked
 * across (its coverage). Drilling `relation=metrics` on a metric node returns
 * empty, so the split avoids a false "no data" answer. No LLM call — the prose
 * is built deterministically in `_available_data.ts`. Per-node failures are
 * isolated so one bad node never sinks the whole answer. Validated against the
 * loose `_graph.ts` facades (not the strict generated schema, whose enums drift).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  ALTERNATES_SHOWN,
  buildMatch,
  buildTieSummary,
  candidateMatch,
  candidateRef,
  DEFAULT_CANDIDATES,
  MAX_CANDIDATES,
  buildNextCall,
  buildPairNextCall,
  buildPairSummary,
  buildSummary,
  coverageKindFor,
  RENDER_FULL_N,
  SELECT_TOP_N,
  SHELL_COVERAGE_MAX,
  hasLiveCoverage,
  isDomainShaped,
  oneLine,
  MAX_COVERAGE_NAMES,
  MAX_COVERAGE_PAGES,
  metricListMatch,
  PAGE_LIMIT,
  promotionEligible,
  toRef,
  topOfEachKind,
  resolvedOnlyMatch,
  unavailableMatch,
} from "./_available_data.js";
import type { CoverageMatch, OtherMatch, PairResolution, ResolvedRef } from "./_available_data.js";
import { confidentMatch, gateCandidates, mentionedWhole, sameTokens } from "./_match_gate.js";
import {
  PAIR_ENTITY_PROBES,
  PAIR_PROBE_LIMIT,
  PAIR_PROBE_TIMEOUT_MS,
  metricFilters,
  reconcilePair,
} from "./_pair_confirm.js";
import type { PairVerdict } from "./_pair_confirm.js";
import {
  graphErrorMessage,
  graphRelatedOutputShape,
  graphSearchOutputShape,
} from "./_graph.js";
import {
  availableDataSlimOutputShape,
  renderAvailableDataMarkdown,
  slimAvailableDataStructured,
  type AvailableDataFullOutput,
} from "./_render_markdown.js";
import type { graphNodeSchema, graphRelationSchema } from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import type { ToolModule } from "./types.js";

/** One drilled coverage page (graph/related's `relation` group). */
type GraphRelationPage = z.infer<typeof graphRelationSchema>;
/** One resolved graph node from graph/search. */
type GraphNode = z.infer<typeof graphNodeSchema>;

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

// The naming claim below deliberately carries NO worked example any more. It
// used to cite `AWS revenue` -> `Amazon Web Services, Inc.` + `Revenues`, which
// `confidentMatch`'s token-equality rule now rejects on purpose: the alias
// `Revenue` accounts for only half of {aws, revenue}, and letting it vouch is
// what shipped `Total Odds` for "total assets". So the example described a
// resolution this tool no longer offers — the pair summary now calls those
// closest names "probably NOT what you asked for". The aggregate measurement
// (9 of 15) stands and predates that rule; any replacement example has to be
// re-measured against the equality gate before it goes in here.
const DESCRIPTION = [
  "Find what proprietary, continuously-updated structured data exists on something — summarized in one call. Free and fast.",
  "",
  "Ask it when the question IS coverage: what does Tako have on X, is this measure tracked at all, what is it called. Then build the real question around what comes back.",
  "",
  "Worth one call first when you need a measure's EXACT name: resolving a loose phrase to the canonical metric name measurably improves what the priced call retrieves (measured, 9 of 15 pairs).",
  "",
  "Works on an entity (a company, person, or place → the metrics tracked on it, e.g. Tesla) or a metric (→ the entities it is tracked across, e.g. Inflation Rate).",
  "",
  "Tips:",
  'Know the measure? Split it: q="Carnival", metric="passenger cruise days" — you get the entity+metric pair and a runnable next_call in ~0.6s. `metric` is also the browse filter: q="Nvidia", metric="data center" lists every NVIDIA metric whose name contains the phrase, with node ids. Omit `metric` only to browse everything an entity has.',
  "One metric across many entities → one metric-first call; one entity across many metrics → one entity-first call. The returned coverage list answers all of them at once — never loop one call per name.",
  'When `q` names both an entity and a metric ("US core PCE" → the company Core and the metric Core PCE Price Index), the tool returns both as candidates with subtype, label, and aliases and picks neither. Re-run with `types` (or `metric`) once you know which you meant.',
  "On the discovery path, `found: true` means a match has live data coverage — never that a name merely resolved. On the lookup path it means the entity holds something matching; read `verified` for what was actually checked, because a probe that failed leaves `resolution` and no coverage evidence. Every other candidate is listed with its node id, subtype, label, and aliases; raise `limit` (max 20) for the wide list.",
  "Pass `label` when you can categorize the term (company → ORG, country → GPE, person → PERSON).",
  "Each match lists the exact metric/entity names, and structuredContent.matches[].coverage.items[] pairs each name with its node id. Search on the EXACT name — the canonical name is what recovers cards. When the measure is known — you passed `metric`, or `q` named a metric — `next_call` is that follow-up prewritten — run it verbatim. A node id is for TRAVERSAL: hand it to `tako_graph_related` to see what else the graph holds on it.",
  "A broad entity's coverage list is capped, so it can be truncated: treat a name you don't see as UNCONFIRMED rather than absent, and fall back to the web instead of re-calling this tool to double-check.",
  "This tool confirms a name EXISTS in the graph; it cannot confirm a chart exists behind it. If next_call returns 0 cards, report the gap rather than rephrasing the query further — one retrieval on the canonical name is the best free evidence available, not proof of absence, and rephrasing is the one thing that does not improve it.",
].join("\n");

const inputSchema = z.object({
  q: z.string().min(2).describe(
    'The NAME of the entity (or metric) to look up, min 2 chars — e.g. "Carnival", "United States", "Nvidia". Put the measure in `metric`, not here.',
  ),
  metric: z.string().min(2).optional().describe(
    'The measure you want, when you already know it — e.g. "gross margin", "passenger cruise days", "capex". Supplying it is the FAST path: the tool resolves the entity+metric pair directly and hands back a runnable next_call, instead of listing every metric the entity has. Omit it only to browse what exists.',
  ),
  types: z.enum(["entity", "metric"]).optional().describe(
    'Narrow resolution to a "thing" ("entity") or a "measure" ("metric"). Omit to search both.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer for `q` (boost, not a filter). Supply when you can categorize the term (company→ORG, place→GPE, person→PERSON, ...). Describes the ENTITY only — it is not applied to `metric`.",
  ),
  // `limit` is NOT a display knob. It sizes every `graph/search` this tool
  // runs, including the `metric` probe, and two later steps scan the whole
  // widened list rather than its head: `exactIdx` promotes an exact-name metric
  // to rank 0 (so `limit` decides which metric `next_call` pins), and
  // `topOfEachKind` can surface a metric that only appears deep in the list
  // (so `limit` decides whether the same `q` answers confidently or returns a
  // tie with `next_call: null`). A caller raising it to "see more options" is
  // entitled to know it can get a different answer, not just a longer one.
  limit: z.number().int().min(1).max(MAX_CANDIDATES).optional().describe(
    "How many candidate nodes to resolve for EACH of `q` and `metric` (default 10, max 20). Every candidate comes back with its node id, type, subtype, label, and aliases; only the top few are coverage-checked. Raise it when a name is ambiguous and you want the wide list — but this widens what the tool considers, not just what it shows: a deeper exact-name metric can become the one `next_call` names, and a deeper metric node can turn a confident single answer into a two-candidate tie.",
  ),
});

type Input = z.infer<typeof inputSchema>;

const resolvedRefSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  type: z.string(),
});

// Mirrors `NextCall` in _available_data.ts. No node_ids / strict: tako_search
// takes neither after the D4 split, and a handle labelled "run verbatim" that
// the named tool rejects is worse than no handle at all.
const nextCallSchema = z.object({
  tool: z.enum(["tako_search"]),
  query: z.string(),
});

const coverageGroupSchema = z.object({
  kind: z.enum(["metrics", "entities"]),
  // name + node_id pairs (canonical) and the names-only projection the text
  // channel renders. See CoverageItem in _available_data.ts for why the id
  // must survive: a pinned follow-up is only precise with the node id.
  items: z.array(z.object({ name: z.string(), node_id: z.string() })),
  names: z.array(z.string()),
  total: z.number().int(),
  truncated: z.boolean(),
  capped: z.boolean(),
});

const coverageMatchSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  type: z.string(),
  subtype: z.string().nullable(),
  label: z.string().nullable(),
  aliases: z.array(z.string()),
  unavailable: z.boolean().optional(),
  // Set by `metricListMatch` when the list was scoped by the caller's `metric`
  // phrase; the pair renderer reads it to say what the list is filtered to.
  filter: z.string().optional(),
  coverage: coverageGroupSchema,
});

// INTERNAL full output shape (types the handler's return value). NOT the
// advertised schema: the summary + coverage-name lists reach the model as
// rendered markdown (renderText below), and the ADVERTISED outputSchema is
// the slim structuredContent shape (the verdict, the matches with their node
// ids, and next_call) so hosts that count structuredContent toward context
// don't pay for the full name lists twice.
// `found` and `verified` carry NO `.describe()` here on purpose. This schema
// types the handler's return; `availableDataSlimOutputShape` is what
// `tools/list` publishes, so only that copy reaches a model — and only that
// copy is guarded (`_pin_form.test.ts` walks published schemas, so pin
// vocabulary added here would pass clean while the same string in the slim
// shape fails). Two hand-maintained copies of the same model-facing prose
// drift; the published one is the contract. Read the semantics there.
const fullOutputSchema = z.object({
  found: z.boolean(),
  verified: z.enum(["coverage", "pair", "unlinked", "resolution"]).optional(),
  query: z.string(),
  summary: z.string(),
  matches: z.array(coverageMatchSchema),
  confident: z.boolean().optional(),
  other_matches: z.array(
    z.object({
      node_id: z.string(),
      name: z.string(),
      type: z.string(),
      subtype: z.string().nullable(),
      label: z.string().nullable(),
      aliases: z.array(z.string()),
      // Present for candidates that were coverage-probed but not rendered in
      // full — enough to switch to one without re-running the tool.
      coverage_total: z.number().int().optional(),
      // True when the server stopped counting — `coverage_total` is a floor.
      coverage_capped: z.boolean().optional(),
    }),
  ),
  next_call: nextCallSchema
    .nullable()
    .describe(
      "Ready-to-run follow-up: call the tool it names with exactly this query. The query uses the canonical graph names for both halves, which is what recovers cards. Present whenever the measure is known: you passed `metric`, or `q` itself named a metric, or the entity has few enough metrics that the top one is unambiguous. Null when `q` named only an entity — pass `metric` to get a handle.",
    ),
  // Lookup path (`metric` supplied) — the resolved pair and its runners-up.
  metric_query: z.string().optional(),
  entity: resolvedRefSchema.nullable().optional(),
  metric: resolvedRefSchema.nullable().optional(),
  entity_alternates: z.array(resolvedRefSchema).optional(),
  metric_alternates: z.array(resolvedRefSchema).optional(),
});
type FullOutput = z.infer<typeof fullOutputSchema>;

// Advertised (slim) schema — see the fullOutputSchema comment above.
const outputSchema = availableDataSlimOutputShape;
type Output = z.infer<typeof outputSchema>;

const searchShape = z.object(graphSearchOutputShape);
const relatedShape = z.object(graphRelatedOutputShape);

const tako_available_data = {
  name: "tako_available_data",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Available Data",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  fixedInputs: [
    // `graph/search limit` is gone from this list: it is the caller's `limit`
    // parameter now, so it is not a fixed input any more. The candidate
    // arithmetic it carried moved to the probe row below and stays DERIVED
    // rather than restated — a hand-written copy of these numbers once claimed
    // four full drills where the handler does one drill plus three limit=1
    // probes, and `docs/TOOLS.md` published the wrong figure verbatim.
    // `fixedInputs` is read off the imported module (`gen-registry.ts`), so
    // retuning a constant regenerates the doc instead of drifting it.
    {
      field: "graph/related limit (coverage drill)",
      value: String(PAGE_LIMIT),
      note:
        `Page size for the rendered coverage list; paging stops at ${MAX_COVERAGE_NAMES} names ` +
        `or ${MAX_COVERAGE_PAGES} pages.`,
    },
    {
      field: "graph/related limit (candidate probes)",
      value: "1",
      note:
        `The cheap per-candidate coverage probes fetch a count only — the probed candidates' ` +
        `lists are never read. The top ${SELECT_TOP_N} gated candidates are inspected: ` +
        `${RENDER_FULL_N} drilled in full and ${SELECT_TOP_N - RENDER_FULL_N} by a limit=1 ` +
        `probe. A shell rank-0 costs one more drill.`,
    },
  ],
  // Declared as the FULL internal shape (assignable to the slim advertised
  // Output via its loose index signature) so tests and hooks keep real types.
  async handler(input: Input, ctx): Promise<FullOutput> {
    // One `graph/search` probe. Extracted because the LOOKUP path runs two of
    // them (entity + metric) in parallel; the discovery path runs one.
    //
    // `types` and `label` are BOTH passed explicitly and neither is ever read
    // from `input` here. `label` because it is an NER label for the ENTITY, and
    // forwarding it to the metric probe measurably degrades that half
    // (`label=METRIC` turned `Gross Margin (%)` into `Product Gross Margin`).
    // `types` because this used to fall back to `input.types` when the argument
    // was omitted, and the ONLY callers that omit it are the swap probes below,
    // which are documented as unfiltered and are useless filtered: with
    // `types="entity"` supplied, `q="gross margin", metric="Nvidia"` stopped
    // being diagnosed as swapped and returned `found: true` with a runnable
    // priced next_call for the inverted pair. An implicit read of `input` here
    // reaches exactly the two probes that must not see it.
    const probe = async (
      q: string,
      types?: "entity" | "metric",
      label?: string,
    ): Promise<GraphNode[]> => {
      const query: Record<string, string | number | boolean> = {
        q,
        limit: input.limit ?? DEFAULT_CANDIDATES,
      };
      if (types !== undefined) query.types = types;
      if (label !== undefined) query.label = label;

      let raw: unknown;
      try {
        raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/v1/graph/search",
          { query, timeoutMs: 15_000 },
        );
      } catch (err) {
        // Log the original transport error — wrapping in a plain Error below
        // drops the DjangoError envelope, so this line is the only server-side
        // record of what actually failed.
        console.error("[tako] tool error tool=tako_available_data stage=graph/search:", err);
        throw new Error(graphErrorMessage(err, "search", undefined, "tako_available_data"));
      }
      const parsed = searchShape.safeParse(raw);
      if (!parsed.success) {
        logWireGuardFailure("tako_available_data", "graph-search", parsed.error, raw);
        throw new Error(
          "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
        );
      }
      return parsed.data.results;
    };

    // Drill each given node's coverage in parallel, type-aware: an entity node
    // → its `metrics`; a metric node → the `entities` it is tracked across
    // (drilling `metrics` on a metric node returns empty, which would be a
    // false "no data"). Per-node error isolation: a failed or malformed
    // graph/related for one node yields an "unavailable" match rather than
    // sinking the whole call (auth/connectivity already proven by the search
    // above). A single-relation drill returns just that group (in `relation`),
    // smaller and faster than the full overview.
    //
    // The drill PAGINATES (cursor, PAGE_LIMIT per page) up to
    // MAX_COVERAGE_NAMES so the coverage list is COMPLETE, not a first-page
    // window: a broad entity's page 1 is dominated by generic
    // normalized-accounting names in the backend's fixed order, so a
    // single-page fetch made anything past it ("Net charges-off …" behind 250
    // boilerplate metrics) undiscoverable. A later-page failure keeps the
    // pages already fetched (partial names beat "unavailable"); only a
    // first-page failure degrades the node to unavailable.
    const drillMatches = (nodes: GraphNode[]): Promise<CoverageMatch[]> =>
      Promise.all(
        nodes.map(async (node) => {
          const relation = coverageKindFor(node.type);
          try {
            let group: GraphRelationPage | null = null;
            let items: GraphRelationPage["items"] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
              const relatedQuery: Record<string, string | number> = {
                node_id: node.id, relation, limit: PAGE_LIMIT,
              };
              if (cursor !== null) relatedQuery.cursor = cursor;
              let relatedRaw: unknown;
              try {
                relatedRaw = await djangoGet<unknown>(
                  ctx.env, ctx.token, "/api/v1/graph/related",
                  { query: relatedQuery, timeoutMs: 15_000 },
                );
              } catch (pageErr) {
                if (group !== null) {
                  // Pages already in hand — return them rather than degrading
                  // the whole node; truncated/total still signal the shortfall.
                  console.warn(
                    `[tako] tool error tool=tako_available_data stage=graph/related node=${node.id} (partial: keeping ${items.length} fetched names):`,
                    pageErr,
                  );
                  break;
                }
                throw pageErr;
              }
              const related = relatedShape.safeParse(relatedRaw);
              if (!related.success) {
                // Wire drift/outage. This degrade is a FALSE NEGATIVE to the
                // caller (first page → "unavailable"; later page → a shorter
                // list) — ALWAYS log it so an outage doesn't silently suppress
                // downstream searches.
                logWireGuardFailure("tako_available_data", "graph-related", related.error, relatedRaw);
                if (group === null) return unavailableMatch(node);
                break;
              }
              const page = related.data.relation ?? null;
              if (page === null) {
                // Spec-legal 200 with relation:null — the node has no such
                // coverage group. That is a real "zero coverage" ANSWER, not an
                // outage: fall through to buildMatch.
                break;
              }
              pages += 1;
              items = [...items, ...page.items];
              group = page;
              const next = page.next_cursor ?? null;
              // Terminate on a page that makes no forward progress (empty items
              // or a cursor echoing the one just used) — a server-side paging
              // bug must degrade to a shorter list, never an infinite loop.
              cursor = page.items.length === 0 || next === cursor ? null : next;
              // pages < MAX_COVERAGE_PAGES is the hard round-trip ceiling.
            } while (cursor !== null && items.length < MAX_COVERAGE_NAMES && pages < MAX_COVERAGE_PAGES);
            return buildMatch(node, group === null ? null : { ...group, items });
          } catch (err) {
            console.warn(
              `[tako] tool error tool=tako_available_data stage=graph/related node=${node.id} (degraded to "unavailable"):`,
              err,
            );
            return unavailableMatch(node);
          }
        }),
      );

    // A SELECTION-only probe: `limit=1` returns the coverage `total` and one
    // item, so it answers "does this candidate have data?" without paying for
    // a paginated list. Its result never reaches the model. A failed probe
    // reports zero rather than throwing — selection must degrade, not sink the
    // call.
    const coverageProbe = async (
      node: GraphNode,
    ): Promise<{ node: GraphNode; total: number; capped: boolean }> => {
      try {
        const raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/v1/graph/related",
          { query: { node_id: node.id, relation: coverageKindFor(node.type), limit: 1 }, timeoutMs: 15_000 },
        );
        const parsed = relatedShape.safeParse(raw);
        return {
          node,
          total: parsed.success ? (parsed.data.relation?.total ?? 0) : 0,
          // Carried so the receipt line can say "250+" only where the server
          // actually stopped counting — see OtherMatch.coverage_capped.
          capped: parsed.success ? (parsed.data.relation?.total_capped ?? false) : false,
        };
      } catch (err) {
        console.warn(
          `[tako] coverage probe failed tool=tako_available_data node=${node.id} (treated as zero):`,
          err,
        );
        return { node, total: 0, capped: false };
      }
    };

    /**
     * The entity's WHOLE metric count, with no `q` on the wire.
     *
     * A FILTERED `total` CANNOT DECIDE COVERAGE. The pair probes all send a
     * substring filter, and `GraphRelationPage.total` carries no contract
     * about what a filter does to it: `openapi/sdk.yaml` documents "totals do
     * not change" only for `label` — and says so precisely because `label` is
     * "a boost, not a filter" — while `total_capped` tells the caller to
     * "narrow with `q` to reach the tail", which reads as `q` narrowing the
     * count. So a filtered `total: 0` may mean "this entity holds nothing" or
     * "this phrase matched nothing", and those pick different entities.
     * The same ambiguity sits on `relation: null`, which `pairProbe` maps to
     * zero. Ask the question unfiltered, and only where the answer decides
     * something: whether to hand the pair to a DIFFERENT entity.
     *
     * `null` on failure, never 0 — a probe that produced no evidence must not
     * authorise the rebind. Same rule as `pairProbe`, opposite of
     * `coverageProbe`, whose zero only ever costs a receipt line.
     */
    const unfilteredMetricTotal = async (nodeId: string): Promise<number | null> => {
      try {
        const raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/v1/graph/related",
          { query: { node_id: nodeId, relation: "metrics", limit: 1 }, timeoutMs: PAIR_PROBE_TIMEOUT_MS },
        );
        const parsed = relatedShape.safeParse(raw);
        if (!parsed.success) {
          logWireGuardFailure("tako_available_data", "bind-verify", parsed.error, raw);
          return null;
        }
        // No filter was sent, so `relation: null` really is "no metrics group".
        return parsed.data.relation?.total ?? 0;
      } catch (err) {
        console.warn(
          `[tako] bind verify failed tool=tako_available_data node=${nodeId} (kept rank 0):`,
          err,
        );
        return null;
      }
    };

    // The PAIR-CONFIRMATION probe: does this entity actually hold this metric?
    //
    // UP TO TWO `graph/related` calls per entity, scoped to it, each narrowed
    // by one substring filter: the VERDICT filter (`metricFilter`) and the
    // caller's VERBATIM phrase, which buys the browse list. `metricFilters`
    // collapses them to one call when the two strings agree.
    // Returns `null` — NOT an empty list — when the
    // probe could not run or failed, because the two mean opposite things: an
    // empty list is evidence ("the entity's list holds nothing matching"),
    // `null` is the absence of evidence, and collapsing them would let an
    // outage manufacture `unlinked` verdicts that unpin every handle the tool
    // emits.
    //
    // `complete` carries the same distinction one level down: a FULL page means
    // the filtered list was cut off, so "not on this page" is not "absent".
    // It comes from `next_cursor`, never from `total` — measured on prod,
    // `relation.total` ignores the `q` filter entirely (Lockheed reports
    // 250/capped with and without `q=Backlog`).
    //
    // Never throws. Auth and connectivity are already proven by the entity
    // search that ran before it, so the only failures reachable here are
    // transient — and today's behaviour (no pair evidence at all) is a
    // perfectly good landing for them.
    const pairProbe = async (
      entityNodeId: string,
      filter: string | null,
    ): Promise<{ items: GraphNode[]; complete: boolean; total: number; capped: boolean } | null> => {
      if (filter === null) return null;
      try {
        const raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/v1/graph/related",
          {
            query: {
              node_id: entityNodeId, relation: "metrics",
              q: filter, limit: PAIR_PROBE_LIMIT,
            },
            timeoutMs: PAIR_PROBE_TIMEOUT_MS,
          },
        );
        const parsed = relatedShape.safeParse(raw);
        if (!parsed.success) {
          // Same rule as the drill: a wire-guard failure degrades the caller's
          // answer, so it is ALWAYS logged rather than silently suppressing the
          // pair evidence.
          logWireGuardFailure("tako_available_data", "pair-confirm", parsed.error, raw);
          return null;
        }
        const page = parsed.data.relation ?? null;
        // A spec-legal 200 with `relation: null` means the node has no metrics
        // group at all — a real, COMPLETE "nothing here", not an outage. Same
        // reading the coverage drill gives it.
        if (page === null) return { items: [], complete: true, total: 0, capped: false };
        return {
          items: page.items,
          complete: (page.next_cursor ?? null) === null,
          // MEASURED, NOT CONTRACTED. On prod today `relation.total` ignores
          // `q` (Lockheed reports 250/capped with and without `q=Backlog`), so
          // this is the entity's whole metric count and fix 2's coverage
          // evidence comes free with the filtered page. But `openapi/sdk.yaml`
          // promises nothing about what a filter does to `total` (see
          // `unfilteredMetricTotal`, which exists for exactly that gap), so a
          // reader must not build on this the way they would build on a
          // documented field. Where the reading decides something expensive —
          // handing the pair to a DIFFERENT entity — the code asks again
          // unfiltered instead of trusting it. TAKO-4336 stays open on the
          // contract.
          total: page.total,
          capped: page.total_capped,
        };
      } catch (err) {
        console.warn(
          `[tako] pair confirm failed tool=tako_available_data node=${entityNodeId} q=${filter} (degraded to no pair evidence):`,
          err,
        );
        return null;
      }
    };

    // ---- LOOKUP path: the caller named the metric ------------------------
    //
    // Two parallel free probes instead of a paginated coverage drill. Measured
    // on staging: ~0.63s vs ~3.0s for the drill, and ~600 chars of output vs
    // ~8.5k. Splitting the halves is what makes it accurate — the combined
    // phrase resolves the metric fine but can destroy entity resolution
    // (`"Pfizer R&D expense"` returns no Pfizer at all in the top 10).
    if (input.metric !== undefined) {
      const metricQuery = input.metric;
      // Two UNFILTERED probes ride alongside the typed ones to detect swapped
      // arguments. The type filter is what makes resolution accurate, but it
      // also destroys the evidence needed here: `types=entity` returns an
      // entity for "gross margin" no matter how entity-unlike it is. Asking
      // the backend to rank across BOTH types recovers its own opinion —
      // measured, 18/18 entity strings ranked an entity first and 18/18 metric
      // strings ranked a metric first.
      const swapProbe = (q: string): Promise<GraphNode[]> =>
        probe(q).catch(() => [] as GraphNode[]);
      const [entityHits, metricHits, qUntyped, metricUntyped] = await Promise.all([
        // The entity probe is load-bearing: it proves auth/connectivity and
        // there is nothing to fall back to without it, so its failure throws.
        probe(input.q, "entity", input.label),
        // The metric probe is isolated, mirroring the discovery drill's rule
        // that one bad node never sinks the whole answer. A transient failure
        // here already has a graceful landing — the entity resolved, so we
        // degrade to "no metric matched" and drill what the entity actually
        // has, instead of 503-ing a call that could still be useful. Auth
        // failures still surface: the entity probe runs in parallel and throws.
        probe(metricQuery, "metric").catch((err: unknown) => {
          console.warn(
            `[tako] metric probe failed tool=tako_available_data metric=${metricQuery} (degraded to no-match):`,
            err,
          );
          return [] as GraphNode[];
        }),
        // Detection only — never allowed to sink the call.
        swapProbe(input.q),
        swapProbe(metricQuery),
      ]);

      // Both halves must look inverted AND resolve confidently in the inverted
      // role. The type test alone is not enough: 8 of 21 real company names
      // rank a metric first (`Equity Residential` → `Equity (Normalized)`,
      // `Block` → `Blocked Shots`), so requiring a confident match on the
      // inverted node is what removes the false positives. Measured over 20
      // correct pairs chosen to include those adversarial names: 0 false
      // positives, and 9/9 on swapped pairs.
      const looksLike = (q: string, hits: GraphNode[], type: string): boolean => {
        const top = hits[0];
        return top !== undefined && top.type === type && confidentMatch(q, top);
      };
      const argsLookSwapped =
        looksLike(input.q, qUntyped, "metric") &&
        looksLike(metricQuery, metricUntyped, "entity");
      if (argsLookSwapped) {
        // Diagnose, never auto-correct: silently reinterpreting the caller's
        // arguments would be a worse failure than the one being fixed, and the
        // corrected call is one line for the model to re-issue. found:false and
        // no next_call, so nothing downstream acts on the unusable pair.
        return {
          found: false,
          query: input.q,
          metric_query: metricQuery,
          summary: `The arguments look swapped: "${oneLine(input.q)}" resolves to a METRIC (${oneLine(qUntyped[0]?.name ?? "?")}) and "${oneLine(metricQuery)}" to an ENTITY (${oneLine(metricUntyped[0]?.name ?? "?")}). Nothing was looked up. Re-run with them the other way round: q="${oneLine(metricQuery)}", metric="${oneLine(input.q)}".`,
          matches: [],
          other_matches: [],
          next_call: null,
          entity: null,
          metric: null,
          entity_alternates: [],
          metric_alternates: [],
        };
      }
      // The ENTITY half does NOT fail open here. On the discovery path a
      // fail-open drill beats nothing, but in a lookup a non-plausible entity
      // produces a confidently wrong pair — better to report no entity and let
      // the summary route the caller.
      const entityGate = gateCandidates(input.q, entityHits);
      // Fix 2: probe the top PAIR_ENTITY_PROBES gated entities, not one. The
      // long note that used to live here — "deliberately NOT coverage-probed,
      // 0.23s → 1.48s" — described a probe that added a ROUND TRIP. These run
      // in the same round trip as the pair probe, which already exists, and
      // they buy a correctness fix rather than a nicer echoed name: a
      // zero-coverage stub (`Duolingo` PRODUCT) no longer takes the pair from
      // the entity that holds the data (`Duolingo, Inc.`).
      const entityCands = entityGate.gated ? entityGate.kept.slice(0, PAIR_ENTITY_PROBES) : [];

      // The METRIC half keeps the backend's ORDER — the gate only decides
      // confidence here, it must not filter or reorder.
      //
      // Metric names are morphological variants and token containment gets
      // that backwards. Measured: `metric="revenue"` returns
      // [`Revenues`, `Top Grossing`, `Avnet Revenue Total Revenue`, …]. The
      // gate REJECTS the correct rank-0 `Revenues` ({revenues} does not
      // contain {revenue}) while KEEPING `Avnet Revenue Total Revenue`
      // (which does), promoting rank-2 noise over the right answer. Ungated
      // backend order was measured at ~86% top-1 / ~100% top-3 across 44
      // cases, so it is the better ranking.
      //
      // The gate still earns its place as a CONFIDENCE signal: when nothing
      // is plausible at all (`metric="number of unicorns"` →
      // `Concentra Number Of Visits`) we keep the candidates visible but
      // refuse to emit a runnable PRICED call for them.
      // Promote a verbatim name the backend ranked low. Fires only on exact
      // normalised equality, so it is a no-op for the ordinary shapes
      // (`revenue`, `gross margin`, `capex` have no exact node) and cannot
      // reshuffle them — it exists for the caller who pasted a full metric
      // name back in, which the backend ranks below the generic one.
      const exactIdx = metricHits.findIndex((n) => sameTokens(metricQuery, n.name));
      const orderedHits =
        exactIdx > 0
          ? [
              metricHits[exactIdx] as GraphNode,
              ...metricHits.filter((_n, i) => i !== exactIdx),
            ]
          : metricHits;
      const metrics = orderedHits.map(toRef);
      // THE NODE WE PIN IS THE NODE THAT MUST PASS. Confidence is judged on
      // rank 0 — the candidate `pair.metric` takes and `next_call` pins — and
      // nothing else.
      //
      // This used to be `.some()` over the shown window (primary + alternates),
      // which meant a confident SIBLING licensed a runnable, priced handle for a
      // rank 0 that had failed the test. Measured on staging (2026-07-31),
      // `q="Pfizer", metric="R&D expense"`:
      //
      //   rank 0  confident=false  Operating costs and expenses   <- pinned
      //   rank 1  confident=false  R&D Expenses (Normalized)
      //   rank 2  confident=true   Research & development expense (R&D) - Americas
      //
      // The tool emitted "run the next_call verbatim […] 0 cards means Tako has
      // no card for this pair, do not rephrase and retry" pinning OPERATING
      // COSTS for an R&D question, so an agent that obeys either reports
      // operating costs as R&D spend or concludes the data is absent. A live
      // agent run escaped only by ignoring the handle.
      //
      // The window is NOT replaced by promoting whichever candidate passed:
      // `confidentMatch` is a yes/no predicate over name and alias tokens — a
      // name containing the query, or an alias equal to it — so it decides
      // confidence and never order (the same rule the entity half follows).
      // Promotion was implemented and measured to pick `CapEx to Revenue` over
      // `Capital Expenditure` and `Avnet Revenue Total Revenue` over
      // `Revenues` — a derived ratio and a junk node, both "confident" by
      // containment while the correct metric fails on morphology. Backend order
      // stays (~86% top-1, ~100% top-3 over 44 cases).
      //
      // So when rank 0 is unvetted the handle is WITHHELD rather than
      // redirected: the summary switches to the "nothing is pinned, pick one
      // deliberately" branch with the entity's own matching metrics and their
      // node ids still visible, which is the recovery the live agent performed
      // by itself.
      //
      // Retire in favour of the real fix once `graph/search` carries a
      // relevance score (KE-805): score the candidates, pin the best. TAKO-3754.
      const rank0 = orderedHits[0] ?? null;
      const rank0Confident = rank0 !== null && confidentMatch(metricQuery, rank0);

      // ---- Pair confirmation + the browse list ------------------------------
      //
      // The lexical verdict above answers "does this node answer the question".
      // It cannot answer "does this entity hold it", and that is the failure
      // that reaches production: Lockheed/backlog, Shopify/GMV and
      // UNH/change-in-unearned-revenues all resolve a perfectly-named metric
      // and return ZERO cards. Only the graph knows, and asking it is free.
      //
      // Fix 3: two substring filters per entity, in the same round trip.
      // `verbatim` is the caller's phrase — its hits are the entity's own
      // metrics containing what was typed, which the tool returns as a list
      // with ids instead of a 25-of-250 sample. `fallback` is today's
      // confirm-or-diagnose filter and keeps the verdict logic unchanged. See
      // `metricFilters`.
      const filters = metricFilters({
        metricQuery, resolvedName: rank0?.name ?? null, confident: rank0Confident,
      });
      const probed = await Promise.all(
        entityCands.map(async (node) => {
          const [verbatim, fallback] = await Promise.all([
            pairProbe(node.id, filters.verbatim),
            pairProbe(node.id, filters.fallback),
          ]);
          return { node, verbatim, fallback };
        }),
      );
      type Probed = (typeof probed)[number];
      // UNAVAILABLE IS NOT ZERO, here as on the discovery path: a probe that
      // produced no evidence is no grounds to hand the caller a different
      // entity.
      const known = (p: Probed): boolean => p.verbatim !== null || p.fallback !== null;
      const totalOf = (p: Probed): number =>
        Math.max(p.verbatim?.total ?? 0, p.fallback?.total ?? 0);
      const first = probed[0];
      let bound: Probed | null = first ?? null;
      if (first !== undefined && known(first) && totalOf(first) === 0) {
        const promotable = probed
          .slice(1)
          .find((p) => known(p) && totalOf(p) > 0 && promotionEligible(input.q, first.node, p.node));
        if (promotable !== undefined) {
          // CONFIRM THE ZERO BEFORE ACTING ON IT. `totalOf` reads a FILTERED
          // page, so its zero may mean "the phrase matched nothing" rather
          // than "the entity holds nothing" — see `unfilteredMetricTotal`.
          // One extra round trip, and only here: this is the branch that hands
          // the caller a different company. Anything but a confirmed zero
          // keeps rank 0.
          bound = (await unfilteredMetricTotal(first.node.id)) === 0 ? promotable : first;
        }
      }
      const entities: ResolvedRef[] =
        bound === null
          ? []
          : [toRef(bound.node), ...entityGate.kept.filter((n) => n.id !== bound.node.id).map(toRef)];

      let verified: PairVerdict = "resolution";
      let entityMetricMatches: GraphNode[] = [];
      let metricList: GraphNode[] = [];
      let listComplete = true;
      if (bound !== null && known(bound)) {
        const reconciled = reconcilePair({
          metricQuery,
          globalMetric: rank0,
          verbatim: bound.verbatim?.items ?? [],
          scoped: bound.fallback?.items ?? [],
          complete: (bound.verbatim?.complete ?? true) && (bound.fallback?.complete ?? true),
        });
        verified = reconciled.verified;
        entityMetricMatches = reconciled.entityMetricMatches;
        metricList = reconciled.metricList;
        listComplete = bound.verbatim?.complete ?? true;
      }

      // The pin is always the global search's rank 0 — linkage describes it, it
      // never replaces it.
      const pinnedConfident = rank0Confident;
      const pair: PairResolution = {
        entity: entities[0] ?? null,
        metric: metrics[0] ?? null,
        entity_alternates: entities.slice(1, 1 + ALTERNATES_SHOWN),
        metric_alternates: metrics.slice(1, 1 + ALTERNATES_SHOWN),
      };
      const listMatch =
        bound !== null && metricList.length > 0
          ? metricListMatch(bound.node, metricList, listComplete, metricQuery)
          : null;
      const matches: CoverageMatch[] = listMatch === null ? [] : [listMatch];
      const listNames = metricList.map((n) => n.name);

      // Entity resolved, nothing matched anywhere — not globally, not on the
      // entity's own list by substring. Fall through to the full drill so the
      // caller sees what DOES exist.
      if (pair.entity !== null && pair.metric === null && listMatch === null) {
        const drilled = await drillMatches(
          entityHits.filter((n) => n.id === pair.entity?.node_id),
        );
        return {
          found: drilled.some(hasLiveCoverage),
          verified: "coverage",
          query: input.q,
          metric_query: metricQuery,
          summary: buildPairSummary({
            entityQuery: input.q,
            metricQuery,
            pair,
            domainShaped: isDomainShaped(input.q),
          }),
          matches: drilled,
          other_matches: [],
          next_call: null,
          entity: pair.entity,
          metric: null,
          entity_alternates: pair.entity_alternates,
          metric_alternates: [],
        };
      }

      return {
        // Fix 2: `found` means the bound entity holds something matching the
        // request — the pinned metric is on its list (`pair`), or its own
        // metrics contain the phrase (the list). `unlinked` with no list is a
        // measured miss and reads false. `resolution` (no probe evidence)
        // keeps today's reading: there is no evidence either way.
        found:
          pair.entity !== null &&
          (listMatch !== null ||
            (pair.metric !== null && pinnedConfident && verified !== "unlinked")),
        ...(pair.entity === null ? {} : { verified }),
        query: input.q,
        metric_query: metricQuery,
        summary: buildPairSummary({
          entityQuery: input.q,
          metricQuery,
          pair,
          domainShaped: isDomainShaped(input.q),
          metricConfident: pinnedConfident,
          verified: pair.entity === null ? undefined : verified,
          entityMetricMatches: entityMetricMatches.map((n) => n.name),
          metricList: listNames,
          metricListCapped: !listComplete,
        }),
        matches,
        other_matches: [],
        // No pinned/unpinned fork any more: the handle never pins, so an
        // `unlinked` verdict and a confirmed pair produce the same shape. What
        // `unlinked` still changes is the SUMMARY, which tells the model the
        // graph holds no edge between the two halves.
        //
        // The `pair.metric !== null` half is DEFENSIVE, not load-bearing:
        // `buildPairNextCall` already returns null on a null metric. It states
        // the precondition where the reader can see it, next to a `found` that
        // can now be true with no metric at all.
        next_call: pair.metric !== null && pinnedConfident ? buildPairNextCall(pair) : null,
        entity: pair.entity,
        metric: pair.metric,
        entity_alternates: pair.entity_alternates,
        metric_alternates: pair.metric_alternates,
      };
    }

    // ---- DISCOVERY path: browse what exists for one name -----------------
    // `input.types` is applied HERE, at the one call site that wants it, rather
    // than as a default inside `probe` (see the comment there).
    const results = await probe(input.q, input.types, input.label);
    // 2) No node → fast exit, no related calls.
    if (results.length === 0) {
      return {
        found: false,
        query: input.q,
        summary: buildSummary({ query: input.q, matches: [], otherMatches: [] }),
        matches: [],
        other_matches: [],
        next_call: null,
      };
    }

    // Gate before drilling: graph/search is fuzzy and carries no score, so
    // ungated the drill budget goes to whatever ranked highest — measured,
    // `q="UnitedHealth Group"` spent half of it on Blackstone Inc., and
    // `q="Carnival Corporation"` reported coverage for Cuscal Limited. Fails
    // open (every candidate kept) when nothing is plausible.
    const gate = gateCandidates(input.q, results);

    // Nothing plausibly matched. Resolve, disclaim, and spend nothing further:
    // the summary is about to say these are "almost certainly NOT what you
    // asked for" and the renderer prints only that summary, so the paginated
    // drill plus three probes below would be paid for output no one reads. It
    // also fixes a channel disagreement — the drill's coverage totals reached
    // `structuredContent` while the prose disclaimed them, so a structured
    // reader saw coverage on a `found: false` response.
    if (!gate.gated) {
      const resolvedOnly = gate.kept.slice(0, SELECT_TOP_N).map(resolvedOnlyMatch);
      const unlisted = gate.kept.slice(SELECT_TOP_N).map(candidateRef);
      return {
        found: false,
        // Nothing was drilled here — these nodes are resolutions the summary is
        // about to disclaim, so claiming a coverage check would overstate it.
        verified: "resolution",
        confident: false,
        query: input.q,
        summary: buildSummary({
          confident: false,
          query: input.q,
          matches: resolvedOnly,
          otherMatches: unlisted,
        }),
        matches: resolvedOnly,
        other_matches: unlisted,
        // No vetted target, so no runnable handle — a priced call must not be
        // spent on a resolution we just disclaimed.
        next_call: null,
      };
    }

    // Inspect the top SELECT_TOP_N, plus the top of each kind even when it
    // ranks lower: fix 1 needs both tops' coverage to decide whether the
    // query names both an entity and a metric.
    const tops = topOfEachKind(gate.kept);
    const inspected = new Set<string>();
    const candidates: GraphNode[] = [];
    for (const n of [...gate.kept.slice(0, SELECT_TOP_N), tops.entity, tops.metric]) {
      if (n === null || inspected.has(n.id)) continue;
      inspected.add(n.id);
      candidates.push(n);
    }

    // Inspect wide, render narrow. Round 1 runs the winner-candidate's FULL
    // drill in parallel with cheap `limit=1` coverage probes of the rest, so
    // the common case (rank 0 is right — 14 of 16 measured) costs one drill,
    // fewer than today's two. Only when rank 0 turns out to have no coverage
    // do we pay a second round, which is the `q="Carnival"` shape.
    const [firstDrill, probes] = await Promise.all([
      drillMatches(candidates.slice(0, RENDER_FULL_N)),
      Promise.all(candidates.slice(RENDER_FULL_N).map((n) => coverageProbe(n))),
    ]);

    // ---- Fix 1: the query names BOTH kinds -------------------------------
    // `q="US core PCE"` resolves the company `Core` (15 metrics) AND the
    // metric `Core PCE Price Index` (3 entities). Rendering rank 0 in full
    // was a confident wrong answer in 7 of 28 spike cases (spec Appendix B).
    // When `types` is omitted, both tops have coverage, and the query
    // mentions each of them whole, return both as candidates and pick
    // neither. The rank-0 drill that already ran is discarded — it ran in
    // parallel, so it cost no round trip.
    const coverageOf = (node: GraphNode): { total: number; capped: boolean } | null => {
      const drilled = firstDrill.find((m) => m.node_id === node.id);
      if (drilled !== undefined) {
        return drilled.unavailable === true
          ? null
          : { total: drilled.coverage.total, capped: drilled.coverage.capped };
      }
      const pr = probes.find((p) => p.node.id === node.id);
      return pr === undefined ? null : { total: pr.total, capped: pr.capped };
    };
    if (input.types === undefined && tops.entity !== null && tops.metric !== null) {
      const e = coverageOf(tops.entity);
      const m = coverageOf(tops.metric);
      if (
        e !== null && m !== null && e.total > 0 && m.total > 0 &&
        mentionedWhole(input.q, tops.entity) && mentionedWhole(input.q, tops.metric)
      ) {
        const entityMatch = candidateMatch(tops.entity, e);
        const metricMatch = candidateMatch(tops.metric, m);
        const tieIds = new Set([entityMatch.node_id, metricMatch.node_id]);
        const tieOthers: OtherMatch[] = [
          // Sourced from `candidates`, NOT `probes`. `probes` omits
          // `candidates[0]`, which is covered today only because rank 0 is
          // always one of the two kind-tops — and that holds only while
          // `type` has exactly two values. `graphNodeSchema.type` is
          // deliberately `z.string()` so a new enum value survives the facade,
          // and such a node at rank 0 would vanish from BOTH channels.
          ...candidates
            .filter((n) => !tieIds.has(n.id))
            .map((n) => {
              const c = coverageOf(n);
              return c === null
                ? candidateRef(n)
                : { ...candidateRef(n), coverage_total: c.total, coverage_capped: c.capped };
            }),
          ...gate.kept
            .filter((n) => !inspected.has(n.id))
            .concat(results.filter((n) => !gate.kept.includes(n)))
            .map(candidateRef),
        ];
        return {
          found: true,
          verified: "coverage",
          confident: true,
          query: input.q,
          summary: buildTieSummary({
            query: input.q,
            entity: entityMatch,
            metric: metricMatch,
            otherMatches: tieOthers,
          }),
          matches: [entityMatch, metricMatch],
          other_matches: tieOthers,
          next_call: null,
        };
      }
    }

    let matches = firstDrill;
    let rendered = candidates.slice(0, RENDER_FULL_N);
    // Candidates displaced from the full render, kept as receipt lines.
    const demoted: OtherMatch[] = [];

    // COVERAGE OUTRANKS THE GATE'S NAME PREFERENCE.
    //
    // The gate ranks own-name matches above alias-only ones to survive poisoned
    // aliases (KE-804), but a name match is not evidence that the node is the
    // one the caller meant — see SHELL_COVERAGE_MAX for the two measured
    // regressions this repairs. Coverage is the strongest rank-independent
    // signal we have until `graph/search` returns a score (KE-805), so the
    // best-covered probe takes over whenever rank 0 is a shell.
    //
    // argmax, not first-non-zero: `q="US inflation"` probes
    // [United States 250, Inflation Rate 63, CPI Inflation Rate SA 1] and
    // first-non-zero would depend on which of those the backend happened to
    // rank first.
    // UNAVAILABLE IS NOT ZERO. A drill that failed tells us nothing about the
    // node's coverage, so it is no grounds to hand the caller a different
    // entity. Observed live: `q="Delta"` hit a transient graph/related failure
    // on `Delta Air Lines, Inc.` and promoted `Delta Corp Limited` — an
    // unrelated company — into the answer, on evidence that did not exist. Left
    // alone, rank 0 renders its own "couldn't load coverage, retry" line, which
    // is both honest and actionable.
    const rank0Known = firstDrill.every((m) => m.unavailable !== true);
    const rank0Coverage = Math.max(
      0,
      ...firstDrill.filter(hasLiveCoverage).map((m) => m.coverage.total),
    );
    const rank0Node = candidates[0] as GraphNode;
    const best = probes
      // Fix 5: an exact match is only ever displaced by a same-named node.
      .filter((pr) => promotionEligible(input.q, rank0Node, pr.node))
      .reduce<(typeof probes)[number] | undefined>(
        (b, pr) => (pr.total > (b?.total ?? 0) ? pr : b),
        undefined,
      );
    if (
      rank0Known &&
      best !== undefined &&
      rank0Coverage <= SHELL_COVERAGE_MAX &&
      best.total > rank0Coverage
    ) {
      const promotedDrill = await drillMatches([best.node]);
      // UNAVAILABLE IS NOT ZERO, in this direction too. The `rank0Known` guard
      // above refuses to PROMOTE on evidence we do not have; this refuses to
      // DEMOTE on it. If the promoted node's own drill failed there is no list
      // to render in rank 0's place, and displacing a rank 0 that DID load its
      // coverage would turn a thin-but-real `found: true` into `found: false`
      // plus a "couldn't load coverage, retry" line — strictly worse than the
      // ordering the promotion set out to improve.
      const promotionLoaded = promotedDrill.some(hasLiveCoverage);
      if (rank0Coverage === 0) {
        // Rank 0 has no list to render, so keeping it costs one summary line
        // and usefully tells the caller the name they typed does resolve
        // ("**SpaceX** — resolved, but Tako holds no metrics for it yet").
        // Safe even if the promoted drill came back unavailable: rank 0 had
        // nothing either way, and its "retry" line is the honest report.
        matches = [...firstDrill, ...promotedDrill];
        rendered = [...rendered, best.node];
      } else if (promotionLoaded) {
        // Rank 0 has a thin list of its own. Rendering both would spend a
        // second ~8.3k coverage list on the loser, which is the cost
        // RENDER_FULL_N exists to avoid — so it drops to a receipt line,
        // carrying its node id and count for a caller who disagrees.
        matches = promotedDrill;
        rendered = [best.node];
        demoted.push(
          ...firstDrill.map((m) => {
            // `unavailable` is DISCARDED, not carried: the `rank0Known` guard
            // on this branch already proves it is never true here, and
            // OtherMatch has no slot for it. `void` is what keeps the
            // destructure from tripping noUnusedLocals.
            const { coverage, unavailable, ...ref } = m;
            void unavailable;
            return { ...ref, coverage_total: coverage.total, coverage_capped: coverage.capped };
          }),
        );
      }
      // else: the promoted drill failed and rank 0 has a real list — no
      // promotion. The probe receipt still names the better-covered candidate
      // with its node id, so the caller can switch without re-running.
    }

    const renderedIds = new Set(rendered.map((n) => n.id));
    const other_matches: OtherMatch[] = [
      // Displaced from the full render by a better-covered candidate. First,
      // because it is what the backend ranked highest — a caller who wanted it
      // should not have to read past the winner's receipts to find it.
      ...demoted,
      // Probed but not rendered: one line each, carrying id + coverage count.
      ...probes
        .filter((pr) => !renderedIds.has(pr.node.id))
        .map((pr) => ({ ...candidateRef(pr.node), coverage_total: pr.total, coverage_capped: pr.capped })),
      // Never inspected: id, kind, and aliases, but no coverage count.
      ...gate.kept
        .filter((n) => !inspected.has(n.id))
        .concat(results.filter((n) => !gate.kept.includes(n)))
        .map(candidateRef),
    ];

    return {
      // `found` mirrors the summary header: true only when some match carries
      // real coverage. Node resolution alone is not "data" — consumers key off
      // this to narrow `sources` to ["data"]. The un-gated case returned above,
      // so reaching here already means the gate found something plausible.
      found: matches.some(hasLiveCoverage),
      // Describes the METHOD (a coverage list was drilled), not the outcome —
      // `found` carries the outcome. True for a drilled node with zero coverage
      // too: that is a real, checked answer.
      verified: "coverage",
      confident: true,
      query: input.q,
      summary: buildSummary({
        query: input.q,
        matches,
        otherMatches: other_matches,
      }),
      matches,
      other_matches,
      // The discovery-to-fetch handle: agents that stop at prose re-derive a
      // query and often miss; this is the same example the summary names, in
      // directly runnable form. Gated on a coverage list small enough to make
      // the target unambiguous — see buildNextCall.
      next_call: buildNextCall(matches),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAvailableDataMarkdown(output as unknown as AvailableDataFullOutput);
  },
  slimStructured(output) {
    return slimAvailableDataStructured(output as unknown as AvailableDataFullOutput);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_available_data;
