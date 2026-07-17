/**
 * `tako_contents` — fetch the downloadable content behind a result URL.
 * Wraps `POST /api/v1/contents`. A Tako card URL resolves to a CSV of the
 * card's data; any other URL resolves to the page's extracted text. One URL
 * per call. `mode` controls delivery: "inline" (default) returns the content
 * in the response body (for a Tako card, only the free 20-row preview unless
 * `max_rows` is raised — up to a 2000-row ceiling — with total_rows/truncated;
 * or web text) so the model can read it directly; "url" returns a short-lived
 * presigned download URL instead. The "inline" default is an intentional
 * MCP-ergonomics divergence from the backend default ("url") — an agent almost
 * always wants to read the data, not hand back a link.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import { ContentsDeliveryMode, ContentsRequest, ContentsResponse } from "../generated/schemas.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Fetch the underlying data behind a result URL — a Tako card URL yields a CSV of the card's data; any other URL yields the page's extracted full text. Pass a single `url` (a TakoCard.webpage_url or a web-result URL). `mode` controls delivery: `inline` (default) returns the content directly in the response so you can read and reason over it — for a Tako card this returns only the free 20-row preview unless you raise `max_rows` (up to 2,000; billed per 1,000 rows beyond the free 20), so always check `total_rows` / `truncated` to know if it's partial; `url` instead returns a short-lived presigned `download_url` (no row cap), for handing the user a download/embed link or for large datasets you don't need to read yourself. Use `inline` when you need the numbers; use `url` when the user just wants the file or the full dataset.";

// Curate the input from the contract explicitly: `.pick` only the fields we
// expose (so a new field added to ContentsRequest in the synced spec does NOT
// silently join the MCP input surface), then re-describe them for the MCP
// surface — including the one documented divergence (default mode → inline)
// and the `max_rows` row cap.
const inputSchema = ContentsRequest.pick({ url: true }).extend({
  // The spec has no minLength on `url`; re-add the prior local .min(1) guard so
  // an empty-string url is rejected at the MCP layer instead of hitting the API.
  url: ContentsRequest.shape.url.min(1),
  mode: ContentsDeliveryMode
    .default("inline")
    .describe('Delivery mode: "inline" (default) returns the content in the response body (for a Tako card, only the free 20-row preview unless you raise max_rows; with total_rows/truncated; or web text) so you can read it directly; "url" returns a short-lived presigned download_url (no row cap).'),
  // Expose the contract's row cap so an agent can pull more than the 20-row free
  // preview inline. parse-don't-cast: reuse the generated shape (carries the
  // .gte(1) guard) and just re-describe it for the MCP surface.
  max_rows: ContentsRequest.shape.max_rows.describe(
    "Inline mode, Tako cards only: max CSV rows to return. Omit for the free 20-row preview (baseline charge only); raise up to the 2,000-row ceiling to export more, billed per 1,000 rows beyond the free 20 (values above 2,000 are clamped). Ignored in url mode (full download) and for web URLs (always full text).",
  ),
});

// NOTE: The generated ContentsResponse wraps items in a nested `contents` array
// and uses `url` for the presigned download URL, while the current tool output
// presents a single flat item with `download_url`. These shapes are incompatible,
// so we keep the hand-written output schema to preserve the shipped API contract
// for MCP consumers. The raw wire is validated against the generated
// ContentsResponse (in the handler) before it is mapped into this flat shape.
const outputSchema = z.object({
  format: z.string(),
  // Presigned download URL + expiry — populated in "url" mode, null in "inline" mode.
  download_url: z.string().nullable(),
  expires_at: z.string().nullable(),
  source_url: z.string(),
  // USD actually charged for this artifact. Web text is metered per page; a
  // Tako-card CSV bills a per-export baseline plus a per-1,000-row rate on rows
  // beyond the free 20-row allowance. Surfaced so the agent can report the cost.
  cost: z.number(),
  // Inline content — populated in "inline" mode (CSV text, up to max_rows / the
  // 20-row free default, or web page text), null in "url" mode. total_rows/truncated describe CSV truncation.
  data: z.string().nullable(),
  total_rows: z.number().nullable(),
  truncated: z.boolean(),
});

type Output = z.infer<typeof outputSchema>;

const takoContents = {
  name: "tako_contents",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Fetch Contents",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx): Promise<Output> {
    // input conforms to the generated ContentsRequest contract (url + mode +
    // optional max_rows). max_rows, when omitted, is absent from `input` and so
    // dropped from the JSON body — the backend then applies its 20-row default.
    const body = input satisfies z.input<typeof ContentsRequest>;
    const raw = await djangoPost<unknown>(
      ctx.env,
      ctx.token,
      "/api/v1/contents/",
      body,
      { timeoutMs: 60_000 },
    );
    // Validate the raw wire response against the generated ContentsResponse so
    // backend drift (renamed fields, restructured contents array) throws here
    // instead of silently mapping to nulls downstream.
    const wireResult = ContentsResponse.safeParse(raw);
    if (!wireResult.success) {
      throw new Error(
        `Tako contents endpoint returned an unexpected wire shape: ${wireResult.error.message}`,
      );
    }
    const wire = wireResult.data;
    const item = wire.contents?.[0];
    if (!item) {
      throw new Error(
        "Tako contents endpoint returned no downloadable content for that URL.",
      );
    }
    // inline mode → backend populates `data` (+ total_rows/truncated) and leaves
    // url/expires_at null; url mode → backend returns a presigned url/expires_at
    // and leaves the inline fields null. Pass both shapes through as-is.
    const parsed = outputSchema.safeParse({
      // Card data carries a content_format (csv/json_*); web text carries null.
      // Preserve the prior flat-contract value ("text" for web) so MCP consumers
      // that key off `format` don't see behavior change from the spec rename.
      format: item.content_format ?? "text",
      download_url: item.url ?? null,
      expires_at: item.expires_at ?? null,
      source_url: item.source_url ?? input.url,
      cost: item.cost ?? 0,
      data: item.data ?? null,
      total_rows: item.total_rows ?? null,
      truncated: item.truncated ?? false,
    });
    if (!parsed.success) {
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
