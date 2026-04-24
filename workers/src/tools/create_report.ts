/**
 * `create_report` — kick off async generation of a Tako analytical report.
 *
 * Wraps `POST /api/v1/internal/reports/`. Reports generate asynchronously on
 * the backend (30 s–5 min depending on type); this tool returns immediately
 * with a `report_id` and a `pending` status. The caller (Claude) should poll
 * `get_report(report_id)` until `status === "completed"`.
 *
 * `report_type` is validated against a finite backend registry
 * (`app/backend/reports/types/registry.py::get_all_report_types`). There is no
 * MCP tool to enumerate valid types today; if Claude passes an unknown value,
 * Django returns a 400 whose body lists the valid names and Claude can retry.
 * A follow-up `list_report_types` tool would need a backend endpoint first.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  report_type: z
    .string()
    .min(1)
    .describe(
      "The report type slug (e.g. an earnings-analysis or industry-overview template). Enumerated by the backend's `get_all_report_types` registry; on an invalid value the server returns 400 with the valid names.",
    ),
  title: z
    .string()
    .min(1)
    .describe("Human-readable title for the generated report."),
  research_objective: z
    .string()
    .min(1)
    .describe(
      "Natural-language brief describing what the report should analyze or answer.",
    ),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Type-specific configuration (e.g. ticker, time range). Shape varies by report_type.",
    ),
  template_source: z
    .string()
    .optional()
    .describe("Optional ID of a user-saved template to seed the report from."),
});

const outputSchema = z.object({
  report_id: z.string(),
  status: z.string().nullable(),
  title: z.string().nullable(),
  credit_cost: z.number().nullable(),
  estimated_runtime_seconds: z.number().nullable(),
});

type DjangoResponse = {
  id?: string;
  report_id?: string;
  status?: string | null;
  title?: string | null;
  credit_cost?: number | null;
  estimated_runtime_seconds?: number | null;
};

const create_report = {
  name: "create_report",
  description:
    "Use this when the user asks to generate a Tako report on a topic (e.g. \"write a Tesla Q1 earnings report\"). Kicks off async generation and returns a report_id. The caller must poll get_report(report_id) until status == 'completed' to retrieve contents. Consumes credits — surface credit_cost to the user when appropriate.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Create Report",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const body: Record<string, unknown> = {
      report_type: input.report_type,
      title: input.title,
      research_objective: input.research_objective,
    };
    if (input.config !== undefined) body.config = input.config;
    if (input.template_source !== undefined) {
      body.template_source = input.template_source;
    }

    // The tool's input-schema description promises LLMs can retry after a
    // 400 by reading the list of valid `report_type` values from the
    // response body. `DjangoBadRequestError.body` carries that detail,
    // and the MCP adapter (`djangoErrorToToolResult`) splices it into
    // the tool's text content — so just let the error propagate.
    const data = await djangoPost<DjangoResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/internal/reports/",
      body,
      { timeoutMs: 30_000 },
    );
    // Prefer `report_id`, fall back to `id`. Throwing when both are
    // missing is louder than returning `""` — an empty id silently
    // propagates into a downstream `get_report("")` call that 404s with
    // a confusing message, while a thrown error fails precisely at the
    // tool that produced the bad response.
    const reportId = data.report_id ?? data.id;
    if (reportId === undefined || reportId === "") {
      throw new Error(
        "Tako create_report response missing both `report_id` and `id`",
      );
    }
    return {
      report_id: reportId,
      status: data.status ?? null,
      title: data.title ?? null,
      credit_cost: data.credit_cost ?? null,
      estimated_runtime_seconds: data.estimated_runtime_seconds ?? null,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default create_report;
