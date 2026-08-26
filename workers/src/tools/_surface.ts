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
 *
 * `tako_credit_balance` looks like the odd one out — its own description tells
 * the model not to call it preemptively — so do NOT demote it to an opt-in
 * without reading this. `.claude-plugin/plugin.json` pins
 * `https://mcp.tako.com/mcp` with NO query string and the plugin's URL is not
 * user-editable, so `?tools=credit_balance` is not a home a plugin user can
 * reach: opt-in means no Claude Code plugin user can ever check a balance. It
 * costs 394 chars of descriptor (275 description + 119 schema) against this
 * set's 15,912 — 2.5%, and 15x less than `tako_search`. Restraint copy on a
 * listed tool is the copy doing its job, not an argument for hiding it.
 */
export const GENERIC_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_available_data",
  "tako_contents",
  "tako_graph_related",
  "tako_credit_balance",
]);

/**
 * The complete anonymous EXECUTABLE tool surface. The listing is
 * auth-invariant (spec D4): every default tool stays listed on anonymous
 * connections, and a default tool outside this set answers sign-in
 * instructions at dispatch time (see the free-tier gate in `mcp.ts`) instead
 * of executing on the shared account. That is THREE of the five defaults —
 * `tako_contents`, `tako_graph_related` and `tako_credit_balance` — so an
 * anonymous connection lists five tools and only two of them run. `tako_answer`
 * is opt-in via `?tools=answer` (spec D1) and never executes anonymously.
 *
 * It lives HERE, not in `freetier.ts`, because `freetier.ts` imports
 * `TOOL_REGISTRY` — the barrel `scripts/gen-registry.ts` WRITES. A generator
 * that statically imports its own output cannot regenerate a stale one: with
 * a tool file deleted and its line still in `_registry.ts`, `registry:gen`
 * dies with ERR_MODULE_NOT_FOUND before it runs, and `AGENTS.md` forbids the
 * hand-edit that would break the tie. This module is a leaf (type-only
 * imports), so the generator reaches the set without reaching the barrel.
 */
export const FREE_TIER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_available_data",
  "tako_search",
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
 *   was absent, empty, or named nothing recognizable (see
 *   `parseToolsParam`). An empty set resolves to the defaults, not to an empty
 *   listing: `new Set()` was the pre-allowlist idiom for "no opt-ins, serve the
 *   defaults" (named `noOptIns` at four call sites), and a caller carrying that
 *   vocabulary forward must not silently register nothing.
 */
export function resolveToolSet(
  surface: Surface,
  requested: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (surface === "chatgpt") return CHATGPT_TOOL_NAMES;
  if (requested === null || requested.size === 0) return GENERIC_DEFAULT_TOOL_NAMES;
  return requested;
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
