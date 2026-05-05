/**
 * `wait_for_knowledge_search` — poll the async knowledge-search status
 * endpoint and return when the task terminates OR when the budget
 * elapses, whichever comes first. Companion to
 * `start_deep_knowledge_search`.
 *
 * Registered ONLY on clients that don't honor MCP
 * `notifications/progress` for tool-call timeout extension (currently:
 * ChatGPT). See `mcp.ts`'s `CHATGPT_ONLY_TOOL_NAMES` set and
 * `start_deep_knowledge_search` for the full rationale.
 *
 * Same hard cap on `max_wait_seconds` as the previous report-side
 * polling wrapper, with the same "agent loops the tool when timed_out
 * is true" pattern.
 *
 * No `appUiResource` / `extraMeta` / `extraContentBlocks` — see
 * `start_deep_knowledge_search` for why. The chart is rendered via a
 * separate `open_chart_ui` call after this tool returns COMPLETED.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  type AsyncTaskEvent,
  type AsyncTaskStatus,
  COMPLETED_STATE,
  FAILURE_STATES,
  type Visualization,
  cardToVisualization,
  isTransientStatusError,
  summarizeProgress,
  visualizationSchema,
} from "./_async_search_shape.js";
import type { ToolModule } from "./types.js";

// Hard ceiling on a single call's wait budget. The MCP TS SDK's
// DEFAULT_REQUEST_TIMEOUT_MSEC is 60_000 and applies unless the caller
// overrides options.timeout. 50s leaves a 10s margin for the final
// HTTP round-trip + JSON serialization at the Worker boundary.
export const MAX_WAIT_CEILING_S = 50;

// Initial 5 s interval catches quickly-completing pipeline runs without
// thrashing Django; +2 s backoff to 15 s prevents hammering when the
// task takes its full minute(s).
export const INITIAL_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF_STEP_MS = 2_000;

// Per-poll request timeout — caps a single hung GET at 15 s so it
// can't burn the whole wait budget on one socket.
const POLL_REQUEST_TIMEOUT_MS = 15_000;

// Transient transport blips against the status endpoint shouldn't
// kill a polling loop whose underlying Celery task is still running.
const MAX_TRANSIENT_RETRIES = 2;

const inputSchema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe(
      "Task ID returned from `start_deep_knowledge_search`.",
    ),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_CEILING_S)
    .default(MAX_WAIT_CEILING_S)
    .describe(
      `How long this single call may block waiting for a terminal status. Capped at ${MAX_WAIT_CEILING_S} s so the call always returns before the MCP client's tool-call timeout fires. If the task isn't done yet, call this tool again with the same task_id — deep searches typically take 1-3 minutes, expect to chain a few calls.`,
    ),
});

const outputSchema = z.object({
  results: z.array(visualizationSchema),
  count: z.number().int().nonnegative(),
  timed_out: z
    .boolean()
    .describe(
      "True when this call returned because max_wait_seconds elapsed without the task reaching a terminal status — call wait_for_knowledge_search again with the same task_id. False when the task reached COMPLETED.",
    ),
  status: z
    .string()
    .optional()
    .describe(
      "Last-known backend task status (PENDING / IN_PROGRESS / COMPLETED). Populated when timed_out is true so the agent can narrate progress.",
    ),
  events_summary: z
    .string()
    .optional()
    .describe(
      'Short progress summary (e.g. "2 progress events; last: PLANNING"). Useful while timed_out.',
    ),
});

type Output = z.infer<typeof outputSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const wait_for_knowledge_search = {
  name: "wait_for_knowledge_search",
  description:
    'Use this AFTER `start_deep_knowledge_search` returns a `task_id`. Server-side polling against Tako\'s deep-search status endpoint. Returns when the task reaches `COMPLETED` (results + chart fields) OR after `max_wait_seconds` (default 50 s) without a terminal status. **If `timed_out` is true, IMMEDIATELY call wait_for_knowledge_search again with the same task_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting); after that, tell the user the search is taking longer than usual and offer to retry.** On COMPLETED, call `open_chart_ui` with `results[0].card_id` to render the top chart inline, then narrate the data.',
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Wait for Deep Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const deadline = Date.now() + input.max_wait_seconds * 1000;
    let interval = INITIAL_POLL_INTERVAL_MS;

    let nextSinceIndex = 0;
    let latestEvents: AsyncTaskEvent[] = [];
    let lastStatus: AsyncTaskStatus | undefined;
    let transientRetriesLeft = MAX_TRANSIENT_RETRIES;

    while (true) {
      let status: AsyncTaskStatus;
      try {
        status = await djangoGet<AsyncTaskStatus>(
          ctx.env,
          ctx.token,
          "/api/v1/knowledge_search/async/status/",
          {
            query: { task_id: input.task_id, since_index: nextSinceIndex },
            timeoutMs: POLL_REQUEST_TIMEOUT_MS,
          },
        );
      } catch (err) {
        if (isTransientStatusError(err) && transientRetriesLeft > 0) {
          transientRetriesLeft -= 1;
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw err;
          }
          await sleep(Math.min(interval, remaining));
          interval = Math.min(
            interval + POLL_BACKOFF_STEP_MS,
            MAX_POLL_INTERVAL_MS,
          );
          continue;
        }
        throw err;
      }

      lastStatus = status;
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

      if (normalizedStatus === COMPLETED_STATE) {
        const cards = status.result?.outputs?.knowledge_cards ?? [];
        const results: Visualization[] = cards.map(cardToVisualization);
        return {
          results,
          count: results.length,
          timed_out: false,
          status: normalizedStatus,
          events_summary: summarizeProgress(latestEvents),
        };
      }

      if (FAILURE_STATES.has(normalizedStatus)) {
        throw new Error(
          `knowledge_search deep task ${normalizedStatus.toLowerCase()} (${summarizeProgress(latestEvents)}): ${status.error ?? "no detail provided by Tako backend"}`,
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining));
      interval = Math.min(
        interval + POLL_BACKOFF_STEP_MS,
        MAX_POLL_INTERVAL_MS,
      );
    }

    return {
      results: [],
      count: 0,
      timed_out: true,
      status:
        typeof lastStatus?.status === "string"
          ? lastStatus.status.toUpperCase()
          : undefined,
      events_summary: summarizeProgress(latestEvents),
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default wait_for_knowledge_search;

export const __test_only__ = {
  INITIAL_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_WAIT_CEILING_S,
};
