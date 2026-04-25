/**
 * `create_report` — kick off async generation of a Tako analytical report.
 *
 * Up to four backend calls, behind a single tool:
 *   0a. (optional) `GET /api/v1/internal/reports/templates/`         — if
 *       the caller doesn't provide `config`, list templates and find the
 *       seeded `is_default: true` row for `report_type`.
 *   0b. (optional) `GET /api/v1/internal/reports/templates/{id}/`   — the
 *       list serializer strips `config`; the detail serializer runs
 *       `populate_templates_from_components` and returns assembled
 *       `input_template` + `output_template` XML in `config`. We need
 *       that XML inline because the backend's create serializer validates
 *       `config` against `AgentReportConfig`, which hard-requires both
 *       fields (`deps.py:20-21`, `config.py:16-17`).
 *   1.  `POST /api/v1/internal/reports/`            — creates the record in
 *       `pending` state (no Celery dispatch yet).
 *   2.  `POST /api/v1/internal/reports/{id}/analyze/` — flips status to
 *       `running` and enqueues the generation job (see
 *       `ReportViewSet.analyze` in the Tako backend).
 *
 * Without steps 0a–0b, the only report type today (`agent_report`) would
 * 400 on every "make me a report" call because its config requires the
 * two XML fields. Without step 2, the report sits in the user's Library
 * as a Draft forever — see `ReportViewSet.create` vs `ReportViewSet.analyze`.
 *
 * Partial-success: if step 1 succeeds but step 2 fails (Celery queue
 * down, analyze 5xx, timeout, …), the report already exists as a Draft
 * on the user's account. Rather than throwing and losing `report_id`,
 * the tool returns with `status: "created_but_not_started"` and a
 * structured `analyze_error`, so the LLM can tell the user their draft
 * is recoverable from the web UI instead of reporting a generic failure.
 * Create failures still throw — there's no record to recover on that path.
 *
 * `report_type` is validated against a finite backend registry
 * (`app/backend/reports/types/registry.py::get_all_report_types`). There is no
 * MCP tool to enumerate valid types today; if Claude passes an unknown value,
 * Django returns a 400 whose body lists the valid names and Claude can retry.
 * A follow-up `list_report_types` tool would need a backend endpoint first.
 */
import { z } from "zod";

import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
  djangoGet,
  djangoPost,
} from "../django.js";
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
  status: z
    .string()
    .nullable()
    .describe(
      "`running` when generation started successfully. `created_but_not_started` means the report exists as a Draft in the user's Library but `/analyze/` failed, so no Celery job was dispatched — tell the user their draft was created and they can re-trigger generation from the web UI. Otherwise whatever the backend returned from create (e.g. `pending`).",
    ),
  title: z.string().nullable(),
  credit_cost: z.number().nullable(),
  estimated_runtime_seconds: z.number().nullable(),
  // Celery task id returned by the `/analyze/` call. Surfaced so operators
  // have a handle to look up the job in Flower / Datadog if it stalls.
  // Null when analyze failed (`status == "created_but_not_started"`).
  celery_task_id: z.string().nullable(),
  // Present when create succeeded but analyze failed. Gives the LLM a
  // structured handle to explain the partial-success state to the user.
  // Create failures still throw — see the comment above the `/analyze/`
  // call for the reason we only swallow analyze errors.
  analyze_error: z
    .object({
      kind: z.string(),
      status: z.number().nullable(),
      message: z.string(),
    })
    .nullable(),
});

type CreateResponse = {
  id?: string;
  report_id?: string;
  status?: string | null;
  title?: string | null;
  credit_cost?: number | null;
  estimated_runtime_seconds?: number | null;
};

type AnalyzeResponse = {
  status?: string | null;
  celery_task_id?: string | null;
};

type ReportTemplate = {
  id?: string;
  is_default?: boolean;
  report_type?: string;
};

type ReportTemplateDetail = ReportTemplate & {
  config?: {
    input_template?: string;
    output_template?: string;
    target_indexes?: string[];
    [key: string]: unknown;
  };
};

// Accept both a bare array and a DRF-paginated `{results: [...]}` shape —
// the backend's pagination class can flip per deployment / per endpoint and
// we don't want to silently miss the default template when it does.
type TemplateListResponse = ReportTemplate[] | { results?: ReportTemplate[] };

