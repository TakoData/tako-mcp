/**
 * `knowledge_search` — single-tool semantic search over Tako's curated
 * knowledge graph.
 *
 * Runs `fast` (lexical, sync, cheap) by default and auto-escalates to
 * `deep` (Orca research pipeline, async, slower) when fast returns no
 * cards (or when the caller passes `search_effort: "deep"` explicitly).
 *
 * Why a single tool with internal polling instead of the
 * `start_search → wait_for_search` split:
 *
 *   - The split-tool flow on hosts that *don't* support a per-call
 *     widget suppression (ChatGPT, tako web UI) leaves an empty
 *     widget container in the chat for every kickoff / wait
 *     intermediate call. Verified persistent across multiple
 *     attempts (start-collapsed widget, no-chart guard, intrinsic
 *     height 0). Single-tool flow has at most ONE rendered
 *     tool-call entry, and it carries the chart on success.
 *
 *   - Per the MCP base protocol, a server may emit
 *     `notifications/progress` while handling a long-running
 *     request. Clients that opt into `resetTimeoutOnProgress: true`
 *     (the SDK option, on by default in the latest TS SDK) reset
 *     their per-tool-call timeout each time we send a progress
 *     event. So a deep-search loop that polls every ~5 s and emits
 *     a progress event each iteration keeps the client timeout
 *     fresh indefinitely — the fast-hit path remains a single
 *     ~1 s sync POST + chart-render, the deep path stretches up to
 *     ~5 minutes inside one tool call.
 *
 *   - Clients without `resetTimeoutOnProgress` support still time
 *     out at their default (60 s for the TS SDK). For those, deep
 *     search is unreliable today — but at least the fast-hit
 *     common case works cleanly with no empty containers.
 */
import { z } from "zod";

import { djangoGet, djangoPost } from "../django.js";
import {
  APP_UI_RESOURCE_URI,
  APP_UI_TEMPLATE_URI_PATTERN,
  buildChartAppUiResource,
  fetchImageDataUrlAndDims,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import {
  type AsyncTaskEvent,
  type AsyncTaskStatus,
  COMPLETED_STATE,
  FAILURE_STATES,
  type KnowledgeCard,
  type SearchPostResponse,
  buildResultsWithAutoChain,
  isAsyncTaskInitiation,
  isTransientStatusError,
  resultsOutputShape,
  summarizeProgress,
} from "./_async_search_shape.js";
import type {
  AppUiResource,
  ToolContentBlock,
  ToolContext,
  ToolModule,
} from "./types.js";

// Polling budget for the deep (Orca) path.
//
//   1. Tako's `orchestrator_deep_config.py` (timeout=300.0) is the
//      upper bound on how long a deep search can possibly take.
//   2. Cloudflare Workers caps subrequests per invocation at 50 on
//      the default tier (1000 on Paid). One or two POSTs (auto-
//      escalation from fast → deep is two) plus N status GETs +
//      retry budget + the auto-chain chart PNG fetch must stay
//      under that ceiling. With a 5 s poll and a 295 s budget that's
//      ~59 GETs worst case — over the 50 default cap, so deep is
//      effectively a Paid-tier feature; fine because the staging
//      and prod Workers run on Paid.
//   3. Every iteration emits a `notifications/progress` event so
//      MCP clients with `resetTimeoutOnProgress: true` keep the
//      per-tool-call timeout fresh while the loop runs.
const POLL_INTERVAL_MS = 5_000;
const POLL_BUDGET_MS = 295_000;
const STATUS_REQUEST_TIMEOUT_MS = 10_000;
// Transient transport blips against the status endpoint shouldn't
// kill a polling loop whose underlying Celery task is still running.
// Swallow up to this many consecutive transient failures across the
// whole loop, count each one against the subrequest budget, and let
// the (N+1)th surface as before so a sustained outage still fails
// loud.
const MAX_TRANSIENT_RETRIES = 2;

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
      "Search depth: `fast` (lexical, sync, cheap) or `deep` (Orca research pipeline, async, slower, runs up to ~5 min server-side). Omit to run `fast` first and auto-escalate to `deep` only if `fast` returns no cards.",
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
});

