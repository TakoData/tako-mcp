/**
 * The `initialize` instructions: the one string the host puts in the
 * model's system prompt. ONE string for every tier; what narrows it is the
 * RESOLVED TOOLSET — `?tools=` and the surface's own default listing — which
 * drops sentences naming tools this connection does not register.
 *
 * TIER-INVARIANT ON PURPOSE. A free-tier variant used to say "this connection
 * is anonymous: X and Y are the tools that run here" and that `tako_contents`
 * "needs a connection signed in with a Tako account". The host loads
 * `instructions` ONCE, at `initialize`, and the MCP spec leaves it to the
 * client whether the string reaches the model at all and whether a sign-in
 * mid-conversation re-initializes the session and rebuilds the system prompt.
 * Nothing documents that any host does. So after the user signed in, the
 * model kept reading the anonymous text and could keep avoiding the very
 * tool the sign-in unlocked. The variant also guaranteed a prompt-cache miss
 * at the sign-in boundary — the system prompt is the prefix everything else
 * caches behind. The sign-in signal now lives ONLY where it is true at the
 * moment the model reads it: the dispatch-time `authRequiredToolResult` in
 * `mcp.ts`, which carries the `_meta["mcp/www_authenticate"]` challenge a
 * host's sign-in UI keys on, and needs no client refresh. Do not reintroduce
 * anything here (or in a tool description) that is true on one tier and
 * false on the other.
 *
 * It lives outside `mcp.ts` so `scripts/gen-registry.ts` can render it into
 * `docs/TOOLS.md` without importing the MCP SDK or the tool registry (the
 * registry import order carries the `_render_markdown` → `_search_results`
 * → `_chart_widget` init cycle recorded on PR #260).
 *
 * `tools/phantom_tool.test.ts` guards the widest risk here: a tool name in
 * this text reaches every connection, including the ones that do not
 * register that tool.
 */