function extractTemplates(body: TemplateListResponse): ReportTemplate[] {
  if (Array.isArray(body)) return body;
  return body.results ?? [];
}

function findDefaultTemplate(
  templates: ReportTemplate[],
  reportType: string,
): ReportTemplate | undefined {
  return templates.find(
    (t) => t.is_default === true && t.report_type === reportType,
  );
}

/**
 * Narrow a `DjangoError` to the same discriminator strings that
 * `djangoErrorToToolResult` (see mcp.ts) uses at the tool boundary, so
 * `analyze_error.kind` is meaningful to the same clients. Kept local to
 * avoid a circular import (mcp.ts imports this file via the tool
 * registry) — the kind strings are duplicated by convention, not by
 * runtime sharing.
 */
function djangoErrorKind(err: DjangoError): string {
  if (err instanceof DjangoUnauthorizedError) return "unauthorized";
  if (err instanceof DjangoTimeoutError) return "timeout";
  if (err instanceof DjangoNotFoundError) return "not_found";
  if (err instanceof DjangoBadRequestError) return "bad_request";
  if (err instanceof DjangoResponseParseError) return "response_parse";
  if (err instanceof DjangoHttpError) return "http";
  return "unknown";
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Port of the web UI's `fillInputTemplate` (app/frontend/src/pages/reports/
 * utils/xmlTemplateParser.ts). For each tag in the template, look up
 * `values[tag.replace(/-/g, "_")]`; if a non-empty string is found, replace
 * the tag's inner content with the escaped value. Two passes: self-closing
 * tags first (expanded to open/close form), then tags with default content.
 * Tags without a matching value are left unchanged.
 */
