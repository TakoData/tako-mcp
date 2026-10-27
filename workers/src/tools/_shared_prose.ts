/**
 * Prose reused VERBATIM by more than one tool.
 *
 * The rule this exists for (spec D2.10): a sentence that belongs to two tools
 * belongs to neither — shared text is one constant reused whole, or it is a
 * `guidance` string on the result that carries it. The `sources` describe was
 * pasted into three tools at ~530 chars each and drifted between them.
 *
 * Reuse WHOLE. Never `.replace()` a fragment of one of these to fit another
 * tool's vocabulary: the substitution silently no-ops the day the source is
 * reworded, and it keeps a sentence alive under a tool that never validated it.
 * A tool whose text must differ writes its own constant.
 */

/**
 * `sources` on `tako_search` and `tako_agent`. Both take the same two-corpus
 * enum and route the same way, so the sentence is one string. `tako_agent`
 * appends `AGENT_SOURCES_THREAD_RULE`.
 *
 * The keep-both rule is the load-bearing part: models narrow to `["web"]`
 * whenever they guess the graph can't hold the answer, for website traffic,
 * a role at a company, or a contact, and Tako's graph holds all three.
 */
export const SOURCES_DESCRIBE =
  "Which corpora to search; default is both. `data` is Tako's knowledge graph, curated from authoritative data sources; `web` is the open web. Keep both unless the user asks for one.";

/** The `sources` rule both agent tools share: a thread's sources are fixed. */
export const AGENT_SOURCES_THREAD_RULE =
  "A thread keeps its sources, so omit this on a follow-up.";

export const PASSAGE_BREAK_DESCRIBE =
  "A ' … ' marks a discontinuity — joined passages or the page's own ellipsis — so never quote across it as one sentence.";

/**
 * The one sign-in sentence for a keyless connection on the generic surface
 * (spec D17): appended to `authRequiredToolResult` by the free-tier dispatch
 * gate in `mcp.ts`, and to the search guidance when a keyless search returns a
 * card whose data is withheld. One generic sentence for every client — the
 * per-UA hint variants died with the User-Agent classifier. Hosts with a
 * linking UI (claude.ai, Claude Code, any OAuth-capable client) sign in;
 * config-file clients connect with an API key. No URLs, no UI deep paths
 * — copy rots (see PAYMENT_REQUIRED_REMEDY_FALLBACK).
 */
export const GENERIC_SIGN_IN_HINT =
  "Sign in with your client's MCP authentication, or connect with a Tako API key.";
