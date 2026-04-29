/**
 * Shared response shape for the Django report detail endpoint.
 *
 * Both `get_report` (one-shot read) and `wait_for_report` (server-side
 * polling wrapper) return the same fields against the same
 * `GET /api/v1/internal/reports/{id}/` endpoint. Pulling the schema,
 * Django response type, and shape function here keeps the two tools in
 * lockstep — adding a field in one place propagates to both.
 *
 * Naming: leading `_` excludes this file from `gen-registry.ts`'s tool
 * scan (see the `NON_TOOL_FILES` / `!f.startsWith("_")` filter there).
 */
import { z } from "zod";

import { type Env, resolvePublicBase } from "../env.js";

/**
 * Raw shape (not yet wrapped in `z.object`) so callers can `...spread`
 * it into a larger schema. `wait_for_report` adds a `timed_out` flag on
 * top of these fields; spreading lets that tool extend without
 * duplicating field definitions.
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
  // Canonical "view this report in the Tako UI" link. Surfaced as a
  // dedicated top-level field (not rolled into `export_urls`) because it
  // is semantically distinct: a view URL, not a downloadable export.
  webpage_url: z.string().nullable(),
  // Populated only when status === "completed":
  result: z.unknown().nullable(),
  export_urls: z.record(z.string(), z.string()).nullable(),
  thread_id: z.string().nullable(),
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
  thread_id?: string | null;
  error_message?: string | null;
  // The detail serializer exposes several per-format export URLs; we
  // flatten any keys ending in `_url` whose value is a string into a
  // single `export_urls` map for LLM convenience.
  [k: string]: unknown;
};

// Keys that already have their own dedicated top-level output field and
// should therefore NOT be re-flattened into the `export_urls` bucket.
const TOP_LEVEL_URL_KEYS = new Set(["webpage_url"]);

function extractExportUrls(
  data: ReportDetailResponse,
): Record<string, string> | null {
  const urls: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (TOP_LEVEL_URL_KEYS.has(key)) continue;
    // Only `_url` (singular) — no known export endpoint returns a
    // string under a plural `_urls` key (those are typically arrays,
    // which wouldn't fit `Record<string, string>` anyway).
    if (typeof value === "string" && key.endsWith("_url")) {
      urls[key] = value;
    }
  }
  return Object.keys(urls).length > 0 ? urls : null;
}

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
    export_urls: extractExportUrls(data),
    thread_id: data.thread_id ?? null,
    error_message: data.error_message ?? null,
  };
}