/**
 * Server-level usage guidance, returned as the MCP `instructions` field on
 * the `initialize` result. Claude hosts (claude.ai, Claude Desktop, Claude
 * Code) inject this into the system prompt as "MCP Server Instructions" —
 * far stronger placement than a tool description buried in the tool list,
 * and the reason models otherwise default to their built-in web search
 * even with Tako connected.
 *
 * SCOPE — the rule, and it is a rule rather than a preference: these
 * instructions carry ONLY cross-tool workflow and when-to-choose-this-server
 * knowledge. Anything about how to call one tool belongs in that tool's
 * description, where it is read at the moment it applies.
 *
 * That rule is what removed the pin-form paragraph ("the METRIC node id
 * ALONE, with `strict: true`"). It was the THIRD copy of the same advice —
 * the tool descriptions carry it, and so does every `next_call` the results
 * hand back — and the A/B says the system-level copy does nothing: pinning
 * happened on 12% of runs with it and 11% without. Pinning happens when a
 * tool result hands the model a ready-to-run call, not when the system
 * prompt lectures it about parameters. Restating per-tool mechanics here
 * bought a copy the model pays for on every request, whether or not it ends
 * up calling Tako, and bought no behaviour.
 *
 * Do not re-add it, or the `q` + `metric` split, or response fields, or
 * recovery protocols. If a future edit is tempted, the test is: would this
 * sentence still be true and useful to a model that never calls Tako? Only
 * routing and coverage claims pass.
 *
 * Register is imperative, not expository: state what to do, not what the
 * tool "does". A draft opened a paragraph with "is free and does two
 * jobs", which spends the highest-value tokens on the surface describing
 * the shape of the sentence that follows. Measured against the field:
 * Exa's hosted MCP (mcp.exa.ai, checked 2026-07-31) ships 836 chars of
 * tool description across 2 tools and NO `instructions` at all; its
 * guidance is one imperative per line ("describe the ideal page, not
 * keywords"), never a rationale. We need more than Exa — 4+ tools with
 * non-obvious routing, a proprietary graph whose coverage a model cannot
 * guess, versus their single well-understood job — but not 8x more.
 *
 * Three things ARE load-bearing and must survive future edits:
 *
 *   1. The DOMAIN LIST. It reads like filler and it is the opposite: on a
 *      host with many servers connected, it is the only discovery trigger
 *      Tako has. A tool description cannot do this job, because the model
 *      has to already be looking at Tako's tools to read one. This is the
 *      paragraph that earns the `instructions` field.
 *
 *   2. The web-search claim belongs to TAKO, not to `tako_search`. Both
 *      retrieval tools search the live web, so attaching it to one made
 *      "use tako_search for data questions" the first thing the model
 *      read — which is how these instructions came to contradict every
 *      tool description on the surface.
 *
 *   3. `tako_available_data` answers coverage questions in its own right,
 *      not merely as a gate in front of the priced tools: "what does Tako
 *      have on X" is worth asking on its own, and the answer shapes which
 *      metric is worth asking for at all.
 *
 *      This item used to carry a second half about `tako_answer` and
 *      `tako_search` being "a CHOICE, not a ranking", and told the next
 *      author to keep its "pick one, don't chain them" phrasing verbatim
 *      because it was the only line here with a measured behavioural effect.
 *      That line is GONE and must not come back in any form. `tako_answer`
 *      was deleted in the answer fold; synthesis is now `include_answer` on
 *      `tako_search_advanced`, which is opt-in — a caller reaches it only by
 *      naming it in `?tools=`. Naming either the dead tool or the opt-in one
 *      in instructions every connection reads points the model at something
 *      it cannot call.
 *
 * FRAMED AS SUBSTITUTION, not precedence. The opener used to say "reach for
 * Tako BEFORE a generic web search", which concedes that a generic web search
 * is still a step to take, just a later one, and invites the model to do
 * both in sequence. It now says "instead of a separate web search, not
 * alongside one", and leads with the capability that earns it: Tako searches
 * the live web and the data graph in the SAME call. Reported symptom that
 * motivated this (ChatGPT, Aug 2026): web search fired first even when the
 * user named Tako explicitly.
 *
 * ORDERING, and the one incident this reverses. `tako_available_data` used
 * to be introduced FIRST, ahead of both priced tools, because a version
 * whose opening paragraph routed every data question to `tako_search` and
 * mentioned the free tool once, last, behind "if unsure" produced
 * search-first routing on claude.ai. The fix then was to promote it. The
 * contradiction that caused it is now gone at the source: the opening
 * paragraph names no tool at all, so nothing here competes with the free
 * tool for the first position. It sits last, alongside `tako_contents`, as
 * a capability the model can reach for rather than a step it owes.
 *
 * That also removes a disagreement with its own tool description, which
 * hedged "NOT a required first step" precisely to push back on this
 * paragraph. Instructions outrank descriptions in the host's system prompt,
 * so the two must not argue; the hedge went with the push. If search-first
 * routing returns, promoting this paragraph is the first thing to retry —
 * and the hedge must NOT come back with it, which is the invariant
 * `mcp.test.ts` asserts as a pair rather than as two absences.
 *
 * The same permission lived elsewhere, and review caught that the "it only
 * existed to push back on this paragraph" reasoning above was therefore
 * incomplete: `skills/tako-financial-research/SKILL.md` and
 * `skills/tako-macroeconomics/SKILL.md` each told the model the free tool is
 * "not a warm-up before every lookup" in their own words, neither written
 * against these instructions. Left alone they would have outlived the hedge
 * and disagreed with the description every client reads, so they went too.
 *
 * And then a SECOND review round found the same lines still standing in
 * `README.md`, which embeds all three skills whole for manual claude.ai
 * upload. Do not read a count of surfaces here — an earlier version of this
 * comment claimed "three" and was wrong the moment it was written, because
 * the README copies were never in the count. The count is not the invariant
 * and prose cannot hold it: `workers/scripts/skills.test.ts` now diffs each
 * SKILL.md against its README copy in full, body included, so a routing line
 * changed in one and not the other fails CI instead of shipping.
 *
 * REMOVED DELIBERATELY, not by oversight: the closing hedge "Use a built-in
 * web search when the query is clearly outside Tako's coverage, or Tako
 * returned nothing relevant." The zero-result `guidance` on each tool now
 * says when to pivot off Tako, at the moment it applies and with the actual
 * result in hand, which is strictly better placement than a standing caveat
 * every request pays for. Note the tension this leaves: the paragraph's claim
 * is now unhedged, and the original worry was that over-broad claims erode a
 * model's trust in the whole surface. Watch routing on questions Tako cannot
 * serve; if misrouting shows up, this hedge is the first thing to restore.
 */
