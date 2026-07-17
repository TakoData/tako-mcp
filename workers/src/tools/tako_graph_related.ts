/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/beta/graph/related`. Overview mode (no relation, no q) is the
 * coverage map; drill mode (relation=<key>) pages one group. `q` accepts a
 * string OR an array of strings — because q is substring-matched and a metric
 * has many names, an array fans out to parallel calls and the results are
 * unioned/deduped by node id (graph calls are free). Wire-guarded against the
 * generated GraphRelatedResponse.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphRelatedResponse } from "../generated/schemas.js";
import { graphErrorMessage, graphRelatedOutputShape, mergeRelatedResponses } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION =
  "Explore what a resolved graph node connects to — the map of **what data Tako has** for it. Call with just `node_id` for the **overview**: an ordered set of relation groups (`metrics`, `entities`, `rel:*` named edges like `rel:competes_with`, `siblings`, `part_of`/`members`), each with a preview and `total`/`total_capped` (a capped total means 'N+' — narrow to see more). Pass `relation=<key>` to page one group. `q` is an **optional** case-insensitive substring filter on name+aliases — use it only to target a specific metric/thing (e.g. `q: \"revenue\"`); omit it to browse coverage. Because `q` is substring-matched and a metric has many names, you may pass an **array** of `q` values (e.g. `[\"revenue\",\"sales\",\"net income\"]`) — each is fetched in parallel and the results are unioned/deduped for you. Honesty caveat: related metrics are **table-level** (metrics in datasets that cover the node), so a listed metric is strong evidence, not proof — `tako_search` is the final validator. Empty `items` is a normal answer. Graph calls are free — use them liberally to ground `tako_search`/`tako_answer`.";

const inputSchema = z.object({
  node_id: z.string().min(1).describe("Opaque public id of the node to explore."),
  relation: z.string().min(1).optional().describe(
    "Relation key to page: metrics, entities, siblings, part_of, members, or rel:<phrase>. Omit for the overview of all groups.",
  ),
  q: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
    .optional()
    .describe(
      "Optional case-insensitive substring filter on name+aliases. Pass an array to fetch multiple name-variants in parallel (results are unioned/deduped).",
    ),
  label: z.enum(NER_LABELS).optional().describe(
    "Prefer related nodes with this NER label (boost, not a filter).",
  ),
  infer_label: z.boolean().optional().describe(
    "Auto-detect labels from q (default true server-side, only when q is set).",
  ),
  cursor: z.string().min(1).optional().describe(
    "Pagination cursor (for a single drilled relation; intended for single-q use).",
  ),
  limit: z.number().int().min(1).max(100).optional().describe(
    "Page size (default 50, max 100).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphRelatedOutputShape);
type Output = z.infer<typeof outputSchema>;

const tako_graph_related = {
  name: "tako_graph_related",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Related",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input: Input, ctx): Promise<Output> {
    // Normalise q into a list of filter values; `undefined` means "no q".
    const qList: (string | undefined)[] = Array.isArray(input.q)
      ? input.q
      : input.q !== undefined
        ? [input.q]
        : [undefined];

    const responses = await Promise.all(
      qList.map(async (qVal) => {
        const query: Record<string, string | number | boolean> = {
          node_id: input.node_id,
        };
        if (input.relation !== undefined) query.relation = input.relation;
        if (qVal !== undefined) query.q = qVal;
        if (input.label !== undefined) query.label = input.label;
        if (input.infer_label !== undefined) query.infer_label = input.infer_label;
        if (input.cursor !== undefined) query.cursor = input.cursor;
        if (input.limit !== undefined) query.limit = input.limit;

        let data: unknown;
        try {
          data = await djangoGet<unknown>(
            ctx.env, ctx.token, "/api/beta/graph/related",
            { query, timeoutMs: 15_000 },
          );
        } catch (err) {
          throw new Error(graphErrorMessage(err, "related", input.node_id));
        }
        const wire = GraphRelatedResponse.safeParse(data);
        if (!wire.success) {
          throw new Error(
            "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
          );
        }
        return wire.data;
      }),
    );

    const result = responses.length === 1 ? responses[0]! : mergeRelatedResponses(responses);
    // Re-validate through the advertised facade (parse-don't-cast) so a future
    // facade/wire drift is caught at runtime, matching the sibling tools.
    return outputSchema.parse(result);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
