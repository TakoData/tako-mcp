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
