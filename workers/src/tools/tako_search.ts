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
import { looseArray } from "./_loose_array.js";
import { logWireGuardFailure } from "./_log.js";
import {
  renderSearchMarkdown,
  searchSlimOutputShape,
  slimSearchStructured,
} from "./_render_markdown.js";
import {
  buildSearchOutput,
  hoistSourceGlossary,
  slimCard,
  slimWebResult,
  takoCardSchema,
  webResultSchema,
  type SearchedSources,
  type SearchOutput,
} from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolContext, ToolModule } from "./types.js";

const DESCRIPTION = [
  "Reconnaissance and chart retrieval across the live web and proprietary data: many results at once, returned as structured cards and web links, and the top card auto-renders inline as a chart.",
  "",
  "It locates data; `tako_contents` reads it. Cards carry headline values, node ids and chart links — call `tako_contents` on an `exportable: true` card's url for the rows themselves, and on a web result's url for its full page text.",
  "",
  "Best for: breadth — fanning out many narrow queries in parallel to see what exists across several entities or metrics; retrieving a chart card when the chart or embed is itself the deliverable; and harvesting node ids and urls to feed `tako_contents`. It is cheap and fast, and built for exactly this fan-out.",
  "",
  "Coverage spans economics, finance, company KPIs, demographics, sports, markets, weather, elections, prediction markets, website/app traffic, real estate, energy, health, and more — metrics that sound web-only (e.g. SimilarWeb-style website traffic) are in the data graph.",
  "",
  'Each query resolves one entity + one metric ("Apple revenue", "Nvidia vs AMD gross margin"); broad or compound queries ("today\'s sports + odds") retrieve poorly. When the question is what Tako covers, or you need a metric\'s exact name, run `tako_available_data` instead of guessing here, then search on the EXACT name it returns — the canonical name is what recovers cards.',
  "",
  "Data and web come back together — treat them as one result, not an either/or. Returns: `cards` with chart URLs, plus `web_results`. To read either in full, call `tako_contents` on its url (web urls are always fetchable; a card's rows need `exportable: true`).",
  "",
  "Non-exportable cards (`exportable: false`, usually license-gated) return no rows on any path: read the headline value from the card's `description` when it carries one (each such card carries a `values_hint` saying exactly this).",
  "",
  "Results arrive as a markdown document: a Tako Data section (per card: headline, exportable flag, node ids, chart link), then Web Results, then source notes. The web results' snippets ride in structuredContent (web_results[].snippet), not the markdown, alongside machine essentials (usage, chart-widget fields).",
].join("\n");

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue"). Website-traffic data is keyed by domain — query "openai.com monthly visits", not "OpenAI website visits".',
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
      .describe(
        'Source(s) to search. Default ["data","web"] (both) — keep BOTH enabled unless you have a confirmed reason to narrow. Narrow to ["data"] only once `tako_available_data` has confirmed the proprietary data exists (web is the fallback when it does not). Narrow to ["web"] only for content a data graph cannot hold (news articles, page text, qualitative claims) — never because a metric merely feels web-native: website traffic, app usage, and similar digital metrics ARE in the proprietary data graph.',
      ),
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

/**
 * Issue the search and shape the response.
 *
 * Split out of the handler so `tako_search_advanced` reuses it verbatim: both
 * tools hit the same endpoint and return the same shape, and only the request
 * body differs. Keeping one copy means a wire-guard or slimming fix lands on
 * both at once.
 *
 * `rowCap` is the per-card inline row budget: `null` drops every row (what the
 * simple tool passes — it never inlines), "all" keeps what the backend sent
 * (what tako_search_advanced passes — it sends its own max_rows on the wire),
 * a number caps to the N most-recent.
 */
export async function runSearch(
  body: z.input<typeof SearchRequest>,
  sources: SearchedSources,
  rowCap: number | "all" | null,
  ctx: ToolContext,
): Promise<SearchOutput> {
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
  // Slim the model-facing payload, which shrinks BOTH channels the model sees
  // (content.text + structuredContent in mcp.ts are both derived from this).
  //
  // Web page text is kept only when the REQUEST asked for it. Derived from the
  // body rather than passed by the caller, so the two tools cannot disagree with
  // what went on the wire: tako_search never sets sources.web.include_contents,
  // so it always drops; tako_search_advanced exposes the field, so a caller who
  // sets it gets what the generated description promises. On /v3/search that
  // text is free (see slimWebResult), so context is the only cost and the caller
  // has already accepted it.
  const keepWebText = body.sources?.web?.include_contents === true;
  // DERIVED from the wire body for the same reason `keepWebText` is: the two
  // search tools then cannot disagree with what was actually requested, and
  // `tako_search` — which takes no pin — gets `false` without naming the concept.
  // Both halves are required: `strict: true` with an empty `node_ids` is a 400 at
  // the backend, and a pin without `strict` only boosts, so neither alone makes
  // zero cards a filter artefact.
  const strictPin =
    body.sources?.data?.strict === true && (body.sources?.data?.node_ids?.length ?? 0) > 0;
  const { cards: slimCards, glossary } = hoistSourceGlossary(
    cards.data.map((c) => slimCard(c, rowCap)),
  );
  const output = buildSearchOutput(
    slimCards,
    webResults.data.map((w) => slimWebResult(w, keepWebText)),
    wire.request_id,
    wire.usage ?? null,
    ctx.env,
    sources,
    strictPin,
    // The zero-result protocol routes through tools an anonymous caller does
    // not have; `buildZeroResultGuidance` branches on this.
    ctx.tier ?? "authenticated",
  );
  // Glossary spreads on LAST so it serializes after the data — truncating
  // clients then drop boilerplate first.
  return glossary === undefined ? output : { ...output, sources_glossary: glossary };
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
    idempotentHint: true,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
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
    return runSearch(buildSearchBody(input), input.sources, null, ctx);
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
    return buildChartExtraMeta(output.image_url, {
      bakeImage: ctx.surface !== "chatgpt",
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
