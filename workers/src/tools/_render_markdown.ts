/**
 * Markdown renderers for the model-facing text channel, the advertised
 * `structuredContent` shapes for the tools the redesign has migrated, and the
 * `slimStructured` hooks the ones it has not reached yet still use.
 *
 * Why markdown: the consumers of these tools are agents reading text. JSON
 * taxes prose-heavy content twice — escaped newlines/quotes inside snippets,
 * and per-item key repetition (`"title":`, `"url":`, … × N results) — and a
 * truncated JSON string is malformed where a truncated markdown doc just
 * loses its tail. Layout: Tako data cards first, then web results, then the
 * two reference maps, so truncating clients lose boilerplate before data.
 *
 * BOTH CHANNELS ARE COMPLETE for the search tools, and the duplication is the
 * decision, not an oversight. The older rule — text carries everything,
 * `structuredContent` shrinks to machine essentials so a host counting both
 * does not pay twice — assumed every host reads the text. A 2026-08 audit
 * measured otherwise: 9 harnesses (Cursor, Vercel AI SDK, OpenCode, Gemini
 * CLI, Goose, LangChain, OpenAI Agents SDK py+js, Excel/Outlook) feed the
 * model `content` ONLY, while both submission targets — ChatGPT and Claude
 * Code — feed it `structuredContent` ONLY. Either channel alone is therefore a
 * wrong answer on some host. The projection is what makes shipping both
 * affordable (~31.9k chars -> ~13k per channel), and the "channel parity
 * (tako_search)" test asserts every projected leaf reaches the text.
 *
 * So `tako_search`, `tako_search_advanced`, `tako_contents` and
 * `tako_visualize` declare NO `slimStructured` hook: their handler output IS
 * the advertised shape, and `pickDeclared` in `mcp.ts` does the per-surface
 * narrowing.
 * `tako_available_data` and `tako_agent` still slim, with the two helpers in
 * this module; `tako_graph_related` slims with its own function.
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

// Flattens upstream text destined for a single-line slot (titles, meta, node
// names): an embedded newline would otherwise start a fresh line the CONTENT
// controls. Defined next to the summary builder that needs the same guarantee,
// so the two channels cannot drift into flattening differently.
import { oneLine } from "./_available_data.js";
import type { ContentsOutput, ProjectedContentsItem } from "./_contents.js";
import type { GraphRelatedFacade } from "./_graph.js";
import {
  autoChainShape,
  nonEmpty,
  projectedCardShape,
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
  cards: z
    .array(projectedCardShape)
    // Holds on BOTH tools, because this shape is shared (see the `related`
    // comment below for the same rule). `tako_search_advanced` with
    // `include_contents: true` sets rowCap "all" and DOES inline rows, so an
    // unqualified "fetch the rows with tako_contents" here sent that caller
    // into a priced refetch of rows it had already paid to inline.
    .describe("The data cards. Rows ride in a card's `rows` only when the request asked to inline them (tako_search never does) — otherwise fetch an exportable card's rows with tako_contents on its url."),
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
  related: z
    .array(z.looseObject({}))
    .optional()
    .describe(
      "Follow-up queries, each with a `query` to send as the next search request. Present only when you set include_related.",
    ),
  answer: z
    .string()
    .optional()
    .describe(
      "The synthesized, citation-backed answer. Present only when you set include_answer: true; the cards and web_results are its citations.",
    ),
  structured_output: z
    .looseObject({})
    .optional()
    .describe(
      "The output_schema you supplied, filled from the same evidence as the answer. Absent when you supplied none, or when Tako could not fill it — see structured_output_error.",
    ),
  structured_output_error: z
    .looseObject({})
    .optional()
    .describe(
      "Why structured_output is absent: `code` and `message`. Present only when Tako could not fill an output_schema you supplied.",
    ),
} as const;

export const searchSlimOutputShape = z.looseObject(searchCoreFields);

/** chatgpt-surface variant: adds the widget fields `window.openai.toolOutput`
 *  reads (the widget ignores `cards`/`web_results`). */
