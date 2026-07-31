/**
 * `tako_available_data` — the one-shot "what data does Tako have on X?" tool.
 *
 * Runs graph/search → graph/related as a single free, low-latency pipeline and
 * returns a natural-language coverage summary. It is the default discovery
 * entry point that replaces manual chaining of the low-level graph primitives
 * (tako_graph_search / tako_graph_related / tako_graph_node), which are off
 * the default surface and opt-in via `?tools=graph` (see `_optional.ts`).
 *
 * Pipeline (discovery): one graph/search, then SELECT_TOP_N candidates are
 * inspected with cheap `limit=1` coverage probes while the top one's FULL
 * paginated drill runs in parallel; only RENDER_FULL_N of them is rendered in
 * full. The drill is type-aware: an entity node → its
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
  PAGE_LIMIT,
  toRef,
  resolvedOnlyMatch,
  unavailableMatch,
} from "./_available_data.js";
import type { CoverageMatch, OtherMatch, PairResolution } from "./_available_data.js";
import { confidentMatch, gateCandidates, sameTokens } from "./_match_gate.js";
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

const DESCRIPTION = [
  "Find what proprietary, continuously-updated structured data exists on something — summarized in one call. Free and fast.",
  "",
  "Ask it when the question IS coverage: what does Tako have on X, is this measure tracked at all, what is it called. Then build the real question around what comes back. NOT a required first step — for a straightforward data question, tako_search or tako_answer directly is usually right.",
  "",
  "Worth one call first when you need a measure's EXACT name: resolving it to the canonical form measurably improves what the priced call retrieves (measured, 9 of 15 pairs; `AWS revenue` went from 0 cards to 3 once resolved to `Amazon Web Services, Inc.` + `Revenues`).",
  "",
  "Works on an entity (a company, person, or place → the metrics tracked on it, e.g. Tesla) or a metric (→ the entities it is tracked across, e.g. Inflation Rate).",
  "",
  "Tips:",
  'Know the measure? Split it: q="Carnival", metric="passenger cruise days" — you get the entity+metric pair and a runnable next_call in ~0.6s. Only omit `metric` to browse everything an entity has.',
  "One metric across many entities → one metric-first call; one entity across many metrics → one entity-first call. The returned coverage list answers all of them at once — never loop one call per name.",
  "Pass `label` when you can categorize the term (company → ORG, country → GPE, person → PERSON).",
  "Each match lists the exact metric/entity names, and structuredContent.matches[].coverage.items[] pairs each name with its node id. To land on exactly one metric, pin THAT node id alone with strict:true and name the entity in the query text; the call then returns that metric's card or nothing. When the measure is known — you passed `metric`, or `q` named a metric — `next_call` is that follow-up prewritten (query + the metric node + strict) — run it verbatim.",
  "A broad entity's coverage list is capped, so it can be truncated: treat a name you don't see as UNCONFIRMED rather than absent, and fall back to the web instead of re-calling this tool to double-check.",
  "This tool confirms a name EXISTS in the graph; it cannot confirm a chart exists behind it. If next_call returns 0 cards, retry the same query WITHOUT node_ids before concluding Tako has no data — the pin is a hard filter and the data is often held under a sibling node.",
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
});

type Input = z.infer<typeof inputSchema>;

const resolvedRefSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  type: z.string(),
});

const nextCallSchema = z.object({
  tool: z.enum(["tako_search", "tako_answer"]),
  query: z.string(),
  node_ids: z.array(z.string()),
  strict: z.boolean(),
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
  label: z.string().nullable().optional(),
  unavailable: z.boolean().optional(),
  coverage: coverageGroupSchema,
});

// INTERNAL full output shape (types the handler's return value). NOT the
// advertised schema: the summary + coverage-name lists reach the model as
// rendered markdown (renderText below), and the ADVERTISED outputSchema is
// the slim structuredContent shape (the verdict, the matches with their node
// ids, and next_call) so hosts that count structuredContent toward context
// don't pay for the full name lists twice.
const fullOutputSchema = z.object({
  found: z.boolean().describe(
    "Means different things on the two paths, because only one of them can check coverage for free. Without `metric` (discovery): at least one match has live data COVERAGE — not mere node resolution; a resolved node with no coverage, or whose coverage lookup failed, yields false. With `metric` (lookup): both halves RESOLVED to confident graph nodes, and no coverage check was performed — a chart may still not exist behind them. Either way, running `next_call` is what confirms retrievable data exists — and 0 cards from it is NOT conclusive on its own: retry without `node_ids` first, since the pin is a hard filter over a graph that holds near-duplicate metric nodes.",
  ),
  query: z.string(),
  summary: z.string(),
  matches: z.array(coverageMatchSchema),
  confident: z.boolean().optional(),
  other_matches: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      // Present for candidates that were coverage-probed but not rendered in
      // full — enough to switch to one without re-running the tool.
      node_id: z.string().optional(),
      coverage_total: z.number().int().optional(),
    }),
  ),
  next_call: nextCallSchema
    .nullable()
    .describe(
      "Ready-to-run follow-up: call this tool with exactly this query, node_ids and strict. `node_ids` holds the METRIC node only — strict is an OR over pinned nodes, so adding the entity id would widen the filter back out. Present whenever the measure is known: you passed `metric`, or `q` itself named a metric, or the entity has few enough metrics that the top one is unambiguous. Null when `q` named only an entity — pass `metric` to get a handle.",
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
    openWorldHint: true,
  },
  annotationsByClient: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsByClient` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  // Declared as the FULL internal shape (assignable to the slim advertised
  // Output via its loose index signature) so tests and hooks keep real types.
  async handler(input: Input, ctx): Promise<FullOutput> {
    // One `graph/search` probe. Extracted because the LOOKUP path runs two of
    // them (entity + metric) in parallel; the discovery path runs one.
    const probe = async (
      q: string,
      types?: "entity" | "metric",
      label?: string,
    ): Promise<GraphNode[]> => {
      const query: Record<string, string | number | boolean> = { q, limit: 10 };
      if (types !== undefined) query.types = types;
      else if (input.types !== undefined) query.types = input.types;
      // `label` is passed explicitly, never read from `input` here: it is an
      // NER label for the ENTITY, and forwarding it to the metric probe
      // measurably degrades that half — `label=METRIC` turned
      // `Gross Margin (%)` into `Product Gross Margin`.
      if (label !== undefined) query.label = label;

      let raw: unknown;
      try {
        raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/beta/graph/search",
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
                  ctx.env, ctx.token, "/api/beta/graph/related",
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
    ): Promise<{ node: GraphNode; total: number }> => {
      try {
        const raw = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/beta/graph/related",
          { query: { node_id: node.id, relation: coverageKindFor(node.type), limit: 1 }, timeoutMs: 15_000 },
        );
        const parsed = relatedShape.safeParse(raw);
        return { node, total: parsed.success ? (parsed.data.relation?.total ?? 0) : 0 };
      } catch (err) {
        console.warn(
          `[tako] coverage probe failed tool=tako_available_data node=${node.id} (treated as zero):`,
          err,
        );
        return { node, total: 0 };
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
      // Kept in gate order — deliberately NOT coverage-probed. Probing the top
      // candidates to promote one that actually has data (the promotion the
      // discovery path does) was implemented and MEASURED: it fixes the echoed
      // entity on ambiguous names (`Carnival` → `Carnival Corporation Ltd.`,
      // `SpaceX` → `Space Exploration Technologies Corp.`) but costs 0.23s →
      // 1.48s per call, a 6.4x regression on every lookup, because a
      // `graph/related` probe is ~0.7s and adds a second round trip. Not worth
      // it here: under `strict` the METRIC pin drives retrieval, the entity
      // only rides in the query text, and the alternates already name the
      // covered variant so the model can switch for free. Re-measure before
      // reinstating.
      const entities = entityGate.gated ? entityGate.kept.map(toRef) : [];
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
      // `confidentMatch` is token containment, so it decides confidence and
      // never order (the same rule the entity half follows). Promotion was
      // implemented and measured to pick `CapEx to Revenue` over
      // `Capital Expenditure` and `Avnet Revenue Total Revenue` over
      // `Revenues` — a derived ratio and a junk node, both "confident" by
      // containment while the correct metric fails on morphology. Backend order
      // stays (~86% top-1, ~100% top-3 over 44 cases).
      //
      // So when rank 0 is unvetted the handle is WITHHELD rather than
      // redirected: the summary switches to the "no metric confidently matches,
      // pick one deliberately" branch with all three candidates and their node
      // ids still visible, which is the recovery the live agent performed by
      // itself. Costs a handle on some pairs where a good candidate is on
      // screen; a priced call pinned to a node nobody vetted costs more.
      //
      // Retire in favour of the real fix once `graph/search` carries a
      // relevance score (KE-805): score the candidates, pin the best. TAKO-3754.
      const metricConfident =
        orderedHits[0] !== undefined && confidentMatch(metricQuery, orderedHits[0]);
      const pair: PairResolution = {
        entity: entities[0] ?? null,
        metric: metrics[0] ?? null,
        entity_alternates: entities.slice(1, 1 + ALTERNATES_SHOWN),
        metric_alternates: metrics.slice(1, 1 + ALTERNATES_SHOWN),
      };

      // Entity resolved but the metric did not: fall through to the discovery
      // drill on that entity. This is exactly when the caller needs the list —
      // they guessed a name that does not exist, so show what does.
      if (pair.entity !== null && pair.metric === null) {
        const drilled = await drillMatches(
          entityHits.filter((n) => n.id === pair.entity?.node_id),
        );
        return {
          found: drilled.some(hasLiveCoverage),
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
        // `found` here reports RESOLUTION, not card availability — no free
        // signal for the latter exists (see the description). The next_call
        // is what confirms it.
        // Both halves required: a resolved metric with no entity is not a
        // usable pair, and the summary is routing the caller elsewhere.
        found: pair.entity !== null && pair.metric !== null && metricConfident,
        query: input.q,
        metric_query: metricQuery,
        summary: buildPairSummary({
          entityQuery: input.q,
          metricQuery,
          pair,
          domainShaped: isDomainShaped(input.q),
          metricConfident,
        }),
        matches: [],
        other_matches: [],
        next_call: metricConfident ? buildPairNextCall(metricQuery, pair) : null,
        entity: pair.entity,
        metric: pair.metric,
        entity_alternates: pair.entity_alternates,
        metric_alternates: pair.metric_alternates,
      };
    }

    // ---- DISCOVERY path: browse what exists for one name -----------------
    const results = await probe(input.q, undefined, input.label);
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
      const unlisted = gate.kept
        .slice(SELECT_TOP_N)
        .map((n) => ({ name: n.name, type: n.type }));
      return {
        found: false,
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

    const candidates = gate.kept.slice(0, SELECT_TOP_N);

    // Inspect wide, render narrow. Round 1 runs the winner-candidate's FULL
    // drill in parallel with cheap `limit=1` coverage probes of the rest, so
    // the common case (rank 0 is right — 14 of 16 measured) costs one drill,
    // fewer than today's two. Only when rank 0 turns out to have no coverage
    // do we pay a second round, which is the `q="Carnival"` shape.
    const [firstDrill, probes] = await Promise.all([
      drillMatches(candidates.slice(0, RENDER_FULL_N)),
      Promise.all(candidates.slice(RENDER_FULL_N).map((n) => coverageProbe(n))),
    ]);

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
    const best = probes.reduce<(typeof probes)[number] | undefined>(
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
      if (rank0Coverage === 0) {
        // Rank 0 has no list to render, so keeping it costs one summary line
        // and usefully tells the caller the name they typed does resolve
        // ("**SpaceX** — resolved, but Tako holds no metrics for it yet").
        matches = [...firstDrill, ...promotedDrill];
        rendered = [...rendered, best.node];
      } else {
        // Rank 0 has a thin list of its own. Rendering both would spend a
        // second ~8.3k coverage list on the loser, which is the cost
        // RENDER_FULL_N exists to avoid — so it drops to a receipt line,
        // carrying its node id and count for a caller who disagrees.
        matches = promotedDrill;
        rendered = [best.node];
        demoted.push(
          ...firstDrill.map((m) => ({
            name: m.name,
            type: m.type,
            node_id: m.node_id,
            coverage_total: m.coverage.total,
          })),
        );
      }
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
        .map((pr) => ({
          name: pr.node.name,
          type: pr.node.type,
          node_id: pr.node.id,
          coverage_total: pr.total,
        })),
      // Never inspected: name only.
      ...gate.kept
        .slice(SELECT_TOP_N)
        .concat(results.filter((n) => !gate.kept.includes(n)))
        .map((n) => ({ name: n.name, type: n.type })),
    ];

    return {
      // `found` mirrors the summary header: true only when some match carries
      // real coverage. Node resolution alone is not "data" — consumers key off
      // this to narrow `sources` to ["data"]. The un-gated case returned above,
      // so reaching here already means the gate found something plausible.
      found: matches.some(hasLiveCoverage),
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
