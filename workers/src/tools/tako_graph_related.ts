/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/v1/graph/related`. Overview mode (no relation, no q) returns
 * each group's key, label, total, and its first three items; drill mode
 * (relation=<key>) pages one group. Items are slimmed to id, name, type,
 * subtype, label — see `slimRelatedResponse`. `q` is a single substring filter
 * — to cover several name-variants of a metric, call this tool once per
 * variant (graph calls are free). Wire-guarded against the
 * loose graphRelatedOutputShape facade (not the strict generated schema, whose
 * RelationKind enum drifts — see the handler note).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { graphErrorMessage, graphRelatedOutputShape, slimRelatedResponse } from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import { renderGraphRelatedMarkdown } from "./_render_markdown.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "Explore what a graph node connects to — the map of what data Tako has for it. Free.",
  "",
  "Best for: drilling into a node after `tako_available_data` resolved it — its metrics, the entities a metric covers, competitors (`rel:competes_with`), subsidiaries, index or group membership (`part_of`, `members`), and sources.",
  "",
  'Drilling `relation: "metrics"` returns only that node\'s metrics group — the smallest, cheapest view of what data Tako holds for it. The full overview (`node_id` alone) also returns entities, siblings, and named edges, at more tokens.',
  'Filtering with `q` ("revenue") narrows to matching names. A listed metric is table-level evidence, not proof — `tako_search` is the final validator.',
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
  // Measured against production, not inferred: `?node_id=…&limit=3` and
  // `&limit=100` return byte-identical overviews (82,741 chars for NVIDIA, 16
  // groups, every group capped at 10 items). `limit` is INERT in overview mode
  // — the server caps each group at 10 — so a caller that raises it to widen
  // the coverage map gets nothing and pays a round trip. The backend's own
  // OpenAPI description has the same gap; this one states the restriction
  // because the model reads it.
  limit: z.number().int().min(1).max(100).optional().describe(
    "Page size for a DRILLED relation (default 50, max 100). Ignored in overview mode, where each group returns at most 10 items.",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphRelatedOutputShape);
type Output = z.infer<typeof outputSchema>;

/**
 * The payload the MCP layer must not forward whole. `graph/related` returns
 * the FULL node record for every related item, and the description dominates:
 * the Nvidia overview measures 82,741 chars at `limit: 5` — ~849 chars per
 * item — and Anthropic PBC's 83,487 overflowed the MCP result cap outright.
 * A default-listed tool cannot spend that, and it would spend it TWICE:
 * `mcp.ts` builds the text channel from `JSON.stringify(output)` when no
 * `renderText` exists, then emits the same object as `structuredContent`.
 *
 * The slimming therefore runs in the HANDLER (`slimRelatedResponse`), before
 * either channel can read the output — dropping `description` and `aliases`
 * from related items, and keeping only the first `OVERVIEW_PREVIEW_N` items
 * of each overview group next to its true `total`. Every dropped field is
 * `.optional()` on `graphNodeSchema`, so the slim still conforms to the
 * advertised outputSchema. `slimStructured` re-applies the same function so
 * the hook stays honest if a caller hands it an unslimmed record; it is
 * idempotent. The focal `node` keeps its aliases and a bounded description:
 * it is one record, and it is the node the caller named. For a related
 * item's own detail, call the tool again on its id.
 *
 * Measured on staging 2026-08-26: Anthropic PBC's 17-group overview is 87,556
 * chars on the wire and reaches the model as 2,108 chars of text plus 6,787
 * of structuredContent; NVIDIA's is 87,798 → 2,014 / 6,788.
 */

const tako_graph_related = {
  name: "tako_graph_related",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Related",
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
  fixedInputs: [],
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
        ctx.env, ctx.token, "/api/v1/graph/related",
        { query, timeoutMs: 15_000 },
      );
    } catch (err) {
      // Log before wrapping: the plain-Error wrap drops the DjangoError
      // envelope, so this is the only server-side record of the failure.
      console.error("[tako] tool error tool=tako_graph_related stage=graph/related:", err);
      throw new Error(graphErrorMessage(err, "related", input.node_id, "tako_graph_related"));
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
      logWireGuardFailure("tako_graph_related", "output", parsed.error, data);
      throw new Error(
        "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Slim AFTER the wire guard: the guard proves the shape, the slimmer
    // decides what the model pays for. See the size constants in _graph.ts.
    return slimRelatedResponse(parsed.data);
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderGraphRelatedMarkdown(output);
  },
  slimStructured(output) {
    // Idempotent: the handler already slimmed. Kept because the hook is the
    // contract `mcp.ts` reads, and a caller that constructs an output by hand
    // must not be able to publish a fat one.
    return slimRelatedResponse(output);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
