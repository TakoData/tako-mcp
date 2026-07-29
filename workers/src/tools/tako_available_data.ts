/**
 * `tako_available_data` — the one-shot "what data does Tako have on X?" tool.
 *
 * Runs graph/search → graph/related as a single free, low-latency pipeline and
 * returns a natural-language coverage summary. It is the default discovery
 * entry point that replaces manual chaining of the low-level graph primitives
 * (tako_graph_search / tako_graph_related / tako_graph_node), which are off
 * the default surface and opt-in via `?tools=graph` (see `_optional.ts`).
 *
 * Pipeline: one graph/search, then a parallel batch of graph/related drills for
 * the top EXPAND_TOP_N hits. The drill is type-aware: an entity node → its
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
  buildMatch,
  buildNextCall,
  buildSummary,
  coverageKindFor,
  EXPAND_TOP_N,
  hasLiveCoverage,
  MAX_COVERAGE_NAMES,
  MAX_COVERAGE_PAGES,
  PAGE_LIMIT,
  unavailableMatch,
} from "./_available_data.js";
import type { OtherMatch } from "./_available_data.js";
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
import type { graphRelationSchema } from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import type { ToolModule } from "./types.js";

/** One drilled coverage page (graph/related's `relation` group). */
type GraphRelationPage = z.infer<typeof graphRelationSchema>;

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "Find what proprietary, continuously-updated structured data exists on something — summarized in one call. Free and fast.",
  "",
  "The recommended first step for a data lookup: run this before tako_search / tako_answer whenever you're unsure the data exists or its exact name. It's free, it confirms coverage, and the exact names it returns make the follow-up priced call land precisely instead of guessing. (Skip it only for an obvious open-web query that no data graph would hold.)",
  "",
  'Best for: any "what structured/proprietary data is there on X?" question, and for confirming a specific figure actually exists BEFORE you spend a priced tako_search / tako_answer — a cheap accuracy check that tells you whether the data exists and under exactly what name.',
  "",
  "Works on an entity (a company, person, or place → the metrics tracked on it, e.g. Tesla) or a metric (→ the entities it is tracked across, e.g. Inflation Rate).",
  "",
  "Tips:",
  'Look up ONE name at a time, not a full question: for "Carnival passenger cruise days" pass q="Carnival" and read the metric you want off coverage.names — a whole phrase in `q` resolves nothing.',
  "One metric across many entities → one metric-first call; one entity across many metrics → one entity-first call. The coverage.names answer all of them at once — never loop one call per name.",
  "Pass `label` when you can categorize the term (company → ORG, country → GPE, person → PERSON) — a strong disambiguation boost.",
  "Each match's coverage.names lists the exact metric/entity names — reuse them verbatim in a follow-up tako_search. When the coverage is small enough to be unambiguous, `next_call` is that follow-up prewritten (query + pinned node_ids) — run it verbatim.",
  "A broad entity's coverage list is capped, so it can be truncated: treat a name you don't see as UNCONFIRMED rather than absent, and fall back to the web instead of re-calling this tool to double-check.",
].join("\n");

