/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/v1/graph/related`. Overview mode (no relation, no q) is the
 * coverage map; drill mode (relation=<key>) pages one group. `q` is a single
 * substring filter — to cover several name-variants of a metric, call this
 * tool once per variant (graph calls are free). Wire-guarded against the
 * loose graphRelatedOutputShape facade (not the strict generated schema, whose
 * RelationKind enum drifts — see the handler note).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  graphErrorMessage,
  graphNodeSchema,
  graphRelationSchema,
  graphRelatedOutputShape,
} from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
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
  limit: z.number().int().min(1).max(100).optional().describe(
    "Page size (default 50, max 100).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphRelatedOutputShape);
type GraphNode = z.infer<typeof graphNodeSchema>;
type GraphRelation = z.infer<typeof graphRelationSchema>;
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
 * Dropping `description` and `aliases` from related items is what makes an
 * overview ~2k instead of ~83k. Both are `.optional()` on `graphNodeSchema`,
 * so the slim still conforms to the advertised outputSchema — the reason the
 * design could promise the reduction with "schema unchanged". The top-level
 * `node` keeps its description: it is one record, and it is the node the
 * caller named. For a related item's own detail, call the tool again on its
 * id, or `tako_search` for its values.
 */
function slimRelatedItem(item: GraphNode): GraphNode {
  const slim: GraphNode = { id: item.id, type: item.type, name: item.name };
  if (item.subtype !== undefined) slim.subtype = item.subtype;
  if (item.label !== undefined) slim.label = item.label;
  return slim;
}

function slimRelationGroup(group: GraphRelation): GraphRelation {
  return { ...group, items: group.items.map(slimRelatedItem) };
}

/** Markdown index of the slim shape — one line per related item. */
function renderRelatedMarkdown(output: Output): string {
  const lines: string[] = [];
  const node = output.node;
  lines.push(`**${node.name}** (${node.subtype ?? node.type}) — \`${node.id}\``);
  if (node.description) lines.push("", node.description);

  const groups = output.relation ? [output.relation] : (output.relations ?? []);
  if (groups.length === 0) {
    lines.push("", "No related nodes.");
    return lines.join("\n");
  }
  for (const group of groups) {
    const shown = group.items.length;
    const count = group.total_capped ? `${shown} of ${group.total}+` : `${shown} of ${group.total}`;
    lines.push("", `### ${group.label} (\`${group.key}\`, ${group.kind}) — ${count}`);
    for (const item of group.items) {
      const qualifier = item.subtype ?? item.type;
      lines.push(`- ${item.name} — \`${item.id}\` (${qualifier})`);
    }
    if (group.next_cursor) {
      lines.push(`_More: call again with \`relation: "${group.key}"\` and \`cursor: "${group.next_cursor}"\`._`);
    }
  }
  return lines.join("\n");
}

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
      logWireGuardFailure("tako_graph_related", "output", parsed.error, data);
      throw new Error(
        "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderRelatedMarkdown(output);
  },
  slimStructured(output) {
    const slim: Record<string, unknown> = { node: output.node };
    if (output.relations != null) slim.relations = output.relations.map(slimRelationGroup);
    if (output.relation != null) slim.relation = slimRelationGroup(output.relation);
    if (output.inferred_labels != null) slim.inferred_labels = output.inferred_labels;
    return slim;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
