/**
 * Parsing for `?tools=` on the MCP URL — an ALLOWLIST that replaces the
 * default listing (spec D1, Exa's semantics: "include all you want").
 */

/**
 * The namespace every tool name carries, and the reason `?tools=` may omit
 * it. `annotations.test.ts` asserts the invariant against `TOOL_REGISTRY`:
 * one unprefixed tool name would need a special case in the parser below.
 */
export const TOOL_NAME_PREFIX = "tako_";

/**
 * Read `?tools=` off a request URL, joining REPEATED params rather than
 * taking the first. `searchParams.get` returns only the first value, and
 * under allowlist semantics that silently narrows the surface: a connector
 * emitting `?tools=agent&tools=visualize` — repeated params are a normal URL
 * idiom that some config UIs and URL builders produce — registers
 * `tako_agent` alone and loses the defaults its own description names.
 *
 * `getAll` returns `[]` for an absent param, so `|| null` preserves the
 * "absent → defaults" branch {@link parseToolsParam} keys on. A
 * present-but-empty `?tools=` collapses to `null` too; it reached the same
 * defaults before, via `parseToolsParam("")`.
 */
export function readToolsParam(url: URL): string | null {
  return url.searchParams.getAll("tools").join(",") || null;
}

/**
 * Retired tokens and the tool that replaced them.
 *
 * NOT the alias table #263 deleted. That one HID a tool: `credits` mapped onto
 * `tako_credit_balance`, so a caller who named the real tool got the alias
 * instead. This forwards a token whose tool no longer exists, so a connection
 * configured before the fold keeps listing the tool it asked for rather than
 * silently widening to the four defaults — an allowlist that resolves to
 * nothing falls back to the defaults, which is the worst outcome here: the
 * caller asked for synthesis and gets a surface that cannot do it, with no
 * error anywhere.
 *
 * Remove an entry one minor release after its tool's deletion ships.
 */
const RETIRED_TOOL_TOKENS: ReadonlyMap<string, string> = new Map([
  // Deleted 2026-08 in the answer fold; synthesis is `include_answer` on the
  // advanced tool, which reaches the same endpoint.
  ["tako_answer", "tako_search_advanced"],
]);

/**
 * Resolve a raw `?tools=` value into the set of tool names to register, or
 * `null` for "use the defaults".
 *
 * Tokens are tool names; the `tako_` prefix is optional, so
 * `?tools=search,contents` and `?tools=tako_search,tako_contents` are the
 * same request.
 *
 * Never throws and never yields an empty surface: unknown tokens are dropped,
 * and when nothing recognizable remains the result is `null`, which
 * `resolveToolSet` reads as "use the defaults". A typo in a connector URL
 * must not break `initialize`.
 *
 * @param knownNames a parameter, not an import of `TOOL_REGISTRY`: importing
 *   the registry from a leaf module is what triggers the `_render_markdown` →
 *   `_search_results` → `_chart_widget` init cycle noted on PR #260.
 */
export function parseToolsParam(
  param: string | null,
  knownNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
  if (param === null) return null;
  const requested = new Set<string>();
  for (const rawToken of param.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (token === "") continue;
    const name = token.startsWith(TOOL_NAME_PREFIX)
      ? token
      : `${TOOL_NAME_PREFIX}${token}`;
    // Forwarding happens BEFORE the known-name check, so a retired token never
    // reaches it — and the check still runs on the replacement, so this map can
    // never register a name the surface does not have.
    const resolved = RETIRED_TOOL_TOKENS.get(name) ?? name;
    if (knownNames.has(resolved)) requested.add(resolved);
  }
  return requested.size === 0 ? null : requested;
}
