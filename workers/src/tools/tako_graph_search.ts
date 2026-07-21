/**
 * `tako_graph_search` — resolve a name to Tako data-graph node(s).
 *
 * Wraps `GET /api/beta/graph/search`. Free + fast. The resolved node ids pin
 * into tako_search / tako_answer (sources.data.node_ids). Validated against the
 * loose graphSearchOutputShape facade (not the strict generated schema, whose
 * enums drift — see the handler note).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { graphErrorMessage, graphSearchOutputShape } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION =
  "Resolve a name to Tako data-graph node(s) — the index of **what data Tako has**. Two jobs: **(1) ground before searching** — resolve entities/metrics and pin their ids into `tako_search`/`tako_answer` `node_ids`, especially when the user explicitly wants Tako/proprietary data; **(2) verify coverage after a miss** — when `tako_search`/`tako_answer` returns no Tako cards (or off-target ones), resolve the entity here, then `tako_graph_related` to find **adjacent metrics Tako does have**, or to confirm Tako lacks the data so you can say so instead of retrying blind rephrasings. Decide up front whether you're resolving a **thing** (`types: \"entity\"`) or a **measure** (`types: \"metric\"`) — don't mix them in one call. Results are popularity-ordered; read each node's `subtype`/`label`/`description` to pick the right one. **Pass `label` when you can categorize the term** (company→`ORG`, country→`GPE`, person→`PERSON`) — a strong disambiguation boost, not a filter; omit only when unsure (`infer_label`, on by default, then guesses from `q`). Graph calls are free and efficient: for a narrow 1-entity/1-metric question, run this **in parallel** with your `tako_search`/`tako_answer`; for broader questions, resolve entities here then call `tako_graph_related` to discover their metrics. Each node's `id` pins into `sources.data.node_ids`.";

const inputSchema = z.object({
  q: z.string().min(2).describe("Search text (min 2 chars)."),
  types: z.enum(["entity", "metric"]).optional().describe(
    'Resolve a "thing" ("entity") or a "measure" ("metric"). Omit to search both.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer (boost, not a filter). PREFER supplying this when you can categorize the term (company→ORG, place→GPE, person→PERSON, ...); omit only when unsure, and infer_label will guess from q.",
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

    let data: unknown;
    try {
      data = await djangoGet<unknown>(
        ctx.env, ctx.token, "/api/beta/graph/search",
        { query, timeoutMs: 15_000 },
      );
    } catch (err) {
      throw new Error(graphErrorMessage(err, "search"));
    }

    // Validate against the LOOSE advertised facade, NOT the generated schema.
    // The generated GraphSearchResponse enforces strict enums (NerLabel,
    // EntityClassName, ...) that drift: when the backend adds a value the
    // committed enum lacks, a strict guard turns a benign addition into a total
    // "unexpected shape" outage (already seen with content_format and with a
    // graph/related kind of "source"). The facade keeps these fields as loose
    // strings, so structural breaks still throw but new enum values pass.
    const parsed = outputSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_search;
