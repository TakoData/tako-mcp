/**
 * `wait_for_report` — server-side wait for a Tako report to reach a
 * terminal status.
 *
 * Two ways to wait, picked per call:
 *
 * 1. **SSE streaming.** When the report has a `celery_task_id` (which is
 *    the same UUID as `AsyncTaskStatus.id` — see `send_to_celery_dist`
 *    in `app/backend/async_tasks/celery_dispatch.py`), open Django's
 *    `GET /api/v1/agent/stream/{task_id}/` and yield through the agent's
 *    progress envelopes. Each `activity` envelope is translated into a
 *    human-readable line and forwarded to the MCP client as a
 *    `notifications/progress` event so the user sees live "fetching X",
 *    "calling tool Y" breadcrumbs instead of a silent spinner.
 * 2. **Polling fallback.** When (a) the report has no `celery_task_id`
 *    (analyze never ran), (b) the streaming endpoint isn't reachable,
 *    or (c) the SSE call fails mid-way, drop into the legacy poll loop
 *    against the report-detail endpoint until terminal or budget
 *    exhausted. Same semantics as the pre-streaming version of this
 *    tool, so no client behavior changes for older reports.
 *
 * Single-call wall-clock budget stays at `MAX_WAIT_CEILING_S` so the
 * call always returns before the MCP client's tool-call timeout fires;
 * the streaming branch hard-bounds the SSE connection to that same
 * deadline. The LLM is instructed to chain back-to-back calls until
 * terminal — same shape as today, just with live progress text in
 * between.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  type StreamEnvelope,
  streamAgent,
} from "../django_stream.js";
import {
  type ReportDetailResponse,
  reportOutputShape,
  shapeReportOutput,
} from "./_report_shape.js";
import type { ToolContext, ToolModule } from "./types.js";

// Hard ceiling on a single call's wait budget. The MCP TS SDK's
// DEFAULT_REQUEST_TIMEOUT_MSEC is 60_000 and applies unless the caller
// passes options.timeout (see the longer note on the same constant in
// knowledge_search.ts). 50s leaves a ~10s margin for the final HTTP
// round-trip + JSON serialization at the Worker boundary.
export const MAX_WAIT_CEILING_S = 50;

// Polling fallback constants (used when streaming isn't available).
// Reports take minutes; some report types finish in <30s, others run
// 10+ min. Poll fast at first to catch quick types, then back off so
// we don't hammer Django on long-running ones. Module-level constants
// so vitest can reach them for fake-timer tests.
export const INITIAL_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF_STEP_MS = 2_000;

// Each per-poll request is bounded so a single hung Django call can't
// burn the whole wait budget on one socket.
const POLL_REQUEST_TIMEOUT_MS = 15_000;

// Terminal report statuses. Comparison is lowercased so casing drift
// between backend versions ("COMPLETED" vs "completed") doesn't
// silently turn a terminal response into an infinite poll loop —
// matches the same defensive normalization in knowledge_search.ts.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_CEILING_S)
    .default(MAX_WAIT_CEILING_S)
    .describe(
      `How long this single call may block waiting for a terminal status. Capped at ${MAX_WAIT_CEILING_S}s so the call always returns before the MCP client's tool-call timeout fires. If the report isn't done yet, call this tool again with the same report_id — reports typically take 5–20 minutes, so expect to chain several calls in a row.`,
    ),
});

// Mirror `get_report`'s output (via the shared shape) and add the
// wait-specific `timed_out` discriminator. Same field names mean the
// model never needs different reading code for the two tools.
const outputSchema = z.object({
  ...reportOutputShape,
  timed_out: z
    .boolean()
    .describe(
      "True when this call returned because max_wait_seconds elapsed without the report reaching a terminal status — call wait_for_report again with the same report_id. False when the report reached a terminal status (completed / failed / cancelled) and you should stop polling.",
    ),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const wait_for_report = {
  name: "wait_for_report",
  description:
    "Use this after create_report (or whenever the user wants to wait for / check on a report). Server-side wait — returns when status is 'completed' / 'failed' / 'cancelled' OR after max_wait_seconds (default 50s) without a terminal status. **If `timed_out` is true, IMMEDIATELY call wait_for_report again with the same report_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. Do NOT use web_search, browse, or your own knowledge to summarize, paraphrase, or pre-empt the report content while waiting. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting): once you've made 12 chained wait_for_report calls and the report is still not terminal, STOP chaining; tell the user the report is taking longer than usual, re-share the `webpage_url`, and remind them they'll receive an email when it's done.** Once terminal, ALWAYS include the response's `webpage_url` so the user has a clickable link to open the report in their browser, then summarize `result` / `export_urls` on completed (drawing ONLY from those fields, never your own knowledge) or `error_message` on failed.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Wait for Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const detailPath = `/api/v1/internal/reports/${encodeURIComponent(input.report_id)}/`;
    const deadline = Date.now() + input.max_wait_seconds * 1000;

    // First fetch — used both to short-circuit on already-terminal
    // reports AND to discover the streaming task_id. Throwing here
    // (Django 4xx/5xx) propagates to the MCP error mapper just like
    // any other tool failure, which is the right behavior: an unknown
    // report_id should fail loud, not silently time out.
    let last = await djangoGet<ReportDetailResponse>(
      ctx.env,
      ctx.token,
      detailPath,
      { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
    );

    if (TERMINAL_STATUSES.has(((last.status ?? "") as string).toLowerCase())) {
      return {
        ...shapeReportOutput(last, input.report_id, ctx.env),
        timed_out: false,
      };
    }

    // Streaming path. `celery_task_id` is the same UUID as
    // `AsyncTaskStatus.id` upstream (`send_to_celery_dist` mints one
    // value and uses it for both), so we can hand it straight to the
    // SSE endpoint. Skip when it's missing — that means analyze never
    // ran or the field hasn't propagated yet, in which case polling
    // is the only option.
    const taskId = readCeleryTaskId(last);
    if (taskId !== null) {
      try {
        last = await consumeStream(ctx, taskId, detailPath, deadline, last);
      } catch (err) {
        // Real streaming failure (404 task not yet registered, 5xx,
        // network glitch — NOT graceful budget exhaustion, which
        // consumeStream swallows internally). Log + fall through to
        // polling so the caller still gets a useful answer.
        console.warn(
          `[wait_for_report] stream error, falling back to polling: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const status = ((last.status ?? "") as string).toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        return {
          ...shapeReportOutput(last, input.report_id, ctx.env),
          timed_out: false,
        };
      }
    }

    // Polling fallback. Runs against whatever budget remains after
    // (a) the first detail fetch and (b) any streaming attempt above.
    last = await pollUntilDeadline(ctx, detailPath, deadline, last);
    const finalStatus = ((last.status ?? "") as string).toLowerCase();
    return {
      ...shapeReportOutput(last, input.report_id, ctx.env),
      timed_out: !TERMINAL_STATUSES.has(finalStatus),
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

/**
 * Drive the SSE stream for one task: emit progress notifications per
 * envelope, then do a final detail fetch when the stream ends so the
 * caller has the report content to return. Returns the last detail
 * response on success; throws on **real** connection errors (4xx/5xx,
 * network glitch) so the caller can fall back to polling; graceful
 * budget exhaustion (our own deadline timer firing) is swallowed and
 * NOT thrown — the caller treats that as a normal early exit.
 *
 * Hard-bounded by the wall-clock `deadline` so a hung backend can't
 * outlast the MCP tool-call timeout — when the deadline is hit we
 * abort the SSE connection and exit cleanly.
 */
