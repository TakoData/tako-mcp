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

import { djangoPost } from "../django.js";
import { SearchRequest, SearchResponse } from "../generated/schemas.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import { logWireGuardFailure } from "./_log.js";
import {
  renderSearchMarkdown,
  searchSlimOutputShape,
  slimSearchStructured,
} from "./_render_markdown.js";
import {
  buildSearchOutput,
  hoistSourceGlossary,
  INLINE_PREVIEW_ROW_CAP,
  MAX_PREVIEW_ROWS,
  PINNED_FROM_CARD,
  slimCard,
  slimWebResult,
  takoCardSchema,
  webResultSchema,
  type SearchOutput,
} from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

const DESCRIPTION = [
  "Reconnaissance and chart retrieval across the live web and proprietary data: many results at once, returned as structured cards and web links, and the top card auto-renders inline as a chart.",
  "",
  `It locates data — and for \`exportable: true\` cards it also includes a free 20-row preview by default (\`include_contents\`) — but a license-gated card carries no rows at all (headline value only, via \`description\`), and a web result is only a snippet, not a value. For a plain "what is X", \`tako_answer\` is the better-suited tool: one written figure beats parsing a preview table yourself, and reaching here first for that costs an extra round trip that re-sends the whole conversation. To ask it about a card you already have, ${PINNED_FROM_CARD}.`,
  "",
  "Best for: breadth — fanning out many narrow queries in parallel to see what exists across several entities or metrics; retrieving a chart card when the chart or embed is itself the deliverable; and harvesting node ids and urls to feed `tako_answer` or `tako_contents`. It is cheap and fast, and built for exactly this fan-out.",
  "",
  "Coverage spans economics, finance, company KPIs, demographics, sports, markets, weather, elections, prediction markets, website/app traffic, real estate, energy, health, and more — metrics that sound web-only (e.g. SimilarWeb-style website traffic) are in the data graph.",
  "",
  'Each query resolves one entity + one metric ("Apple revenue", "Nvidia vs AMD gross margin"); broad or compound queries ("today\'s sports + odds") retrieve poorly. When the question is what Tako covers, or you need a metric\'s exact name, run `tako_available_data` (free) instead of guessing here.',
  "",
  "Data and web come back together — treat them as one result, not an either/or. Returns: `cards` (up to `count`) with preview rows and chart URLs, plus `web_results`. To read a web result in full, call `tako_contents` on its url (web urls are always fetchable; a card's full csv needs `exportable: true`).",
  "",
  `Non-exportable cards (\`exportable: false\`, usually license-gated) return no rows: read the headline value from the card's \`description\` when it carries one, or get specific figures via \`tako_answer\` — ${PINNED_FROM_CARD} (each such card carries a \`values_hint\` saying exactly this).`,
  "",
  "Results arrive as a markdown document: a Tako Data section (per card: headline, exportable flag, node ids, chart link, a rows-count pointer), then Web Results, then source notes. The cards' actual rows and the web results' snippets ride in structuredContent (cards[].content, web_results[].snippet), not the markdown, alongside machine essentials (request_id, usage, chart-widget fields).",
].join("\n");

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue"). Website-traffic data is keyed by domain — query "openai.com monthly visits", not "OpenAI website visits".',
    ),
  sources: z
    .array(z.enum(["data", "web", "tako"]))
    .min(1)
    .default(["data", "web"])
    .describe(
      'Source(s) to search. Default ["data","web"] (both) — keep BOTH enabled unless you have a confirmed reason to narrow. Narrow to ["data"] only once `tako_available_data` has confirmed the proprietary data exists (web is the fallback when it does not). Narrow to ["web"] only for content a data graph cannot hold (news articles, page text, qualitative claims) — never because a metric merely feels web-native: website traffic, app usage, and similar digital metrics ARE in the proprietary data graph. ("tako" is a legacy synonym for "data".)',
    ),
  effort: z
    .enum(["fast", "instant"])
    .optional()
    .describe(
      'Search effort: "fast" (default) or "instant" (fastest, serves cached embeds as-is). Omit for fast.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of results to return per source (1-20)."),
  include_contents: z
    .boolean()
    .default(true)
    .describe(
      `Inline each Tako card's data preview (default true; preview_rows sets how many rows). Set false — pointers-only, no rows — for large parallel fan-outs or when coverage is unconfirmed (no prior tako_available_data check). DATA source only; web page text is never auto-inlined (billed per page — use tako_contents). Full export is a separate tako_contents call, only for cards marked \`exportable: true\`.`,
    ),
  preview_rows: z
    .number()
    .int()
    .min(1)
    .max(MAX_PREVIEW_ROWS)
    .default(INLINE_PREVIEW_ROW_CAP)
    .describe(
      `Cap on the rows of each card's data inlined when include_contents is true — always the N MOST-RECENT rows (default ${INLINE_PREVIEW_ROW_CAP}, the free inline allowance the server ships; values above your account's allowance have no effect). Lower it to trim context on broad fan-outs. For MORE than ${INLINE_PREVIEW_ROW_CAP} rows, call tako_contents on the card's url (max_rows up to 2,000 — first ${INLINE_PREVIEW_ROW_CAP} free, priced beyond). Ignored when include_contents is false.`,
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
  node_ids: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "Graph node ids (from tako_available_data, or a card's nodes) to PIN into the proprietary data source. Pinned nodes get a strong retrieval boost. Max 20. Applies only to the 'data' source.",
    ),
  strict: z
    .boolean()
    .default(false)
    .describe(
      "Hard filter. When true, return ONLY cards matching at least one node in node_ids (which must then be non-empty — empty node_ids + strict is a 400). When false (default), pinned nodes are preferred/boosted but organic results still return.",
    ),
});

