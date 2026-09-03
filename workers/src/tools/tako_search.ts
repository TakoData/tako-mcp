/**
 * `tako_search` — fast semantic search over Tako's curated knowledge
 * graph (and the live web when asked), backed by `POST /api/v3/search`.
 *
 * Synchronous and fast-only: `effort` is `fast` (default) or `instant`
 * (cached-embed fast path). There is no in-tool deep/research path and
 * no async polling. A zero-card response carries a `guidance` field
 * (built in `_search_results.ts`) steering the model to the free
 * `tako_available_data` coverage check instead of priced
 * reword-and-retry loops.
 *
 * The top result auto-renders inline as a chart: `buildSearchOutput`
 * lifts the top card's `card_id` into top-level widget fields
 * (`pub_id`, `embed_url`, `image_url`, …) that the host's chart widget
 * reads. `buildChartUrls` only needs a `card_id`, which v3 TakoCards
 * carry directly.
 */
import { z } from "zod";

import { SearchRequest } from "../generated/schemas.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import { looseArray } from "./_loose_array.js";
import {
  renderSearchMarkdown,
  searchChatgptOutputShape,
  searchSlimOutputShape,
} from "./_render_markdown.js";
import { runSearch } from "./_run_search.js";
import { SOURCES_DESCRIBE } from "./_shared_prose.js";
import type { SearchOutput } from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolContext, ToolModule } from "./types.js";

const DESCRIPTION = [
  "Search Tako's data graph and the live web in one call: many results at once, as structured cards plus web results, with the top card rendered inline as a chart.",
  "",
  "It finds data; `tako_contents` fetches it. Each card carries a headline value, node ids, and a url — pass the url to `tako_contents` for rows (`exportable: true` cards) or a web result's full page text. When `exportable` is false the rows are locked — read the headline value from the card's `description`.",
  "",
  // `Best for:` verbatim: AGENTS.md's tool-description rule, and the form the
  // other three default tools already use in docs/TOOLS.md.
  'Best for: breadth — fan out several narrow queries in parallel. Each query resolves one metric — for one entity, or a comparison set ("Apple revenue", "Nvidia vs AMD gross margin"); several metrics or topics in one query retrieve poorly. To learn what Tako covers, or a metric\'s canonical name, run `tako_available_data` first, then search on the canonical name it returns.',
].join("\n");

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue"). Double-quote a multi-word name to keep it one entity ("tesla motors" club revenue); an unpaired quote disables quoting. Website-traffic data is keyed by domain — query "openai.com monthly visits", not "OpenAI website visits".',
    ),
  // looseArray: hosts that stringify the array they meant to send (observed
  // from OpenBB Copilot) get it coerced instead of a -32602. `commaSeparated` is
  // safe here and ONLY here: the item domain is a closed enum, no member of
  // which contains a comma. See _loose_array.ts.
  //
  // The ONE field here that keeps a default, and it is not an exception to the
  // no-defaults rule below: the Worker READS `sources` to decide which
  // per-source blocks to build and which zero-card guidance branch applies. It
  // is never forwarded to the API as a value.
  sources: looseArray(
    z
      .array(z.enum(["data", "web"]))
      .min(1)
      .default(["data", "web"])
      // Shared with tako_agent, whole and unmodified (spec D2.10).
      .describe(SOURCES_DESCRIBE),
    { field: "tako_search.sources", commaSeparated: true },
  ),
  country_code: z
    .string()
    .optional()
    .describe(
      "ISO 3166-1 alpha-2 country code for localized results. Omit it and the server uses US. Set it to localize for the user.",
    ),
  locale: z
    .string()
    .optional()
    .describe(
      "BCP-47 locale tag for language and formatting. Omit it and the server uses en-US. Set it to localize for the user.",
    ),
});

type Input = z.infer<typeof inputSchema>;

// The ADVERTISED output schema: the PROJECTED shape, typed field by field.
// The handler's output is an explicit projection (`projectCard` /
// `projectWebResult` in `_search_results.ts`), so unknown backend keys cannot
// leak and the schema no longer needs to be a loose stub — the wire guard
// stays the generated SearchResponse safeParse in runSearch. Per surface:
// the chatgpt variant adds the widget fields `window.openai.toolOutput`
// reads; the generic one omits them, and `pickDeclared` in mcp.ts strips
// them from `/mcp` responses by construction (spec, "Per-tool shape").
const outputSchema = searchSlimOutputShape;

type Output = z.infer<typeof outputSchema>;

/**
 * Reshape the flat MCP input into the backend's nested SearchRequest body.
 * Exported for the contract-guard test.
 *
 * The `satisfies z.input<typeof SearchRequest>` annotation is the build-time
 * guard: if the backend request contract changes (new required field, renamed
 * key, changed enum) this line fails to compile — the intended signal.
 */
