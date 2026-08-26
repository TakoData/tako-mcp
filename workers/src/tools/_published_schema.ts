/**
 * Render a tool schema exactly as the MCP SDK publishes it on `tools/list`.
 *
 * Do not convert with a bare `z.toJSONSchema()`. `registerTool` is handed
 * `schema.shape` (see `mcp.ts`), rebuilds it as a strict object, and converts
 * with the SDK's `toJsonSchemaCompat(..., { pipeStrategy })`, which on zod v4
 * targets **draft-07**. Zod's own default is 2020-12, so the obvious call
 * emits a `$schema` line no client ever receives — the only byte that differed
 * across all 16 published schemas when `docs/TOOLS.md` was audited, on a page
 * whose first claim is byte-for-byte parity with the wire.
 *
 * `mcp.conformance.test.ts` pins this against a real `tools/list` response, so
 * an SDK bump that changes the dialect fails CI instead of drifting the doc.
 */
import { z } from "zod";

/**
 * The published JSON Schema for one tool schema, or `undefined` when the SDK
 * would publish nothing.
 *
 * Mirrors `mcp.ts` rather than second-guessing it: a schema with no `.shape`
 * is silently NOT advertised there, so rendering one here would document a
 * schema no client receives.
 */
export function publishedJsonSchema(
  schema: z.ZodType<unknown>,
  io: "input" | "output",
): Record<string, unknown> | undefined {
  const shape = (schema as unknown as { shape?: z.ZodRawShape }).shape;
  if (shape === undefined) return undefined;
  return z.toJSONSchema(z.object(shape), { io, target: "draft-7" }) as Record<
    string,
    unknown
  >;
}
