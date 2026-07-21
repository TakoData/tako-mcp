/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/beta/graph/related`. Overview mode (no relation, no q) is the
 * coverage map; drill mode (relation=<key>) pages one group. `q` is a single
 * substring filter — to cover several name-variants of a metric, call this
 * tool once per variant (graph calls are free). Wire-guarded against the
 * loose graphRelatedOutputShape facade (not the strict generated schema, whose
 * RelationKind enum drifts — see the handler note).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { graphErrorMessage, graphRelatedOutputShape } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "Explore what a resolved graph node connects to — the map of what data Tako has for it. Free.",
  "",
  "Best for: checking coverage after resolving a node with `tako_graph_search`.",
  "",
  'Drilling `relation: "metrics"` returns only that node\'s metrics group — the smallest, cheapest view of what data Tako holds for it. The full overview (`node_id` alone) also returns entities, siblings, and named edges, at more tokens.',
  'Filtering with `q` ("revenue") narrows to a single metric. A listed metric is table-level evidence, not proof — `tako_search` is the final validator.',
].join("\n");

const inputSchema = z.object({
  node_id: z.string().min(1).describe("Opaque public id of the node to explore."),
  relation: z.string().min(1).optional().describe(
    "Relation key to page: metrics, entities, siblings, part_of, members, or rel:<phrase>. Omit for the overview of all groups.",
  ),
  q: z.string().min(1).optional().describe(
    "Optional case-insensitive substring filter on name+aliases (single string). For several name-variants of a metric, call the tool once per variant.",
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
    const query: Record<string, string | number | boolean> = {
      node_id: input.node_id,
    };
    if (input.relation !== undefined) query.relation = input.relation;
    if (input.q !== undefined) query.q = input.q;
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
    // Validate against the LOOSE advertised facade, NOT the generated schema.
    // The generated GraphRelatedResponse enforces a strict RelationKind enum
    // (related|data|sibling|membership) — but the live API also returns
    // kind:"source", which a strict guard rejects as "unexpected shape" even
    // though the response is fine. Same drift class as content_format. The
    // facade keeps kind/type/subtype/label as loose strings, so a new enum
    // value passes while genuine structural breaks still throw.
    const parsed = outputSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