const inputSchema = z.object({
  q: z.string().min(2).describe(
    'The NAME of one entity or one metric to look up (min 2 chars). Not a full question: for "Carnival passenger cruise days" pass "Carnival" and read the metric off the returned coverage.names.',
  ),
  types: z.enum(["entity", "metric"]).optional().describe(
    'Narrow resolution to a "thing" ("entity") or a "measure" ("metric"). Omit to search both.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer (boost, not a filter). Supply when you can categorize the term (company→ORG, place→GPE, person→PERSON, ...).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const coverageGroupSchema = z.object({
  kind: z.enum(["metrics", "entities"]),
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
// the slim structuredContent shape (found/query/next_call) so hosts that
// count structuredContent toward context don't pay for the content twice.
const fullOutputSchema = z.object({
  found: z.boolean().describe(
    "True when at least one match has live data coverage — not mere node resolution. A resolved node with no coverage (or whose coverage lookup failed) yields false.",
  ),
  query: z.string(),
  summary: z.string(),
  matches: z.array(coverageMatchSchema),
  other_matches: z.array(z.object({ name: z.string(), type: z.string() })),
  next_call: z
    .object({
      tool: z.literal("tako_search"),
      query: z.string(),
      node_ids: z.array(z.string()),
    })
    .nullable()
    .describe(
      "Ready-to-run follow-up, present only when the target is UNAMBIGUOUS — the coverage list is small enough that its top metric is the obvious one: call tako_search with exactly this query and node_ids (pinned) to fetch the confirmed series in one step. Null otherwise (a broad entity's top metric is arbitrary — compose your own entity + metric query from coverage.names instead of spending a priced search on a guess).",
    ),
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
    // 1) Resolve the name to graph nodes.
    const searchQuery: Record<string, string | number | boolean> = {
      q: input.q,
      limit: 10,
    };
    if (input.types !== undefined) searchQuery.types = input.types;
    if (input.label !== undefined) searchQuery.label = input.label;

    let searchRaw: unknown;
    try {
      searchRaw = await djangoGet<unknown>(
        ctx.env, ctx.token, "/api/beta/graph/search",
        { query: searchQuery, timeoutMs: 15_000 },
      );
    } catch (err) {
      // Log the original transport error — wrapping in a plain Error below
      // drops the DjangoError envelope, so this line is the only server-side
      // record of what actually failed.
      console.error("[tako] tool error tool=tako_available_data stage=graph/search:", err);
      throw new Error(graphErrorMessage(err, "search", undefined, "tako_available_data"));
    }
    const search = searchShape.safeParse(searchRaw);
    if (!search.success) {
      logWireGuardFailure("tako_available_data", "graph-search", search.error, searchRaw);
      throw new Error(
        "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }

    const results = search.data.results;
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

    const top = results.slice(0, EXPAND_TOP_N);
    const other_matches: OtherMatch[] = results
      .slice(EXPAND_TOP_N)
      .map((n) => ({ name: n.name, type: n.type }));

    // 3) Drill each top hit's coverage in parallel, type-aware: an entity node
    //    → its `metrics`; a metric node → the `entities` it is tracked across
    //    (drilling `metrics` on a metric node returns empty, which would be a
    //    false "no data"). Per-node error isolation: a failed or malformed
    //    graph/related for one node yields an "unavailable" match rather than
    //    sinking the whole call (auth/connectivity already proven by the search
    //    above). A single-relation drill returns just that group (in `relation`),
    //    smaller and faster than the full overview.
    //
    //    The drill PAGINATES (cursor, PAGE_LIMIT per page) up to
    //    MAX_COVERAGE_NAMES so coverage.names is the COMPLETE list, not a
    //    first-page window: a broad entity's page 1 is dominated by generic
    //    normalized-accounting names in the backend's fixed order, so a
    //    single-page fetch made anything past it ("Net charges-off …" behind
    //    250 boilerplate metrics) undiscoverable. A later-page failure keeps
    //    the pages already fetched (partial names beat "unavailable"); only a
    //    first-page failure degrades the node to unavailable.
    const matches = await Promise.all(
      top.map(async (node) => {
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
              // outage: fall through to buildMatch (a null group on the first
              // page yields the empty coverage the pre-pagination code built).
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
            // pages < MAX_COVERAGE_PAGES is the hard round-trip ceiling: if
            // the server ever serves pages far smaller than PAGE_LIMIT, the
            // drill degrades to fewer names instead of serializing dozens of
            // sequential calls inside a "free, fast" tool.
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

    return {
      // `found` mirrors the summary header: true only when some match carries
      // real coverage. Node resolution alone is not "data" — consumers key off
      // this to narrow `sources` to ["data"].
      found: matches.some(hasLiveCoverage),
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
