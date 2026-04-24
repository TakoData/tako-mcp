/**
 * `get_report` — fetch a Tako report's current status and (when ready) content.
 *
 * Wraps `GET /api/v1/internal/reports/{report_id}/`. Unified read: while the
 * report is generating, `status` is `pending` / `running` and content fields
 * are absent; once `status === "completed"`, the full `sections`,
 * `export_urls`, etc. are populated.
 *
 * Caller (Claude) polls this after `create_report` returns a `report_id`. The
 * backend report detail endpoint is synchronous/cheap; polling every ~15 s is
 * reasonable. A future refinement could surface a `next_poll_at` hint.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
});

const outputSchema = z.object({
  report_id: z.string(),
  status: z.string().nullable(),
  title: z.string().nullable(),
  report_type: z.string().nullable(),
  research_objective: z.string().nullable(),
  credit_cost: z.number().nullable(),
  runtime_seconds: z.number().nullable(),
  estimated_runtime_seconds: z.number().nullable(),
  // Canonical "view this report in the Tako UI" link. Surfaced as a
  // dedicated top-level field (not rolled into `export_urls`) because it is
  // semantically distinct: a view URL, not a downloadable export.
  webpage_url: z.string().nullable(),
  // Populated only when status === "completed":
  result: z.unknown().nullable(),
  export_urls: z.record(z.string(), z.string()).nullable(),
  thread_id: z.string().nullable(),
  // Populated only when status === "failed":
  error_message: z.string().nullable(),
});

type DjangoResponse = {
  id?: string;
  report_id?: string;
  status?: string | null;
  title?: string | null;
  report_type?: string | null;
  research_objective?: string | null;
  credit_cost?: number | null;
  runtime_seconds?: number | null;
  estimated_runtime_seconds?: number | null;
  webpage_url?: string | null;
  result?: unknown;
  thread_id?: string | null;
  error_message?: string | null;
  // The detail serializer exposes several per-format export URLs. We flatten
  // any keys ending in `_url` whose value is a string into a single
  // `export_urls` map for LLM convenience.
  [k: string]: unknown;
};

// Keys lifted to their own top-level output field and therefore excluded
// from the flattened `export_urls` bucket to avoid double-reporting.
const EXPORT_URL_KEY_EXCLUSIONS = new Set(["webpage_url"]);

function extractExportUrls(data: DjangoResponse): Record<string, string> | null {
  const urls: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (EXPORT_URL_KEY_EXCLUSIONS.has(key)) continue;
    if (
      typeof value === "string" &&
      (key.endsWith("_url") || key.endsWith("_urls"))
    ) {
      urls[key] = value;
    }
  }
  return Object.keys(urls).length > 0 ? urls : null;
}

const get_report = {
  name: "get_report",
  description:
    "Use this to check the status of a Tako report (from create_report) and fetch its contents once generation completes. Poll every ~15 s until status == 'completed'. When the report is still generating, narrative/sections fields are null; when done, they contain the full report payload and export URLs (pdf, pptx).",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Get Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const reportId = encodeURIComponent(input.report_id);
    const data = await djangoGet<DjangoResponse>(
      ctx.env,
      ctx.token,
      `/api/v1/internal/reports/${reportId}/`,
      { timeoutMs: 30_000 },
    );
    return {
      report_id: data.report_id ?? data.id ?? input.report_id,
      status: data.status ?? null,
      title: data.title ?? null,
      report_type: data.report_type ?? null,
      research_objective: data.research_objective ?? null,
      credit_cost: data.credit_cost ?? null,
      runtime_seconds: data.runtime_seconds ?? null,
      estimated_runtime_seconds: data.estimated_runtime_seconds ?? null,
      webpage_url: data.webpage_url ?? null,
      result: data.result ?? null,
      export_urls: extractExportUrls(data),
      thread_id: data.thread_id ?? null,
      error_message: data.error_message ?? null,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_report;
