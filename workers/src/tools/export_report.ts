/**
 * `export_report` — fetch a completed Tako report's export file in a
 * specific format (markdown, JSON, PDF, or PowerPoint) and return its
 * contents through the Worker.
 *
 * Wraps `GET /api/v1/internal/reports/{report_id}/export/{slug}/`. The
 * web Export menu (Markdown / JSON / PDF / PowerPoint) hits the same
 * endpoint per format. The slug for each format mirrors the file
 * extension (markdown → `markdown`, powerpoint → `pptx`) — confirmed
 * via the staging web UI's network panel for `pdf` and `json`;
 * `markdown` and `pptx` follow the same convention and are flagged at
 * call time if a slug ever 404s.
 *
 * Why proxy through the Worker instead of returning a URL the LLM
 * surfaces as a link: the export endpoint requires Tako auth (X-API-Key
 * for the MCP path; session cookies for the web app). A bare URL handed
 * to the user would 401 unless they happen to be on a logged-in tako.com
 * tab. Proxying lets the MCP layer reuse the user's bearer token and
 * deliver the bytes inline.
 *
 * Return shape:
 *   - Text formats (markdown, json) → `content` carries the decoded
 *     string. The LLM can quote / paste it directly into chat.
 *   - Binary formats (pdf, pptx) → `content_base64` carries the file as
 *     base64 with `content_type` and `byte_size` populated. Chat
 *     clients vary in how they surface base64 file blobs; the LLM
 *     should describe the export and re-share the report's
 *     `webpage_url` so the user can also download from the Tako UI.
 *
 * Hard cap on file size (`MAX_EXPORT_BYTES`) so a runaway report
 * doesn't blow Worker memory or response-size limits — typical agent
 * reports run small (tens to a few hundred KB), but an unusually long
 * report with embedded charts could push past the cap; surface a clear
 * error in that case rather than streaming an unbounded blob.
 */
import { z } from "zod";

import type { ToolModule } from "./types.js";

// Format → URL slug. Mirrors the Django export endpoint's path segment.
// `pdf` and `json` are confirmed against the staging web UI's network
// panel; `markdown` and `pptx` are conventional and use the file
// extension as the slug. If a future backend version uses different
// slugs (e.g. `powerpoint` instead of `pptx`), update this map and the
// description.
const FORMAT_SLUG: Record<ExportFormat, string> = {
  markdown: "markdown",
  json: "json",
  pdf: "pdf",
  powerpoint: "pptx",
};

type ExportFormat = "markdown" | "json" | "pdf" | "powerpoint";

const FORMAT_VALUES = ["markdown", "json", "pdf", "powerpoint"] as const;

// Formats whose response body is text we can decode and ship inline.
// Every other format is treated as binary and base64-encoded.
const TEXT_FORMATS: ReadonlySet<ExportFormat> = new Set(["markdown", "json"]);

// Hard cap on export size. A typical agent report's PDF runs ~100–500
// KB; PPTX a bit larger. 4 MiB is generous headroom, well below
// Workers' practical response-size limit while still small enough that
// base64-encoding inline doesn't dominate the tool result. Reports
// above the cap should be downloaded from the Tako web UI directly —
// the error message points the user there.
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

// Cap on how much of the upstream error body we surface in the thrown
// message. Django DRF errors are typically a few hundred bytes; we
// truncate any pathological case so log lines stay greppable.
const ERROR_BODY_MAX_CHARS = 500;

// Per-call timeout. Export rendering is heavier than a status read
// (PDF/PPTX go through a real renderer); 60 s leaves margin under the
// MCP SDK's default 60 s tool-call timeout once the round-trip from
// the host to the Worker is accounted for.
const EXPORT_TIMEOUT_MS = 60_000;

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
  format: z
    .enum(FORMAT_VALUES)
    .describe(
      "File format to export. `markdown` and `json` come back as text in `content`; `pdf` and `powerpoint` come back as base64 in `content_base64`. Maps to the Tako web Export menu options.",
    ),
});

