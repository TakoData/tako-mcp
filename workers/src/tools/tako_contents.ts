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
import { logWireGuardFailure } from "./_log.js";
import { extractPassages } from "./_passages.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Fetch the real content behind one result URL from tako_search or tako_answer — the rows behind a Tako card, or a web page's full text.",
  "",
  "Best for: getting the full data to compute over or quote after `tako_search` / `tako_answer` — a search result carries only a preview and a chart, not its rows.",
  "",
  "Precondition (Tako cards): license-gated cards (`exportable: false`) always 403. Never call this on them; their headline value is in the card's `description` and specific figures come from `tako_answer` (see the card's `values_hint`). Call only on `exportable: true` cards, and even then a rare card still 403s: fall back, don't retry.",
  "",
  "Web URLs always work — so this is also the fallback path when tako_search / tako_answer surfaced relevant `web_results` but no fitting Tako data card: pass the web result's url here to read its full page text. Looking for one figure or section in a long page (a filing, a report)? Pass `query` to get just the matching passages in ONE call instead of wading through the full text.",
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
      "Tako cards only: max CSV rows to return, in either delivery mode. Omit for the free 20-row default (baseline charge only); raise up to 2,000 to export more, billed per 1,000 rows beyond the free 20. Ignored for web URLs (use max_chars).",
    ),
  // Web-text character cap, passed through to the wire. The backend default is
  // the FULL page text (up to 1M chars ≈ 250k tokens — observed in the wild and
  // unreadable for any client), so the MCP defaults it DOWN to a context-sized
  // cap instead. Billing is per page regardless of the cap, so the default
  // costs nothing; `truncated` reports any cut.
  max_chars: z
    .number()
    .int()
    .gte(1)
    .lte(1_000_000)
    .default(100_000)
    .describe(
      "Web URLs only: character cap on the extracted page text (default 100,000; max 1,000,000 = full text). Billing is per page regardless, so the cap only trims what reaches you — `truncated: true` reports a cut. Raise it when you need a full long document, or pass `query` to pull just the matching passages instead. Ignored for Tako card URLs (use max_rows).",
    ),
  // MCP-layer feature, deliberately NOT part of the wire body (the handler
  // strips it): the worker fetches the page text and slices out the passages
  // around matches, so a long-document fetch is one wave, not
  // fetch → cover-page → refetch.
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Web URLs + inline mode only: return just the passages around case-insensitive matches of this query (full phrase first, per-word fallback) instead of the full page text — e.g. query="RevPAR" against a hotel earnings page. The `note` field summarizes the matches; a no-match note says so explicitly (deterministic miss — try another url, not another wording). Ignored for Tako card URLs and in url mode.',
    ),
});

