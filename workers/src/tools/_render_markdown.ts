/**
 * Markdown renderers for the model-facing text channel and the advertised
 * `structuredContent` shapes every tool now returns directly.
 *
 * Why markdown: the consumers of these tools are agents reading text. JSON
 * taxes prose-heavy content twice — escaped newlines/quotes inside snippets,
 * and per-item key repetition (`"title":`, `"url":`, … × N results) — and a
 * truncated JSON string is malformed where a truncated markdown doc just
 * loses its tail. Layout: Tako data cards first, then web results, then the
 * two reference maps, so truncating clients lose boilerplate before data.
 *
 * BOTH CHANNELS ARE COMPLETE for every migrated tool, and the duplication is
 * the decision, not an oversight. The older rule — text carries everything,
 * `structuredContent` shrinks to machine essentials so a host counting both
 * does not pay twice — assumed every host reads the text. A 2026-08 audit
 * measured otherwise: 9 harnesses (Cursor, Vercel AI SDK, OpenCode, Gemini
 * CLI, Goose, LangChain, OpenAI Agents SDK py+js, Excel/Outlook) feed the
 * model `content` ONLY, while both submission targets — ChatGPT and Claude
 * Code — feed it `structuredContent` ONLY. Either channel alone is therefore a
 * wrong answer on some host. The projection is what makes shipping both
 * affordable (~31.9k chars -> ~13k per channel on search), and the per-tool
 * "channel parity" tests assert every projected STRING and NUMBER leaf
 * reaches the text. Booleans they cannot see — a boolean renders as a WORD
 * ("exportable", "TRUNCATED"), never as its literal — so each has its own
 * assertion instead.
 *
 * So NO TOOL declares a `slimStructured` hook any more: every handler's output
 * IS the advertised shape, and `pickDeclared` in `mcp.ts` does the per-surface
 * narrowing. `tako_agent` was the last one still slimming; the hook itself
 * stays in `mcp.ts` for a future tool, with its contract tested there.
 *
 * `request_id` reaches NEITHER channel, on purpose. It is a server-side
 * correlation id with no use to a model or an end user, and OpenAI's app
 * review calls out request/trace/session/debug identifiers as things a tool
 * response should not carry unless strictly necessary. It still arrives on
 * the wire and is still recoverable: `registerTool` in `mcp.ts` logs it per
 * call, which is where a support question should be answered from. Anything
 * re-adding it to an advertised shape or a footer puts it back in front of
 * the model — `pickDeclared` strips undeclared keys, so the advertised
 * shapes below are the actual gate.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import { z } from "zod";

import type {
  AgentRunOutput,
  ProjectedAgentCard,
  ProjectedCitation,
} from "./_agent_run.js";
// Flattens upstream text destined for a single-line slot (titles, meta, node
// names): an embedded newline would otherwise start a fresh line the CONTENT
// controls. Defined next to the summary builder that needs the same guarantee,
// so the two channels cannot drift into flattening differently.
import {
  oneLine,
  type AvailableDataOutput,
  type ProjectedCandidate,
  type ProjectedMatch,
  type ProjectedRef,
} from "./_available_data.js";
import type { ContentsOutput, ProjectedContentsItem } from "./_contents.js";
import {
  projectedFocalNodeShape,
  projectedRelationPageShape,
  projectedRelationPreviewShape,
  type ProjectedRelated,
} from "./_graph.js";
import {
  autoChainShape,
  nonEmpty,
  projectedCardShape,
  projectedCardWithRowsShape,
  projectedWebResultShape,
  usageAdvertisedSchema,
  type ProjectedCard,
  type ProjectedWebResult,
  type SearchOutput,
  type TakoCard,
  type Usage,
  type WebResult,
} from "./_search_results.js";

/** The advertised structuredContent for the search tools: the PROJECTED
 *  shape, typed field by field, because the projection now controls every
 *  key (spec: 2026-08-26-model-facing-surface-redesign). Two variants, one
 *  per surface — the chatgpt one adds the chart widget fields the Apps SDK
 *  hands to `window.openai.toolOutput`; the generic `/mcp` surface has no
 *  reader for them, so they are not declared there and `pickDeclared`
 *  strips them from responses by construction. `request_id` is deliberately
 *  undeclared on both (OpenAI review). */
const searchCoreFields = {
  // The CORE card — no `rows`. `tako_search` cannot inline (its handler passes
  // `rowCap: null` on every call), so the field is declared on the advanced
  // shape below instead, which is the same rule the answer-fold fields follow.
  cards: z
    .array(projectedCardShape)
    .describe("The data cards. Fetch an exportable card's rows with tako_contents on its url."),
  web_results: z.array(projectedWebResultShape).describe("Web results."),
  usage: usageAdvertisedSchema
    .nullable()
    .describe("Cost-plus usage for this request (null when not metered)."),
  guidance: z
    .string()
    .optional()
    .describe("Zero-card responses only: what this response is evidence about, and the one next action."),
  metric_definitions: z
    .record(z.string(), z.string())
    .optional()
    .describe("What each metric means (unit, basis, caveats), keyed by metric name, deduped across cards."),
  source_notes: z
    .record(z.string(), z.string())
    .optional()
    .describe("What each source is and how it builds its data, keyed by source name."),
} as const;

