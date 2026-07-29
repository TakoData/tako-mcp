/**
 * Markdown renderers for the model-facing text channel of `tako_search` and
 * `tako_answer`, plus the paired `structuredContent` slimmers.
 *
 * Why markdown: the consumers of these tools are agents reading text. JSON
 * taxes prose-heavy content twice — escaped newlines/quotes inside snippets,
 * and per-item key repetition (`"title":`, `"url":`, … × N results) — and a
 * truncated JSON string is malformed where a truncated markdown doc just
 * loses its tail. Layout: Tako data cards first, then web results, then the
 * hoisted source notes, so truncating clients lose boilerplate before data.
 *
 * The channel split (see `mcp.ts`): `renderText` output becomes
 * `content.text` (everything the model reads); `slimStructured` output
 * becomes `structuredContent` (machine essentials only — widget fields,
 * request_id, usage, guidance). Hosts count BOTH toward model context, so
 * the slim side is what keeps markdown from doubling the bill.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import { z } from "zod";

import {
  autoChainShape,
  usageSchema,
  type SearchOutput,
  type TakoCard,
  type Usage,
  type WebResult,
} from "./_search_results.js";

/** The advertised structuredContent shape for tako_search. Loose so the
 *  handler's full output satisfies it; `cards`/`web_results` are declared
 *  because they ARE the payload a structuredContent-reading client needs —
 *  advertising only the metadata is what made those clients read an empty
 *  envelope. Declared loosely (the card shape is the backend's, and pinning
 *  it here would reintroduce the wire-drift failure `_search_results.ts`
 *  documents). */
export const searchSlimOutputShape = z.looseObject({
  cards: z
    .array(z.looseObject({}))
    .optional()
    .describe("The data cards — the payload. Each carries its title, description (headline value), facts, and inline rows under `content`."),
  web_results: z
    .array(z.looseObject({}))
    .optional()
    .describe("Web results with their snippets."),
  request_id: z.string(),
  usage: usageSchema
    .nullable()
    .describe("Cost-plus usage for this request (null when not metered)."),
  guidance: z
    .string()
    .optional()
    .describe("Present only on a zero-card response: the recovery protocol."),
  ...autoChainShape,
});

/** The advertised structuredContent shape for tako_answer. Carries the
 *  synthesized answer and its citations for the same reason as search. */
export const answerSlimOutputShape = z.looseObject({
  answer: z.string().optional().describe("The synthesized, citation-backed answer."),
  cards: z.array(z.looseObject({})).optional().describe("Cards cited by the answer."),
  web_results: z.array(z.looseObject({})).optional().describe("Web results cited by the answer."),
  request_id: z.string(),
  usage: usageSchema
    .nullable()
    .describe("Cost-plus usage for this request (null when not metered)."),
  guidance: z
    .string()
    .optional()
    .describe(
      "Present only when the data source grounded zero cards: the deterministic coverage verdict.",
    ),
});

/** tako_answer's full handler output (internal; the advertised schema is
 *  `answerSlimOutputShape` and the full content rides in the markdown). The
 *  index signature + explicit `| undefined` optionals keep it mutually
 *  assignable with the zod-inferred internal shape and the slim advertised
 *  Output under exactOptionalPropertyTypes. */
export interface AnswerFullOutput {
  answer: string;
  cards: TakoCard[];
  web_results: WebResult[];
  usage: Usage | null;
  request_id: string;
  guidance?: string | undefined;
  sources_glossary?: Record<string, string> | undefined;
  [key: string]: unknown;
}

const WIDGET_KEYS = [
  "pub_id",
  "embed_url",
  "image_url",
  "dark_mode",
  "width",
  "height",
] as const;

/**
 * structuredContent for tako_search: the FULL payload.
 *
 * This is the MCP-spec-natural channel — a client that reads structuredContent
 * (the obvious choice when a tool advertises an outputSchema) must find the
 * cards there, not an empty envelope. Slimming this side to metadata made
 * those clients silently perform worse than ones reading the text block.
 *
 * The payload is carried EXACTLY ONCE: `renderText` is a compact index
 * (titles, headline values, pointers) rather than a second copy of the rows,
 * so hosts that count both channels are not billed twice.
 */
