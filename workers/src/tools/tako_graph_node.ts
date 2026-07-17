/**
 * `tako_graph_node` — hydrate a single graph-node id into full detail.
 *
 * Wraps `GET /api/beta/graph/node/{id}`. Use it when you hold a bare node id
 * (e.g. from a tako_search card's slim `nodes`) and need aliases/subtype/label
 * to compose a grounded query. Wire-guarded against the generated GraphNode.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphNode } from "../generated/schemas.js";
import { graphErrorMessage, graphNodeSchema } from "./_graph.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Hydrate a single graph-node `id` into full detail (name, `aliases`, `subtype`, `label`, `description`). Use it when you have a bare node id — e.g. one returned on a `tako_search` card's `nodes` (which carry only id/name/type) — and need its aliases/subtype to compose a grounded query or confirm what it is. Free and efficient.";

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
  async handler(input: Input, ctx): Promise<Output> {
    const path = `/api/beta/graph/node/${encodeURIComponent(input.id)}`;
    let data: unknown;
    try {
      data = await djangoGet<unknown>(ctx.env, ctx.token, path, {
        timeoutMs: 15_000,
      });
    } catch (err) {
      throw new Error(graphErrorMessage(err, "node", input.id));
    }

    const wire = GraphNode.safeParse(data);
    if (!wire.success) {
      throw new Error(
        "Tako graph/node endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Re-validate through the advertised facade (parse-don't-cast) so a future
    // facade/wire drift is caught at runtime, matching the sibling tools.
    return outputSchema.parse(wire.data);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_node;
