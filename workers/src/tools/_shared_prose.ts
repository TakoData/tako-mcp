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
 * enum with the same default, and both route the same way, so the sentence is
 * one string.
 *
 * The digital-metrics clause is the load-bearing part: models narrow to
 * `["web"]` for website and app traffic on the assumption that a data graph
 * cannot hold it, and Tako's does.
 */
export const SOURCES_DESCRIBE =
  'Which corpora to search; default is both. Narrow to ["data"] once `tako_available_data` confirms coverage; narrow to ["web"] only for news or page text — website traffic is in the data graph.';

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