async function consumeStream(
  ctx: ToolContext,
  taskId: string,
  detailPath: string,
  deadline: number,
  initial: ReportDetailResponse,
): Promise<ReportDetailResponse> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return initial;

  const aborter = new AbortController();
  let budgetExhausted = false;
  const budgetTimer = setTimeout(() => {
    budgetExhausted = true;
    aborter.abort();
  }, remaining);
  // Combine the per-call budget with the client's cancel signal so
  // either firing tears down the connection.
  const signal = ctx.signal !== undefined
    ? combineSignals(ctx.signal, aborter.signal)
    : aborter.signal;

  let sawStreamDone = false;

  try {
    for await (const env of streamAgent(ctx.env, ctx.token, taskId, {
      signal,
    })) {
      const message = humanizeEnvelope(env);
      if (message !== null && ctx.sendProgress !== undefined) {
        // Best-effort: a closed transport / write race shouldn't
        // bring the stream down. Swallow silently — the report
        // still completes upstream regardless.
        await ctx.sendProgress({ message }).catch(() => undefined);
      }
      if (env.category === "control" && env.block.kind === "stream_done") {
        sawStreamDone = true;
        break;
      }
    }
  } catch (err) {
    // If the budget timer fired, the resulting AbortError /
    // DjangoTimeoutError is graceful exit, not a failure to surface.
    // Anything else is a real stream error (4xx/5xx, body parse,
    // upstream crash) and propagates to the caller's polling fallback.
    if (!budgetExhausted) {
      throw err;
    }
  } finally {
    clearTimeout(budgetTimer);
  }

  // After stream_done OR a clean body close OR budget exhaustion,
  // fetch the report detail once more so we return the actual report
  // content / status. The stream itself doesn't carry the final
  // report payload (it carries agent activity envelopes), so this is
  // required either way.
  if (sawStreamDone || Date.now() < deadline) {
    return await djangoGet<ReportDetailResponse>(
      ctx.env,
      ctx.token,
      detailPath,
      { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
    );
  }
  return initial;
}

