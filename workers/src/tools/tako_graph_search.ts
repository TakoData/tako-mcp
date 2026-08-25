/**
 * `tako_graph_search` — resolve a name to Tako data-graph node(s).
 *
 * Wraps `GET /api/v1/graph/search`. Free + fast. The resolved node ids pin
 * into tako_search / tako_answer (sources.data.node_ids). Validated against the
 * loose graphSearchOutputShape facade (not the strict generated schema, whose
 * enums drift — see the handler note).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { graphErrorMessage, graphSearchOutputShape } from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "Resolve a name to Tako data-graph node ids — to see what Tako has, and to pin one into `tako_search` / `tako_answer`. Free and fast.",
  "",
  "Best for: grounding a query, or checking whether Tako covers an entity or metric.",
  "",
  "Pin the METRIC node id ALONE, with `strict: true`, and name the entity in the query text — pinning an entity id, or pinning without strict, does not steer retrieval.",
  "",
  "Tips:",
  'One kind per call — a thing (`types: "entity"`) or a measure (`types: "metric"`), not both.',
  "Pass `label` when you can categorize the term (company → ORG, country → GPE, person → PERSON) — a strong disambiguation boost.",
  "To see an entity's data, resolve it here, then call `tako_graph_related` on its id.",
].join("\n");

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
  annotationsBySurface: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
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
        ctx.env, ctx.token, "/api/v1/graph/search",
        { query, timeoutMs: 15_000 },
      );
    } catch (err) {
      // Log before wrapping: the plain-Error wrap drops the DjangoError
      // envelope, so this is the only server-side record of the failure.
      console.error("[tako] tool error tool=tako_graph_search stage=graph/search:", err);
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
      logWireGuardFailure("tako_graph_search", "output", parsed.error, data);
      throw new Error(
        "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_search;
