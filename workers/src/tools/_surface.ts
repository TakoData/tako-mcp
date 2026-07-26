/**
 * Per-client tool-surface membership and annotation resolution.
 *
 * `mcp.ts` uses {@link isToolOnSurface} to decide which tools to register
 * for a request's detected client, and {@link toolAnnotationsForClient} to
 * resolve the annotations that client sees. `scripts/gen-registry.ts` runs
 * the same two functions to validate that `chatgpt-app-submission.json`
 * describes exactly the tools (and annotations) ChatGPT receives from the
 * default production MCP URL — sharing one module is what keeps the
 * hand-maintained submission metadata from drifting.
 *
 * The leading underscore keeps this file out of the tool-module scan in
 * `gen-registry.ts` (it is NOT a `ToolModule`).
 */
import { OPTIONAL_TOOL_NAMES } from "./_optional.js";
import type {
  AnyToolModule,
  McpClientKind,
  ToolAnnotations,
} from "./types.js";

/**
 * Tools that should ONLY appear on ChatGPT-class clients.
 *
 * ChatGPT's Apps SDK doesn't send a progressToken, so the single-tool
 * `tako_agent` dispatch+poll path (which emits progress to keep the
 * per-call timeout fresh) can't survive ChatGPT's ~60 s ceiling. The
 * split pair `tako_agent_start` / `tako_agent_wait` is used instead.
 *
 * Hosting them only on the clients that need them keeps the Claude.ai
 * tool surface minimal (no risk of the agent there accidentally choosing
 * the slower split flow over the single-call path) and keeps the registry
 * codegen unchanged (registry/server.json still lists everything for
 * discovery; the runtime just filters per request).
 */
export const CHATGPT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_agent_start",
  "tako_agent_wait",
]);

/**
 * Tools registered for all clients EXCEPT ChatGPT. The dispatch+poll
 * `tako_agent` relies on `notifications/progress` for timeout extension —
 * suppress it for chatgpt (which doesn't support that mechanism) and
 * route to the split pair instead.
 */
export const CHATGPT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_agent",
]);

/**
 * Optional tools that stay on the DEFAULT surface for ChatGPT only.
 * `tako_visualize` ships the chart widget ChatGPT renders; hiding it
 * behind `?tools=` would silently break the ChatGPT app experience,
 * so ChatGPT keeps it without opting in. Every other client must
 * enable it via `?tools=visualize`.
 */
export const CHATGPT_DEFAULT_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tako_visualize",
]);

/**
 * Whether a tool is registered for a request. Three gates, in order:
 *
 * 1. Opt-in gate: optional tools (see `OPTIONAL_TOOL_ALIASES` in
 *    `_optional.ts`) are excluded from the default surface and registered
 *    only when enabled via the `tools` query param — except tools ChatGPT
 *    keeps by default ({@link CHATGPT_DEFAULT_ON_TOOL_NAMES}). Applied
 *    first so a disabled tool never reaches client-variant selection.
 * 2. ChatGPT-only tools are hidden from everyone else.
 * 3. ChatGPT-excluded tools are hidden from ChatGPT.
 */
export function isToolOnSurface(
  name: string,
  client: McpClientKind,
  enabledOptionalToolNames: ReadonlySet<string>,
): boolean {
  if (
    OPTIONAL_TOOL_NAMES.has(name) &&
    !enabledOptionalToolNames.has(name) &&
    !(client === "chatgpt" && CHATGPT_DEFAULT_ON_TOOL_NAMES.has(name))
  ) {
    return false;
  }
  if (CHATGPT_ONLY_TOOL_NAMES.has(name) && client !== "chatgpt") return false;
  if (CHATGPT_EXCLUDED_TOOL_NAMES.has(name) && client === "chatgpt") return false;
  return true;
}

/**
 * Resolve the annotations a client sees for a tool: the canonical MCP
 * annotations, merged with the tool's own per-client overrides (see
 * `annotationsByClient` in `types.ts` for why the two exist and the rule
 * that decides which hints diverge).
 */
export function toolAnnotationsForClient(
  tool: Pick<AnyToolModule, "annotations" | "annotationsByClient">,
  client: McpClientKind,
): ToolAnnotations {
  return { ...tool.annotations, ...tool.annotationsByClient?.[client] };
}
