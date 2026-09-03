/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/v1/graph/related`. Map mode (no relation) returns each
 * group's key, label, total and a preview of its names; drill mode
 * (relation=<key>) pages one group with the id of every item. `q` is a single
 * substring filter — to cover several name-variants of a metric, call once per
 * variant (graph calls are free). Wire-guarded against the loose
 * `graphRelatedOutputShape` facade (not the strict generated schema, whose
 * RelationKind enum drifts — see the handler note), then projected by
 * `projectRelated` before either channel reads it.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  FIXED_RELATION_KEYS,
  graphErrorMessage,
  graphRelatedOutputShape,
  OVERVIEW_PREVIEW_N,
  projectRelated,
  type ProjectedRelated,
} from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import { graphRelatedSlimOutputShape, renderGraphRelatedMarkdown } from "./_render_markdown.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION = [
  "Explore what a graph node connects to — its metrics, the entities a metric covers, competitors, industry, index membership, and sources.",
  "",
  `Two modes. Pass \`node_id\` alone for the map: every relation group with its key, label, total, and its first ${String(OVERVIEW_PREVIEW_N)} names. Pass \`relation\` to page one group, where each item comes back with the id that explores it. Read a key off the map rather than guessing — an unknown key returns an empty group, not an error.`,
  "",
  "Best for: expanding a node you already resolved. Resolve a name to a node id with `tako_available_data` first. A metric listed here means the graph tracks it, not that a card exists — `tako_search` is the final check.",
].join("\n");

const inputSchema = z.object({
  node_id: z.string().min(1).describe(
    "Public id of the node to explore, as returned by `tako_available_data` or on a `tako_search` card.",
  ),
  relation: z.string().min(1).optional().describe(
    `Relation key to page, taken from the map: ${FIXED_RELATION_KEYS.join(", ")}, or a named edge like rel:competes_with. Omit for the map.`,
  ),
  q: z.string().min(1).optional().describe(
    'Case-insensitive substring filter on names and aliases, one string per call: "revenue" matches `Total Revenue` and misses `Sales`. Call once per name variant.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer among the related nodes — a boost, not a filter.",
  ),
  infer_label: z.boolean().optional().describe(
    "Detect labels from `q`. Omit it and the server infers them whenever `q` is set.",
  ),
  cursor: z.string().min(1).optional().describe(
    "Page handle from a previous drilled relation. Omit it for the first page.",
  ),
  // `limit` is INERT in map mode, and the description must say so or a caller
  // pays a round trip to widen a map that never widens. Two independent caps
  // stack: measured against production, `?node_id=…&limit=3` and `&limit=100`
  // return byte-identical maps (82,741 chars for NVIDIA, 16 groups, every
  // group capped at 10 items) — and on top of that `projectRelated` previews
  // OVERVIEW_PREVIEW_N names per group before either channel sees it. The
  // describe interpolates that constant rather than restating it: a
  // hand-written number contradicts the tool's own cap the moment it moves.
  limit: z.number().int().min(1).max(100).optional().describe(
    `Page size for a drilled relation. Omit it and the server serves 50. Ignored on the map, where every group returns its first ${String(OVERVIEW_PREVIEW_N)} names whatever you pass.`,
  ),
});

type Input = z.infer<typeof inputSchema>;

/** The wire contract — what `graph/related` is allowed to send us. Never advertised. */
const wireSchema = z.object(graphRelatedOutputShape);

// The ADVERTISED output schema: the PROJECTED shape, typed field by field.
// The handler returns an explicit projection, so an unknown backend key cannot
// leak and the schema no longer needs to be the wire facade. One shape for
// both surfaces — this tool mounts no widget, so there is nothing per-surface
// to add.
const outputSchema = graphRelatedSlimOutputShape;
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
    idempotentHint: true,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Reads Tako's own graph and nothing else — a closed, first-party
    // system. MCP's canonical reading (domain of interaction) keeps the
    // generic surface at true; OpenAI's Apps review reading ("operates
    // entirely within closed or private systems" → false) makes it false
    // on the chatgpt surface. See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  fixedInputs: [],
  async handler(input: Input, ctx): Promise<ProjectedRelated> {
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
        { query, timeoutMs: 15_000, caller: ctx.caller },
      );
    } catch (err) {
      // Log before wrapping: the plain-Error wrap drops the DjangoError
      // envelope, so this is the only server-side record of the failure.
      console.error("[tako] tool error tool=tako_graph_related stage=graph/related:", err);
      throw new Error(graphErrorMessage(err, "related", input.node_id, "tako_graph_related"));
    }
    // Validate against the LOOSE wire facade, NOT the generated schema. The
    // generated GraphRelatedResponse enforces a strict RelationKind enum
    // (related|data|sibling|membership) — but the live API also returns
    // kind:"source", which a strict guard rejects as "unexpected shape" even
    // though the response is fine. Same drift class as content_format. The
    // facade keeps kind/type/subtype/label as loose strings, so a new enum
    // value passes while genuine structural breaks still throw.
    const parsed = wireSchema.safeParse(data);
    if (!parsed.success) {
      logWireGuardFailure("tako_graph_related", "output", parsed.error, data);
      throw new Error(
        "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Project AFTER the wire guard: the guard proves the shape, the projection
    // decides what the model pays for. The raw payload cannot ship — Anthropic
    // PBC's 83,487-char map overflowed the MCP result cap outright, and
    // `mcp.ts` would spend it TWICE (text built from JSON.stringify, then the
    // same object as structuredContent). See the size constants in `_graph.ts`.
    return projectRelated(parsed.data);
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderGraphRelatedMarkdown(output as ProjectedRelated);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
