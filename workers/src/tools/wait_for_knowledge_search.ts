/**
 * `wait_for_knowledge_search` — server-side polling wrapper around the
 * async knowledge-search status endpoint.
 *
 * Polls `/api/v1/knowledge_search/async/status/?task_id=…` until either
 * a terminal status is observed OR `max_wait_seconds` elapses, whichever
 * comes first. The hard cap on `max_wait_seconds` (50s) keeps every
 * single tool call well under the MCP client's 60s default timeout, so
 * the agent can chain back-to-back waits without ever tripping a
 * client-side abort.
 *
 * Mirrors `wait_for_report` for reports — the pattern is the same:
 * server-side loop, agent loops the tool when `timed_out` is true.
 *
 * Subrequest math: with a 50s budget, 5s initial interval and +2s
 * backoff capped at 15s, a single timed-out call makes at most ~7
 * status GETs — well under Cloudflare Workers' default 50-subrequest
 * cap (1000 on Paid).
 */
import { z } from "zod";

import { DjangoHttpError, DjangoTimeoutError, djangoGet } from "../django.js";
import {
  type AsyncTaskEvent,
  type AsyncTaskStatus,
  COMPLETED_STATE,
  FAILURE_STATES,
  buildResultsWithAutoChain,
  resultsOutputShape,
  summarizeProgress,
} from "./_async_search_shape.js";
import type { ToolModule } from "./types.js";

// Hard ceiling on a single call's wait budget. The MCP TS SDK's
// DEFAULT_REQUEST_TIMEOUT_MSEC is 60_000 and applies unless the caller
// overrides options.timeout. 50s leaves a 10s margin for the final
// HTTP round-trip + JSON serialization at the Worker boundary.
export const MAX_WAIT_CEILING_S = 50;

// Initial 5s interval catches quickly-completing pipeline runs without
// thrashing Django; +2s backoff to 15s prevents hammering when the
// task takes its full minute(s). Module-level constants so tests can
// reach them via fake timers.
export const INITIAL_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF_STEP_MS = 2_000;

// Per-poll request timeout — caps a single hung GET at 15s so it can't
// burn the whole wait budget on one socket.
const POLL_REQUEST_TIMEOUT_MS = 15_000;

// Transient transport blips against the status endpoint shouldn't kill
// a polling loop whose underlying Celery task is still running. Match
// the previous in-tool polling behavior: swallow up to MAX_TRANSIENT_RETRIES
// failures across the loop, then surface so a sustained outage fails loud.
const MAX_TRANSIENT_RETRIES = 2;

const inputSchema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe(
      "Task ID returned from a previous knowledge_search async kickoff.",
    ),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_CEILING_S)
    .default(MAX_WAIT_CEILING_S)
    .describe(
      `How long this single call may block waiting for a terminal status. Capped at ${MAX_WAIT_CEILING_S}s so the call always returns before the MCP client's tool-call timeout fires. If the task isn't done yet, call this tool again with the same task_id — deep searches typically take 1-5 minutes, expect to chain a few calls in a row.`,
    ),
});

// Output mirrors knowledge_search's sync results path so the chart
// widget renders identically when the deep task finishes via this tool,
// plus the wait-specific `timed_out` discriminator and last-known
// progress fields for the timed-out branch.
const outputSchema = z.object({
  ...resultsOutputShape,
  timed_out: z
    .boolean()
    .describe(
      "True when this call returned because max_wait_seconds elapsed without the task reaching a terminal status — call wait_for_knowledge_search again with the same task_id. False when the task reached COMPLETED.",
    ),
  status: z
    .string()
    .optional()
    .describe(
      "Last-known backend task status (PENDING / IN_PROGRESS / COMPLETED). Useful when timed_out is true.",
    ),
  events_summary: z
    .string()
    .optional()
    .describe(
      'Short progress summary (e.g. "2 progress events; last: PLANNING"). Useful when timed_out is true.',
    ),
});

type Output = z.infer<typeof outputSchema>;

function isTransientStatusError(err: unknown): boolean {
  if (err instanceof DjangoTimeoutError) return true;
  if (
    err instanceof DjangoHttpError &&
    err.status !== undefined &&
    err.status >= 500
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const wait_for_knowledge_search = {
  name: "wait_for_knowledge_search",
  description:
    'Use this AFTER `knowledge_search` returns a `task_id` with `status: "pending"`. Server-side polling around Tako\'s deep (Orca) async-search status endpoint. Returns when the task reaches `COMPLETED` OR after `max_wait_seconds` (default 50s) without a terminal status. **If `timed_out` is true, IMMEDIATELY call wait_for_knowledge_search again with the same task_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting).** On COMPLETED, this tool DOES NOT auto-render a chart inline (intentional — the wait flow involves multiple tool calls and an inline widget per call would clutter the chat). Call `open_chart_ui` with `results[0].card_id` to render the top chart, then narrate the data and offer to chart other results.',
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Wait for Knowledge Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const deadline = Date.now() + input.max_wait_seconds * 1000;
    let interval = INITIAL_POLL_INTERVAL_MS;

    // Cumulative across polls so the timed_out / failed message can show
    // how far the pipeline got. since_index = maxId + 1 ensures the
    // backend filter (inclusive >=) only returns events strictly newer
    // than what we've already seen.
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
          // Don't sleep past the deadline.
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            // Budget already exhausted — surface the original error
            // rather than a synthetic timed_out response, since we
            // never got a successful status read.
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
        return {
          ...buildResultsWithAutoChain(cards, ctx.env),
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

    // Budget exhausted without a terminal status. Return the empty
    // results shape (so the schema parses) plus the wait-specific
    // diagnostic fields.
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
  // Intentionally NO `appUiResource` / `extraMeta` / `extraContentBlocks`
  // on this tool, even though COMPLETED responses carry chart fields
  // (pub_id, embed_url, image_url, …). Reason: a deep search routinely
  // requires multiple chained calls to this tool — one initial kickoff
  // poll plus several timed_out continuations until the backend task
  // terminates. If we attached the chart widget bundle to this tool,
  // every intermediate call would render an empty 240-px-tall widget
  // container in the chat (host CSS reserves min-height for any tool
  // with `appUiResource`, regardless of what the inner widget reports
  // for intrinsic height — verified on ChatGPT). Stacked across N
  // chained calls, that becomes a visually busy column of empty boxes.
  // Instead, the agent narrates the COMPLETED data and chains into
  // `open_chart_ui` (which always carries the widget bundle, always
  // has a chart to render) for the inline chart. One extra agent step
  // for the deep path; clean chat for the wait loop. The fast path
  // (knowledge_search sync results) keeps the inline widget unchanged.
} satisfies ToolModule<typeof inputSchema, Output>;

export default wait_for_knowledge_search;

// Exported for unit tests — the polling-budget constants drive
// fake-timer counts in `wait_for_knowledge_search.test.ts`.
export const __test_only__ = {
  INITIAL_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_WAIT_CEILING_S,
};