/** The four the ANSWER endpoint adds, declared only on the tool that can reach
 *  it. `tako_search` hardcodes `endpoint: "search"` (tako_search.ts) and takes
 *  no `include_related`, so all four are unreachable there — yet it published
 *  them anyway from #273 until review round two, 885 chars (20%) of its output
 *  schema describing fields it cannot return, with `answer` promising a
 *  synthesis and nothing saying how to get one. Output-schema prose pays no
 *  budget: `assertProseBudget` counts the description and the parameters only.
 *
 *  Because these now ship ONLY on `tako_search_advanced`, each describe names
 *  the knob that produces it. That was banned while the shape was shared —
 *  `phantom_tool.test.ts` fails a tool whose published text names a knob it
 *  does not have — and the ban was met by deleting the explanation rather than
 *  the field. Keep a describe and its knob on the same tool, or the guard
 *  turns back into a gag. */
const answerFoldFields = {
  // THE DESCRIBE CARRIES THE FIELD NAMES, because the shape cannot.
  // `projectRelated` emits `{query, description?, node_ids?}`
  // (`projectedRelatedShape`), and publishing that shape is the obvious fix —
  // it costs +160 chars of draft-07 structure against an output schema sitting
  // EXACTLY on its shrink-only ratchet (4,888, `LEGACY_OUTPUT_SCHEMA_CEILINGS`),
  // so generation fails. Prose cannot cover a structural cost, and the two
  // describes that could fund it (`cards[].coverage_end`,
  // `web_results[].snippet`) are shared with `tako_search` and earmarked for
  // ITS fan-out PR by that ceiling's own comment.
  //
  // So the field names ride in prose until that pass frees the room. Do not
  // "simplify" this back to a bare stub: `looseObject({})` still DELIVERS the
  // fields, and without these names the model gets `{}` and has to guess that
  // a follow-up can be pinned at all.
  related: z
    .array(z.looseObject({}))
    .optional()
    .describe(
      "Follow-up queries, when you set include_related. Each has a `query` to send next and may have `node_ids` for `data.node_ids`.",
    ),
  // Trimmed to fund the `related` names above, and both cuts are restatements:
  // "Present only when you set include_answer: true" repeats what the
  // `include_answer` parameter already promises, and `structured_output`'s
  // two absence cases both end at `structured_output_error`.
  answer: z
    .string()
    .optional()
    .describe("The synthesized answer, cited from the cards and web_results."),
  structured_output: z
    .looseObject({})
    .optional()
    .describe(
      "Your output_schema filled from the same evidence; see structured_output_error when absent.",
    ),
  structured_output_error: z
    .looseObject({})
    .optional()
    .describe(
      "Why structured_output is absent: `code` and `message`.",
    ),
} as const;

export const searchSlimOutputShape = z.looseObject(searchCoreFields);

/** chatgpt-surface variant: adds the widget fields `window.openai.toolOutput`
 *  reads (the widget ignores `cards`/`web_results`). */
export const searchChatgptOutputShape = z.looseObject({
  ...searchCoreFields,
  ...autoChainShape,
});

/** `tako_search_advanced` only: the core plus the answer endpoint's four, and
 *  the one card field only this tool can fill. */
export const searchAdvancedOutputShape = z.looseObject({
  ...searchCoreFields,
  cards: z
    .array(projectedCardWithRowsShape)
    // Says what to do with BOTH outcomes, because this tool produces both: an
    // unqualified "fetch the rows with tako_contents" sent an
    // `include_contents: true` caller into a priced refetch of rows it had
    // already paid to inline.
    .describe("The data cards. Rows ride in a card's `rows` only when the request asked to inline them — otherwise fetch an exportable card's rows with tako_contents on its url."),
  ...answerFoldFields,
});

// ---------------------------------------------------------------------------
// tako_visualize
// ---------------------------------------------------------------------------

/** The advertised structuredContent for `tako_visualize`: the card the call
 *  just created, addressed three ways.
 *
 *  `embed_url` and `image_url` are declared on BOTH surfaces, which is a
 *  deliberate departure from `tako_search`. There the six widget fields were
 *  the TOP CARD's render plumbing and each card carried its own `url`, so
 *  dropping them from `/mcp` cost the model nothing. Here the created card IS
 *  the entire result: drop them and a structured-only host (Claude Code,
 *  Codex, VS Code — 5 of the 17 audited) receives a title and no way to show
 *  or link the chart it just published.
 *
 *  `pub_id`, `dark_mode`, `width` and `height` stay chatgpt-only. The widget
 *  is their sole reader (`_chart_widget.ts` reads them off
 *  `window.openai.toolOutput`) and it is suppressed on `/mcp`, where the chart
 *  ships as a PNG content block instead (`widgetSuppressed` in `mcp.ts`).
 *  `card_id` is advertised nowhere: `pub_id` carries the identical string. */
const visualizeCoreFields = {
  title: z
    .string()
    .optional()
    .describe("The card's title: the one you supplied, or its `header` component's title."),
  // `url`, not the wire's `webpage_url`: this is the same thing a tako_search
  // card calls `url` and the same thing tako_contents takes as `url` (spec D2,
  // one name for one thing).
  url: z.string().optional().describe("The card's page on Tako."),
  embed_url: autoChainShape.embed_url.describe("The card as a page to embed in an iframe."),
  image_url: autoChainShape.image_url.describe("A PNG rendering of the card."),
} as const;

/** The four fields only the chatgpt widget reads. */
const visualizeWidgetFields = {
  pub_id: autoChainShape.pub_id,
  dark_mode: autoChainShape.dark_mode,
  width: autoChainShape.width,
  height: autoChainShape.height,
} as const;

export const visualizeOutputShape = z.looseObject(visualizeCoreFields);

/** chatgpt-surface variant: adds the widget fields `window.openai.toolOutput`
 *  reads. */
export const visualizeChatgptOutputShape = z.looseObject({
  ...visualizeCoreFields,
  ...visualizeWidgetFields,
});

