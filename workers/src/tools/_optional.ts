/**
 * Opt-in ("optional") MCP tools and the aliases that enable them.
 *
 * Most tools are registered on every connection. A small set is opt-in: it is
 * excluded from the default surface and registered only when the client
 * explicitly asks for it via the `tools` query parameter on the MCP URL
 * (e.g. `.../mcp?tools=agent`), mirroring how Exa exposes its optional tools.
 *
 * This module is the single source of truth for that mapping. The leading
 * underscore keeps it out of the tool-file scan in `gen-registry.ts` (it is
 * NOT a `ToolModule`); `mcp.ts` imports it to gate registration per request.
 */

/**
 * Alias → the tool names it enables.
 *
 * `agent` spans all three agent tool files: the single-call `tako_agent`
 * (Claude / unknown clients) and the `tako_agent_start` / `tako_agent_wait`
 * split pair (ChatGPT). The alias enables the *feature*; the per-client
 * filters in `mcp.ts` (`CHATGPT_ONLY_TOOL_NAMES` / `CHATGPT_EXCLUDED_TOOL_NAMES`)
 * then narrow to the correct variant for the calling client. Users never need
 * to know the split exists — they enable `agent` and get the right tool.
 *
 * `visualize` and `credits` are single-tool aliases: these
 * tools are useful but rarely needed, so they are kept off the default
 * surface to save per-session context. They compose freely, e.g.
 * `?tools=visualize,credits`. Exception: `tako_visualize` stays on the
 * default surface for ChatGPT clients (it powers the chart widget) — see
 * `CHATGPT_DEFAULT_ON_TOOL_NAMES` in `mcp.ts`.
 *
 * `graph` enables the three low-level graph primitives (search / related /
 * node). `tako_available_data` covers the common discovery path in one call,
 * so these are off the default surface — but the primitives expose
 * capabilities it does not (traversal relations like `siblings`/`members`,
 * server-side `q` filtering within a relation, cursor paging, full node
 * detail), so power users get them back with `?tools=graph`.
 *
 * Only aliases are recognized on the wire (not raw tool names), so this table
 * is also the complete, closed set of tokens `?tools=` accepts.
 */
export const OPTIONAL_TOOL_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  agent: ["tako_agent", "tako_agent_start", "tako_agent_wait"],
  visualize: ["tako_visualize"],
  credits: ["get_credit_balance"],
  graph: ["tako_graph_search", "tako_graph_related", "tako_graph_node"],
};

/**
 * Every tool name that is opt-in — i.e. excluded from the default surface and
 * registered only when enabled. Derived from `OPTIONAL_TOOL_ALIASES` so the
 * alias table stays the sole source of truth.
 */
export const OPTIONAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(OPTIONAL_TOOL_ALIASES).flat(),
);

/**
 * Resolve the raw `tools` query-param value into the set of opt-in tool names
 * to register for this request.
 *
 * Tokens are comma-separated; each is trimmed, lowercased, and de-duplicated.
 * Only known aliases (keys of {@link OPTIONAL_TOOL_ALIASES}) are recognized —
 * raw tool names and unknown tokens are ignored. Parsing never throws: a typo
 * in the connector URL must not break `initialize`; it just leaves the optional
 * tool off. Pure (no I/O or logging) so it is trivially unit-testable — the
 * request handler logs the raw value and resolved set for observability.
 *
 * @param param the raw value of the `tools` search param, or `null` if absent.
 * @returns the set of tool names to additionally register (empty when nothing
 *   was recognized).
 */
export function parseEnabledOptionalToolNames(
  param: string | null,
): Set<string> {
  const enabled = new Set<string>();
  if (param === null) return enabled;
  for (const rawToken of param.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (token === "") continue;
    const toolNames = OPTIONAL_TOOL_ALIASES[token];
    if (toolNames === undefined) continue;
    for (const name of toolNames) enabled.add(name);
  }
  return enabled;
}
