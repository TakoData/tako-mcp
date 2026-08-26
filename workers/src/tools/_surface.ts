/**
 * Per-surface tool membership and annotation resolution.
 *
 * The request PATH decides the surface (`surface.ts`): `/mcp` is the
 * generic surface every client shares; `/mcp/chatgpt` is the OAuth-required
 * surface submitted to OpenAI's app directory. Nothing here reads the
 * client User-Agent (spec D2) and nothing here varies by tier — the tool
 * LISTING is auth-invariant (spec D4); anonymous EXECUTION is gated at
 * dispatch time in `mcp.ts`, keyed on `FREE_TIER_TOOL_NAMES`.
 *
 * `mcp.ts` uses {@link isToolOnSurface} to decide which tools to register
 * for a request, and {@link toolAnnotationsForSurface} to resolve the
 * annotations that surface sees. `scripts/gen-registry.ts` runs the same
 * two functions to validate that `chatgpt-app-submission.json` describes
 * exactly the tools (and annotations) ChatGPT receives from
 * `https://mcp.tako.com/mcp/chatgpt` — sharing one module is what keeps
 * the hand-maintained submission metadata from drifting.
 *
 * The leading underscore keeps this file out of the tool-module scan in
 * `gen-registry.ts` (it is NOT a `ToolModule`).
 */
import type { Surface } from "../surface.js";
import { OPTIONAL_TOOL_NAMES } from "./_optional.js";
import type { AnyToolModule, ToolAnnotations } from "./types.js";

/**
 * Tools that appear ONLY on the chatgpt surface.
 *
 * ChatGPT's Apps SDK doesn't send a progressToken, so the single-tool
 * `tako_agent` dispatch+poll path (which emits progress to keep the
 * per-call timeout fresh) can't survive ChatGPT's ~60 s ceiling. The
 * split pair `tako_agent_start` / `tako_agent_wait` is used instead.
 *
 * Hosting them only on the surface that needs them keeps the generic
 * surface minimal (no risk of an agent there accidentally choosing the
 * slower split flow over the single-call path) and keeps the registry
 * codegen unchanged (registry/server.json still lists everything for
 * discovery; the runtime just filters per request).
 */
export const CHATGPT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_agent_start",
  "tako_agent_wait",
]);

/**
 * Tools registered on every surface EXCEPT chatgpt. The dispatch+poll
 * `tako_agent` relies on `notifications/progress` for timeout extension —
 * ChatGPT doesn't support that mechanism, so the chatgpt surface routes
 * to the split pair instead.
 */
export const CHATGPT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_agent",
]);

/**
 * Optional tools that stay on the DEFAULT chatgpt surface (spec D16).
 *
 * `tako_visualize` turns data the agent already has into a Tako card and
 * auto-chains it into the same `ui://tako/embed/chart` widget bundle
 * `tako_search` uses. Hiding it behind `?tools=` on the one surface whose
 * host renders that widget inline means the tool whose entire output is a
 * chart would be missing from exactly the place the chart renders.
 *
 * The generic surface keeps it opt-in (`?tools=visualize`): there the
 * payoff is a shareable embed URL rather than an inline chart, which is
 * worth the ~3.5k tokens of standing schema (a 20-member discriminated
 * union — by far the largest descriptor on the surface) only when asked
 * for.
 */
export const CHATGPT_DEFAULT_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_visualize",
]);

/**
 * Whether a tool is registered for a request. Three gates, in order:
 *
 * 1. Opt-in gate: optional tools (see `OPTIONAL_TOOL_ALIASES` in
 *    `_optional.ts`) are excluded from the default surface and registered
 *    only when enabled via the `tools` query param — except the tools the
 *    chatgpt surface keeps by default
 *    ({@link CHATGPT_DEFAULT_ON_TOOL_NAMES}).
 * 2. ChatGPT-only tools are hidden from every other surface.
 * 3. ChatGPT-excluded tools are hidden from the chatgpt surface.
 *
 * Deliberately NO tier gate: the listing is auth-invariant (spec D4).
 * What an anonymous connection can EXECUTE is `FREE_TIER_TOOL_NAMES`,
 * enforced at dispatch time in `mcp.ts` — a listed tool outside that set
 * (e.g. `tako_contents`) answers sign-in instructions instead of running.
 */
export function isToolOnSurface(
  name: string,
  surface: Surface,
  enabledOptionalToolNames: ReadonlySet<string>,
): boolean {
  if (
    OPTIONAL_TOOL_NAMES.has(name) &&
    !enabledOptionalToolNames.has(name) &&
    !(surface === "chatgpt" && CHATGPT_DEFAULT_ON_TOOL_NAMES.has(name))
  ) {
    return false;
  }
  if (CHATGPT_ONLY_TOOL_NAMES.has(name) && surface !== "chatgpt") return false;
  if (CHATGPT_EXCLUDED_TOOL_NAMES.has(name) && surface === "chatgpt") {
    return false;
  }
  return true;
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