const outputSchema = z.object(resultsOutputShape);

type Output = z.infer<typeof outputSchema>;

const knowledge_search = {
  name: "knowledge_search",
  description:
    'Answer factual questions and find live data with Tako\'s curated knowledge graph. **Default to this BEFORE any web search whenever the user asks about: current or latest values, schedules and upcoming events, recent scores and results, trends and time series, comparisons, statistics, forecasts, prices, polls, or prediction-market odds.** Coverage spans sports, economics, finance, demographics, technology, weather, polls and elections, prediction markets (Polymarket), traffic (SimilarWeb), real-estate, energy, health, and more — plus real-time data via deep research, so it works for fresh / today / this-week questions, not just historical aggregates. Each result is a structured factual answer + a chart. **The top result auto-renders inline** as a Tako chart — narrate the data and reference the chart that\'s already shown ("as the chart above shows"); do NOT paste the embed URL or echo `![…](image_url)` markdown for the top card. Mention other titles by name and tell the user they can ask to chart any of them — those follow-ups go through `open_chart_ui`. **`search_effort: "deep"` and the default fast→deep auto-escalation can run up to ~5 minutes server-side**; this tool emits MCP `notifications/progress` events while polling so clients that set `resetTimeoutOnProgress: true` (the SDK default) keep the call alive for the full duration. Clients that don\'t honor progress notifications may time out on deep — those should pass `search_effort: "fast"` to force the cheap sync path.',
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
      // Tako's `orchestrator_fast_config.py` allows fast to run up to
      // ~120s sync; budget the abort just past that. Deep returns 202
      // in <1s so this margin is irrelevant on that path.
      return djangoPost<SearchPostResponse>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search",
        body,
        { timeoutMs: 130_000 },
      );
    };

    // On ChatGPT, the single-tool-call deep path can't survive the
    // host's per-call timeout (its Apps SDK doesn't honor MCP
    // notifications/progress for timeout reset, so polling for
    // 1-5 minutes inside one tool call always trips the 60-second
    // timeout). Redirect the agent to the kickoff/wait pair, which
    // is registered only when `client === "chatgpt"` in `mcp.ts`.
    //
    // Other clients (Claude.ai, "unknown", future hosts) keep the
    // existing single-call behavior — Claude.ai resets its timeout
    // on each progress notification we emit, so deep works there
    // even when a specific request omits the progressToken (the
    // backend task still completes before any reasonable wall-clock
    // ceiling for fast or sync paths). Gate is UA-based, NOT
    // progressToken-based: a Claude.ai request that happens to omit
    // the token must still reach the deep path.
    if (input.search_effort === "deep" && ctx.client === "chatgpt") {
      throw new Error(
        "This client uses the kickoff/wait deep-search flow. Use `start_deep_knowledge_search` to launch the deep task, then `wait_for_knowledge_search` to retrieve the result.",
      );
    }

    // First call: fast (default) or deep (explicit, only reachable
    // on clients with progress support after the guard above).
    const initialEffort: "fast" | "deep" = input.search_effort ?? "fast";
    let cards = await (async () => {
      const initial = await runSearch(initialEffort);
      if (isAsyncTaskInitiation(initial)) {
        return pollDeep(ctx, initial.task_id);
      }
      return initial.outputs?.knowledge_cards ?? [];
    })();

    // Auto-escalation: omitted effort + empty fast → deep, EXCEPT
    // on ChatGPT (where the kickoff/wait flow is the agent's path
    // for deep — see the explicit-deep guard above).
    if (
      input.search_effort === undefined &&
      cards.length === 0 &&
      ctx.client !== "chatgpt"
    ) {
      const escalated = await runSearch("deep");
      if (isAsyncTaskInitiation(escalated)) {
        cards = await pollDeep(ctx, escalated.task_id);
      } else {
        cards = escalated.outputs?.knowledge_cards ?? [];
      }
    }

    return buildResultsWithAutoChain(cards, ctx.env);
  },
  async extraMeta(output, _ctx) {
    void _ctx;
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

// Deep polling. Hoisted out of the handler so the unit tests can hit
// it directly (and so the auto-escalation path can call it without
// duplicating the loop).
async function pollDeep(
  ctx: ToolContext,
  taskId: string,
): Promise<KnowledgeCard[]> {
  const startedAt = Date.now();
  let nextSinceIndex = 0;
  let latestEvents: AsyncTaskEvent[] = [];
  let transientRetriesLeft = MAX_TRANSIENT_RETRIES;
  // Monotonic progress counter (count of polls so far). Required by
  // the MCP spec — `progress` MUST increase across notifications for
  // the same progressToken.
  let pollCount = 0;

  while (true) {
    let status: AsyncTaskStatus;
    try {
      status = await djangoGet<AsyncTaskStatus>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search/async/status/",
        {
          query: { task_id: taskId, since_index: nextSinceIndex },
          timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (err) {
      if (isTransientStatusError(err) && transientRetriesLeft > 0) {
        transientRetriesLeft -= 1;
        const elapsed = Date.now() - startedAt;
        if (elapsed + POLL_INTERVAL_MS >= POLL_BUDGET_MS) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      throw err;
    }

    pollCount += 1;
    if (status.events && status.events.length > 0) {
      latestEvents = latestEvents.concat(status.events);
      const maxId = status.events.reduce(
        (acc, e) => (typeof e.id === "number" && e.id > acc ? e.id : acc),
        nextSinceIndex - 1,
      );
      nextSinceIndex = maxId + 1;
    }

    const normalizedStatus =
      typeof status.status === "string" ? status.status.toUpperCase() : "";
    const isTerminal =
      normalizedStatus === COMPLETED_STATE ||
      FAILURE_STATES.has(normalizedStatus);

    // Emit a progress notification to keep the client's tool-call
    // timeout alive. The message carries a short "current pipeline
    // step" hint pulled from the most recent event, when available.
    // Best-effort — `sendProgress` swallows errors internally so a
    // notification failure can't break the polling loop.
    //
    // On terminal iterations we await so the final progress event
    // flushes before the handler returns / throws — prior code used
    // fire-and-forget which races with the result envelope being
    // assembled in `mcp.ts`. On non-terminal iterations the trailing
    // sleep is plenty of time for the in-flight notification, and
    // awaiting per-iteration would block the loop on the network
    // hop.
    const progressPromise = ctx.sendProgress(pollCount, {
      message: `deep search ${summarizeProgress(latestEvents)}`,
    });
    if (isTerminal) {
      await progressPromise;
    } else {
      void progressPromise;
    }

    if (normalizedStatus === COMPLETED_STATE) {
      return status.result?.outputs?.knowledge_cards ?? [];
    }

    if (FAILURE_STATES.has(normalizedStatus)) {
      throw new Error(
        `knowledge_search deep task ${normalizedStatus.toLowerCase()} (${summarizeProgress(latestEvents)}): ${status.error ?? "no detail provided by Tako backend"}`,
      );
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed + POLL_INTERVAL_MS >= POLL_BUDGET_MS) {
      throw new Error(
        `knowledge_search deep task ${taskId} did not complete within ${Math.round(POLL_BUDGET_MS / 1000)}s (${summarizeProgress(latestEvents)}) — Tako's deep-research pipeline may be busy. Try again shortly, or pass \`search_effort: "fast"\` to force the cheap sync path.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export default knowledge_search;

// Exported for unit tests — the polling-budget constants drive the
// mock-response counts in `knowledge_search.test.ts` so the
// budget-exhaustion test stays correct when the budget is tuned.
export const __test_only__ = {
  POLL_INTERVAL_MS,
  POLL_BUDGET_MS,
};
