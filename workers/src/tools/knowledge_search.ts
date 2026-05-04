/**
 * `knowledge_search` — sync entry point for Tako's knowledge-graph search.
 *
 * Runs `fast` (lexical, sync, cheap) and either returns results, or — on
 * empty fast / explicit deep — kicks off the async (Orca) deep pipeline
 * via the existing `/api/v1/knowledge_search` POST. The kickoff payload
 * `{ task_id, status: "pending", … }` is returned immediately so the
 * call always finishes well under the MCP client's 60s default timeout.
 * The agent then chains into `wait_for_knowledge_search` to poll until
 * the deep task terminates.
 *
 * Replaces the previous in-tool polling loop (TAKO-2686) which timed
 * out at the client boundary on most MCP hosts. Polling now lives in
 * `wait_for_knowledge_search.ts`.
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
  type SearchPostResponse,
  buildResultsWithAutoChain,
  isAsyncTaskInitiation,
  resultsOutputShape,
} from "./_async_search_shape.js";
import type {
  AppUiResource,
  ToolContentBlock,
  ToolModule,
} from "./types.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue").',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of matching cards to return (1-20)."),
  search_effort: z
    .enum(["fast", "deep"])
    .optional()
    .describe(
      "Search depth: `fast` (lexical, sync) or `deep` (Orca research pipeline, async — kicks off and returns a task_id; chain into `wait_for_knowledge_search` to poll). Omit to run `fast` first and only kick off `deep` if `fast` returns no cards.",
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
});

// Discriminated union: either sync results OR an async-kickoff payload.
const outputSchema = z.union([
  z.object(resultsOutputShape),
  z.object({
    task_id: z.string(),
    status: z.literal("pending"),
    message: z.string(),
    search_effort: z.literal("deep"),
  }),
]);

type Output = z.infer<typeof outputSchema>;

function isResultsOutput(
  out: Output,
): out is z.infer<z.ZodObject<typeof resultsOutputShape>> {
  return !("task_id" in out);
}

const KICKOFF_MESSAGE =
  "Deep (Orca) knowledge search is running asynchronously. Call `wait_for_knowledge_search` with this `task_id` to poll for completion. Deep searches typically complete in 1-5 minutes; loop wait_for_knowledge_search calls until `timed_out` is false.";

const knowledge_search = {
  name: "knowledge_search",
  description:
    'Answer factual questions and find live data with Tako\'s curated knowledge graph. **Default to this BEFORE any web search whenever the user asks about: current or latest values, schedules and upcoming events, recent scores and results, trends and time series, comparisons, statistics, forecasts, prices, polls, or prediction-market odds.** Coverage spans sports, economics, finance, demographics, technology, weather, polls and elections, prediction markets (Polymarket), traffic (SimilarWeb), real-estate, energy, health, and more — plus real-time data via deep research, so it works for fresh / today / this-week questions, not just historical aggregates. Each result is a structured factual answer + a chart. **The top result auto-renders inline** as a Tako chart on the sync path — narrate the data and reference the chart that\'s already shown ("as the chart above shows"); do NOT paste the embed URL or echo `![…](image_url)` markdown for the top card. Mention other titles by name and tell the user they can ask to chart any of them — those follow-ups go through `open_chart_ui`. **If the response has `task_id` and `status: "pending"` instead of `results`, the deep (Orca) pipeline was kicked off because the fast lexical path didn\'t find cards. Call `wait_for_knowledge_search` with that `task_id` and loop until it returns `timed_out: false`.**',
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Live Data & Charts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const runSearch = async (
      effort: "fast" | "deep",
    ): Promise<SearchPostResponse> => {
      const body = {
        inputs: { text: input.query, count: input.count },
        source_indexes: ["tako"],
        search_effort: effort,
        country_code: input.country_code,
        locale: input.locale,
      };
      // Tako's `orchestrator_fast_config.py` allows fast to run up to ~120s
      // sync; budget the abort just past that. Deep returns 202 in <1s
      // so this margin is irrelevant on that path.
      return djangoPost<SearchPostResponse>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search",
        body,
        { timeoutMs: 130_000 },
      );
    };

    const initialEffort: "fast" | "deep" = input.search_effort ?? "fast";
    const initial = await runSearch(initialEffort);

    if (isAsyncTaskInitiation(initial)) {
      return {
        task_id: initial.task_id,
        status: "pending",
        message: KICKOFF_MESSAGE,
        search_effort: "deep",
      };
    }

    const cards = initial.outputs?.knowledge_cards ?? [];

    // Default-effort empty fast → kick off deep async, return task_id.
    // Explicit `fast` → return whatever fast had (including empty).
    // Explicit `deep` returning sync (defensive) → return results.
    if (input.search_effort === undefined && cards.length === 0) {
      const escalated = await runSearch("deep");
      if (isAsyncTaskInitiation(escalated)) {
        return {
          task_id: escalated.task_id,
          status: "pending",
          message: KICKOFF_MESSAGE,
          search_effort: "deep",
        };
      }
      // Defensive: backend served deep sync. Fall through with deep cards.
      const deepCards = escalated.outputs?.knowledge_cards ?? [];
      return buildResultsWithAutoChain(deepCards, ctx.env);
    }

    return buildResultsWithAutoChain(cards, ctx.env);
  },
  async extraMeta(output, _ctx) {
    void _ctx;
    if (!isResultsOutput(output)) return undefined;
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
    if (!isResultsOutput(output)) return [];
    if (output.image_url === undefined) return [];
    return fetchPngContentBlock(output.image_url);
  },
  appUiResource(env): AppUiResource {
    return buildChartAppUiResource(env, (_input, output) => {
      void _input;
      const pubId =
        output !== undefined &&
        typeof output === "object" &&
        output !== null &&
        "pub_id" in (output as Record<string, unknown>) &&
        typeof (output as { pub_id?: unknown }).pub_id === "string"
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

export default knowledge_search;