const outputSchema = z.object({
  report_id: z.string(),
  format: z.enum(FORMAT_VALUES),
  // Upstream content-type, e.g. `application/pdf`,
  // `text/markdown; charset=utf-8`. Echoed straight from Django so
  // clients can branch on it without re-deriving from the format.
  content_type: z.string().nullable(),
  byte_size: z.number().int().nonnegative(),
  // Populated for text formats (markdown, json). Null for binary.
  content: z.string().nullable(),
  // Populated for binary formats (pdf, powerpoint) as base64. Null for text.
  content_base64: z.string().nullable(),
});

const export_report = {
  name: "export_report",
  description:
    "Use this when the user explicitly asks to export, download, or save a completed Tako report in a specific file format (Markdown, JSON, PDF, or PowerPoint). The report MUST be `status === \"completed\"` — if it isn't, this tool will return an error; call `wait_for_report` first. **Returning the file:** for `markdown` and `json`, the `content` field has the text — surface it to the user (paste markdown into your reply or summarize JSON). For `pdf` and `powerpoint`, `content_base64` carries the file (with `byte_size` and `content_type`); since chat clients don't reliably render binary downloads inline, tell the user the file size + format and ALSO share the report's `webpage_url` so they can download from the Tako web UI's Export menu. Do NOT call this proactively after `create_report` or `get_report` — only when the user asks for an export. If the user just wants to read the report, share `webpage_url` instead — no export needed.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Export Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const base = ctx.env.DJANGO_BASE_URL;
    if (base === undefined || base === "") {
      throw new Error(
        "DJANGO_BASE_URL is not configured (empty or undefined binding)",
      );
    }
    if (base.endsWith("/")) {
      throw new Error(
        `DJANGO_BASE_URL must not end with a trailing slash (got \`${base}\`)`,
      );
    }

    const slug = FORMAT_SLUG[input.format];
    const path = `/api/v1/internal/reports/${encodeURIComponent(input.report_id)}/export/${slug}/`;
    const url = `${base}${path}`;

    // Build a `Request` object explicitly (rather than passing a URL
    // string + init to `fetch`) so test helpers that recover the
    // outgoing request via `request_instanceof_Request` continue to
    // work. Mirrors the pattern in `django.ts::executeRequest`.
    const request = new Request(url, {
      method: "GET",
      headers: { "X-API-Key": ctx.token },
    });

    let response: Response;
    try {
      response = await fetch(request, {
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Export endpoint timed out after ${EXPORT_TIMEOUT_MS}ms (GET ${path}). The renderer may be backed up; try again in a minute.`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const body = await safeReadText(response);
      // 404 on the export path almost always means the report isn't
      // completed yet (or the format slug is wrong). Surface the hint
      // about wait_for_report so the LLM doesn't keep retrying
      // export_report on a still-running report.
      if (response.status === 404) {
        throw new Error(
          `Export endpoint returned 404 for ${path}. The report may not be completed yet — call wait_for_report first — or the format slug "${slug}" may not be supported by the backend. Upstream body: ${body || "(empty)"}`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Export endpoint returned ${response.status} for ${path}. The token doesn't have access to this report. Upstream body: ${body || "(empty)"}`,
        );
      }
      throw new Error(
        `Export endpoint returned ${response.status} for ${path}: ${body || "(empty body)"}`,
      );
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_EXPORT_BYTES) {
      throw new Error(
        `Export file is ${buffer.byteLength} bytes, exceeds the ${MAX_EXPORT_BYTES}-byte cap. Download from the Tako web UI directly via the report's webpage_url.`,
      );
    }

    const contentType = response.headers.get("content-type");
    const isText = TEXT_FORMATS.has(input.format);
    const content = isText ? new TextDecoder().decode(buffer) : null;
    // `Buffer` is available because `nodejs_compat` is enabled in
    // wrangler.jsonc. Avoids the `String.fromCharCode(...spread)` pattern
    // which can blow the call stack on multi-megabyte inputs.
    const contentBase64 = isText
      ? null
      : Buffer.from(buffer).toString("base64");

    return {
      report_id: input.report_id,
      format: input.format,
      content_type: contentType,
      byte_size: buffer.byteLength,
      content,
      content_base64: contentBase64,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return false;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length <= ERROR_BODY_MAX_CHARS
      ? text
      : `${text.slice(0, ERROR_BODY_MAX_CHARS)}...[truncated]`;
  } catch {
    return "";
  }
}

export default export_report;
