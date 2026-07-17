/**
 * Shared facades + helpers for the graph primitive tools
 * (tako_graph_search / tako_graph_related / tako_graph_node).
 *
 * The generated schemas (GraphNode, GraphRelatedResponse, …) are the wire
 * contract each tool safeParses against. These hand-written facades are the
 * tools' *advertised* output shapes — flat, no z.lazy — mirroring the
 * wire-guard/facade split tako_search already uses so the MCP SDK can emit
 * clean JSON schema for outputs.
 */
import { z } from "zod";

import type { GraphNode, GraphRelatedResponse } from "../generated/schemas.js";

/** Advertised graph-node facade. subtype/label are stringified enums on the
 *  wire; the facade keeps them as loose strings so a new enum value never
 *  breaks the advertised contract. */
export const graphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["metric", "entity"]),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  subtype: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
});

/** Advertised relation-group facade. next_cursor is present only on a drilled
 *  page (relation), absent on overview groups (relations[]). */
export const graphRelationSchema = z.object({
  key: z.string(),
  kind: z.string(),
  label: z.string(),
  items: z.array(graphNodeSchema),
  total: z.number().int(),
  total_capped: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});

export const graphSearchOutputShape = {
  results: z.array(graphNodeSchema),
  inferred_labels: z.array(z.string()).nullable().optional(),
} as const;

export const graphRelatedOutputShape = {
  node: graphNodeSchema,
  relations: z.array(graphRelationSchema).nullable().optional(),
  relation: graphRelationSchema.nullable().optional(),
  inferred_labels: z.array(z.string()).nullable().optional(),
} as const;

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function dedupeStrings<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Union + dedupe (by node id) a set of graph/related responses fetched for
 * different `q` filters into a single response. Called only when the caller
 * passed multiple `q` values — a single response is returned unchanged by the
 * handler and never reaches here.
 *
 * Merged totals reflect the union of returned items, not a server count
 * (multi-`q` is a client-side convenience over the free graph endpoint).
 */
export function mergeRelatedResponses(
  responses: GraphRelatedResponse[],
): GraphRelatedResponse {
  const base = responses[0];
  if (base === undefined) {
    throw new Error("mergeRelatedResponses: empty response list");
  }

  const inferredFlat = dedupeStrings(
    responses.flatMap((r) => r.inferred_labels ?? []),
  );
  const inferred_labels = inferredFlat.length > 0 ? inferredFlat : undefined;

  // Drill mode: every response carries `.relation` for the same key.
  if (base.relation != null) {
    const items = dedupeNodes(responses.flatMap((r) => r.relation?.items ?? []));
    return {
      node: base.node,
      relation: {
        key: base.relation.key,
        kind: base.relation.kind,
        label: base.relation.label,
        items,
        total: items.length,
        total_capped: responses.some((r) => r.relation?.total_capped === true),
        next_cursor: null,
      },
      inferred_labels,
    };
  }

  // Overview mode: union groups by key (first-seen order), union items by id.
  const order: string[] = [];
  const groups = new Map<string, NonNullable<GraphRelatedResponse["relations"]>[number]>();
  for (const r of responses) {
    for (const g of r.relations ?? []) {
      const existing = groups.get(g.key);
      if (existing === undefined) {
        order.push(g.key);
        groups.set(g.key, { ...g, items: [...g.items] });
      } else {
        const items = dedupeNodes([...existing.items, ...g.items]);
        groups.set(g.key, {
          ...existing,
          items,
          total: items.length,
          total_capped: existing.total_capped || g.total_capped,
        });
      }
    }
  }
  return {
    node: base.node,
    relations: order.map((k) => groups.get(k)!),
    inferred_labels,
  };
}
