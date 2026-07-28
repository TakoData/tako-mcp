/**
 * Per-client tool-surface membership and annotation resolution.
 *
 * `mcp.ts` uses {@link isToolOnSurface} to decide which tools to register
 * for a request's detected client, and {@link toolAnnotationsForClient} to
 * resolve the annotations that client sees. `scripts/gen-registry.ts` runs
 * the same two functions to validate that `chatgpt-app-submission.json`
 * describes exactly the tools (and annotations) ChatGPT receives from the
 * default production MCP URL over an authenticated connection — sharing
 * one module is what keeps the hand-maintained submission metadata from
 * drifting.
 *
 * The leading underscore keeps this file out of the tool-module scan in
 * `gen-registry.ts` (it is NOT a `ToolModule`).
 */
import { FREE_TIER_TOOL_NAMES, type Tier } from "../freetier.js";
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
 * Auth-required tools that stay DISCOVERABLE (listed) on anonymous ChatGPT
 * connections. ChatGPT's Apps SDK offers the link-account flow per tool
 * from the `tools/list` descriptors — a tool hidden from the anonymous
 * listing can never surface the sign-in UI, so the two submitted tools
 * that need a linked account must still be listed before authentication
 * (developers.openai.com/apps-sdk/build/auth). They are listed, NOT
 * runnable: `registerTool` in `mcp.ts` gates the call at dispatch time
 * and answers with an `_meta["mcp/www_authenticate"]` challenge instead
 * of executing on the shared free-tier account. Every other client keeps
 * the original policy (hidden entirely — a listed tool that errors on
 * call wastes agent turns on hosts with no linking UI to show).
 *
 * This set plus `FREE_TIER_TOOL_NAMES` must EQUAL the tools
 * `chatgpt-app-submission.json` declares — `assertChatgptSubmissionParity`
 * in `gen-registry.ts` enforces the equality in BOTH directions, so
 * removing a name here fails `registry:check` (it would silently drop a
 * submitted tool's link-account affordance), and adding one requires
 * declaring it in the submission.
 */
export const CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES: ReadonlySet<string> =
  new Set(["tako_contents", "tako_visualize"]);

/**
 * Whether a tool is registered for a request. Four gates, in order:
 *
 * 1. Free-tier gate: anonymous connections (`tier: "free"`) see ONLY
 *    `FREE_TIER_TOOL_NAMES` — plus, on ChatGPT, the auth-required
 *    submitted tools in {@link CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES},
 *    which are listed for the link-account UI but blocked at call time
 *    (see the free-tier dispatch gate in `mcp.ts`). The invariant,
 *    stated precisely: a client-controlled User-Agent can widen the
 *    anonymous LISTING (to the fixed, submission-declared set above),
 *    but nothing — not UA, not `?tools=` opt-ins, not
 *    {@link CHATGPT_DEFAULT_ON_TOOL_NAMES} — can widen what anonymous
 *    connections can EXECUTE; that stays exactly `FREE_TIER_TOOL_NAMES`,
 *    enforced again at dispatch time in `mcp.ts`.
 * 2. Opt-in gate: optional tools (see `OPTIONAL_TOOL_ALIASES` in
 *    `_optional.ts`) are excluded from the default surface and registered
 *    only when enabled via the `tools` query param — except tools ChatGPT
 *    keeps by default ({@link CHATGPT_DEFAULT_ON_TOOL_NAMES}). Applied
 *    before client-variant selection so a disabled tool never reaches it.
 * 3. ChatGPT-only tools are hidden from everyone else.
 * 4. ChatGPT-excluded tools are hidden from ChatGPT.
 */
export function isToolOnSurface(
  name: string,
  client: McpClientKind,
  enabledOptionalToolNames: ReadonlySet<string>,
  tier: Tier = "authenticated",
): boolean {
  if (
    tier === "free" &&
    !FREE_TIER_TOOL_NAMES.has(name) &&
    !(
      client === "chatgpt" &&
      CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES.has(name)
    )
  ) {
    return false;
  }
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
 * Which `annotationsByClient` family a client's annotations resolve from.
 *
 * Canonical MCP annotations are reserved for `claude` — the one client
 * family known to read the hints with the MCP spec's meanings. Everything
 * else, INCLUDING `unknown`, resolves the `chatgpt` overrides. The two
 * failure modes are not symmetric: an OpenAI reviewer or directory
 * crawler whose UA `detectMcpClient` doesn't recognize lands on
 * `unknown`, and serving it canonical labels would contradict
 * `chatgpt-app-submission.json` — an app-rejection risk. Serving the
 * Apps-review labels to a generic third-party MCP client merely
 * understates `openWorldHint` on retrieval — cosmetic, and reversible.
 */
export function annotationClientFamily(client: McpClientKind): McpClientKind {
  return client === "claude" ? "claude" : "chatgpt";
}

/**
 * Resolve the annotations a client sees for a tool: the canonical MCP
 * annotations, merged with the tool's own per-client overrides for the
 * client's {@link annotationClientFamily} (see `annotationsByClient` in
 * `types.ts` for why the two exist and the rule that decides which hints
 * diverge).
 */
export function toolAnnotationsForClient(
  tool: Pick<AnyToolModule, "annotations" | "annotationsByClient">,
  client: McpClientKind,
): ToolAnnotations {
  return {
    ...tool.annotations,
    ...tool.annotationsByClient?.[annotationClientFamily(client)],
  };
}