function fillInputTemplate(
  template: string,
  values: Record<string, unknown>,
): string {
  const selfClosingPattern = /<(\w[\w-]*)(\s[^>/]*)?\s*\/>/g;
  let result = template.replace(
    selfClosingPattern,
    (fullMatch, tag: string, attrsStr: string | undefined) => {
      const configKey = tag.replace(/-/g, "_");
      const value = values[configKey];
      if (typeof value === "string" && value.length > 0) {
        const attrs = attrsStr ?? "";
        return `<${tag}${attrs}>${xmlEscape(value)}</${tag}>`;
      }
      return fullMatch;
    },
  );

  const contentTagPattern = /<(\w[\w-]*)(\s[^>/]*)?>([^]*?)<\/\1>/g;
  result = result.replace(
    contentTagPattern,
    (fullMatch, tag: string, attrsStr: string | undefined) => {
      const configKey = tag.replace(/-/g, "_");
      const value = values[configKey];
      if (typeof value === "string" && value.length > 0) {
        const attrs = attrsStr ?? "";
        return `<${tag}${attrs}>${xmlEscape(value)}</${tag}>`;
      }
      return fullMatch;
    },
  );

  return result;
}

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

    // Resolve a sensible default template when the caller doesn't provide
    // config of its own. Without this, `agent_report` (the only type today)
    // 400s on every call because its config model requires
    // `input_template` + `output_template` XML fields the LLM can't
    // reasonably construct.
    //
    // Mirrors the Tako web UI flow: list → find default → GET detail (which
    // carries the assembled XML in `config`) → fill the input XML with the
    // user's research_objective → POST with filled config + template_source.
    //
    // We skip this entirely when the caller provides an explicit `config`:
    // they've made a decision, we don't burn round-trips second-guessing it.
    const shouldResolveTemplate =
      input.config === undefined || Object.keys(input.config).length === 0;

    if (shouldResolveTemplate) {
      const listed = await djangoGet<TemplateListResponse>(
        ctx.env,
        ctx.token,
        "/api/v1/internal/reports/templates/",
        { timeoutMs: 30_000 },
      );
      const defaultTemplate = findDefaultTemplate(
        extractTemplates(listed),
        input.report_type,
      );

      if (
        defaultTemplate?.id !== undefined &&
        defaultTemplate.id !== "" &&
        input.template_source === undefined
      ) {
        // Fetch detail to get the assembled XML — list serializer strips
        // `config`, detail serializer runs `populate_templates_from_components`
        // and returns the XML in `config.input_template` /
        // `config.output_template`.
        const detail = await djangoGet<ReportTemplateDetail>(
          ctx.env,
          ctx.token,
          `/api/v1/internal/reports/templates/${encodeURIComponent(defaultTemplate.id)}/`,
          { timeoutMs: 30_000 },
        );
        const tmplConfig = detail.config ?? {};
        const rawInputTemplate = tmplConfig.input_template ?? "";
        const rawOutputTemplate = tmplConfig.output_template ?? "";
        const substitutions: Record<string, unknown> = {
          research_objective: input.research_objective,
        };
        const filledInput = fillInputTemplate(rawInputTemplate, substitutions);

        body.template_source = defaultTemplate.id;
        const resolvedConfig: Record<string, unknown> = {
          input_template: filledInput,
          output_template: rawOutputTemplate,
          research_objective: input.research_objective,
          audience_details: null,
        };
        if (
          Array.isArray(tmplConfig.target_indexes) &&
          tmplConfig.target_indexes.length > 0
        ) {
          resolvedConfig.target_indexes = tmplConfig.target_indexes;
        }
        body.config = resolvedConfig;
      } else {
        // No default found — fall through to create with just the objective
        // folded in. Django's 400 will surface the real issue (missing seed)
        // rather than us masking it.
        body.config = { research_objective: input.research_objective };
      }
    } else if (input.config !== undefined) {
      body.config = input.config;
    }

    if (input.template_source !== undefined) {
      body.template_source = input.template_source;
    }

    // The tool's input-schema description promises LLMs can retry after a
    // 400 by reading the list of valid `report_type` values from the
    // response body. `DjangoBadRequestError.body` carries that detail,
    // and the MCP adapter (`djangoErrorToToolResult`) splices it into
    // the tool's text content — so just let the error propagate.
    const created = await djangoPost<CreateResponse>(
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
    const reportId = created.report_id ?? created.id;
    if (reportId === undefined || reportId === "") {
      throw new Error(
        "Tako create_report response missing both `report_id` and `id`",
      );
    }

    // Kick off generation. The create call alone leaves the report as a
    // Draft; `analyze` is what transitions it to RUNNING and dispatches
    // the Celery task. Empty body is fine for non-brief report types —
    // backend assembles config from what create already persisted.
    //
    // We catch Django transport errors here instead of propagating: by
    // this point the report already exists as a Draft on the user's
    // account, and the thrown `DjangoError` doesn't carry `report_id`.
    // Letting it bubble up through `djangoErrorToToolResult` would
    // produce a generic "analyze failed" error with no handle the LLM
    // could use to tell the user their draft is waiting for them in the
    // web UI. Returning partial success — `report_id` + a
    // `created_but_not_started` status + the structured `analyze_error`
    // — keeps the draft recoverable. Create failures still throw (above)
    // because there's no record to recover on that path.
    //
    // Scope: only `DjangoError` subtypes are caught. Raw JS exceptions
    // (programmer errors, V8 OOM, etc.) still bubble because they
    // indicate a handler bug, not an upstream partial failure.
    let analyzed: AnalyzeResponse | undefined;
    let analyzeError: z.infer<typeof outputSchema>["analyze_error"] = null;
    try {
      analyzed = await djangoPost<AnalyzeResponse>(
        ctx.env,
        ctx.token,
        `/api/v1/internal/reports/${encodeURIComponent(reportId)}/analyze/`,
        {},
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      if (err instanceof DjangoError) {
        analyzeError = {
          kind: djangoErrorKind(err),
          status: err.status ?? null,
          message: err.message,
        };
      } else {
        throw err;
      }
    }

    return {
      report_id: reportId,
      // Prefer the analyze response's status ("running") so the caller
      // knows generation actually started. On analyze failure, surface
      // `created_but_not_started` — the `status` field's schema doc
      // explains what that means for the LLM.
      status:
        analyzeError !== null
          ? "created_but_not_started"
          : (analyzed?.status ?? created.status ?? null),
      title: created.title ?? null,
      credit_cost: created.credit_cost ?? null,
      estimated_runtime_seconds: created.estimated_runtime_seconds ?? null,
      celery_task_id: analyzed?.celery_task_id ?? null,
      analyze_error: analyzeError,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default create_report;
