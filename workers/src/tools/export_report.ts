/**
 * `export_report` — return a short-lived download URL for a completed
 * Tako report in a specific file format (markdown, JSON, PDF, or
 * PowerPoint).
 *
 * Why a download URL instead of inlined file content: ChatGPT's tool-
 * safety wrapper rejects large or binary tool-result payloads, so an
 * inline base64 PDF (or even a 500 KB JSON) was getting blocked
 * before it ever reached the user. A URL-based shape sidesteps that
 * entirely — the LLM surfaces the URL as a markdown link, the user
 * clicks, the Worker streams the file back with `Content-Disposition:
 * attachment`. See `exports.ts` for the token format and the security
 * tradeoffs of embedding the user's API key in the URL.
 *
 * The actual file fetch happens at click time, on the
 * `/exports/:token` Worker route — NOT in this handler. This handler
 * just mints the token. That keeps the tool call fast and avoids
 * burning the Worker's per-request budget on a multi-second PDF
 * render every time the LLM offers an export.
 */
import { z } from "zod";

import { resolveMcpPublicBase } from "../env.js";
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  EXPORT_FORMATS,
  mintExportToken,
} from "../exports.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
  format: z
    .enum(EXPORT_FORMATS)
    .describe(
      "File format to export. Maps to the Tako web Export menu options.",
    ),
});

// http(s) only — this URL is handed to a browser. Defense-in-depth
// even though we build the URL ourselves from a trusted env binding.
const HTTP_URL_REGEX = /^https?:\/\//;

const outputSchema = z.object({
  report_id: z.string(),
  format: z.enum(EXPORT_FORMATS),
  // Short-lived URL the user clicks to download the file. Worker
  // streams it back with `Content-Disposition: attachment`.
  download_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "download_url must be http(s)" }),
  // Unix epoch seconds at which the URL stops working. Surfaced so
  // the LLM can tell the user "click within X minutes" honestly.
  expires_at: z.number().int().positive(),
  expires_in_seconds: z.number().int().positive(),
});

const export_report = {
  name: "export_report",
  description:
    "Use this when the user explicitly asks to export, download, or save a completed Tako report in a specific file format (Markdown, JSON, PDF, or PowerPoint). Returns a short-lived `download_url` (default: 5 minutes) — surface it to the user as a markdown link, e.g. `[Download as PDF](download_url)`, and tell them how long they have to click before it expires (`expires_in_seconds`). The report MUST be `status === \"completed\"`; if the click 404s with \"report not ready,\" call `wait_for_report` first and re-mint a fresh URL. Do NOT call this proactively after `create_report` or `get_report` — only when the user actually asks for an export. If the user just wants to read the report in their browser, share the report's `webpage_url` instead — no export needed.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Export Report",
    readOnlyHint: true,
    destructiveHint: false,
    // The download URL is publicly resolvable for its TTL — set
    // `openWorldHint: true` to flag that a side-effect-free token is
    // entering circulation.
    openWorldHint: true,
  },
  async handler(input, ctx) {
    if (ctx.env.EXPORT_TOKEN_KEY === undefined || ctx.env.EXPORT_TOKEN_KEY === "") {
      throw new Error(
        "export_report is not configured on this deployment (missing EXPORT_TOKEN_KEY). Ask the operator to run `wrangler secret put EXPORT_TOKEN_KEY`.",
      );
    }

    // `resolveMcpPublicBase` falls back to the request's own origin
    // when the env binding is unset — safe in `wrangler dev` and in
    // tests, but production / staging must have `MCP_PUBLIC_BASE_URL`
    // pinned so download URLs never leak `*.workers.dev`. Surfacing
    // the env binding explicitly here would force callers to pass a
    // request through ToolContext, which they currently don't; the
    // env-only path covers the deployed case where it matters.
    const base = resolveMcpPublicBase(ctx.env);

    const { token, expiresAt } = await mintExportToken(
      ctx.token,
      input.report_id,
      input.format,
      ctx.env,
    );

    return {
      report_id: input.report_id,
      format: input.format,
      // Token already URL-safe (base64url), so no extra encoding here.
      download_url: `${base}/exports/${token}`,
      expires_at: expiresAt,
      expires_in_seconds: DEFAULT_TOKEN_TTL_SECONDS,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default export_report;
