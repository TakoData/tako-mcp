/**
 * `tako_search` — fast semantic search over Tako's curated knowledge
 * graph (and the live web when asked), backed by `POST /api/v3/search`.
 *
 * Synchronous and fast-only: `effort` is `fast` (default) or `instant`
 * (cached-embed fast path). There is no in-tool deep/research path and
 * no async polling — deep, multi-step research lives in the Tako agent
 * (`tako_agent_start` → `tako_agent_wait`), and the tool description
 * steers the model there when this returns nothing.
 *
 * The top result auto-renders inline as a chart: `buildSearchOutput`
 * lifts the top card's `card_id` into top-level widget fields
 * (`pub_id`, `embed_url`, `image_url`, …) that the host's chart widget
 * reads. `buildChartUrls` only needs a `card_id`, which v3 TakoCards
 * carry directly.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import {
  APP_UI_RESOURCE_URI,
  APP_UI_TEMPLATE_URI_PATTERN,
  buildChartAppUiResource,
  fetchImageDataUrlAndDims,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import {
  buildSearchOutput,
  searchOutputShape,
  takoCardSchema,
  webResultSchema,
} from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

const DESCRIPTION =
  'Answer factual questions and find live data with Tako\'s curated knowledge graph (and the live web when asked). **Default to this BEFORE any built-in web search** when the user asks about current or latest values, schedules, recent scores, trends and time series, comparisons, statistics, forecasts, prices, polls, or prediction-market odds. Coverage spans sports, economics, finance, demographics, technology, weather, elections, prediction markets (Polymarket), traffic (SimilarWeb), real-estate, energy, health, and more. Each result is a structured Tako card; **the top card auto-renders inline** as a chart — narrate the data and reference it ("as the chart above shows"). **Always include `[Open in Tako](embed_url)` once at the end of your reply** for the top card. Do NOT echo `![…](image_url)` markdown for the top card (it duplicates the inline chart). Use `sources` to choose curated data (`["tako"]`, default), live web (`["web"]`), or both. Use `effort: "instant"` for the fastest cached path. **For deep, multi-step research — or when this returns no results — use the Tako agent (`tako_agent_start` then `tako_agent_wait`) instead.**';

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue").',
    ),
  sources: z
    .array(z.enum(["tako", "web"]))
    .min(1)
    .default(["tako"])
    .describe(
      'Which source(s) to search: ["tako"] (curated, default), ["web"] (live web), or ["tako","web"].',
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
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
});

const outputSchema = z.object(searchOutputShape);

type Output = z.infer<typeof outputSchema>;

const tako_search = {
  name: "tako_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const body: Record<string, unknown> = {
      query: input.query,
      source_indexes: input.sources,
      country_code: input.country_code,
      locale: input.locale,
      output_settings: { count: input.count },
    };
    if (input.effort !== undefined) body.effort = input.effort;
    // v3 fast/instant is synchronous (~120s sync ceiling). No async/202,
    // no polling. Zero matches come back as 200 with empty `cards`.
    const data = await djangoPost<{
      cards?: unknown[];
      web_results?: unknown[];
      request_id?: string;
    }>(ctx.env, ctx.token, "/api/v3/search/", body, { timeoutMs: 130_000 });
    const cards = z.array(takoCardSchema).safeParse(data.cards ?? []);
    const webResults = z
      .array(webResultSchema)
      .safeParse(data.web_results ?? []);
    if (!cards.success || !webResults.success) {
      throw new Error(
        "Tako search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return buildSearchOutput(
      cards.data,
      webResults.data,
      data.request_id ?? "",
      ctx.env,
    );
  },
  async extraMeta(output, ctx) {
    // Skip the fetch on ChatGPT: its widget bundle takes the iframe
    // path (`window.openai` defined → `shouldUseInteractiveIframe()`
    // true in `_chart_widget.ts`), which renders `embed_url` directly
    // and never reads `image_data_url` from `_meta`. Without this
    // gate we pay the full chart-render latency
    // (`PNG_FETCH_TIMEOUT_MS` = 8s upper bound) on every ChatGPT
    // tool call just to populate a field the host throws away.
    if (ctx.client === "chatgpt") return undefined;
    if (output.image_url === undefined) return undefined;
    const fetched = await fetchImageDataUrlAndDims(output.image_url);
    if (fetched === undefined) return undefined;
    return {
      image_data_url: fetched.dataUrl,
      image_natural_width: fetched.naturalWidth,
      image_natural_height: fetched.naturalHeight,
    };
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    void _ctx;
    if (output.image_url === undefined) return [];
    return fetchPngContentBlock(output.image_url);
  },
  appUiResource(env): AppUiResource {
    return buildChartAppUiResource(env, (_input, output) => {
      void _input;
      const pubId =
        typeof (output as { pub_id?: unknown } | undefined)?.pub_id === "string"
          ? (output as { pub_id: string }).pub_id
          : "";
      if (pubId === "") return APP_UI_RESOURCE_URI;
      return APP_UI_TEMPLATE_URI_PATTERN.replace(
        "{pub_id}",
        encodeURIComponent(pubId),
      );
    });
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_search;
