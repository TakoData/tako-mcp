/**
 * Shared response shape for the Django report detail endpoint.
 *
 * `get_report` (one-shot read) consumes this shape against the
 * `GET /api/v1/internal/reports/{id}/` endpoint. The shared module
 * exists because we previously also had a `wait_for_report` polling
 * wrapper that needed the same response fields; that tool was removed
 * (it triggered crashy long-poll loops on ChatGPT and Claude), but
 * the shared shape is kept here in case a future kickoff/wait variant
 * for reports is reintroduced.
 *
 * Naming: leading `_` excludes this file from `gen-registry.ts`'s tool
 * scan (see the `NON_TOOL_FILES` / `!f.startsWith("_")` filter there).
 */
import { z } from "zod";

import { type Env, resolvePublicBase } from "../env.js";

/**
 * Raw shape (not yet wrapped in `z.object`) so callers can `...spread`
 * it into a larger schema (e.g., a future wait-style wrapper that adds
 * a `timed_out` flag on top).
 */
export const reportOutputShape = {
  report_id: z.string(),
  status: z.string().nullable(),
  title: z.string().nullable(),
  report_type: z.string().nullable(),
  research_objective: z.string().nullable(),
  credit_cost: z.number().nullable(),
  runtime_seconds: z.number().nullable(),
  estimated_runtime_seconds: z.number().nullable(),
  // Canonical "view this report in the Tako UI" link. Always present
  // and constructed from PUBLIC_BASE_URL — Django's response value is
  // ignored. Downloadable exports flow through the dedicated
  // `export_report` tool, not as URL fields on this response.
  webpage_url: z.string().nullable(),
  // Populated only when status === "completed":
  result: z.unknown().nullable(),
  // Populated only when status === "failed":
  error_message: z.string().nullable(),
} as const;

export const reportOutputSchema = z.object(reportOutputShape);

export type ReportDetailResponse = {
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
  error_message?: string | null;
};

/**
 * Normalize a Django report detail response into the canonical output
 * shape. `fallbackReportId` is used when the response carries neither
 * `report_id` nor `id` — preserving the caller's input rather than
 * returning an empty string that would cascade into a confusing 404 on
 * any downstream lookup.
 *
 * `webpage_url` is constructed from `PUBLIC_BASE_URL` (the public web
 * origin, not the Django API origin) rather than read from the response.
 * The Django report detail endpoint does not reliably populate this
 * field, and the URL pattern is stable
 * (`${web}/reports/{report_id}?from=library`), so building it here
 * guarantees every report response carries a working browser link the
 * LLM can hand to the user.
 */
export function shapeReportOutput(
  data: ReportDetailResponse,
  fallbackReportId: string,
  env: Env,
): z.infer<typeof reportOutputSchema> {
  const reportId = data.report_id ?? data.id ?? fallbackReportId;
  return {
    report_id: reportId,
    status: data.status ?? null,
    title: data.title ?? null,
    report_type: data.report_type ?? null,
    research_objective: data.research_objective ?? null,
    credit_cost: data.credit_cost ?? null,
    runtime_seconds: data.runtime_seconds ?? null,
    estimated_runtime_seconds: data.estimated_runtime_seconds ?? null,
    webpage_url: `${resolvePublicBase(env)}/reports/${encodeURIComponent(reportId)}?from=library`,
    result: data.result ?? null,
    error_message: data.error_message ?? null,
  };
}