/**
 * Translate one stream envelope into a human-readable progress line, or
 * `null` if the envelope shouldn't surface to the user (control frames,
 * content deltas — those are the report itself, not progress about it).
 *
 * Kept loose on purpose: unknown block kinds return `null` so a Django
 * regression that adds a new block type degrades to "no extra progress
 * line" instead of crashing the stream.
 */
function humanizeEnvelope(env: StreamEnvelope): string | null {
  if (env.category !== "activity") return null;
  const block = env.block;
  switch (block.kind) {
    case "status":
      return typeof block.message === "string" && block.message.length > 0
        ? block.message
        : null;
    case "tool_call": {
      const tool = typeof block.tool === "string" ? block.tool : "tool";
      const sm =
        typeof block.status_message === "string" && block.status_message.length > 0
          ? block.status_message
          : null;
      return sm ?? `Calling ${tool}…`;
    }
    case "tool_result": {
      const tool = typeof block.tool === "string" ? block.tool : "tool";
      return `${tool} done`;
    }
    case "tool_error": {
      const tool = typeof block.tool === "string" ? block.tool : "tool";
      const err = typeof block.error === "string" ? block.error : "";
      // Cap the error tail so a single block can't blow up the
      // notification payload — these go straight to the chat UI.
      return err.length > 0 ? `${tool} failed: ${err.slice(0, 200)}` : `${tool} failed`;
    }
    case "tool_retry": {
      const tool = typeof block.tool === "string" ? block.tool : "tool";
      return `Retrying ${tool}…`;
    }
    case "subagent": {
      const stype =
        typeof block.subagent_type === "string" ? block.subagent_type : "subagent";
      return block.event === "dispatch" ? `Starting ${stype}…` : `${stype} done`;
    }
    default:
      return null;
  }
}

function readCeleryTaskId(detail: ReportDetailResponse): string | null {
  const value = detail.celery_task_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Polling loop equivalent to the pre-streaming version of this tool.
 * Used both as the streaming fallback and as the primary path for
 * reports that don't expose a streaming task id.
 *
 * Takes the detail response that was already fetched (`initial`) so
 * the caller's first GET isn't repeated, and returns the most recent
 * snapshot — terminal or otherwise — when the budget elapses.
 */
async function pollUntilDeadline(
  ctx: ToolContext,
  detailPath: string,
  deadline: number,
  initial: ReportDetailResponse,
): Promise<ReportDetailResponse> {
  let last = initial;
  let interval = INITIAL_POLL_INTERVAL_MS;

  while (true) {
    const status = ((last.status ?? "") as string).toLowerCase();
    if (TERMINAL_STATUSES.has(status)) return last;

    // Don't sleep past the deadline. Pick the smaller of the next
    // interval and the remaining budget so a tail call that's a few
    // seconds away from its deadline doesn't queue a 15 s sleep and
    // overshoot.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval + POLL_BACKOFF_STEP_MS, MAX_POLL_INTERVAL_MS);

    last = await djangoGet<ReportDetailResponse>(
      ctx.env,
      ctx.token,
      detailPath,
      { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
    );
  }
}

/**
 * Same shape as `combineSignals` in `django_stream.ts`, duplicated here
 * to avoid exporting an internal helper across module boundaries. Both
 * call sites are tiny and the alternative (an internal "utils" file)
 * usually rots into a junk drawer — keeping the two copies side-by-side
 * is cheaper to maintain.
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any).any as
    | ((signals: AbortSignal[]) => AbortSignal)
    | undefined;
  if (typeof anyFn === "function") return anyFn([a, b]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export default wait_for_report;
