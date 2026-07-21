/**
 * `tako_contents` — fetch the downloadable content behind a result URL.
 * Wraps `POST /api/v1/contents`. A Tako card URL resolves to the card's data —
 * CSV by default, or JSON via `content_format` (json_records → `records`,
 * json_compact → `dataset`); any other URL resolves to the page's extracted
 * text. Not every card is exportable: the backend's export-safe gate 403s
 * cards without exportable data, so the tool description tells the model to
 * check `content` presence first. That check is necessary, not sufficient —
 * search/answer set `content` via the lenient supports_data_export() while
 * this endpoint gates on the stricter export_safe(), so a content-bearing
 * card can still 403 (the handler maps that to a self-correcting message).
 * One URL per call. A Tako card CSV is capped at a 20-row free default in BOTH modes;
 * `max_rows` raises that up to a 2000-row ceiling — there is no uncapped export.
 * `mode` controls only delivery, not the row count: "inline" (default) returns
 * the (capped) content in the response body — total_rows/truncated report the
 * true size — so the model can read it directly; "url" returns a short-lived
 * presigned download URL to the same capped CSV instead. The "inline" default is
 * an intentional
 * MCP-ergonomics divergence from the backend default ("url") — an agent almost
 * always wants to read the data, not hand back a link.
 */
import { z } from "zod";

import { DjangoHttpError, DjangoNotFoundError, djangoPost, extractErrorDetail } from "../django.js";
import { ContentsDeliveryMode, ContentsRequest, ContentsResponse, TakoDataset } from "../generated/schemas.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Fetch the real content behind one result URL from tako_search or tako_answer — the rows behind a Tako card, or a web page's full text.",
  "",
  "Best for: getting the full data to compute over or quote after `tako_search` / `tako_answer` — a search result carries only a preview and a chart, not its rows.",
  "",
  "Precondition (Tako cards): a card is exportable only if its result carried a `content` attribute (non-null). If `content` is missing or null this call fails — use the card's preview/chart instead. Presence is necessary but not sufficient: a rare card still 403s, so fall back, don't retry. Web URLs always work.",
].join("\n");

// Curate the input from the contract explicitly: `.pick` only the fields we
// expose (so a new field added to ContentsRequest in the synced spec does NOT
// silently join the MCP input surface), then re-describe them for the MCP
// surface — including the one documented divergence (default mode → inline),
// the `max_rows` row cap, and the `content_format` serialization.
const inputSchema = ContentsRequest.pick({ url: true }).extend({
  // The spec has no minLength on `url`; re-add the prior local .min(1) guard so
  // an empty-string url is rejected at the MCP layer instead of hitting the API.
  url: ContentsRequest.shape.url.min(1),
  mode: ContentsDeliveryMode
    .default("inline")
    .describe('Delivery only — does NOT change the row cap: "inline" (default) returns the content in the response body (a Tako card — 20-row default, raise max_rows up to 2,000; total_rows/truncated report truncation — or web text) so you can read it directly; "url" returns a short-lived presigned download_url to the same capped file.'),
  // Serialization of a Tako card's data. parse-don't-cast: reuse the generated
  // shape (keeps the enum + "csv" default) and re-describe for the MCP surface.
  // Which output field carries the payload depends on this: csv→data,
  // json_records→records, json_compact→dataset (see outputSchema/handler).
  content_format: ContentsRequest.shape.content_format.describe(
    "Tako cards only — serialization of the returned data: \"csv\" (default, returned as text in `data`), \"json_records\" (array of row objects in `records`), or \"json_compact\" (compact columns+rows TakoDataset in `dataset`). Ignored for web URLs (always text in `data`).",
  ),
  // Expose the row cap so an agent can pull more than the 20-row default.
  // Applies in BOTH delivery modes (url mode is capped too — there is no
  // uncapped export). Bound it to the backend's 2,000-row ceiling here so the
  // cap is explicit in the discovery card and over-asks fail fast at the MCP
  // layer instead of being silently clamped server-side.
  max_rows: z
    .number()
    .int()
    .gte(1)
    .lte(2000)
    .optional()
    .describe(
      "Tako cards only: max CSV rows to return, in either delivery mode. Omit for the free 20-row default (baseline charge only); raise up to 2,000 to export more, billed per 1,000 rows beyond the free 20. Ignored for web URLs (always full text).",
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
  // Inline payload — populated in "inline" mode, null in "url" mode. Exactly one
  // of data / records / dataset is populated per call, selected by content_format:
  //   csv          → `data`    (CSV text, or web page text — the only web shape)
  //   json_records → `records` (one object per row)
  //   json_compact → `dataset` (compact columns+rows TakoDataset)
  // total_rows/truncated describe the row cap (up to max_rows / the 20-row default).
  data: z.string().nullable(),
  // json_records payload: rows as objects. Null unless content_format=json_records.
  records: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .nullable(),
  // json_compact payload: TakoDataset (columns + positional rows). Null unless
  // content_format=json_compact. Reuses the generated schema (parse-don't-cast).
  dataset: TakoDataset.nullable(),
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
    let raw: unknown;
    try {
      raw = await djangoPost<unknown>(
        ctx.env,
        ctx.token,
        "/api/v1/contents/",
        body,
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      // Map the two "this URL has no exportable content" statuses to
      // self-correcting messages so the model stops retrying and falls back
      // to the card's preview/metadata. Per the OpenAPI contract: 403 is the
      // export-safe gate (e.g. protected-source export); 404 is "does not
      // exist or has no exportable data". Both are framed as the LIKELY
      // cause — not asserted fact — since 403 in particular can have other
      // causes (cf. _graph.ts, where a 403 on /beta/graph is an edge block,
      // not a query problem). The backend's detail is spliced in only when
      // extractErrorDetail recognises a structured envelope — a raw slice
      // would flood the model text with an edge/WAF HTML block page.
      //
      // Note the 403 message does NOT claim the card lacked a `content`
      // attribute: the search/answer adapter sets `content` via the lenient
      // supports_data_export(), while this endpoint gates on the stricter
      // export_safe() — so the card that lands here may well have carried
      // one (presence is necessary for export, not sufficient).
      if (err instanceof DjangoHttpError && err.status === 403) {
        const detail = extractErrorDetail(err.body);
        throw new Error(
          `The contents endpoint refused this export (403${detail !== undefined ? `: ${detail}` : ""}). For a Tako card this usually means the export gate rejected it as unexportable — possible even when the card carried a \`content\` attribute (the export descriptor), since presence is required for export but does not guarantee it. Don't retry or rephrase; use the card's title, inline preview, and chart instead. Never call tako_contents on a card whose \`content\` attribute is missing or null.`,
        );
      }
      if (err instanceof DjangoNotFoundError) {
        const detail = extractErrorDetail(err.body);
        throw new Error(
          `The contents endpoint found nothing downloadable at that URL (404${detail !== undefined ? `: ${detail}` : ""}). The resource may not exist or has no exportable data. Check the URL came from a search/answer result verbatim; for a Tako card, only ones whose result carried a \`content\` attribute (non-null) are exportable.`,
        );
      }
      throw err;
    }
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
      // Exactly one of these is populated per call (per content_format); the
      // other two stay null. Pass each through as-is.
      data: item.data ?? null,
      records: item.records ?? null,
      dataset: item.dataset ?? null,
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
