/**
 * `tako_graph_node` — hydrate a single graph-node id into full detail.
 *
 * Wraps `GET /api/v1/graph/node/{id}`. Use it when you hold a bare node id
 * (e.g. from a tako_search card's slim `nodes`) and need aliases/subtype/label
 * to compose a grounded query. Validated against the loose graphNodeSchema
 * facade (not the strict generated GraphNode, whose enums drift).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { graphErrorMessage, graphNodeSchema } from "./_graph.js";
import { logWireGuardFailure } from "./_log.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Get full detail for one graph-node `id`: name, aliases, subtype, label, description. Use it when you hold a bare node id — e.g. from a `tako_search` card's `nodes` (only id/name/type) — and need aliases or subtype to ground a query. Free and fast.";

const inputSchema = z.object({
  id: z.string().min(1).describe("Opaque public node id (as returned by graph search/related or on a card's nodes)."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = graphNodeSchema;
type Output = z.infer<typeof outputSchema>;

const tako_graph_node = {
  name: "tako_graph_node",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Node",
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
    const path = `/api/v1/graph/node/${encodeURIComponent(input.id)}`;
    let data: unknown;
    try {
      data = await djangoGet<unknown>(ctx.env, ctx.token, path, {
        timeoutMs: 15_000,
      });
    } catch (err) {
      // Log before wrapping: the plain-Error wrap drops the DjangoError
      // envelope, so this is the only server-side record of the failure.
      console.error("[tako] tool error tool=tako_graph_node stage=graph/node:", err);
      throw new Error(graphErrorMessage(err, "node", input.id));
    }

    // Validate against the LOOSE advertised facade, NOT the generated GraphNode
    // (whose subtype/label enums drift — a new EntityClassName/NerLabel would
    // make a strict guard throw "unexpected shape" on a valid node). The facade
    // keeps those as loose strings; structural breaks still throw.
    const parsed = outputSchema.safeParse(data);
    if (!parsed.success) {
      logWireGuardFailure("tako_graph_node", "output", parsed.error, data);
      throw new Error(
        "Tako graph/node endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_node;