type Input = z.infer<typeof inputSchema>;

// The ADVERTISED output schema. The payload — cards (with their rows), web
// results, glossary — rides in `structuredContent`, the spec-natural channel
// for a tool that advertises an `outputSchema`; the markdown text channel
// (renderText below) is a readable INDEX of it, carrying headlines and
// `rowsPointer()` lines rather than a second copy, so hosts that count both
// channels toward context don't pay for the content twice.
//
// The name says "slim" for history, not behavior: `slimSearchStructured` is
// now a full spread. What the schema still does is stay LOOSELY typed on the
// content fields, so a backend wire change can't fail structured-output
// validation — the drift failure `_search_results.ts` documents. The full
// internal shape (searchOutputShape) types the handler's return value and is
// loose-compatible with this one, so validation passes for both, and the
// generated SearchResponse stays the wire-guard (safeParse on the raw backend
// data before mapping).
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
  if (input.sources.includes("data") || input.sources.includes("tako")) {
    const data: NonNullable<
      NonNullable<z.input<typeof SearchRequest>["sources"]>["data"]
    > = { count: input.count, include_contents: input.include_contents };
    if (input.node_ids !== undefined && input.node_ids.length > 0) {
      data.node_ids = input.node_ids;
    }
    if (input.strict) {
      data.strict = true;
    }
    sources.data = data;
  }
  if (input.sources.includes("web")) {
    // Web page text is billed per page, so it is never auto-inlined regardless
    // of `include_contents` (which governs only the free Tako card preview).
    // The model fetches web text on demand via tako_contents(url).
    // snippet_max_chars 2000: an explicit cap, not the backend's per-endpoint
    // default (4000 on /v3/search since TakoData/tako#28462). A meatier free
    // excerpt per web result, so the model picks the right url for a priced
    // tako_contents follow-up from a real excerpt instead of a headline —
    // bounded, because count defaults to 10 here and the snippet rides
    // verbatim in structuredContent, so the cap is a per-call token budget.
    //
    // highlights: the snippet becomes the passages Exa's model selects against
    // the query instead of the page's opening characters. The opening is
    // usually nav chrome and press-release preamble; the excerpt exists to let
    // the model choose a url to spend tako_contents on, and preamble does not
    // support that choice. Two consequences ride along — a page with no
    // highlight returns `snippet: null` and keeps its slot, and one snippet
    // may hold several non-contiguous passages joined by " … ". Both are
    // documented to the model on `searchSlimOutputShape.web_results`, which is
    // the ADVERTISED schema; `webResultSchema.snippet` is the wire guard and
    // is never sent to a client, so a description there would reach nobody.
    sources.web = {
      count: input.count,
      include_contents: false,
      snippet_max_chars: 2000,
      highlights: true,
    };
  }
  const body: z.input<typeof SearchRequest> = {
    query: input.query,
    sources,
    country_code: input.country_code,
    locale: input.locale,
  };
  if (input.effort !== undefined) body.effort = input.effort;
  return body satisfies z.input<typeof SearchRequest>; // ← build-time guard: backend request drift breaks here
}