export function buildSearchBody(input: Input): z.input<typeof SearchRequest> {
  // Typed against the contract (not Record<string, …>) so a renamed/added
  // `Sources` key or a new required per-source sub-field breaks compilation here.
  const sources: NonNullable<z.input<typeof SearchRequest>["sources"]> = {};
  // Each block goes out EMPTY. The simple tool declares no defaults of its own:
  // an omitted field is omitted from the body, so the v3 API's own default
  // applies and every parameter description here states that default in words.
  //
  // This deletes two overrides the tool used to carry — `count: 10` on both
  // sources (the API serves 5) and `snippet_max_chars: 2000` (the API serves
  // 4000 on /v3/search). Both predate tako#29572, which made every delivered
  // row bill per 1k, and neither had a rationale anywhere in the tree. A caller
  // who wants them names the advanced search tool.
  if (input.sources.includes("data")) sources.data = {};
  if (input.sources.includes("web")) {
    // The ONE opinionated departure from the API, and the same one Exa's
    // web_search_exa makes: the snippet becomes the passages Exa's model selects
    // against the query instead of the page's opening characters. The opening is
    // usually nav chrome and press-release preamble; the excerpt exists so the
    // model can choose which url to spend a tako_contents call on, and preamble
    // does not support that choice.
    //
    // Two consequences ride along — a page with no highlight returns
    // `snippet: null` and keeps its slot, and one snippet may hold several
    // non-contiguous passages joined by " … ". Both are documented to the model
    // on `searchSlimOutputShape.web_results`, which is the ADVERTISED schema;
    // `webResultSchema.snippet` is the wire guard and is never sent to a client,
    // so a description there would reach nobody.
    sources.web = { highlights: true };
  }
  const body: z.input<typeof SearchRequest> = { query: input.query, sources };
  if (input.country_code !== undefined) body.country_code = input.country_code;
  if (input.locale !== undefined) body.locale = input.locale;
  return body satisfies z.input<typeof SearchRequest>; // ← build-time guard: backend request drift breaks here
}


const tako_search = {
  name: "tako_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  // The chart widget fields exist only where a widget reads them.
  outputSchemaBySurface: { chatgpt: searchChatgptOutputShape },
  annotations: {
    title: "Tako: Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Open-world on EVERY surface: the call searches the live public web,
    // a system outside Tako's first-party context. That is open-world
    // under MCP's reading (domain of interaction) and under OpenAI's Apps
    // review guideline ("tools that interact with external systems ...
    // must be explicitly labeled"). See `annotationsBySurface` in types.ts.
    openWorldHint: true,
  },
  // No `anonymousInputRejects`. It existed for one input — `include_contents:
  // true`, which billed rows to the shared free-tier account — and that input
  // is gone: rows come from tako_contents now. This tool has nothing left to
  // refuse anonymously, which is the point of the split (spec D4).
  fixedInputs: [
    {
      field: "sources.web.highlights",
      value: "true",
      note: "Query-relevant highlight passages per web result, so the excerpt supports choosing a url to fetch. The API default is false.",
    },
  ],
  // Declared as the FULL internal shape (assignable to the slim advertised
  // Output via its loose index signature) so tests and hooks keep real types.
  async handler(input, ctx): Promise<SearchOutput> {
    // rowCap null: the simple tool never inlines rows. Rows are a tako_contents
    // call on an `exportable: true` card — the explicit search-then-fetch step
    // that also lets this tool run anonymously.
    return runSearch(
      { endpoint: "search", body: buildSearchBody(input) },
      input.sources,
      null,
      ctx,
      "tako_search",
    );
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderSearchMarkdown(output as SearchOutput);
  },
  async extraMeta(output, ctx) {
    // Skip the fetch on ChatGPT: its widget bundle takes the committed
    // iframe path (`window.openai` defined → `hasOpenAiRuntime()`
    // true in `_chart_widget.ts`), which renders `embed_url` directly
    // and never reads `image_data_url` from `_meta`. Without this
    // gate we pay the full chart-render latency
    // `bakeImage` is FALSE on every call today: `extraMeta` runs only when a
    // widget is live (`ui !== undefined` in mcp.ts), and only the chatgpt
    // surface serves one — so `ctx.surface !== "chatgpt"` cannot be true here.
    // The expression stays because it is what the claude.ai widget fast-follow
    // needs (gated on anthropics/claude-ai-mcp#753 and #40): a widget on the
    // generic surface reads the baked PNG rather than an iframe, so it wants
    // `bakeImage: true`, and this already says so. On the generic surface the
    // inline PNG comes from `extraContentBlocks` instead, which mcp.ts runs on
    // the opposite condition (`ui === undefined`).
    //
    // What the reachable branch does: ChatGPT's widget renders `embed_url` in
    // an iframe and never reads the baked PNG, but it cannot measure that
    // cross-origin iframe, so without the card's real aspect ratio the iframe
    // falls back to a fixed height and leaves empty bands under a wide chart.
    // Dimensions only — a 64-byte ranged read instead of a ~170 KB render.
    // Cast: the widget fields are declared only on the chatgpt advertised
    // schema now, so the loose base Output no longer types them.
    const o = output as SearchOutput;
    return buildChartExtraMeta(o.image_url, {
      bakeImage: ctx.surface !== "chatgpt",
      env: ctx.env,
      origin: ctx.origin,
      pubId: o.pub_id,
    });
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    void _ctx;
    const o = output as SearchOutput;
    if (o.image_url === undefined) return [];
    return fetchPngContentBlock(o.image_url);
  },
  appUiResource(env, requestOrigin): AppUiResource {
    return buildChartAppUiResourceFromOutputPubId(env, requestOrigin);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_search;