export function slimSearchStructured(o: SearchOutput): Record<string, unknown> {
  return { ...(o as unknown as Record<string, unknown>) };
}

/** structuredContent for tako_answer: the full payload, same rationale. */
export function slimAnswerStructured(o: AnswerFullOutput): Record<string, unknown> {
  return { ...(o as unknown as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Fence opaque/untrusted text with a backtick run LONGER than any run inside
 * it (min 3), so the content can neither close the fence early nor forge the
 * document's own framing. JSON-stringification used to provide this boundary
 * incidentally (upstream text arrived escaped, inside a string); now that web
 * page text and snippets ride verbatim in one markdown document, a page
 * ending in "## Tako Data (1 card)…_request_id: …_" would otherwise render
 * indistinguishably from our own sections and footer.
 */
function fenced(text: string, lang = ""): string {
  const runs = text.match(/`+/g);
  const longest = runs === null ? 0 : Math.max(...runs.map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Flatten upstream text destined for a single-line slot (titles, meta): an
 *  embedded newline would otherwise start a fresh line the content controls. */
const oneLine = (v: string): string => v.replace(/\s*\n\s*/g, " ").trim();

type LooseContent = {
  content_format?: string | null;
  data?: string | null;
  records?: Array<Record<string, unknown>> | null;
  dataset?: { columns?: unknown; rows?: unknown[] } | null;
  total_rows?: number | null;
  truncated?: boolean | null;
};

/** One line describing the rows that rode in structuredContent, instead of a
 *  second copy of them. */
function rowsPointer(content: TakoCard["content"]): string | undefined {
  if (content == null) return undefined;
  const c = content as LooseContent;
  const shown =
    (Array.isArray(c.dataset?.rows) ? c.dataset.rows.length : undefined) ??
    (Array.isArray(c.records) ? c.records.length : undefined) ??
    (typeof c.data === "string" && c.data.trim() !== ""
      ? Math.max(0, c.data.split("\n").filter((l) => l !== "").length - 1)
      : undefined);
  if (shown === undefined || shown === 0) return undefined;
  const total = c.total_rows ?? undefined;
  const of = total !== undefined && total > shown ? ` of ${total}` : "";
  return `data: ${shown}${of} rows in structuredContent.cards[].content (full export via tako_contents).`;
}

/** Names riding on a card's sources/methodologies arrays (paragraphs live in
 *  the glossary section, keyed by these names). */
function namesOf(items: unknown, nameKey: string): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) =>
      i !== null && typeof i === "object" ? (i as Record<string, unknown>)[nameKey] : undefined,
    )
    .filter((n): n is string => typeof n === "string" && n !== "");
}

type LooseDefinition = { term?: unknown; metric_name?: unknown; name?: unknown; definition?: unknown };

/**
 * A card's as-of date. The backend ships this as an OBJECT
 * (`{"data_as_of": "2026-03-31"}`) on search cards, so a bare
 * `typeof === "string"` test drops it on every real card. The date is the
 * only reliable way to tell a reported actual from a forward projection (a
 * future date) and a fresh series from a stale vintage, so losing it costs
 * the model a correctness check the title alone cannot replace. Accept the
 * string form too — other endpoints send one.
 */
function freshnessOf(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (value !== null && typeof value === "object") {
    const asOf = (value as { data_as_of?: unknown }).data_as_of;
    if (typeof asOf === "string" && asOf !== "") return asOf;
  }
  return undefined;
}

/**
 * Retrieval relevance. `relevance_score` is the entitlement-gated numeric
 * field; unentitled responses carry the coarse `relevance` string ("High" /
 * "Medium" / "Low") instead. Render whichever is present so the fact never
 * silently vanishes for free-tier callers.
 */
function relevanceOf(rec: Record<string, unknown>): string | undefined {
  if (typeof rec.relevance_score === "number") return String(rec.relevance_score);
  if (typeof rec.relevance === "string" && rec.relevance !== "") return rec.relevance;
  return undefined;
}

function renderCard(card: TakoCard, idx: number): string {
  const rec = card as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`### ${idx + 1}. ${card.title ?? card.card_id ?? "Untitled card"}`);
  if (typeof card.description === "string" && card.description !== "") {
    lines.push(card.description);
  }

  // Retrieval metadata rides too (relevance_score is entitlement-gated —
  // "only populated for entitled accounts" — so dropping it would silently
  // remove a paid feature's output).
  if (
    typeof rec.semantic_description === "string" &&
    rec.semantic_description !== "" &&
    rec.semantic_description !== card.description
  ) {
    lines.push(`semantic_description: ${rec.semantic_description}`);
  }

  const facts: string[] = [];
  facts.push(`exportable: ${card.exportable === true ? "yes" : "no"}`);
  const relevance = relevanceOf(rec);
  if (relevance !== undefined) facts.push(`relevance: ${relevance}`);
  if (typeof rec.card_type === "string" && rec.card_type !== "") {
    facts.push(`type: ${rec.card_type}`);
  }
  const freshness = freshnessOf(rec.data_freshness);
  if (freshness !== undefined) facts.push(`freshness: ${freshness}`);
  const nodes = card.nodes ?? [];
  if (nodes.length > 0) {
    facts.push(`nodes: ${nodes.map((n) => `\`${n.id}\` (${n.name})`).join(", ")}`);
  }
  const sourceNames = namesOf(rec.sources, "source_name");
  if (sourceNames.length > 0) facts.push(`source: ${sourceNames.join(", ")}`);
  // Methodology names must render for the same reason source names do: the
  // glossary hoists methodology paragraphs keyed by these names, and a
  // Source Notes entry nothing references is unattributable.
  const methodologyNames = namesOf(rec.methodologies, "methodology_name");
  if (methodologyNames.length > 0) facts.push(`methodology: ${methodologyNames.join(", ")}`);
  const sourceIndexes = Array.isArray(rec.source_indexes)
    ? rec.source_indexes.filter((s): s is string => typeof s === "string" && s !== "")
    : [];
  if (sourceIndexes.length > 0) facts.push(`source_indexes: ${sourceIndexes.join(", ")}`);
  if (typeof card.webpage_url === "string" && card.webpage_url !== "") {
    facts.push(`chart: ${card.webpage_url}`);
  }
  if (typeof rec.embed_url === "string" && rec.embed_url !== "") {
    facts.push(`embed: ${rec.embed_url}`);
  }
  if (typeof rec.image_url === "string" && rec.image_url !== "") {
    facts.push(`image: ${rec.image_url}`);
  }
  lines.push(facts.join(" · "));

  if (typeof rec.values_hint === "string") lines.push(`values_hint: ${rec.values_hint}`);

  const defs = rec.metric_definitions;
  if (Array.isArray(defs) && defs.length > 0) {
    const rendered = defs
      .map((d) => {
        if (d === null || typeof d !== "object") return undefined;
        const ld = d as LooseDefinition;
        const term = ld.term ?? ld.metric_name ?? ld.name;
        if (typeof term !== "string" || typeof ld.definition !== "string") return undefined;
        return `- ${term}: ${ld.definition}`;
      })
      .filter((s): s is string => s !== undefined);
    if (rendered.length > 0) lines.push(rendered.join("\n"));
  }

  // Rows are NOT duplicated here: the full payload rides in structuredContent
  // (see slimSearchStructured). Emitting them in both channels would bill the
  // model twice for the same table on every host that counts content AND
  // structuredContent. A one-line pointer keeps the text channel a readable
  // index of what arrived.
  const rows = rowsPointer(card.content);
  if (rows !== undefined) lines.push(rows);

  return lines.join("\n");
}

function renderWebResult(w: WebResult, idx: number): string {
  // Titles/meta are upstream web content: single-line slots are
  // newline-flattened so a page can't forge the
  // document's own sections (see `fenced`).
  const lines: string[] = [`${idx + 1}. Title: ${oneLine(w.title)}`, `URL: ${w.url}`];
  const meta: string[] = [];
  if (typeof w.source_name === "string" && w.source_name !== "") meta.push(oneLine(w.source_name));
  if (typeof w.publish_date === "string" && w.publish_date !== "") {
    meta.push(`Published: ${oneLine(w.publish_date)}`);
  }
  if (meta.length > 0) lines.push(meta.join(" · "));
  // Snippet omitted on purpose: it rides verbatim in
  // structuredContent.web_results. Prose-heavy text is the most expensive
  // thing to carry twice, and this is the channel that had the duplicate.
  return lines.join("\n");
}

function renderGlossary(glossary: Record<string, string> | undefined): string | undefined {
  if (glossary === undefined) return undefined;
  const entries = Object.entries(glossary);
  if (entries.length === 0) return undefined;
  return ["## Source Notes", ...entries.map(([name, text]) => `**${name}**: ${text}`)].join("\n\n");
}

function renderFooter(requestId: string, usage: Usage | null): string {
  const parts = [`request_id: ${requestId}`];
  if (usage !== null && typeof usage.total_cost_usd === "number") {
    parts.push(`cost: $${usage.total_cost_usd}`);
  }
  return `_${parts.join(" · ")}_`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** The tako_search text channel: guidance (if any) → data cards → web
 *  results → source notes → footer. */
export function renderSearchMarkdown(o: SearchOutput): string {
  const blocks: string[] = [];
  if (o.guidance !== undefined) blocks.push(`> ${o.guidance}`);

  if (o.cards.length > 0) {
    blocks.push(`## Tako Data (${o.cards.length} card${o.cards.length === 1 ? "" : "s"})`);
    blocks.push(...o.cards.map((c, i) => renderCard(c, i)));
  } else if (o.guidance === undefined) {
    blocks.push("## Tako Data\nNo data cards matched.");
  }

  if (o.web_results.length > 0) {
    blocks.push(`## Web Results (${o.web_results.length})`);
    blocks.push(o.web_results.map((w, i) => renderWebResult(w, i)).join("\n\n---\n\n"));
  }

  const glossary = renderGlossary(o.sources_glossary);
  if (glossary !== undefined) blocks.push(glossary);

  blocks.push(renderFooter(o.request_id, o.usage));
  return blocks.join("\n\n");
}

/** The tako_answer text channel: the synthesized answer first, then its
 *  citations (cards + web), source notes, footer. */
export function renderAnswerMarkdown(o: AnswerFullOutput): string {
  const blocks: string[] = [o.answer];
  if (o.guidance !== undefined) blocks.push(`> ${o.guidance}`);

  if (o.cards.length > 0) {
    blocks.push(`## Cited Data (${o.cards.length} card${o.cards.length === 1 ? "" : "s"})`);
    blocks.push(...o.cards.map((c, i) => renderCard(c, i)));
  }

  if (o.web_results.length > 0) {
    blocks.push(`## Cited Web (${o.web_results.length})`);
    blocks.push(o.web_results.map((w, i) => renderWebResult(w, i)).join("\n\n---\n\n"));
  }

  const glossary = renderGlossary(o.sources_glossary);
  if (glossary !== undefined) blocks.push(glossary);

  blocks.push(renderFooter(o.request_id, o.usage));
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_available_data
// ---------------------------------------------------------------------------

/** Advertised (slim) structuredContent shape for tako_available_data: the
 *  machine-checkable verdict + the ready-to-run follow-up. The summary and
 *  coverage-name lists ride in the markdown text. */
export const availableDataSlimOutputShape = z.looseObject({
  found: z
    .boolean()
    .describe(
      "True when at least one match has live data coverage — not mere node resolution.",
    ),
  query: z.string(),
  next_call: z
    .object({
      tool: z.literal("tako_search"),
      query: z.string(),
      node_ids: z.array(z.string()),
    })
    .nullable()
    .describe(
      "Ready-to-run follow-up when coverage was found: call tako_search with exactly this query and node_ids pinned. Null when no match has coverage.",
    ),
});

interface CoverageMatchLike {
  node_id: string;
  name: string;
  type: string;
  unavailable?: boolean | undefined;
  coverage: {
    kind: string;
    names: string[];
    total: number;
    truncated: boolean;
    capped: boolean;
  };
  [key: string]: unknown;
}

export interface AvailableDataFullOutput {
  found: boolean;
  query: string;
  summary: string;
  matches: CoverageMatchLike[];
  other_matches: Array<{ name: string; type: string }>;
  next_call: { tool: "tako_search"; query: string; node_ids: string[] } | null;
  [key: string]: unknown;
}

export function slimAvailableDataStructured(
  o: AvailableDataFullOutput,
): Record<string, unknown> {
  return { found: o.found, query: o.query, next_call: o.next_call };
}

/** The coverage report: the deterministic summary, then each match's full
 *  coverage-name list (the primary payload — these are the exact terms to
 *  reuse in tako_search), then the runnable next_call. */
export function renderAvailableDataMarkdown(o: AvailableDataFullOutput): string {
  const blocks: string[] = [o.summary];

  for (const m of o.matches) {
    if (m.unavailable === true || m.coverage.names.length === 0) continue;
    const total = `${m.coverage.total}${m.coverage.capped ? "+" : ""}`;
    const head = `**${m.name}** (\`${m.node_id}\`) — ${m.coverage.kind} (${total} total):`;
    const names = m.coverage.names.join(", ");
    const more =
      m.coverage.truncated && m.coverage.total > m.coverage.names.length
        ? ` …and ${m.coverage.total - m.coverage.names.length} more not shown (treat a name you don't see as unconfirmed, not absent).`
        : "";
    blocks.push(`${head}\n${names}${more}`);
  }

  if (o.next_call !== null) {
    // The embedded query is caller input — dynamic fence, same as web text.
    blocks.push(`next_call (run verbatim):\n${fenced(JSON.stringify(o.next_call), "json")}`);
  }

  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_agent / tako_agent_wait
// ---------------------------------------------------------------------------

/** Advertised (slim) structuredContent shape for agent runs: lifecycle fields
 *  only — the answer, citations, and metadata ride in the markdown text. */
export const agentRunSlimOutputShape = z.looseObject({
  run_id: z.string(),
  status: z
    .string()
    .describe("queued | running | completed | failed."),
  timed_out: z
    .boolean()
    .describe("True when the wait window elapsed before a terminal status — poll again with the same run_id."),
  thread_id: z
    .string()
    .nullable()
    .optional()
    .describe("Pass back as thread_id to ask a follow-up in the same conversation."),
  error: z
    .object({ code: z.string(), message: z.string() })
    .loose()
    .nullable()
    .optional(),
});

interface AgentCitationLike {
  index: number;
  title: string;
  url?: string | null | undefined;
  source_name?: string | null | undefined;
  publish_date?: string | null | undefined;
  [key: string]: unknown;
}

interface AgentNoteLike {
  title?: string | undefined;
  term?: string | undefined;
  description?: string | undefined;
  definition?: string | undefined;
  [key: string]: unknown;
}

export interface AgentRunLike {
  run_id: string;
  thread_id?: string | null | undefined;
  status: string;
  timed_out: boolean;
  result?: {
    answer?: string | null | undefined;
    cards?: Array<{
      title?: string | null | undefined;
      embed_url?: string | null | undefined;
      [key: string]: unknown;
    }>;
    citations?: AgentCitationLike[];
    metadata?: {
      definitions?: AgentNoteLike[] | null | undefined;
      assumptions?: AgentNoteLike[] | null | undefined;
      methodology?: AgentNoteLike[] | null | undefined;
    } | null | undefined;
    [key: string]: unknown;
  } | null | undefined;
  error?: { code: string; message: string } | null | undefined;
  [key: string]: unknown;
}

export function slimAgentRunStructured(run: AgentRunLike): Record<string, unknown> {
  const out: Record<string, unknown> = {
    run_id: run.run_id,
    status: run.status,
    timed_out: run.timed_out,
    thread_id: run.thread_id ?? null,
  };
  if (run.error != null) out.error = run.error;
  return out;
}

function renderAgentNotes(title: string, notes: AgentNoteLike[] | null | undefined): string | undefined {
  if (!Array.isArray(notes) || notes.length === 0) return undefined;
  const lines = notes
    .map((n) => {
      const head = n.title ?? n.term;
      const body = n.description ?? n.definition;
      if (typeof head !== "string" || typeof body !== "string") return undefined;
      return `- ${head}: ${body}`;
    })
    .filter((s): s is string => s !== undefined);
  if (lines.length === 0) return undefined;
  return `## ${title}\n${lines.join("\n")}`;
}

/** An agent run as markdown: the answer, its indexed citations (the [n]
 *  markers in the answer join to these), charts, and the reasoning notes.
 *  Non-terminal runs render as a poll-again status line. */
export function renderAgentRunMarkdown(run: AgentRunLike): string {
  const footer = `_run_id: ${run.run_id}${run.thread_id != null ? ` · thread_id: ${run.thread_id} (pass back for follow-ups)` : ""} · status: ${run.status}_`;

  if (run.status === "failed") {
    const e = run.error;
    return [
      `Agent run failed${e != null ? ` (${e.code}): ${e.message}` : "."}`,
      footer,
    ].join("\n\n");
  }
  if (run.status !== "completed") {
    return [
      `Agent run \`${run.run_id}\` is still ${run.status}${run.timed_out ? " (this wait window elapsed)" : ""}. Poll again with the same run_id — runs typically take 30–90s.`,
      footer,
    ].join("\n\n");
  }

  const blocks: string[] = [];
  const answer = run.result?.answer;
  blocks.push(typeof answer === "string" && answer !== "" ? answer : "Agent run completed with no answer text.");

  const citations = run.result?.citations ?? [];
  if (citations.length > 0) {
    const lines = citations.map((c) => {
      const meta: string[] = [];
      if (typeof c.source_name === "string" && c.source_name !== "") meta.push(c.source_name);
      if (typeof c.publish_date === "string" && c.publish_date !== "") meta.push(c.publish_date);
      const tail = meta.length > 0 ? ` (${meta.join(" · ")})` : "";
      return `[${c.index}] ${c.title}${c.url != null ? ` — ${c.url}` : ""}${tail}`;
    });
    blocks.push(`## Citations\n${lines.join("\n")}`);
  }

  const cards = run.result?.cards ?? [];
  const chartLines = cards
    .map((c) =>
      typeof c.embed_url === "string" && c.embed_url !== ""
        ? `- ${c.title ?? "Chart"}: ${c.embed_url}`
        : undefined,
    )
    .filter((s): s is string => s !== undefined);
  if (chartLines.length > 0) blocks.push(`## Charts\n${chartLines.join("\n")}`);

  const md = run.result?.metadata;
  for (const section of [
    renderAgentNotes("Definitions", md?.definitions),
    renderAgentNotes("Assumptions", md?.assumptions),
    renderAgentNotes("Methodology", md?.methodology),
  ]) {
    if (section !== undefined) blocks.push(section);
  }

  blocks.push(footer);
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_contents
// ---------------------------------------------------------------------------

export interface ContentsOutputLike {
  note?: string | undefined;
  data?: string | undefined;
  records?: Array<Record<string, unknown>> | undefined;
  dataset?: unknown;
  format?: string | undefined;
  total_rows?: number | undefined;
  truncated?: boolean | undefined;
  download_url?: string | undefined;
  expires_at?: string | undefined;
  source_url?: string | undefined;
  cost: number;
  [key: string]: unknown;
}

/** The batch envelope: one entry per requested url, positionally aligned. */
export interface ContentsBatchLike {
  results: ContentsOutputLike[];
  cost: number;
  [key: string]: unknown;
}

/** structuredContent for tako_contents: the full batch INCLUDING each item's
 *  payload. This is the ONLY copy — `renderContentsText` emits a pointer, not
 *  a duplicate, for the same reason search cards get `rowsPointer()`. */
export function slimContentsStructured(o: ContentsBatchLike): Record<string, unknown> {
  return { ...(o as unknown as Record<string, unknown>) };
}

/** tako_contents as text: the payload itself (page text raw, csv fenced,
 *  json payloads fenced), led by the passage note and trailed by a one-line
 *  metadata footer. This is where the JSON-escaping tax on 100k-char pages
 *  actually dies. */
/** One line naming the payload that rode in structuredContent, in place of a
 *  second copy of it. */
function payloadPointer(o: ContentsOutputLike): string | undefined {
  if (typeof o.data === "string" && o.data !== "") {
    const kind = o.format === undefined ? "page text" : `${o.format} data`;
    return `${kind}: ${o.data.length} chars in structuredContent.results[].data`;
  }
  if (Array.isArray(o.records)) {
    return `${o.records.length} records in structuredContent.results[].records`;
  }
  if (o.dataset !== undefined) return "dataset in structuredContent.results[].dataset";
  return undefined;
}

function renderContentsItem(o: ContentsOutputLike): string {
  const blocks: string[] = [];
  // A failed url in a batch renders as its error and nothing else — the other
  // entries are untouched, so the model reads N-1 payloads plus one reason.
  if (typeof o.error === "string") {
    return `${oneLine(String(o.url ?? ""))}\n\n> ${o.error}`;
  }
  if (o.url !== undefined) blocks.push(oneLine(String(o.url)));
  if (o.note !== undefined) blocks.push(`> ${o.note}`);

  if (o.download_url !== undefined) {
    blocks.push(
      `Download: ${o.download_url}${o.expires_at !== undefined ? ` (expires ${o.expires_at})` : ""}`,
    );
  }

  // Page text is upstream web content — fenced (dynamic length) so it can't
  // forge this document's own note/footer framing. Inside the fence it still
  // rides verbatim: the JSON-escaping tax stays dead, only the boundary is
  // back. Card csv/json get the same treatment (a cell containing ``` would
  // otherwise close the fence early).
  // The payload rides in structuredContent, NOT here. Emitting it in both
  // channels would ship the same page text twice on every call — up to 10
  // urls x a 100k-char inline cap — which is the exact doubling this module
  // removes for search cards via rowsPointer(). A pointer keeps the text
  // channel a readable index of what arrived.
  const payload = payloadPointer(o);
  if (payload !== undefined) blocks.push(payload);

  const meta: string[] = [`cost: $${o.cost}`];
  if (o.total_rows !== undefined) meta.push(`total_rows: ${o.total_rows}`);
  if (o.truncated === true) meta.push("truncated");
  if (o.source_url !== undefined) meta.push(`source_url: ${o.source_url}`);
  blocks.push(`_${meta.join(" · ")}_`);

  return blocks.join("\n\n");
}

/** tako_contents as text: one section per requested url, each with the payload
 *  itself (page text raw, csv fenced, json payloads fenced). This is where the
 *  JSON-escaping tax on 100k-char pages actually dies. A single-url call renders
 *  as one section, so the batch shape costs nothing in the common case. */
export function renderContentsText(o: ContentsBatchLike): string {
  const items = o.results ?? [];
  if (items.length === 0) return "No content fetched.";
  if (items.length === 1) return renderContentsItem(items[0] as ContentsOutputLike);
  const failed = items.filter((r) => typeof r.error === "string").length;
  const header = `## Contents (${items.length} urls${failed > 0 ? `, ${failed} failed` : ""})`;
  const sections = items.map((r, i) => `### ${i + 1}. ${renderContentsItem(r)}`);
  return [header, ...sections, `_total cost: $${o.cost}_`].join("\n\n");
}