/** The handler's full output — every field either surface can advertise. */
export type VisualizeOutput = z.infer<typeof visualizeChatgptOutputShape>;

/**
 * The tako_visualize text channel. Four fields, so the whole document is a
 * heading and a fact list — but it is a COMPLETE one: every field the
 * projection emits renders here, because 9 of the audited harnesses feed the
 * model this channel and nothing else, and on those a missing `embed_url` is
 * a card the model cannot hand back.
 *
 * No `guidance`. The tool has one outcome — every failure throws — and the
 * public-and-permanent disclosure belongs in the description, before the call,
 * where the model can still stop. Repeating it here would bill every caller
 * for a warning that arrives too late to act on.
 */
export function renderVisualizeMarkdown(o: VisualizeOutput): string {
  // Guarded on the RENDERED value, not on `undefined`: the em dash is the
  // separator, so a title that flattens to nothing must not leave one
  // dangling, and a bare `- url: ` line is worse than no line. The projection
  // drops empty strings now, but this function is exported and its type
  // permits one.
  const title = o.title === undefined ? "" : oneLine(o.title);
  const lines: string[] = [
    title === "" ? "## Card created" : `## Card created — ${title}`,
  ];
  const facts: string[] = [];
  if (nonEmpty(o.url) !== undefined) facts.push(`- url: ${o.url}`);
  if (nonEmpty(o.embed_url) !== undefined) facts.push(`- embed: ${o.embed_url}`);
  if (nonEmpty(o.image_url) !== undefined) facts.push(`- image: ${o.image_url}`);
  if (facts.length > 0) lines.push("", ...facts);
  return lines.join("\n");
}

// slimSearchStructured is gone: the explicit projection means the handler's
// output IS the advertised shape (plus request_id and, on /mcp, the widget
// fields), and `structuredContentFor`'s pickDeclared narrowing does the rest.
// The tako_answer slimmers went with the tool (#273 folded it into
// tako_search_advanced).

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * The backtick run that safely fences `text`: longer than any run inside it,
 * minimum 3.
 *
 * Exported because `gen-registry.ts` wraps a WHOLE rendered document in a fence
 * for `docs/TOOLS.md`, and that wrapper has to out-run whatever {@link fenced}
 * emitted inside it. A hardcoded four backticks there works only until a
 * fixture snippet contains a triple-backtick run — then the inner fence closes
 * the outer one and raw markdown spills into the page.
 */
