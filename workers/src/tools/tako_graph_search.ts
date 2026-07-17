/**
 * `tako_graph_search` — resolve a name to Tako data-graph node(s).
 *
 * Wraps `GET /api/beta/graph/search`. Free + fast. The resolved node ids pin
 * into tako_search / tako_answer (sources.data.node_ids). Wire-guarded against
 * the generated GraphSearchResponse; returns the flat graphSearchOutputShape
 * facade.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphSearchResponse } from "../generated/schemas.js";
import { graphSearchOutputShape } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION =
  "Resolve a name to Tako data-graph node(s) so you can see **what data Tako has** and pin exact nodes into `tako_search`/`tako_answer`. Decide up front whether you're resolving a **thing** (`types: \"entity\"`) or a **measure** (`types: \"metric\"`) — don't mix them in one call. Results are popularity-ordered; read each node's `subtype`/`label`/`description` to pick the right one. `label` is a ranking **boost, not a filter** (off-label nodes still return) — omit it to let `infer_label` auto-detect from `q`. Graph calls are free and efficient: for a narrow 1-entity/1-metric question, run this **in parallel** with your `tako_search`/`tako_answer`; for broader questions, resolve entities here then call `tako_graph_related` to discover their metrics. Each node's `id` pins into `sources.data.node_ids`.";

const inputSchema = z.object({
  q: z.string().min(2).describe("Search text (min 2 chars)."),
  types: z.enum(["entity", "metric"]).optional().describe(
    'Resolve a "thing" ("entity") or a "measure" ("metric"). Omit to search both.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer (boost, not a filter). Omit to let infer_label run.",
  ),
  infer_label: z.boolean().optional().describe(
    "Auto-detect labels from q (default true server-side). Set false to disable.",
  ),
  limit: z.number().int().min(1).max(50).optional().describe(
    "Max results (default 20, max 50).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphSearchOutputShape);
type Output = z.infer<typeof outputSchema>;

const tako_graph_search = {
  name: "tako_graph_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input: Input, ctx): Promise<Output> {
    const query: Record<string, string | number | boolean> = { q: input.q };
    if (input.types !== undefined) query.types = input.types;
    if (input.label !== undefined) query.label = input.label;
    if (input.infer_label !== undefined) query.infer_label = input.infer_label;
    if (input.limit !== undefined) query.limit = input.limit;

    const data = await djangoGet<unknown>(
      ctx.env, ctx.token, "/api/beta/graph/search",
      { query, timeoutMs: 15_000 },
    );

    const wire = GraphSearchResponse.safeParse(data);
    if (!wire.success) {
      throw new Error(
        "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Re-validate through the advertised facade (parse-don't-cast) so a future
    // facade/wire drift is caught at runtime, matching the sibling tools.
    return outputSchema.parse(wire.data);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_search;
