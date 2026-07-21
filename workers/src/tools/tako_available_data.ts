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
  buildSummary,
  coverageKindFor,
  EXPAND_TOP_N,
  hasLiveCoverage,
  unavailableMatch,
} from "./_available_data.js";
import type { OtherMatch } from "./_available_data.js";
import {
  graphErrorMessage,
  graphRelatedOutputShape,
  graphSearchOutputShape,
} from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "See what proprietary, continuously-updated data Tako has on an entity or metric — resolved to graph nodes and summarized in one call. Free and fast.",
  "",
  "Best for: the first thing to call when you want to know what proprietary data is available (a company, person, place, or measure) before running a priced tako_search / tako_answer.",
  "",
  "How it works: resolves the name to the top graph matches, then reports the live data Tako has for each — the metrics it tracks for an entity (e.g. Tesla), or the entities a metric is tracked across (e.g. Inflation Rate) — as a natural-language summary you can show the user.",
  "",
  "Tips:",
  "Pass `label` when you can categorize the term (company → ORG, country → GPE, person → PERSON) — a strong disambiguation boost.",
  "The exact metric names in the summary are the terms to reuse in a follow-up tako_search (e.g. \"Apple Inc. revenue\").",
].join("\n");

const inputSchema = z.object({
  q: z.string().min(2).describe("Entity or metric name to look up (min 2 chars)."),
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

const outputSchema = z.object({
  found: z.boolean().describe(
    "True when at least one match has live data coverage — not mere node resolution. A resolved node with no coverage (or whose coverage lookup failed) yields false.",
  ),
  query: z.string(),
  summary: z.string(),
  matches: z.array(coverageMatchSchema),
  other_matches: z.array(z.object({ name: z.string(), type: z.string() })),
});
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
  async handler(input: Input, ctx): Promise<Output> {
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
      throw new Error(graphErrorMessage(err, "search", undefined, "tako_available_data"));
    }
    const search = searchShape.safeParse(searchRaw);
    if (!search.success) {
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
    const matches = await Promise.all(
      top.map(async (node) => {
        const relation = coverageKindFor(node.type);
        try {
          const relatedRaw = await djangoGet<unknown>(
            ctx.env, ctx.token, "/api/beta/graph/related",
            { query: { node_id: node.id, relation, limit: 50 }, timeoutMs: 15_000 },
          );
          const related = relatedShape.safeParse(relatedRaw);
          if (!related.success) return unavailableMatch(node);
          return buildMatch(node, related.data.relation);
        } catch {
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
      summary: buildSummary({ query: input.q, matches, otherMatches: other_matches }),
      matches,
      other_matches,
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_available_data;