// NOTE: The generated ContentsResponse wraps items in a nested `contents` array
// and uses `url` for the presigned download URL, while the current tool output
// presents a single flat item with `download_url`. These shapes are incompatible,
// so we keep the hand-written output schema to preserve the shipped API contract
// for MCP consumers. The raw wire is validated against the generated
// ContentsResponse (in the handler) before it is mapped into this flat shape.
// Minimal-envelope output: every field is omitted when it carries nothing —
// a web-page fetch is essentially {data, cost}, matching how a model actually
// reads it, instead of ten fields of nulls around one payload.
const outputSchema = z.object({
  // Passage-extraction summary (present only when `query` was used): match
  // count + how to get the full text. Kept OUT of `data` so `data` is pure
  // page text.
  note: z.string().optional(),
  // The payload — exactly one channel is present per inline call:
  //   web page text or card csv → `data`
  //   json_records             → `records` (one object per row)
  //   json_compact             → `dataset` (compact columns+rows TakoDataset)
  // All absent in "url" mode (the payload is behind download_url instead).
  data: z.string().optional(),
  records: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .optional(),
  // Reuses the generated schema (parse-don't-cast).
  dataset: TakoDataset.optional(),
  // Tako cards only: the serialization of the payload (csv / json_records /
  // json_compact). Absent for web page text.
  format: z.string().optional(),
  // Tako cards only: the TRUE row count behind the returned window.
  total_rows: z.number().optional(),
  // Present (true) only when part of the content was cut — by the row cap,
  // max_chars, or passage extraction. Absent means complete.
  truncated: z.boolean().optional(),
  // "url" mode only: presigned download link + expiry.
  download_url: z.string().optional(),
  expires_at: z.string().optional(),
  // Present only when the fetched URL differs from the requested one (redirect).
  source_url: z.string().optional(),
  // USD actually charged for this artifact. Web text is metered per page; a
  // Tako-card CSV bills a per-export baseline plus a per-1,000-row rate on rows
  // beyond the free 20-row allowance. Surfaced so the agent can report the cost.
  cost: z.number(),
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
  annotationsByClient: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction — retrieval is
    // closed-world there. See `annotationsByClient` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  async handler(input, ctx): Promise<Output> {
    // `query` is an MCP-layer knob (passage extraction below), NOT a wire
    // field — strip it or the backend's extra="forbid" 400s the request. The
    // rest conforms to the generated ContentsRequest contract (url + mode +
    // optional max_rows); max_rows, when omitted, is absent from `input` and so
    // dropped from the JSON body — the backend then applies its 20-row default.
    const { query: passageQuery, ...body } = input;
    void (body satisfies z.input<typeof ContentsRequest>);
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
      // Attach a self-correcting message via `modelGuidance` and re-throw the
      // ORIGINAL DjangoError (rather than a plain Error). registerTool then
      // routes it through djangoErrorToToolResult, so contents 403/404 keep the
      // same `_meta["tako/error"]` envelope (kind/status/body) every other tool
      // emits, while the model still sees the guidance in the text channel.
      // The guidance already splices the recognised backend detail, so
      // djangoErrorToToolResult uses it verbatim (no second splice).
      if (err instanceof DjangoHttpError && err.status === 403) {
        const detail = extractErrorDetail(err.body);
        err.modelGuidance = `The contents endpoint refused this export (403${detail !== undefined ? `: ${detail}` : ""}). For a Tako card this usually means the export gate rejected it as unexportable — possible even for an \`exportable: true\` card, since that flag is necessary for export but does not guarantee it. Don't retry or rephrase; use the card's title, inline preview, and chart instead. Never call tako_contents on a card whose result had \`exportable: false\` (equivalently, a missing or null \`content\` attribute).`;
        throw err;
      }
      if (err instanceof DjangoNotFoundError) {
        const detail = extractErrorDetail(err.body);
        err.modelGuidance = `The contents endpoint found nothing downloadable at that URL (404${detail !== undefined ? `: ${detail}` : ""}). The resource may not exist or has no exportable data. Check the URL came from a search/answer result verbatim; for a Tako card, only ones whose result had \`exportable: true\` (a non-null \`content\` attribute) are exportable.`;
        throw err;
      }
      throw err;
    }
    // Validate the raw wire response against the generated ContentsResponse so
    // backend drift (renamed fields, restructured contents array) throws here
    // instead of silently mapping to nulls downstream.
    const wireResult = ContentsResponse.safeParse(raw);
    if (!wireResult.success) {
      // Zod detail goes to the server log only — the raw issue dump is
      // upstream-echoed content and noise for the model (Safety Rules).
      logWireGuardFailure("tako_contents", "ContentsResponse", wireResult.error, raw);
      throw new Error(
        "Tako contents endpoint returned an unexpected wire shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    const wire = wireResult.data;
    const item = wire.contents?.[0];
    if (!item) {
      logWireGuardFailure("tako_contents", "empty-contents", undefined, raw);
      throw new Error(
        "Tako contents endpoint returned no downloadable content for that URL.",
      );
    }
    // Passage extraction (web text + inline mode only): replace the full page
    // text with the windows around the query's matches, and surface the match
    // summary as `note`. Card payloads (content_format "csv"/"json_*") and
    // url-mode responses (no inline data) pass through untouched. Billing is
    // unchanged — the full text was fetched; this only slims what reaches the
    // model. Web text is identified by a MISSING content_format (cards always
    // carry one).
    let dataText = item.data ?? undefined;
    let note: string | undefined;
    let cut = item.truncated ?? false;
    if (
      passageQuery !== undefined &&
      item.content_format == null &&
      typeof dataText === "string"
    ) {
      const extracted = extractPassages(dataText, passageQuery);
      dataText = extracted.data;
      note = extracted.note;
      cut = cut || extracted.truncated;
    }
    // Minimal envelope: include a field only when it carries something. Key
    // order is payload-first (note explains data, so it leads), metadata last —
    // truncating clients then lose the trailing chrome, never the content. A
    // web fetch is {data, cost}; url mode is {download_url, expires_at, cost};
    // source_url only rides when the fetch was redirected off the requested url.
    const parsed = outputSchema.safeParse({
      ...(note !== undefined ? { note } : {}),
      ...(dataText !== undefined ? { data: dataText } : {}),
      ...(item.records != null ? { records: item.records } : {}),
      ...(item.dataset != null ? { dataset: item.dataset } : {}),
      ...(item.content_format != null ? { format: item.content_format } : {}),
      ...(item.total_rows != null ? { total_rows: item.total_rows } : {}),
      ...(cut ? { truncated: true } : {}),
      ...(item.url != null ? { download_url: item.url } : {}),
      ...(item.expires_at != null ? { expires_at: item.expires_at } : {}),
      ...(item.source_url != null && item.source_url !== input.url
        ? { source_url: item.source_url }
        : {}),
      cost: item.cost ?? 0,
    });
    if (!parsed.success) {
      logWireGuardFailure("tako_contents", "output-normalise", parsed.error, raw);
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
