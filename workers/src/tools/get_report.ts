/**
 * `get_report` — fetch a Tako report's current status and (when ready) content.
 *
 * Wraps `GET /api/v1/internal/reports/{report_id}/`. Unified read: while the
 * report is generating, `status` is `pending` / `running` and content fields
 * are absent; once `status === "completed"`, `result` carries the full
 * report payload. Downloadable exports (PDF/PPTX/Markdown/JSON) live behind
 * the dedicated `export_report` tool, not as URL fields on this response.
 *
 * One-shot status check. For waiting on the report to finish, prefer
 * `wait_for_report` — it keeps the polling loop server-side so the model
 * doesn't have to manage cadence + termination + budget itself.
 *
 * Response shape lives in `_report_shape.ts` so this tool and
 * `wait_for_report` cannot drift on field names.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import {
  type ReportDetailResponse,
  reportOutputSchema,
  shapeReportOutput,
} from "./_report_shape.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
});

const get_report = {
  name: "get_report",
  description:
    "Use this for a one-shot status check on a Tako report (from create_report). For waiting on a report to finish, prefer `wait_for_report` — it keeps the polling loop on the server. When still 'pending' / 'running', the `result` field is null. When 'completed', it contains the full report payload. When 'failed', read `error_message` and surface it to the user instead of retrying indefinitely. ALWAYS include the response's `webpage_url` in your reply so the user has a clickable link to open the report in their browser — every response carries one whether the report is still cooking or done. For downloadable exports (PDF/PPTX/Markdown/JSON), call `export_report` with the report_id and the desired format.",
  inputSchema,
  outputSchema: reportOutputSchema,
  annotations: {
    title: "Tako: Get Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const reportId = encodeURIComponent(input.report_id);
    const data = await djangoGet<ReportDetailResponse>(
      ctx.env,
      ctx.token,
      `/api/v1/internal/reports/${reportId}/`,
      { timeoutMs: 30_000 },
    );
    return shapeReportOutput(data, input.report_id, ctx.env);
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof reportOutputSchema>>;

export default get_report;
