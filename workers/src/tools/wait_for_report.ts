/**
 * `wait_for_report` — server-side polling wrapper around the report
 * detail endpoint. Block on a single tool call until the report reaches
 * a terminal status OR `max_wait_seconds` elapses, whichever comes first.
 *
 * Why this exists alongside `get_report`:
 *   - `get_report` is a single-shot status read. It forces the model to
 *     run the polling loop itself, burning turns and tokens.
 *   - This keeps the loop on the Worker side. Each call is hard-capped
 *     under the most aggressive MCP client tool-call timeout (~60s, the
 *     SDK default — see `knowledge_search.ts` for the longer note on
 *     `DEFAULT_REQUEST_TIMEOUT_MSEC`), so the model can chain back-to-back
 *     calls without ever tripping a timeout mid-call.
 *   - Backend pipeline is unchanged. Celery still does the work; this
 *     tool just changes who waits.
 *
 * Subrequest math: with a 50s budget, a 5s initial interval and +2s
 * backoff capped at 15s, a single timed-out call makes at most ~7
 * status GETs — well under Cloudflare Workers' default 50-subrequest
 * cap (1000 on Paid).
 *
 * Response shape comes from `_report_shape.ts`, so this tool and
 * `get_report` stay lockstep on field names.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  type ReportDetailResponse,
  reportOutputShape,
  shapeReportOutput,
} from "./_report_shape.js";
import type { ToolModule } from "./types.js";

// Hard ceiling on a single call's wait budget. The MCP TS SDK's
// DEFAULT_REQUEST_TIMEOUT_MSEC is 60_000 and applies unless the caller
// passes options.timeout (see the longer note on the same constant in
// knowledge_search.ts). 50s leaves a ~10s margin for the final HTTP
// round-trip + JSON serialization at the Worker boundary.
export const MAX_WAIT_CEILING_S = 50;

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
    "Use this after create_report (or whenever the user wants to wait for / check on a report). Server-side polling — returns when status is 'completed' / 'failed' / 'cancelled' OR after max_wait_seconds (default 50s) without a terminal status. **If `timed_out` is true, IMMEDIATELY call wait_for_report again with the same report_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting): once you've made 12 chained wait_for_report calls and the report is still not terminal, STOP chaining; tell the user the report is taking longer than usual, re-share the `webpage_url`, and remind them they'll receive an email when it's done.** Once terminal, ALWAYS include the response's `webpage_url` so the user has a clickable link to open the report in their browser, then summarize `result` / `export_urls` on completed or `error_message` on failed.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Wait for Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const path = `/api/v1/internal/reports/${encodeURIComponent(input.report_id)}/`;
    const deadline = Date.now() + input.max_wait_seconds * 1000;
    let interval = INITIAL_POLL_INTERVAL_MS;
    // Track the most recent successful read so the timed_out branch can
    // surface the latest known status fields rather than a synthetic
    // "no data" object. The first poll always runs before any deadline
    // check, so this is set by the time we exit the loop in practice.
    let last: ReportDetailResponse | undefined;

    while (true) {
      last = await djangoGet<ReportDetailResponse>(
        ctx.env,
        ctx.token,
        path,
        { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
      );

      const status = (last.status ?? "").toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        return {
          ...shapeReportOutput(last, input.report_id, ctx.env),
          timed_out: false,
        };
      }

      // Don't sleep past the deadline. Pick the smaller of the next
      // interval and the remaining budget so a wait_for_report that's
      // 3s away from its deadline doesn't queue a 15s sleep and then
      // overshoot by 12s.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining));
      interval = Math.min(interval + POLL_BACKOFF_STEP_MS, MAX_POLL_INTERVAL_MS);
    }

    // `last` is always set: the first iteration's djangoGet runs before
    // any deadline check, and we only break out of the loop after a
    // successful read. The non-null assertion is documenting that
    // invariant rather than masking a real undefined case.
    return {
      ...shapeReportOutput(last as ReportDetailResponse, input.report_id, ctx.env),
      timed_out: true,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default wait_for_report;