const tako_search = {
  name: "tako_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  annotationsByClient: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsByClient` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  // Declared as the FULL internal shape (assignable to the slim advertised
  // Output via its loose index signature) so tests and hooks keep real types.
  async handler(input, ctx): Promise<SearchOutput> {
    // v3 SearchRequest takes a per-source `sources` OBJECT — an index is
    // searched iff its key is present, and `count` / `include_contents` are
    // per-source. The old flat `source_indexes` + `output_settings.count`
    // shape is extra="forbid" rejected (400) by the current backend.
    const body = buildSearchBody(input);
    // v3 fast/instant is synchronous (~120s sync ceiling). No async/202,
    // no polling. Zero matches come back as 200 with empty `cards`.
    const data = await djangoPost<unknown>(ctx.env, ctx.token, "/api/v3/search/", body, { timeoutMs: 130_000 });

    // Wire-contract guard: validate against the generated SearchResponse before
    // mapping into the normalised MCP output shape.
    const wireCheck = SearchResponse.safeParse(data);
    if (!wireCheck.success) {
      logWireGuardFailure("tako_search", "SearchResponse", wireCheck.error, data);
      throw new Error(
        "Tako search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    const wire = wireCheck.data;

    const cards = z.array(takoCardSchema).safeParse(wire.cards ?? []);
    const webResults = z.array(webResultSchema).safeParse(wire.web_results ?? []);
    if (!cards.success || !webResults.success) {
      logWireGuardFailure(
        "tako_search",
        cards.success ? "web_results" : "cards",
        cards.success ? (webResults.success ? undefined : webResults.error) : cards.error,
        data,
      );
      throw new Error(
        "Tako search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Slim the model-facing payload: cap each card's inline row preview to the
    // caller's preview_rows most-recent rows when include_contents is on (drop
    // it entirely when off), and always drop web page text (billed per page —
    // fetch via tako_contents). This shrinks BOTH channels the model sees
    // (content.text + structuredContent in mcp.ts are both derived from this
    // output). Full data is a tako_contents call. The ?? guards direct handler
    // calls that bypass the schema's default.
    const cap = input.include_contents
      ? (input.preview_rows ?? INLINE_PREVIEW_ROW_CAP)
      : null;
    const { cards: slimCards, glossary } = hoistSourceGlossary(
      cards.data.map((c) => slimCard(c, cap)),
    );
    const output = buildSearchOutput(
      slimCards,
      webResults.data.map(slimWebResult),
      wire.request_id,
      wire.usage ?? null,
      ctx.env,
      input.sources,
    );
    // Glossary spreads on LAST so it serializes after the data — truncating
    // clients then drop boilerplate first.
    return glossary === undefined ? output : { ...output, sources_glossary: glossary };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderSearchMarkdown(output as SearchOutput);
  },
  slimStructured(output) {
    return slimSearchStructured(output as SearchOutput);
  },
  async extraMeta(output, ctx) {
    // Skip the fetch on ChatGPT: its widget bundle takes the committed
    // iframe path (`window.openai` defined → `hasOpenAiRuntime()`
    // true in `_chart_widget.ts`), which renders `embed_url` directly
    // and never reads `image_data_url` from `_meta`. Without this
    // gate we pay the full chart-render latency
    // (`PNG_FETCH_TIMEOUT_MS` = 8s upper bound) on every ChatGPT
    // tool call just to populate a field the host throws away.
    // ChatGPT gets DIMENSIONS ONLY (a 64-byte ranged read): its widget renders
    // `embed_url` in an iframe and never reads the baked PNG, but it cannot
    // measure that cross-origin iframe's content, so without the card's real
    // aspect ratio the iframe falls back to a fixed height and leaves empty
    // bands under a wide chart. Claude gets the full baked image — there the
    // PNG *is* the chart.
    return buildChartExtraMeta(output.image_url, {
      bakeImage: ctx.client !== "chatgpt",
      env: ctx.env,
      origin: ctx.origin,
      pubId: output.pub_id,
    });
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    void _ctx;
    if (output.image_url === undefined) return [];
    return fetchPngContentBlock(output.image_url);
  },
  appUiResource(env, requestOrigin): AppUiResource {
    return buildChartAppUiResourceFromOutputPubId(env, requestOrigin);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_search;