export function fenceRunFor(text: string): string {
  const runs = text.match(/`+/g);
  // `reduce`, NEVER `Math.max(...runs)`. The spread passes one argument per
  // backtick run, and `text` here is unbounded attacker-controlled page text —
  // `projectWebResult` copies `content.data` verbatim with no length cap.
  // Measured under node: fine at 100k runs, `RangeError: Maximum call stack
  // size exceeded` at 200k, and workerd's stack is smaller. The throw is not
  // contained either: `mcp.ts` catches a failed `renderText` and falls back to
  // `JSON.stringify(output)`, which ships `request_id` — the one field this
  // module's docstring says reaches NEITHER channel — and unfences the
  // document.
  const longest = runs === null ? 0 : runs.reduce((max, r) => Math.max(max, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Fence opaque/untrusted text with a backtick run LONGER than any run inside
 * it (min 3), so the content can neither close the fence early nor forge the
 * document's own framing. JSON-stringification used to provide this boundary
 * incidentally (upstream text arrived escaped, inside a string); now that web
 * page text and snippets ride verbatim in one markdown document, a page
 * ending in "## Tako Data (1 card)…_cost: $0_" would otherwise render
 * indistinguishably from our own sections and footer.
 */
function fenced(text: string, lang = ""): string {
  const fence = fenceRunFor(text);
  return `${fence}${lang}\n${text}\n${fence}`;
}









/**
 * The one-line trailer: what this call cost, and nothing else.
 *
 * It used to lead with `request_id`. That is now deliberately absent from
 * both channels (see the module docstring) — which leaves cost as the only
 * member, so an unmetered call has no footer at all rather than an empty
 * `__`. Returns `undefined` in that case and the callers skip the block.
 */
function renderFooter(usage: Usage | null): string | undefined {
  if (usage === null || typeof usage.total_cost_usd !== "number") return undefined;
  return `usage: $${usage.total_cost_usd}`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** The tako_search text channel: guidance (if any) → data cards → web
 *  results → source notes → footer. */
// ---------------------------------------------------------------------------
// tako_search text channel — COMPLETE, not an index (spec, text-channel
// template). Every projected field renders here: the consensus audit found 9
// harnesses that feed the model ONLY this channel, so an index without
// snippets or rows is a wrong answer there. Order: guidance (when present),
// cards, web results, reference maps LAST (tail-truncating hosts lose prose
// before data), usage as the final line.
// ---------------------------------------------------------------------------

function renderProjectedCard(c: ProjectedCard): string {
  const lines: string[] = [`### ${oneLine(c.title ?? "Untitled card")}`];
  // `oneLine`, for the same reason the reference maps flatten their values: a
  // description was the one card field neither flattened nor fenced, so a
  // newline followed by `## ` in upstream prose opened a heading in this
  // document.
  if (c.description !== undefined) lines.push(oneLine(c.description));
  const access: string[] = [];
  if (c.url !== undefined) access.push(`url: ${c.url}`);
  access.push(
    c.exportable
      ? c.total_rows !== undefined
        ? `exportable, ${c.total_rows} rows`
        : "exportable"
      : c.description !== undefined
        ? // Names the FIELD, not its position. The same fact reaches
          // structuredContent, where `description` is a sibling key and nothing
          // is "above" anything — a positional pointer is only true in one of
          // the two channels this projection has to serve.
          "rows locked — the headline value is in this card's `description`"
        : "rows locked",
  );
  lines.push(`- ${access.join(" · ")}`);
  const meta: string[] = [];
  if (c.source !== undefined) meta.push(`source: ${oneLine(c.source)}`);
  // "data through", first, because it is the one a reader judging currency
  // needs — a card refreshed today can carry a series ending months ago.
  if (c.coverage_end !== undefined) meta.push(`data through ${c.coverage_end}`);
  // "refreshed", not "updated": this is Tako's refresh date, not the date the
  // DATA runs to, and a bare "updated" in a fact line reads as the latter.
  if (c.last_updated !== undefined) meta.push(`refreshed ${c.last_updated}`);
  if (c.relevance !== undefined) meta.push(`relevance ${oneLine(c.relevance)}`);
  if (meta.length > 0) lines.push(`- ${meta.join(" · ")}`);
  if (c.nodes !== undefined && c.nodes.length > 0) {
    lines.push(`- nodes: ${c.nodes.map((n) => `\`${n.id}\` (${oneLine(n.name)})`).join(" · ")}`);
  }
  if (c.rows !== undefined) {
    // One fact line for what the payload is, then the payload. The line only
    // appears when it has something to say: `format` rides only on the two
    // non-tabular formats, and `truncated` only when rows were cut. Both are
    // structured keys, so rendering them here is what keeps the two channels
    // equivalent — `truncated: true` most of all, which tells the model the
    // rows it is reading are not all of them.
    const desc: string[] = [];
    if (c.rows.format !== undefined) desc.push(`format: ${oneLine(c.rows.format)}`);
    if (c.rows.truncated === true) desc.push("TRUNCATED — these are not all the rows");
    if (desc.length > 0) lines.push(`- rows: ${desc.join(" · ")}`);
    // `columns`/`rows` render as ONE fenced JSON object rather than a markdown
    // table: `tako_contents` renders the same shape the same way (byte-identical
    // to its structured payload), and a table would re-encode every cell into a
    // form the parity test can only approximate.
    if (c.rows.rows !== undefined) {
      const table: Record<string, unknown> = {};
      if (c.rows.columns !== undefined) table.columns = c.rows.columns;
      table.rows = c.rows.rows;
      lines.push(fenced(JSON.stringify(table), "json"));
    } else if (c.rows.columns !== undefined) {
      // A non-tabular payload (csv, card_json) carries `columns` only when the
      // manifest named them, and then it is the units the model needs — one
      // line beside the payload, not a second copy of the header inside a
      // fenced object.
      lines.push(`- columns: ${c.rows.columns.map(oneLine).join(" · ")}`);
    }
    if (c.rows.data !== undefined) lines.push(fenced(c.rows.data));
    if (c.rows.card_data !== undefined) lines.push(fenced(JSON.stringify(c.rows.card_data), "json"));
  }
  return lines.join("\n");
}

function renderProjectedWebResult(w: ProjectedWebResult): string {
  const meta: string[] = [];
  if (w.source !== undefined) meta.push(oneLine(w.source));
  if (typeof w.published === "string") meta.push(w.published);
  const heading = `### ${oneLine(w.title ?? w.url)}${meta.length > 0 ? ` — ${meta.join(", ")}` : ""}`;
  const lines: string[] = [heading, w.url];
  // Snippets and page text are upstream web content rendered verbatim into
  // this document — fenced so a page cannot forge our own section framing.
  if (typeof w.snippet === "string" && w.snippet !== "") lines.push(fenced(w.snippet));
  if (w.content !== undefined && typeof w.content.data === "string") {
    // BEFORE the fence, and the same rule as a card's inlined rows: a reader
    // who is handed a page cut at `article_content_max_chars` (default 30,000)
    // and told nothing will quote it as the whole page. `truncated` rides in
    // `structuredContent`, so omitting it here is a channel gap, not a saving —
    // and the parity walk cannot catch it, because that walk collects string
    // and number leaves only.
    if (w.content.truncated === true) {
      lines.push("- page text: TRUNCATED — this is not the whole page");
    }
    lines.push(fenced(w.content.data));
  }
  return lines.join("\n");
}

function renderNameMap(title: string, map: Record<string, string>): string {
  // FLATTEN THE VALUE, not just the key. `appendNote` joins paragraphs with a
  // blank line, so a note carrying both a source_description and a
  // methodology_description used to render its second paragraph as a
  // top-level block — a paragraph starting `## ` then sat between the list and
  // the `usage: $` footer, indistinguishable from this document's own framing.
  // The projection itself produces that input: a multi-source card files two
  // source descriptions plus a methodology under one key.
  return [
    `## ${title}`,
    ...Object.entries(map).map(([name, text]) => `- ${oneLine(name)}: ${oneLine(text)}`),
  ].join("\n");
}

export function renderSearchMarkdown(o: SearchOutput): string {
  const blocks: string[] = [];
  // The answer leads. A verdict ahead of it reads as "this answer failed"
  // rather than "the data index has a gap" — the guidance is about coverage,
  // and the prose above it may be a complete, correct web-grounded answer.
  if (o.answer !== undefined) blocks.push(o.answer);
  if (o.guidance !== undefined) blocks.push(`> ${o.guidance}`);
  if (o.structured_output_error !== undefined) {
    // Absence with no reason reads as a bug. Naming the code tells the model
    // the field is missing on purpose and whether retrying could fill it.
    blocks.push(
      `> structured_output absent (${oneLine(o.structured_output_error.code)}): ${oneLine(
        o.structured_output_error.message,
      )}`,
    );
  }

  blocks.push(`## Data cards (${o.cards.length})`);
  blocks.push(...o.cards.map(renderProjectedCard));
  // The top card's chart links: dropped from per-card structured fields, so
  // the text channel is where a content-only host reads them.
  if (o.embed_url !== undefined || o.image_url !== undefined) {
    const links: string[] = [];
    if (o.embed_url !== undefined) links.push(`embed: ${o.embed_url}`);
    if (o.image_url !== undefined) links.push(`image: ${o.image_url}`);
    blocks.push(`Top card chart — ${links.join(" · ")}`);
  }
  if (o.web_results.length > 0) {
    blocks.push(`## Web results (${o.web_results.length})`);
    blocks.push(...o.web_results.map(renderProjectedWebResult));
  }
  if (o.structured_output !== undefined) {
    // Completeness: content-only hosts must see the filled schema too.
    blocks.push("## Structured output");
    blocks.push(fenced(JSON.stringify(o.structured_output, null, 1)));
  }
  if (o.related !== undefined && o.related.length > 0) {
    blocks.push("## Related queries");
    blocks.push(
      o.related
        .map((r) => {
          const parts = [`- ${oneLine(r.query)}`];
          if (r.description !== undefined) parts.push(`— ${oneLine(r.description)}`);
          // The ids are the whole point of the field — they pin the follow-up —
          // and they rode in structuredContent alone until now, invisible on
          // the 9 harnesses that read only this channel.
          if (r.node_ids !== undefined) {
            parts.push(`(pin: ${r.node_ids.map((id) => `\`${id}\``).join(" ")})`);
          }
          return parts.join(" ");
        })
        .join("\n"),
    );
  }
  if (o.metric_definitions !== undefined) blocks.push(renderNameMap("Definitions", o.metric_definitions));
  if (o.source_notes !== undefined) blocks.push(renderNameMap("Source notes", o.source_notes));
  const footer = renderFooter(o.usage);
  if (footer !== undefined) blocks.push(footer);
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_available_data — COMPLETE in both channels (spec, text-channel
// template). Order: guidance, the resolved pair, the drilled matches, the
// candidates, the runnable handle. There is no reference prose to put last —
// the `summary` blob that used to open this document is gone (see the
// guidance section of `_available_data.ts`).
// ---------------------------------------------------------------------------

const coverageItemShape = z.object({
  name: z.string().describe("Canonical graph name."),
  id: z.string().describe("Graph node id."),
});

/** What a DRILLED node holds: the counts plus the listed entries. */
const coverageShape = z.looseObject({
  total: z.number().describe("Entries in all, not entries listed."),
  total_capped: z.boolean().describe("`total` is a floor."),
  truncated: z.boolean().optional().describe("More entries exist than are listed."),
  items: z.array(coverageItemShape).optional().describe("Headline-first."),
});

/** What a COUNTED node holds: the counts alone. A candidate is probed for its
 *  size, never for its list, so declaring `items` here would advertise a field
 *  no candidate can carry — and cost the whole item schema a second time. */
const coverageCountShape = z.looseObject({
  total: z.number(),
  total_capped: z.boolean().describe("`total` is a floor."),
});

const projectedRefShape = z.object({ id: z.string(), name: z.string() });

const candidateFields = {
  id: z.string(),
  name: z.string().describe("Canonical graph name — search on this."),
  type: z.string().describe("entity or metric; also what `coverage` counts."),
  kind: z.string().optional(),
} as const;

/** Advertised structuredContent for tako_available_data — the projected shape
 *  (`projectMatch` / `projectCandidate` in `_available_data.ts`), typed field
 *  by field. No field description INSTRUCTS (spec D4): every "call X with Y"
 *  sentence this schema used to carry moved to the tool description, and the
 *  three that named `node_ids`/`strict` on `tako_search` named a parameter
 *  that tool has not had since the D4 split. */
export const availableDataSlimOutputShape = z.looseObject({
  found: z.boolean().describe("Whether Tako holds matching data; `verified` says on what evidence."),
  verified: z
    .enum(["coverage", "pair", "unlinked", "resolution"])
    .optional()
    .describe(
      "What was checked. `pair`: the metric is on the entity's own list. `coverage`: a list was drilled. `unlinked`: the list was checked, the metric is absent. `resolution`: names resolved only.",
    ),
  guidance: z.string().optional().describe("The verdict, and the one next action."),
  matches: z
    .array(z.looseObject({ ...candidateFields, aliases: z.array(z.string()).optional(), unavailable: z.boolean().optional(), filter: z.string().optional().describe("The `metric` phrase that narrowed this list. When set, `total` counts only matching entries."), coverage: coverageShape }))
    .describe("The nodes whose coverage was drilled, best first."),
  candidates: z
    .array(z.looseObject({ ...candidateFields, coverage: coverageCountShape.optional() }))
    .describe("The other nodes `q` resolved to, best first."),
  next_call: z
    .object({
      // A plain string, not an enum of the two possible names: the value is
      // resolved per connection (`searchToolFor`), and an enum listing
      // `tako_search_advanced` publishes that name to every surface —
      // including chatgpt, which never registers it. `phantom_tool.test.ts`
      // reads published schemas, so the enum was the phantom, not the value.
      tool: z.string(),
      query: z.string(),
    })
    .nullable()
    .describe("A follow-up search in canonical names. Null when no target is unambiguous."),
  entity: projectedRefShape.nullable().optional().describe("Lookup path: the resolved entity."),
  metric: projectedRefShape.nullable().optional().describe("Lookup path: the resolved metric."),
  entity_candidates: z.array(projectedRefShape).optional().describe("Runners-up."),
  metric_candidates: z.array(projectedRefShape).optional().describe("Runners-up."),
});

const nodeHead = (c: { name: string; type: string; kind?: string }): string =>
  `${oneLine(c.name)} — ${[c.type, c.kind].filter((p): p is string => typeof p === "string").map(oneLine).join(" · ")}`;

const totalStr = (c: { total: number; total_capped: boolean }): string =>
  `${c.total}${c.total_capped ? "+" : ""}`;

/**
 * What a node's coverage counts, agreeing in number with it. Only the
 * candidate receipt lines use this — a match's list HEADER is a category
 * label, so it stays plural ("entities: 1 total") where a count reads
 * singular ("1 entity").
 */
const coverageNoun = (type: string, total: number): string =>
  type === "metric" ? (total === 1 ? "entity" : "entities") : total === 1 ? "metric" : "metrics";

function renderMatch(m: ProjectedMatch): string {
  const lines: string[] = [`### ${nodeHead(m)}`, `- \`${oneLine(m.id)}\``];
  if (m.aliases !== undefined && m.aliases.length > 0) {
    lines.push(`- aliases: ${m.aliases.map(oneLine).join(", ")}`);
  }
  if (m.unavailable === true) {
    lines.push("- coverage unavailable — the lookup failed, so this is not a gap in the data");
    return lines.join("\n");
  }
  // What the list COUNTS, without which `total` is unreadable: 13 hits for the
  // caller's phrase and 13 metrics in all serialize identically.
  const what =
    m.filter === undefined
      ? m.type === "metric" ? "entities" : "metrics"
      : `metrics containing "${oneLine(m.filter)}"`;
  const items = m.coverage.items ?? [];
  if (items.length === 0) {
    // "none" is only true at total 0. The tie branch counts a node's coverage
    // without listing it, so `total: 15, items: []` must not read as a gap.
    lines.push(
      m.coverage.total === 0
        ? `- ${what}: none`
        : `- ${what}: ${totalStr(m.coverage)} total, none listed`,
    );
    return lines.join("\n");
  }
  lines.push(
    `- ${what} (${totalStr(m.coverage)} total, ${items.length} listed): ${items
      .map((i) => `${oneLine(i.name)} \`${oneLine(i.id)}\``)
      .join(" · ")}`,
  );
  // A CUT LIST MUST SAY SO, or a name past the cap reads as absent — and the
  // recovery must name something free. It used to point at the web; the two
  // things that actually answer are this tool's own `metric` filter and a
  // drill on the node id.
  if (m.coverage.truncated === true) {
    lines.push("- more exist than are listed — treat a name you don't see as unconfirmed, not absent; pass `metric` with a phrase to filter this list");
  }
  return lines.join("\n");
}

function renderCandidate(c: ProjectedCandidate): string {
  const count =
    c.coverage === undefined
      ? ""
      : ` — ${totalStr(c.coverage)} ${coverageNoun(c.type, c.coverage.total)}`;
  return `- ${nodeHead(c)} — \`${oneLine(c.id)}\`${count}`;
}

const refList = (refs: readonly ProjectedRef[]): string =>
  refs.map((r) => `${oneLine(r.name)} \`${oneLine(r.id)}\``).join(" · ");

export function renderAvailableDataMarkdown(o: AvailableDataOutput): string {
  const blocks: string[] = [];
  if (o.guidance !== undefined) blocks.push(`> ${o.guidance}`);
  // `found` renders even though the fields around it imply it. Recovering it
  // from text alone takes a different inference per branch — discount the
  // candidate coverage counts on the disclaimed branch, read the wording of
  // `guidanceMetricUnresolved` on the pair branch, where `found` turns on a
  // `pinnedConfident` this document never names. Both channels carry the whole
  // answer (spec D3), and the parity walker cannot enforce that for a boolean.
  const facts = [`found: ${o.found ? "yes" : "no"}`];
  if (o.verified !== undefined) facts.push(`verified: ${o.verified}`);
  blocks.push(facts.join("\n"));

  // The resolved pair leads on the lookup path: it is the answer, and the
  // matches below it are the supporting list.
  if (o.entity !== undefined || o.metric !== undefined) {
    const rows: string[] = ["## Pair"];
    if (o.entity != null) rows.push(`- entity: ${oneLine(o.entity.name)} \`${oneLine(o.entity.id)}\``);
    if (o.metric != null) rows.push(`- metric: ${oneLine(o.metric.name)} \`${oneLine(o.metric.id)}\``);
    if (o.entity_candidates !== undefined && o.entity_candidates.length > 0) {
      rows.push(`- entity candidates: ${refList(o.entity_candidates)}`);
    }
    if (o.metric_candidates !== undefined && o.metric_candidates.length > 0) {
      rows.push(`- metric candidates: ${refList(o.metric_candidates)}`);
    }
    if (rows.length > 1) blocks.push(rows.join("\n"));
  }

  if (o.matches.length > 0) {
    blocks.push(`## Matches (${o.matches.length})`);
    blocks.push(...o.matches.map(renderMatch));
  }
  if (o.candidates.length > 0) {
    blocks.push(`## Candidates (${o.candidates.length})\n${o.candidates.map(renderCandidate).join("\n")}`);
  }
  if (o.next_call !== null) {
    blocks.push(`## Next call\n${o.next_call.tool}: ${oneLine(o.next_call.query)}`);
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_graph_related — COMPLETE in both channels (spec, text-channel
// template). Order: the focal node, the relations (the payload), then the
// node's description LAST, so a tail-truncating host loses prose before data.
// ---------------------------------------------------------------------------

/** Advertised structuredContent for tako_graph_related: the projected shape,
 *  typed field by field, because `projectRelated` controls every key. */
export const graphRelatedSlimOutputShape = z.looseObject({
  node: projectedFocalNodeShape,
  relations: z.array(projectedRelationPreviewShape).optional().describe("Every group, previewed. The map."),
  relation: projectedRelationPageShape.nullable().optional().describe("The one group you drilled."),
});

function renderFocalNode(n: ProjectedRelated["node"]): string {
  const kinds = [n.type, n.kind].filter((p): p is string => typeof p === "string" && p !== "");
  const lines = [
    `# ${oneLine(n.name)}`,
    `- \`${oneLine(n.id)}\` · ${kinds.map(oneLine).join(" · ")}`,
  ];
  if (n.aliases !== undefined && n.aliases.length > 0) {
    lines.push(`- aliases: ${n.aliases.map(oneLine).join(", ")}`);
  }
  return lines.join("\n");
}

const groupTotal = (g: { total: number; total_capped: boolean }): string =>
  `${g.total}${g.total_capped ? "+" : ""}`;

export function renderGraphRelatedMarkdown(o: ProjectedRelated): string {
  const blocks: string[] = [renderFocalNode(o.node)];

  if (o.relation !== undefined) {
    if (o.relation === null) {
      // A drill that came back empty — spec-legal, and `tako_available_data`
      // reads it as a real "zero coverage". Without this arm the whole answer
      // was the focal header: a name and an id, and not one word about the
      // group the caller asked for, which reads as a truncated result. The
      // renderer cannot name the key (it sees the output, not the input), so
      // it states the two things the key would not add.
      blocks.push(
        "That relation has no items for this node. An unknown relation key is NOT an error — it returns empty the same way — so re-read the map (`node_id` alone) for the keys this node actually has.",
      );
    } else {
      const g = o.relation;
      const items = g.items ?? [];
      const lines = items.map(
        (i) => `- ${oneLine(i.name)} \`${oneLine(i.id)}\`${i.kind === undefined ? "" : ` · ${oneLine(i.kind)}`}`,
      );
      blocks.push(
        `## \`${oneLine(g.key)}\` — ${oneLine(g.label)} (${groupTotal(g)} total, ${items.length} on this page)\n${
          lines.length > 0 ? lines.join("\n") : "_none_"
        }`,
      );
      if (g.next_cursor !== undefined) blocks.push(`More: pass cursor "${oneLine(g.next_cursor)}".`);
    }
  } else if (o.relations !== undefined && o.relations.length > 0) {
    const lines = o.relations.map((g) => {
      const names = (g.preview ?? []).map(oneLine).join(", ");
      const more = g.total > (g.preview ?? []).length ? ", …" : "";
      // A cursor on a map group is the only handle to the rest of it, so it
      // rides the line rather than waiting for the drill to rediscover it.
      const cursor = g.next_cursor === undefined ? "" : ` — cursor "${oneLine(g.next_cursor)}"`;
      return `- \`${oneLine(g.key)}\` — ${oneLine(g.label)} — ${groupTotal(g)}: ${names}${more}${cursor}`;
    });
    blocks.push(
      `## Relations (${o.relations.length})\nPass \`relation\` with a key to page one group, or \`q\` to filter by substring.\n${lines.join("\n")}`,
    );
  } else {
    blocks.push("No related nodes.");
  }

  // Reference prose last (spec, text-channel template): a tail-truncating host
  // (OpenCode 50 KB, Gemini CLI 40k chars) loses the blurb before the map.
  if (o.node.description !== undefined) blocks.push(`## About\n${oneLine(o.node.description)}`);
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_agent — COMPLETE in both channels (spec, text-channel template).
//
// What this replaced: `slimAgentRunStructured`, which advertised
// `{run_id, status, timed_out, thread_id}` and nothing else. The answer, its
// citations and its cards existed only here, in the text — invisible on the
// five harnesses that feed the model `structuredContent` and drop `content`.
// Both channels now render the same projection (`_agent_run.ts`).
//
// Order: answer, then cards, then citations, then the reference maps LAST
// (tail-truncating hosts lose prose before data), then thread_id and usage.
// ---------------------------------------------------------------------------

// `agentRunOutputShape` is declared in `_agent_run.ts`, next to the projection
// that fills it — the same place `_contents.ts` keeps `contentsOutputShape`.
// A shape that lives apart from its projection is how the two drift.

function renderAgentCard(c: ProjectedAgentCard): string {
  const lines: string[] = [`### ${oneLine(c.title ?? "Untitled card")}`];
  // `oneLine` for the reason renderProjectedCard gives: a newline followed by
  // `## ` in a description opens a heading in this document, forging a section
  // between `## Cards` and `## Citations`. An agent card's description is
  // model-written prose, so it carries markdown more often than a search
  // card's does.
  if (c.description !== undefined) lines.push(oneLine(c.description));
  const access: string[] = [];
  if (c.url !== undefined) access.push(`url: ${c.url}`);
  access.push(
    c.exportable
      ? c.total_rows !== undefined
        ? `exportable, ${c.total_rows} rows`
        : "exportable"
      : "rows locked",
  );
  lines.push(`- ${access.join(" · ")}`);
  // The chart itself. `tako_search` keeps these on the top card only, because
  // its widget renders one; this tool renders nothing, so every card needs the
  // links a host would draw or open.
  const chart: string[] = [];
  if (c.image_url !== undefined) chart.push(`image: ${c.image_url}`);
  if (c.embed_url !== undefined) chart.push(`embed: ${c.embed_url}`);
  if (chart.length > 0) lines.push(`- ${chart.join(" · ")}`);
  const meta: string[] = [];
  if (c.source !== undefined) meta.push(`source: ${oneLine(c.source)}`);
  // "refreshed", not "updated", the same word renderProjectedCard uses: this is
  // Tako's refresh date, not the date the data runs to, and a bare "updated" in
  // a fact line reads as the latter.
  if (c.last_updated !== undefined) meta.push(`refreshed ${c.last_updated}`);
  if (meta.length > 0) lines.push(`- ${meta.join(" · ")}`);
  return lines.join("\n");
}

function renderCitation(c: ProjectedCitation): string {
  const url = c.url !== undefined ? ` — ${c.url}` : "";
  const corpus = c.source_index !== undefined ? ` (${c.source_index})` : "";
  return `[${c.index}] ${oneLine(c.title)}${url}${corpus}`;
}

/** An agent run as markdown: the answer, the cards it built, the indexed
 *  sources its [n] markers join to, and the reasoning notes behind it. */
export function renderAgentRunMarkdown(o: AgentRunOutput): string {
  const blocks: string[] = [];
  if (o.answer !== undefined) blocks.push(o.answer);
  if (o.guidance !== undefined) blocks.push(`> ${o.guidance}`);
  if (o.error !== undefined) {
    blocks.push(`> Agent run failed (${oneLine(o.error.code)}): ${oneLine(o.error.message)}`);
  }
  // A terminal run with no prose and no reason is a backend anomaly, not an
  // empty answer the model should paraphrase — say so rather than emitting a
  // document whose first line is a section header.
  if (blocks.length === 0) blocks.push("The agent returned no answer.");

  if (o.cards.length > 0) {
    blocks.push(`## Cards (${o.cards.length})`);
    blocks.push(...o.cards.map(renderAgentCard));
  }
  if (o.citations.length > 0) {
    blocks.push(`## Citations (${o.citations.length})`);
    blocks.push(o.citations.map(renderCitation).join("\n"));
  }
  if (o.definitions !== undefined) blocks.push(renderNameMap("Definitions", o.definitions));
  if (o.assumptions !== undefined) blocks.push(renderNameMap("Assumptions", o.assumptions));
  if (o.methodology !== undefined) blocks.push(renderNameMap("Methodology", o.methodology));
  if (o.thread_id !== undefined) {
    blocks.push(`thread_id: ${o.thread_id} — send it back to ask a follow-up.`);
  }
  const footer = renderFooter(o.usage);
  if (footer !== undefined) blocks.push(footer);
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_contents text channel — COMPLETE, not an index (spec, text-channel
// template). It used to emit a POINTER at the payload
// ("page text: 2120 chars in structuredContent.results[].data", 150 chars
// against 2,284 structured, measured on prod 2026-08-30), which is the whole
// result on the 9 harnesses that feed the model `content` only.
//
// Card rows render as `JSON.stringify(item.rows)` — BYTE-IDENTICAL to what
// `structuredContent` carries, since both serialize the same projected object
// in the same key order. That is what makes channel parity exact here rather
// than approximate, and it is why the rows are not re-rendered as a markdown
// table: a table writes a missing cell as an empty one, which is the null
// ambiguity the projection switched off CSV to escape (see `_contents.ts`).
// ---------------------------------------------------------------------------

/** One requested url: anchor, the note that explains the payload, the payload,
 *  then the chrome — the same order `projectedContentsItemShape` DECLARES, so a
 *  host that truncates either channel loses the same thing. The shape is the
 *  authority, not the projection's spread: zod rebuilds a parsed object in
 *  declaration order. */
function renderContentsItem(item: ProjectedContentsItem, showCost: boolean): string {
  const blocks: string[] = [oneLine(item.url)];
  // A failed url renders as its reason and nothing else; the other entries are
  // untouched, so the model reads N-1 payloads plus one recovery.
  if (item.error !== undefined) {
    blocks.push(`> ${oneLine(item.error)}`);
  } else {
    if (item.note !== undefined) blocks.push(`> ${oneLine(item.note)}`);
    if (item.rows !== undefined) blocks.push(fenced(JSON.stringify(item.rows), "json"));
    // Page text is upstream content rendered verbatim into our own document —
    // fenced so a page ending in "## Contents (1 url)" cannot forge the framing.
    if (item.text !== undefined) blocks.push(fenced(item.text));
  }
  const meta: string[] = [];
  if (item.truncated === true) meta.push("truncated");
  if (item.source_url !== undefined) meta.push(`fetched: ${oneLine(item.source_url)}`);
  if (showCost) meta.push(`cost: $${item.cost}`);
  if (meta.length > 0) blocks.push(`- ${meta.join(" · ")}`);
  return blocks.join("\n\n");
}

/**
 * `tako_contents` as text: one section per requested url, each carrying its
 * whole payload, then `usage` as the final line.
 *
 * A single-url call — the common case — renders with no `##` header and no
 * per-item cost line: with one entry the item's `cost` and the root `usage`
 * are the same number, so one line says it. A batch shows both, because
 * knowing WHICH url was expensive is the fact a caller acts on.
 */
export function renderContentsText(o: ContentsOutput): string {
  const items = o.results ?? [];
  if (items.length === 0) return "No content fetched.";
  const footer = `usage: $${o.usage.total_cost_usd}`;
  if (items.length === 1) {
    return [renderContentsItem(items[0] as ProjectedContentsItem, false), footer].join("\n\n");
  }
  const failed = items.filter((r) => r.error !== undefined).length;
  const header = `## Contents (${items.length} urls${failed > 0 ? `, ${failed} failed` : ""})`;
  const sections = items.map((r, i) => `### ${i + 1}. ${renderContentsItem(r, true)}`);
  return [header, ...sections, footer].join("\n\n");
}