export const searchChatgptOutputShape = z.looseObject({
  ...searchCoreFields,
  ...autoChainShape,
});

/** `tako_search_advanced` only: the core plus the answer endpoint's four. */
export const searchAdvancedOutputShape = z.looseObject({
  ...searchCoreFields,
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

type LooseContent = {
  content_format?: string | null;
  data?: string | null;
  records?: Array<Record<string, unknown>> | null;
  dataset?: { columns?: unknown; rows?: unknown[] } | null;
  total_rows?: number | null;
  truncated?: boolean | null;
  /** Per-column descriptors, in column order — the ONLY carrier of a
   *  column's unit. See `renderColumnManifest`. */
  manifest?: Array<{
    name?: string | null;
    metric?: string | null;
    entity?: string | null;
    unit?: string | null;
  }> | null;
};

/**
 * The units line for inlined rows.
 *
 * Without it a json_records inline reads `[{"col": 12.4}]` and nothing on
 * either channel says whether 12.4 is USD, USD billions or a percent — the
 * generated `ColumnDescriptor` is the only place `unit`, `metric` and
 * `entity` exist, and the CSV branch fences the payload alone.
 *
 * One line for the whole manifest, `name — metric, entity, unit`, dropping
 * whichever parts a producer left unset. `undefined` when no column carries
 * anything worth printing, so a manifest of bare names adds no line.
 */
function renderColumnManifest(manifest: NonNullable<LooseContent["manifest"]>): string | undefined {
  const cols = manifest
    .map((c) => {
      const parts = [c.metric, c.entity, c.unit].filter(
        (v): v is string => typeof v === "string" && v !== "",
      );
      const name = typeof c.name === "string" && c.name !== "" ? c.name : undefined;
      if (parts.length === 0) return name;
      return name === undefined ? parts.join(", ") : `${name} — ${parts.join(", ")}`;
    })
    .filter((v): v is string => v !== undefined)
    .map(oneLine);
  if (cols.length === 0) return undefined;
  // Only worth a line when at least one column said more than its own header.
  const informative = manifest.some((c) =>
    [c.metric, c.entity, c.unit].some((v) => typeof v === "string" && v !== ""),
  );
  return informative ? `- columns: ${cols.join(" · ")}` : undefined;
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
    if (typeof c.rows.data === "string") {
      // The string branch fences `data` ALONE, so the descriptor keys beside it
      // reach structuredContent and nothing else — `truncated: true` most of
      // all, which tells the model the rows it is reading are cut. The JSON
      // branch below stringifies the whole object and never had the gap. Both
      // keys are dropped from the line when absent, so a card with neither
      // renders exactly as before.
      const desc: string[] = [];
      if (typeof c.rows.content_format === "string") desc.push(`format: ${c.rows.content_format}`);
      if (c.rows.truncated === true) desc.push("TRUNCATED — these are not all the rows");
      if (desc.length > 0) lines.push(`- rows: ${desc.join(" · ")}`);
      const columns = Array.isArray(c.rows.manifest)
        ? renderColumnManifest(c.rows.manifest)
        : undefined;
      if (columns !== undefined) lines.push(columns);
      lines.push(fenced(c.rows.data));
    } else {
      const columns = Array.isArray(c.rows.manifest)
        ? renderColumnManifest(c.rows.manifest)
        : undefined;
      if (columns !== undefined) lines.push(columns);
      lines.push(fenced(JSON.stringify(c.rows)));
    }
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
        .map((r) =>
          typeof r.description === "string" && r.description !== ""
            ? `- ${oneLine(r.query)} — ${oneLine(r.description)}`
            : `- ${oneLine(r.query)}`,
        )
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
// tako_available_data
// ---------------------------------------------------------------------------

/**
 * How many coverage entries per match ride in `structuredContent`. The full
 * (up to MAX_COVERAGE_NAMES) name list is already in the markdown text; this
 * channel exists to hand over the ids for a PINNED follow-up, and metric
 * entries are ordered headline-first, so the useful ones are at the front.
 * Capped because name+id pairs for 200 metrics would roughly double the
 * response for a payload the model reads once.
 */
export const STRUCTURED_COVERAGE_ITEMS = 25;

const resolvedRefShape = z.object({
  node_id: z.string(),
  name: z.string(),
  type: z.string(),
});

const coverageItemShape = z.object({
  name: z.string(),
  node_id: z.string().describe("Graph node id. Hand it to tako_graph_related to explore what else the graph holds on this node."),
});

/** Advertised (slim) structuredContent shape for tako_available_data: the
 *  machine-checkable verdict, the resolved matches with their node ids, and
 *  the ready-to-run follow-up. The prose summary and the full coverage-name
 *  lists ride in the markdown text. */
export const availableDataSlimOutputShape = z.looseObject({
  found: z
    .boolean()
    .describe(
      "The OUTCOME. Discovery path (no `metric`): at least one match has live data coverage, not mere node resolution. Lookup path (`metric` supplied): the resolved entity HOLDS something matching — the resolved metric is on its own metric list, or its metrics contain your phrase. Both names resolving isn't enough: a checked list with nothing matching reads false. A metric that resolved nowhere globally still reads true when the entity's own list carries the phrase. Read `verified` for what was actually CHECKED. Never means a chart exists; only running `next_call` establishes that.",
    ),
  verified: z
    .enum(["coverage", "pair", "unlinked", "resolution"])
    .optional()
    .describe(
      "WHAT WAS CHECKED, as distinct from `found`, which is the outcome. `coverage`: a coverage list was drilled. `pair`: the metric is on the entity's own metric list — the strongest free evidence there is. `unlinked`: the entity's list was checked and the resolved metric is not on it, so a card for this pair is unlikely. It says nothing about the rest of the list — `unlinked` and `found: true` sit together whenever your `metric` phrase matched entries the resolved node is not one of, and `coverage` then names them. `resolution`: no pair evidence (check skipped or failed) — treat exactly as before.",
    ),
  query: z.string(),
  matches: z
    .array(
      z.looseObject({
        node_id: z.string(),
        name: z.string(),
        type: z.string(),
        subtype: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
        unavailable: z.boolean().optional(),
        filter: z
          .string()
          .optional()
          .describe(
            "The `metric` phrase this match's coverage was filtered by. Present means `coverage.total` counts only the entries matching it, not the entity's whole list — without it a structured-only reader cannot tell `total: 13` meaning \"13 hits for your phrase\" from `total: 13` meaning \"13 metrics in all\". The text channel distinguishes them; this is how the machine channel does.",
          ),
        coverage: z.looseObject({
          kind: z.string(),
          total: z.number(),
          truncated: z.boolean(),
          items: z.array(coverageItemShape),
          // Optional in the ADVERTISED shape (not in the emitted value) for
          // the same reason every slim shape here is loose: the handler's FULL
          // output must stay assignable to it, and the full CoverageGroup
          // carries no slim-channel bookkeeping field. `slimAvailableData-
          // Structured` always emits it.
          items_truncated: z
            .boolean()
            .optional()
            .describe(
              "More coverage entries exist than are listed here, so treat an entry you do not see as unconfirmed, not absent. The text channel carries every name that was fetched, and says so when that list was cut too.",
            ),
        }),
      }),
    )
    .describe(
      "The resolved matches and their coverage, each entry carrying its canonical name and graph node id. To fetch a specific metric, call tako_search with the EXACT canonical name as the query — the canonical name is what recovers cards. A node id is for traversal via tako_graph_related.",
    ),
  // Optional in the ADVERTISED shape, always present in the emitted value —
  // the same rule `items_truncated` follows: the handler's FULL output carries
  // `other_matches`, not `candidates`, and must stay assignable to this shape.
  candidates: z
    .array(
      z.object({
        node_id: z.string(),
        name: z.string(),
        type: z.string(),
        subtype: z.string().nullable(),
        label: z.string().nullable(),
        coverage_total: z.number().int().optional(),
      }),
    )
    .optional()
    .describe(
      "The other nodes `q` resolved to, best first, each with its canonical name to search on and its id to explore with tako_graph_related. coverage_total is present only for candidates that were coverage-checked; the text channel carries their aliases.",
    ),
  next_call: z
    .object({
      tool: z.enum(["tako_search"]),
      query: z.string(),
    })
    .nullable()
    .describe(
      "Ready-to-run follow-up: call the tool it names with exactly this query. The query uses the canonical graph names for both halves, which is what recovers cards. Present whenever the measure is known: you passed `metric`, or `q` itself named a metric, or the entity has few enough metrics that the top one is unambiguous. Null otherwise — pass `metric` to get a handle.",
    ),
  // Lookup path (`metric` supplied): the resolved pair. Optional because the
  // discovery path returns `matches` instead.
  metric_query: z.string().optional(),
  entity: resolvedRefShape.nullable().optional(),
  metric: resolvedRefShape
    .nullable()
    .optional()
    .describe("The resolved metric, by its canonical graph name — the name the follow-up query uses."),
  entity_alternates: z.array(resolvedRefShape).optional(),
  metric_alternates: z
    .array(resolvedRefShape)
    .optional()
    .describe(
      "Runners-up. The top metric is right ~80% of the time and the top three ~93-95%, so check these before accepting the primary.",
    ),
});

interface CoverageMatchLike {
  node_id: string;
  name: string;
  type: string;
  subtype: string | null;
  label: string | null;
  aliases: string[];
  unavailable?: boolean | undefined;
  /** Set when the list was filtered by the caller's `metric` phrase (lookup path). */
  filter?: string | undefined;
  coverage: {
    kind: string;
    items: Array<{ name: string; node_id: string }>;
    names: string[];
    total: number;
    truncated: boolean;
    capped: boolean;
  };
  [key: string]: unknown;
}

export interface ResolvedRefLike {
  node_id: string;
  name: string;
  type: string;
}

export interface AvailableDataFullOutput {
  found: boolean;
  /** What evidence stands behind the verdict — see PairVerdict in _pair_confirm.ts. */
  verified?: "coverage" | "pair" | "unlinked" | "resolution" | undefined;
  query: string;
  summary: string;
  matches: CoverageMatchLike[];
  other_matches: Array<{
    node_id: string;
    name: string;
    type: string;
    subtype: string | null;
    label: string | null;
    aliases: string[];
    coverage_total?: number | undefined;
    coverage_capped?: boolean | undefined;
  }>;
  next_call: { tool: "tako_search"; query: string } | null;
  /** False when the gate failed open — the matches are low-confidence. */
  confident?: boolean | undefined;
  metric_query?: string | undefined;
  entity?: ResolvedRefLike | null | undefined;
  metric?: ResolvedRefLike | null | undefined;
  entity_alternates?: ResolvedRefLike[] | undefined;
  metric_alternates?: ResolvedRefLike[] | undefined;
  [key: string]: unknown;
}

export function slimAvailableDataStructured(
  o: AvailableDataFullOutput,
): Record<string, unknown> {
  return {
    found: o.found,
    // Omitted rather than emitted as null when no check applies (swapped args,
    // no entity) — an absent field reads as "not applicable", where a null
    // would read as a checked-and-empty result.
    ...(o.verified === undefined ? {} : { verified: o.verified }),
    query: o.query,
    // The node ids the whole discovery→fetch handoff depends on. They were
    // previously text-only (as prose inside `**Name** (`id`)`), so an agent
    // reading structuredContent got a bare `found` boolean and nothing to act
    // on. Names stay capped here (STRUCTURED_COVERAGE_ITEMS) because the full
    // list is in the text; the ids are the part text can't cheaply carry.
    matches: o.matches.map((m) => ({
      node_id: m.node_id,
      name: m.name,
      type: m.type,
      ...(m.subtype === undefined ? {} : { subtype: m.subtype }),
      ...(m.label === undefined ? {} : { label: m.label }),
      ...(m.unavailable === true ? { unavailable: true } : {}),
      // What `coverage.total` COUNTS, without which it is unreadable: 13 hits
      // for the caller's phrase and 13 metrics in all serialize identically.
      // The text channel says `metrics containing "data center" (13)`; this is
      // the machine channel's half of that sentence.
      ...(m.filter === undefined ? {} : { filter: m.filter }),
      coverage: {
        kind: m.coverage.kind,
        total: m.coverage.total,
        truncated: m.coverage.truncated,
        items: m.coverage.items.slice(0, STRUCTURED_COVERAGE_ITEMS),
        // `total`, not the slice. Deriving this from `items.length` alone read
        // FALSE on the tie path, whose matches carry `items: []` beside a real
        // `total` — so `0 > 5` told a structured reader the empty list was the
        // whole list, next to `total: 15, truncated: true`. Keep the slice
        // clause too: it is the only one that fires when `total` undercounts
        // the entries (a filtered count, a capped page), and this flag must
        // never read false while entries were dropped.
        items_truncated:
          m.coverage.items.length > STRUCTURED_COVERAGE_ITEMS ||
          m.coverage.total > Math.min(m.coverage.items.length, STRUCTURED_COVERAGE_ITEMS),
      },
    })),
    // The wide candidate list reaches the machine channel too: a
    // structured-only reader could not act on names it had no ids for.
    candidates: (o.other_matches ?? []).map((c) => ({
      node_id: c.node_id,
      name: c.name,
      type: c.type,
      subtype: c.subtype ?? null,
      label: c.label ?? null,
      ...(c.coverage_total === undefined ? {} : { coverage_total: c.coverage_total }),
    })),
    next_call: o.next_call,
    ...(o.metric_query === undefined ? {} : { metric_query: o.metric_query }),
    ...(o.entity === undefined ? {} : { entity: o.entity }),
    ...(o.metric === undefined ? {} : { metric: o.metric }),
    ...(o.entity_alternates === undefined ? {} : { entity_alternates: o.entity_alternates }),
    ...(o.metric_alternates === undefined ? {} : { metric_alternates: o.metric_alternates }),
  };
}

/** The coverage report: the deterministic summary, then each match's full
 *  coverage-name list (the primary payload — these are the exact terms to
 *  reuse in tako_search), then the runnable next_call. */
function renderRef(
  label: string,
  ref: ResolvedRefLike,
  alternates: ResolvedRefLike[],
  // Goes on the FIRST line. Taken as a parameter rather than concatenated by
  // the caller because this function returns MULTIPLE lines when alternates
  // exist, so an appended suffix would land on the alternates line instead.
  suffix = "",
): string {
  // Names are upstream content in a single-line slot — flattened so an
  // embedded newline cannot start a line that mimics this very format.
  const lines = [`${label}  ${oneLine(ref.name)}  \`${oneLine(ref.node_id)}\`${suffix}`];
  if (alternates.length > 0) {
    lines.push(
      `${" ".repeat(label.length)}  alternates: ${alternates
        .map((a) => `${oneLine(a.name)} (\`${oneLine(a.node_id)}\`)`)
        .join(" · ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The LOOKUP path's document: what was asked, what each half resolved to (with
 * ids), the runners-up, and one runnable call.
 *
 * Echoing the resolution back is the point. The top metric is right ~80% of the
 * time, and when it is wrong it is wrong VISIBLY — `metric="total revenue"`
 * resolves `Total Odds` with `Revenues` sitting at rank 1. Printing the name
 * the tool actually picked, next to the alternates, lets the model catch that
 * for free instead of pinning a confidently wrong node.
 */
export function renderAvailableDataPairMarkdown(o: AvailableDataFullOutput): string {
  const blocks: string[] = [o.summary];
  const rows: string[] = [];
  if (o.entity != null) {
    rows.push(renderRef("entity", o.entity, o.entity_alternates ?? []));
  }
  if (o.metric != null) {
    // The verdict rides on the metric row because the metric is what gets
    // pinned — it is the row a model reads before deciding to trust the handle.
    const mark =
      o.verified === "pair"
        ? "  (on the entity's metric list)"
        : o.verified === "unlinked"
          ? "  (NOT on the entity's metric list)"
          : "";
    rows.push(renderRef("metric", o.metric, o.metric_alternates ?? [], mark));
  }
  if (rows.length > 0) blocks.push(rows.join("\n"));

  // The entity's own metrics containing the caller's phrase (fix 3), or the
  // full coverage drill when nothing resolved. `filter` is what tells the two
  // apart, so the header can say what the list is scoped to.
  for (const m of o.matches) {
    if (m.unavailable === true || m.coverage.names.length === 0) continue;
    const total = `${m.coverage.total}${m.coverage.capped ? "+" : ""}`;
    const what =
      m.filter === undefined ? m.coverage.kind : `${m.coverage.kind} containing "${oneLine(m.filter)}"`;
    // A CUT LIST MUST SAY SO, or a name past the cap reads as absent. This
    // loop renders the lookup path's fall-through drill, which is the same
    // full paginated one the discovery renderer warns about (capped at
    // MAX_COVERAGE_NAMES / MAX_COVERAGE_PAGES) — it lost the warning when the
    // route widened from `matches.length === 0` to every `metric_query`.
    // A filtered list cannot name the remainder: its `total` counts the hits,
    // and a page that came back with a cursor never said how many matched.
    const more =
      m.coverage.total > m.coverage.names.length
        ? ` …and ${m.coverage.total - m.coverage.names.length} more not shown (treat a name you don't see as unconfirmed, not absent).`
        : m.coverage.truncated
          ? " …this list was cut, so treat a name you don't see as unconfirmed, not absent."
          : "";
    blocks.push(
      `**${oneLine(m.name)}** (\`${oneLine(m.node_id)}\`) — ${what} (${total}):\n${m.coverage.names.map(oneLine).join(", ")}${more}`,
    );
  }

  if (o.next_call !== null) {
    // The embedded query is caller input — dynamic fence, same as web text.
    blocks.push(`next_call (run verbatim):\n${fenced(JSON.stringify(o.next_call), "json")}`);
  }
  return blocks.join("\n\n");
}

export function renderAvailableDataMarkdown(o: AvailableDataFullOutput): string {
  // The lookup path renders the pair rows, and now its own metric list too
  // (fix 3), so it owns every output carrying a `metric_query` — including the
  // fall-through full drill, which used to route here.
  if (o.metric_query !== undefined) return renderAvailableDataPairMarkdown(o);
  // Nothing plausibly matched. The handler now skips the coverage drill on this
  // path entirely, so there are no names left to print and this is belt and
  // braces rather than the thing doing the work — kept because the summary
  // already disclaims these resolutions ("almost certainly NOT what you asked
  // for") and appending a coverage list under one would contradict it. Before
  // the drill was skipped, this suppressed ~8.5k chars elaborating on an answer
  // we had just disclaimed, while `structuredContent` still carried the totals
  // — the two channels disagreed. Both now report no coverage.
  if (o.confident === false) return o.summary;
  const blocks: string[] = [o.summary];

  for (const m of o.matches) {
    if (m.unavailable === true || m.coverage.names.length === 0) continue;
    const total = `${m.coverage.total}${m.coverage.capped ? "+" : ""}`;
    const head = `**${oneLine(m.name)}** (\`${oneLine(m.node_id)}\`) — ${m.coverage.kind} (${total} total):`;
    const names = m.coverage.names.map(oneLine).join(", ");
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
// tako_graph_related
// ---------------------------------------------------------------------------

function nodeKind(n: {
  type: string;
  subtype?: string | null | undefined;
  label?: string | null | undefined;
}): string {
  return [n.type, n.subtype, n.label]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .map(oneLine)
    .join(" · ");
}

/**
 * The compact map of a node. Overview: one line per relation group — key,
 * label, total, the preview names. Drill: one line per item with its id.
 * Node names and ids are upstream content in single-line slots, so they are
 * flattened the same way the available-data renderer flattens them.
 */
export function renderGraphRelatedMarkdown(o: GraphRelatedFacade): string {
  const n = o.node;
  const head: string[] = [`**${oneLine(n.name)}** (\`${oneLine(n.id)}\`) — ${nodeKind(n)}`];
  if (n.aliases !== undefined && n.aliases.length > 0) {
    head.push(`aliases: ${n.aliases.map(oneLine).join(", ")}`);
  }
  if (typeof n.description === "string" && n.description !== "") head.push(oneLine(n.description));
  const blocks: string[] = [head.join("\n")];

  if (o.relation !== undefined && o.relation !== null) {
    const g = o.relation;
    const total = `${g.total}${g.total_capped ? "+" : ""}`;
    const more = g.next_cursor ? `; more: pass cursor "${oneLine(g.next_cursor)}"` : "";
    const lines = g.items.map((i) => {
      const kind = [i.subtype, i.label].filter((p): p is string => typeof p === "string" && p !== "");
      return `- ${oneLine(i.name)} (\`${oneLine(i.id)}\`)${kind.length > 0 ? ` · ${kind.map(oneLine).join(", ")}` : ""}`;
    });
    blocks.push(
      `\`${oneLine(g.key)}\` — ${oneLine(g.label)} — ${total} total, ${g.items.length} on this page${more}:\n${lines.length > 0 ? lines.join("\n") : "_none_"}`,
    );
  } else if (o.relations !== undefined && o.relations !== null) {
    if (o.relations.length === 0) {
      blocks.push("No related nodes.");
      return blocks.join("\n\n");
    }
    const lines = o.relations.map((g) => {
      const total = `${g.total}${g.total_capped ? "+" : ""}`;
      // A group the preview shows WHOLE is answerable from the overview, so it
      // carries its ids; a group with more behind it does not, because the
      // drill returns every id for free and 3 ids per group across a 17-group
      // overview costs ~1.3k chars for handles the next call supplies anyway.
      const complete = !g.total_capped && g.total <= g.items.length;
      const names = g.items
        .map((i) => (complete ? `${oneLine(i.name)} (\`${oneLine(i.id)}\`)` : oneLine(i.name)))
        .join(", ");
      const tail = g.total > g.items.length ? ", …" : "";
      // A cursor on an overview group is the only handle to the rest of it, so
      // it rides the line rather than waiting for the drill to rediscover it.
      const more = g.next_cursor
        ? ` — more: \`relation: "${oneLine(g.key)}"\`, cursor "${oneLine(g.next_cursor)}"`
        : "";
      return `- \`${oneLine(g.key)}\` — ${oneLine(g.label)} — ${total}: ${names}${tail}${more}`;
    });
    blocks.push(
      `Relations (pass \`relation: "<key>"\` to page one, \`q\` to filter by substring):\n${lines.join("\n")}`,
    );
  } else if (o.relation === null) {
    // A drill that came back `relation: null` — spec-legal, and
    // `tako_available_data` already reads it as a real "zero coverage", so it
    // reaches the model. Without this arm the response was the focal-node
    // header ALONE: a name and an id, and not one word about the group the
    // caller asked for, which reads as a truncated result rather than an
    // answer. The renderer cannot name the key (renderText sees the output,
    // not the input), so it states the two things the key would not add.
    blocks.push(
      "That relation has no items for this node. An unknown relation key is NOT an error — it returns empty the same way — so re-read the overview (`node_id` alone) for the keys this node actually has.",
    );
  } else {
    // `relations: null`, or neither key present. Same reading as `relations:
    // []`, and the same sentence the renderer this replaced emitted.
    blocks.push("No related nodes.");
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// tako_agent
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
