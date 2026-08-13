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
 * Client families that render MCP Apps widgets inline, and therefore get
 * widget `_meta` on their tool registrations instead of the portable
 * inline-PNG `image` content block.
 *
 * ChatGPT renders the widget as a fully interactive iframe; Claude renders
 * the same bundle via its image branch (claude.ai's host CSP blocks the
 * cross-origin iframe today — anthropics/claude-ai-mcp#40 — and the bundle
 * probes for that at runtime). The ChatGPT desktop app (`"codex"`) renders
 * the same interactive iframe as chatgpt.com from its `codex-sandbox://`
 * webview — REQUIRES tako.com's `frame-ancestors` to allow the
 * `codex-sandbox:` scheme (shipped in TakoData/tako#29218; before that
 * deploy the iframe dies with `ERR_BLOCKED_BY_RESPONSE` and the app shows
 * a grey tile where the PNG used to be). Everything else — Cursor,
 * Windsurf, Gemini CLI, LibreChat, Claude Code's terminal client — gets
 * the PNG.
 *
 * This is the ONE definition of "widget client". `mcp.ts` computes
 * `widgetSuppressed` from it, and {@link WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES}
 * below keys off it too, so the tool that ships a widget and the clients that
 * receive widget metadata cannot drift apart (they were two hand-maintained
 * `client === …` comparisons in separate files before).
 */
export function isWidgetClient(client: McpClientKind): boolean {
  return client === "chatgpt" || client === "claude" || client === "codex";
}

/**
 * The ChatGPT PRODUCT family: chatgpt.com's connector AND the merged
 * ChatGPT desktop app (`"codex"`). These share the tool surface — the
 * split agent pair, the anonymous discoverable set, `securitySchemes`
 * injection, the Apps-SDK reauth challenge — because they are the same
 * product with two MCP transports (verified live against the desktop app
 * 2026-08-13: it lists, calls, and auth-gates exactly like chatgpt.com).
 *
 * Deliberately NOT the same predicate as {@link isWidgetClient}: claude is
 * a widget client but not ChatGPT family, and the two sets gate different
 * things — this one the product surface, that one the widget `_meta`.
 * Codex joined `isWidgetClient` only once tako.com's `frame-ancestors`
 * allowed the `codex-sandbox:` scheme (TakoData/tako#29218) — its widget
 * iframe is blocked with `ERR_BLOCKED_BY_RESPONSE` on any backend without
 * that deploy, leaving a grey dead tile where the PNG used to be.
 */
export function isChatGptFamilyClient(client: McpClientKind): boolean {
  return client === "chatgpt" || client === "codex";
}

/**
 * Optional tools that stay on the DEFAULT surface for widget clients
 * ({@link isWidgetClient}).
 *
 * `tako_visualize` is the second chart-widget owner: it turns data the agent
 * already has into a Tako card and auto-chains it into the same
 * `ui://tako/embed/chart` bundle `tako_search` uses. Hiding it behind
 * `?tools=` on a host that renders widgets means the one tool whose entire
 * output is a chart is missing from exactly the place that chart would
 * render. So the membership rule is "does this client render the widget",
 * which is why it keys off {@link isWidgetClient} rather than a hand-listed
 * set of client kinds.
 *
 * Read `isWidgetClient` before assuming this covers "Claude" generally: the
 * classifier deliberately buckets Claude Code (`claude-code/*`, and the
 * Agent SDK under it) as `"unknown"`, because a terminal cannot render a
 * widget. Default-on therefore reaches claude.ai and Claude Desktop and NOT
 * Claude Code — including the Claude Code plugin, whose url is fixed in
 * `plugin.json`. That is the intended outcome, not a gap to close: a
 * terminal client gains no inline chart from this tool, so it would be
 * paying the schema cost below for a link.
 *
 * Non-widget clients still opt in via `?tools=visualize`; there the payoff
 * is a shareable embed URL rather than an inline chart, which is worth the
 * ~3.5k tokens of standing schema only when asked for. That descriptor is
 * by far the largest on the surface (a 20-member discriminated union), so
 * this set is deliberately not "every optional tool with a widget".
 */
export const WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES: ReadonlySet<string> = new Set(
  ["tako_visualize"],
);

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
 *    {@link WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES} — can widen what anonymous
 *    connections can EXECUTE; that stays exactly `FREE_TIER_TOOL_NAMES`,
 *    enforced again at dispatch time in `mcp.ts`.
 *
 *    Note what this ordering means for `tako_visualize` on Claude: it is
 *    default-on for widget clients (gate 2) but NOT free-tier-executable and
 *    NOT anonymous-discoverable, and gate 1 runs first — so an anonymous
 *    Claude connection does not list it, and an authenticated one does. That
 *    is the intended shape (it is a priced, card-minting write), and it is
 *    why adding it to gate 2 could not widen the anonymous surface even if
 *    someone spoofed the UA.
 * 2. Opt-in gate: optional tools (see `OPTIONAL_TOOL_ALIASES` in
 *    `_optional.ts`) are excluded from the default surface and registered
 *    only when enabled via the `tools` query param — except tools widget
 *    clients keep by default ({@link WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES}).
 *    Applied before client-variant selection so a disabled tool never
 *    reaches it.
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
      isChatGptFamilyClient(client) &&
      CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES.has(name)
    )
  ) {
    return false;
  }
  if (
    OPTIONAL_TOOL_NAMES.has(name) &&
    !enabledOptionalToolNames.has(name) &&
    !(isWidgetClient(client) && WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES.has(name))
  ) {
    return false;
  }
  if (CHATGPT_ONLY_TOOL_NAMES.has(name) && !isChatGptFamilyClient(client)) {
    return false;
  }
  if (CHATGPT_EXCLUDED_TOOL_NAMES.has(name) && isChatGptFamilyClient(client)) {
    return false;
  }
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
