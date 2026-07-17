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

import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "../django.js";
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

/** Which graph endpoint an error came from (drives the tailored guidance). */
export type GraphOp = "search" | "related" | "node";

// The public NER labels graph/search accepts (mirrors NerLabel in the generated
// schema and the tako-graph-agent skill). Listed in the 400 hint so the agent
// can immediately correct a bad `label`.
const NER_LABEL_LIST =
  "PERSON, ORG, GPE, LOC, PRODUCT, EVENT, LANGUAGE, MONEY, METRIC, STOCK_TICKER, WEBSITE";

const NODE_ID_HINT =
  "Node ids come from tako_graph_search / tako_graph_related results or a tako_search card's `nodes` — never a plain name; resolve the name first.";

/**
 * Translate a transport/HTTP error from a `/beta/graph/*` call into an
 * agent-facing message that points at the fix, instead of leaking a raw
 * "Django returned 400 for GET …".
 *
 * Grounded ONLY in the documented graph contract (`openapi/sdk.yaml`:
 * search → 400/503, related → 400/404/503, node → 404/503) and the
 * live-verified behaviours recorded in the tako-graph-agent skill:
 *   - 401 → key missing/invalid, or a key used against the wrong environment
 *     (a prod key is rejected on staging and vice-versa).
 *   - 400 → a bad parameter; on search that is almost always an off-enum
 *     `label` or a bad `types`.
 *   - 404 (related/node) → the NODE ID does not resolve. NB an unknown
 *     `relation` KEY is NOT a 404 — it returns 200 with empty items, so a 404
 *     always means the node id, never the relation.
 *   - 429 → rate limit (~180 req/min); back off and retry.
 *   - 503 → a backing data store is temporarily unavailable; retry with backoff.
 *   - 403 → observed as a Cloudflare/edge block on direct probes; not a query
 *     problem, so it is surfaced as an infra issue, not a "fix your input".
 *
 * `ref` is the node id (related/node) echoed back so the agent sees what failed.
 * Non-transport errors are passed through unmasked.
 */
export function graphErrorMessage(
  err: unknown,
  op: GraphOp,
  ref?: string,
): string {
  const tool = `tako_graph_${op}`;
  const idOf = ref ? `"${ref}"` : "the given id";

  if (err instanceof DjangoUnauthorizedError) {
    return `${tool}: Tako rejected the API key (401). Make sure the token is set and matches the environment — a production key is rejected on staging and vice-versa.`;
  }

  if (err instanceof DjangoBadRequestError) {
    const detail = err.body ? ` Backend detail: ${err.body.slice(0, 200)}` : "";
    if (op === "search") {
      return `${tool}: invalid request (400). Most often a bad \`label\` — valid values are ${NER_LABEL_LIST}; omit \`label\` to let inference run. \`types\` must be "entity" or "metric" (resolve one kind per call).${detail}`;
    }
    if (op === "related") {
      return `${tool}: invalid request (400). Confirm \`node_id\` is an id from a graph result (not a name); to filter use \`q\`, to page a group use a valid \`relation\` key (metrics, entities, siblings, part_of, members, or rel:<phrase>).${detail}`;
    }
    return `${tool}: invalid node id (400) for ${idOf}. ${NODE_ID_HINT}${detail}`;
  }

  if (err instanceof DjangoNotFoundError) {
    if (op === "related") {
      return `${tool}: no graph node with id ${idOf} (404). Resolve the entity/metric with tako_graph_search first and pass the \`id\` it returns. (An unknown \`relation\` is NOT a 404 — it returns empty items, so this means the node id itself.)`;
    }
    if (op === "node") {
      return `${tool}: no graph node with id ${idOf} (404). ${NODE_ID_HINT}`;
    }
    return `${tool}: not found (404).`;
  }

  if (err instanceof DjangoTimeoutError) {
    return `${tool}: the graph request timed out. Graph calls are normally fast — retry once; if it persists the service may be degraded.`;
  }

  if (err instanceof DjangoHttpError) {
    if (err.status === 429) {
      return `${tool}: rate limited (429). The graph API allows ~180 requests/min — back off briefly (jittered) and retry, and pace any parallel fan-out.`;
    }
    if (err.status === 503) {
      return `${tool}: the graph data store is temporarily unavailable (503). Retry after a short backoff.`;
    }
    if (err.status === 403) {
      return `${tool}: the request was blocked (403) before reaching the graph service (likely an edge/WAF rule) — this is not a query problem. Flag it to the Tako team.`;
    }
    const detail = err.body ? ` ${err.body.slice(0, 200)}` : "";
    return `${tool}: graph request failed (HTTP ${err.status}).${detail} Retry once; if it persists, flag it to the Tako team.`;
  }

  if (err instanceof DjangoError) {
    // e.g. DjangoResponseParseError — a 2xx whose body wasn't JSON.
    return `${tool}: the graph API returned an unreadable (non-JSON) response, possibly an edge error page. Retry once; if it persists, flag it to the Tako team.`;
  }

  // Not a transport error — surface it rather than masking it.
  return `${tool}: unexpected error — ${err instanceof Error ? err.message : String(err)}`;
}

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

function dedupeValues<T>(values: T[]): T[] {
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

  const inferredFlat = dedupeValues(
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
