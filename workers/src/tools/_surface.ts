/**
 * Per-surface tool membership and annotation resolution.
 *
 * The request PATH decides the surface (`surface.ts`); the `?tools=` query
 * param (parsed by `_tools_param.ts`) can replace the generic surface's
 * default listing with an allowlist (spec D1). The chatgpt surface is FIXED
 * (spec D2): OpenAI snapshots the tool list at submission, so nothing may
 * add to or remove from it per request — the param is ignored there.
 *
 * Nothing here varies by tier: the LISTING is auth-invariant (spec D4 of the
 * surface-split design); anonymous EXECUTION is gated at dispatch in
 * `mcp.ts`, keyed on `FREE_TIER_TOOL_NAMES`.
 *
 * `mcp.ts` registers exactly `resolveToolSet(surface, requested)`.
 * `scripts/gen-registry.ts` calls the same function to validate
 * `chatgpt-app-submission.json` and to emit `docs/TOOLS.md`, so the
 * submission, the docs, and the runtime cannot drift apart.
 *
 * The leading underscore keeps this file out of the tool-module scan in
 * `gen-registry.ts` (it is NOT a `ToolModule`).
 */
import type { Surface } from "../surface.js";
import type { AnyToolModule, ToolAnnotations } from "./types.js";

/**
 * Default listing on `/mcp` (spec D3). Search + fetch + the free coverage
 * tool, plus graph exploration and the balance lookup. Everything else
 * (`tako_answer`, `tako_agent`, `tako_visualize`) is reachable only by
 * naming it in `?tools=`.
 */
export const GENERIC_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_available_data",
  "tako_contents",
  "tako_graph_related",
  "tako_credit_balance",
]);

/**
 * The listing on `/mcp/chatgpt` — exactly the tools submitted to OpenAI
 * (`chatgpt-app-submission.json`). Any change here is a resubmission.
 */
export const CHATGPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_available_data",
  "tako_contents",
  "tako_visualize",
  "tako_graph_related",
]);

/**
 * The tools a request registers.
 *
 * @param requested the parsed `?tools=` allowlist, or `null` when the param
 *   was absent, empty, or named nothing recognisable (see
 *   `parseToolsParam`). Never an empty set: the surface is never empty.
 */
export function resolveToolSet(
  surface: Surface,
  requested: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (surface === "chatgpt") return CHATGPT_TOOL_NAMES;
  return requested ?? GENERIC_DEFAULT_TOOL_NAMES;
}

/** Whether one tool is registered for a request — see {@link resolveToolSet}. */
export function isToolOnSurface(
  name: string,
  surface: Surface,
  requested: ReadonlySet<string> | null,
): boolean {
  return resolveToolSet(surface, requested).has(name);
}

/**
 * Resolve the annotations a surface sees for a tool: the canonical MCP
 * annotations (what the generic surface and the generated registry serve),
 * merged with the tool's `annotationsBySurface.chatgpt` overrides on the
 * chatgpt surface (see `annotationsBySurface` in `types.ts` for the
 * openWorldHint semantic fork that makes the override necessary).
 */
export function toolAnnotationsForSurface(
  tool: Pick<AnyToolModule, "annotations" | "annotationsBySurface">,
  surface: Surface,
): ToolAnnotations {
  return surface === "chatgpt"
    ? { ...tool.annotations, ...tool.annotationsBySurface?.chatgpt }
    : { ...tool.annotations };
}
