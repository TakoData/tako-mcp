import type { AnyToolModule } from "./types.js";

/**
 * Keep only the keys the advertised `outputSchema` actually declares.
 *
 * `registerTool` takes a `ZodRawShape`, so the SDK rebuilds our schemas as
 * STRICT `z.object`s and publishes `additionalProperties: false` — the
 * `z.looseObject` looseness we declare them with does not survive
 * registration. Any undeclared key therefore makes a spec-compliant client
 * (the official Python SDK among them) reject the whole result, text block
 * included, on a call the caller has already been billed for.
 *
 * Lives outside `mcp.ts` so `scripts/gen-registry.ts` can build the sample
 * `structuredContent` for `docs/TOOLS.md` through the SAME narrowing the
 * server applies — without importing the MCP SDK (the init-cycle rule
 * `instructions.ts` records).
 */
export function pickDeclared(
  schema: AnyToolModule["outputSchema"],
  value: Record<string, unknown>,
): Record<string, unknown> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (shape === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (key in value) out[key] = value[key];
  }
  return out;
}
