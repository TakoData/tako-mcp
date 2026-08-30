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
 * tool, plus graph exploration. Everything else
 * (`tako_search_advanced`, `tako_agent`, `tako_visualize`) is reachable only
 * by naming it in `?tools=`.
 */
export const GENERIC_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_search",
  "tako_available_data",
  "tako_contents",
  "tako_graph_related",
]);

/**
 * The complete anonymous EXECUTABLE tool surface: `tako_search` alone. The
 * listing is auth-invariant (spec D4): every default tool stays listed on
 * anonymous connections, and a default tool outside this set answers sign-in
 * instructions at dispatch time (see the free-tier gate in `mcp.ts`) instead
 * of executing on the shared account. So an anonymous connection lists four
 * tools and one of them runs. `tako_search_advanced` is opt-in via
 * `?tools=search_advanced` (spec D1) and never executes anonymously — it can
 * bill rows.
 *
 * `tako_available_data` LEFT this set on purpose, and the reason is not
 * credits. Graph calls are credit-free, so the per-IP limiter (which counts
 * only calls to tools in this set) was metering a tool that spent nothing.
 * What graph traffic actually consumes is the shared account's per-user rate
 * limit in Django (`graph_explore_user_burst`, 180/minute across EVERY
 * anonymous caller worldwide, since they all authenticate as one key). One
 * `tako_available_data` call fans out into up to ~9 graph requests
 * (`graph/search` + a 4-page coverage drill + candidate probes), so roughly
 * twenty anonymous calls a minute exhausted the bucket for everyone — while
 * `tako_graph_related`, which makes ONE graph request, was refused. With
 * this set at `tako_search` alone, anonymous traffic makes zero graph
 * requests and the tier's only cost is the credit-priced search it meters.
 * The anonymous tier is a taste of search that converts to sign-in, not a
 * discovery surface: a refused call returns the sign-in result, which is the
 * prompt.
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