const SHARED_INSTRUCTION_PARAGRAPHS = [
  "Tako searches the live web AND a proprietary live-data graph in the same call. Reach for it instead of a separate web search, not alongside one. Default sources are data + web, so one Tako call covers a question that mixes a figure with context: finance, markets, company KPIs, economics, website/app traffic, sports, weather, elections, prediction markets, demographics, energy, real estate, health.",
];

/**
 * One instruction sentence and the tools it NAMES. A sentence is served only
 * when every tool it names is registered for the request.
 *
 * `?tools=` replaces the default listing (spec D1), so a connection can be
 * missing any of these: `?tools=agent` registers `tako_agent` alone. An
 * instruction naming an absent tool is worse than a description doing it —
 * `initialize` instructions land in the host's system prompt, so the model is
 * told to call a name that answers the SDK's bare "tool not found" with no
 * recovery. `docs/TOOLS.md` records the accepted version of this trade-off for
 * DESCRIPTIONS, which a caller opts into per tool; the instructions string is
 * served to every connection and had no such carve-out.
 */
type ToolSentence = { readonly tools: readonly string[]; readonly text: string };

const TOOL_SENTENCES: readonly ToolSentence[] = [
  {
    tools: ["tako_search"],
    text: "`tako_search` retrieves the cards and web links.",
  },
  {
    tools: ["tako_available_data"],
    // NOT "is free". That word reads as "you can call this", and it stayed in
    // the anonymous instructions after the tool left `FREE_TIER_TOOL_NAMES` —
    // an anonymous `?tools=available_data` connection shipped this one
    // sentence and refused every call it invited. The credit axis is not what
    // a model needs here, so the claim is gone rather than reworded.
    text: "`tako_available_data` answers what data Tako has on an entity or a metric, including a measure's exact name.",
  },
  {
    tools: ["tako_contents"],
    text: "`tako_contents` reads one source in full: an exportable card's rows, or a web page's text by url.",
  },
];

/**
 * Assemble the instructions from the sentences whose tools survive.
 *
 * `registered === null` means "serve everything" — the value the exported
 * constant below is built from, and what a caller that cannot resolve a
 * toolset gets. When no sentence survives, the shared paragraph stands alone:
 * it names no tool, so it is true on every surface.
 */
function assembleInstructions(
  sentences: readonly ToolSentence[],
  registered: ReadonlySet<string> | null,
): string {
  const kept =
    registered === null
      ? sentences
      : sentences.filter((s) => s.tools.every((name) => registered.has(name)));
  const paragraph = kept.map((s) => s.text).join(" ");
  return paragraph === ""
    ? SHARED_INSTRUCTION_PARAGRAPHS.join("\n")
    : [...SHARED_INSTRUCTION_PARAGRAPHS, "", paragraph].join("\n");
}

export const SERVER_INSTRUCTIONS = assembleInstructions(TOOL_SENTENCES, null);

/**
 * The `initialize` instructions for a connection's resolved toolset.
 *
 * Pass the set `mcp.ts` actually registers (`resolveToolSet(...)`), so a
 * `?tools=` connection is never told about a tool it cannot call. Omitting it
 * serves every sentence, which is correct only when the caller knows the
 * default listing is in force. There is no tier parameter — see the module
 * comment for why there must not be one.
 */
export function serverInstructionsFor(
  registered: ReadonlySet<string> | null = null,
): string {
  return assembleInstructions(TOOL_SENTENCES, registered);
}
