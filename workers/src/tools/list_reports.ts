/**
 * `list_reports` — list the user's existing Tako reports.
 *
 * Wraps `GET /api/v1/internal/reports/`. Required for Claude to find
 * `report_id` values from prior sessions (reports created outside the current
 * conversation are otherwise invisible to the agent).
 *
 * Added alongside `create_report` + `get_report` in Phase 2 per the tool
 * surface audit (`docs/tool-surface-audit-2026-04.md`).
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of reports to return."),
  status: z
    .enum(["pending", "running", "completed", "failed"])
    .optional()
    .describe("Filter by report status."),
});

const reportSummarySchema = z.object({
  report_id: z.string(),
  title: z.string().nullable(),
  report_type: z.string().nullable(),
  status: z.string().nullable(),
  created_at: z.string().nullable(),
  credit_cost: z.number().nullable(),
});

const outputSchema = z.object({
  reports: z.array(reportSummarySchema),
  count: z.number().int().nonnegative(),
});

type DjangoReport = {
  id?: string;
  report_id?: string;
  title?: string | null;
  report_type?: string | null;
  status?: string | null;
  created_at?: string | null;
  credit_cost?: number | null;
};

// DRF paginates most list endpoints with `{count, next, previous, results[]}`.
// We normalize both paginated and plain-array shapes here so the tool doesn't
// care which the backend returns.
type DjangoListResponse =
  | DjangoReport[]
  | {
      count?: number;
      results?: DjangoReport[];
    };

const list_reports = {
  name: "list_reports",
  description:
    "Use this to list the user's existing Tako reports. Returns report IDs, titles, types, and statuses. Useful for finding a report the user created earlier so you can fetch its contents with get_report or refer to it in follow-up actions.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: List Reports",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const query: Record<string, string | number | boolean> = {};
    if (input.limit !== undefined) query.limit = input.limit;
    if (input.status !== undefined) query.status = input.status;

    const data = await djangoGet<DjangoListResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/internal/reports/",
      { query, timeoutMs: 30_000 },
    );
    const rows = Array.isArray(data) ? data : (data.results ?? []);
    const reports = rows.map((r) => ({
      report_id: r.report_id ?? r.id ?? "",
      title: r.title ?? null,
      report_type: r.report_type ?? null,
      status: r.status ?? null,
      created_at: r.created_at ?? null,
      credit_cost: r.credit_cost ?? null,
    }));
    return { reports, count: reports.length };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default list_reports;
