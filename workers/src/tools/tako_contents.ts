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
import {
  renderContentsText,
  slimContentsStructured,
  type ContentsBatchLike,
} from "./_render_markdown.js";
import type { ToolContext, ToolModule } from "./types.js";

const DESCRIPTION = [
  "Fetch the real content behind one result URL from tako_search or tako_answer — the rows behind a Tako card, or a web page's full text.",
  "",
  "Best for: getting the full data to compute over or quote after `tako_search` / `tako_answer` — a search result carries only a preview and a chart, not its rows.",
  "",
  "Precondition (Tako cards): non-exportable cards (`exportable: false`, usually license-gated) always 403. Never call this on them; their headline value is in the card's `description` (when present) and specific figures come from `tako_answer` (see the card's `values_hint`). Call only on `exportable: true` cards, and even then a rare card still 403s: fall back, don't retry.",
  "",
  "Web URLs always work — so this is also the fallback path when tako_search / tako_answer surfaced relevant `web_results` but no fitting Tako data card: pass the web result's url here to read its full page text. Looking for one figure or section in a long page (a filing, a report)? Pass `query` to get just the matching passages in ONE call instead of wading through the full text.",
].join("\n");

// Curate the input from the contract explicitly: `.pick` only the fields we
// expose (so a new field added to ContentsRequest in the synced spec does NOT
// silently join the MCP input surface), then re-describe them for the MCP
// surface — including the one documented divergence (default mode → inline),
// the `max_rows` row cap, and the `content_format` serialization.
/** Max URLs per call. The backend takes one URL per request, so a batch
 *  fans out to N subrequests; this bounds both the Workers subrequest budget
 *  and the bill a single call can run up. */
export const MAX_CONTENTS_URLS = 10;

const inputSchema = ContentsRequest.pick({ url: true }).extend({
  urls: z
    .array(ContentsRequest.shape.url.min(1))
    .min(1)
    .max(MAX_CONTENTS_URLS)
    .optional()
    .describe(
      `The result URLs to fetch, 1-${MAX_CONTENTS_URLS} per call (a TakoCard chart URL or a web result url). Batch them: fetching 8 filings in ONE call costs the same as 8 calls but saves 7 round trips, and every extra round trip re-sends the whole conversation as input tokens. Each URL is fetched and BILLED independently; one URL failing does not fail the others (its entry carries an \`error\` instead of a payload).`,
    ),
  // Legacy single-URL form, kept so an in-flight caller pinned to the old
  // schema keeps working. `urls` is the documented shape; exactly one of the
  // two must be present.
  url: ContentsRequest.shape.url
    .min(1)
    .optional()
    .describe("Deprecated single-URL form — use `urls` instead. Equivalent to `urls: [url]`."),
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
  // unreadable for any client), so the HANDLER defaults it DOWN to a
  // context-sized 100k — but only where the text reaches the model:
  //   inline, no query → 100k (billing is per page, so the cap costs nothing)
  //   inline + query   → pinned to the 1M ceiling (passages scan the FULL
  //                      text; a capped scan would turn "term at char 300k"
  //                      into a false "deterministic miss")
  //   url mode         → omitted (nothing reaches the model; the cap would
  //                      truncate the downloaded FILE and, because max_chars
  //                      is part of the backend's S3 cache key, bust every
  //                      previously cached page)
  // Kept .optional() with NO zod default so the handler can tell "caller
  // asked for this cap" from "caller said nothing".
  max_chars: z
    .number()
    .int()
    .gte(1)
    .lte(1_000_000)
    .optional()
    .describe(
      "Web URLs only: character cap on the extracted page text (max 1,000,000 = full text). Inline fetches default to 100,000 — billing is per page regardless, so the cap only trims what reaches you, and `truncated: true` reports a cut. Raise it when you need a full long document inline. In url mode the downloaded file is the full text unless you set this (an explicit value caps the file too). Ignored when `query` is set (passages always scan the full text) and for Tako card URLs (use max_rows).",
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
      'Web URLs + inline mode only: return just the passages around case-insensitive matches of this query (full phrase first, per-word fallback) instead of the full page text — e.g. query="RevPAR" against a hotel earnings page. The FULL page text is always scanned (max_chars is ignored). The `note` field summarizes the matches; a no-match note says so explicitly (deterministic miss — try another url, not another wording). Ignored for Tako card URLs and in url mode.',
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
const itemSchema = z.object({
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

type ContentItemOutput = z.infer<typeof itemSchema>;

// Batch envelope. `results` is positionally aligned with the requested urls,
// so results[i] always describes urls[i] — including the failures, which carry
// `error` in place of a payload rather than being dropped (a compacted array
// would silently re-map every index after the first failure).
const outputSchema = z.object({
  results: z.array(
    itemSchema.extend({
      // Which requested URL this entry is for — the array is positional, but
      // an explicit url survives reordering and truncation downstream.
      url: z.string(),
      // Present INSTEAD of a payload when this URL alone failed. The other
      // entries are unaffected.
      error: z.string().optional(),
    }),
  ),
  // Sum of the per-item costs actually charged across the batch.
  cost: z.number(),
});

type Output = z.infer<typeof outputSchema>;

/** Fetch ONE url. Throws on failure so the caller can decide whether a single
 *  URL's error degrades to an entry or fails the whole batch. */
type Input = z.infer<typeof inputSchema>;

/** One URL's failure, as text the model can act on. Prefers the
 *  self-correcting `modelGuidance` the 403/404 paths attach, so a gated card
 *  inside a batch still explains itself instead of surfacing a bare status. */
function errorText(reason: unknown): string {
  if (reason instanceof DjangoHttpError) {
    if (reason.modelGuidance !== undefined) return reason.modelGuidance;
    const detail = extractErrorDetail(reason.body);
    return `Fetch failed (${reason.status}${detail !== undefined ? `: ${detail}` : ""}).`;
  }
  return reason instanceof Error ? reason.message : String(reason);
}

async function fetchOne(
  url: string,
  input: Input,
  ctx: ToolContext,
): Promise<ContentItemOutput> {
  // `query`/`urls` are MCP-layer knobs, NOT wire fields — strip them or the
  // backend's extra="forbid" 400s the request. The rest conforms to the
  // generated ContentsRequest contract (url + mode + optional max_rows).
  const { query: passageQuery, max_chars: maxCharsAsked, urls: _urls, url: _url, ...rest } = input;
  void _urls;
  void _url;
  const inline = input.mode !== "url";
  // Effective web-text cap (see the max_chars schema comment for the full
  // rationale): query pins the ceiling so passages scan the whole page;
  // plain inline defaults to 100k; url mode sends nothing unless the caller
  // set a cap explicitly — an undefined here both leaves the wire field off
  // and disables the derived-truncation check below.
  const maxChars =
    inline && passageQuery !== undefined
      ? 1_000_000
      : maxCharsAsked ?? (inline ? 100_000 : undefined);
  const body = {
    ...rest,
    url,
    ...(maxChars !== undefined ? { max_chars: maxChars } : {}),
  };
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
  // Derive `truncated` for capped web text: the backend's `truncated` flag
  // is rows-only (never set on the web route), so a page cut at max_chars
  // would otherwise arrive with no truncation signal at all — and the
  // minimal envelope reads absence as "complete". Length AT the cap is
  // treated as cut; the false positive (a page exactly cap-length) is
  // vanishingly rare next to the guaranteed false "complete" on every long
  // page. Web text is identified by a missing content_format (cards always
  // carry one).
  if (
    item.content_format == null &&
    typeof dataText === "string" &&
    maxChars !== undefined &&
    dataText.length >= maxChars
  ) {
    cut = true;
  }
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
  const parsed = itemSchema.safeParse({
    ...(note !== undefined ? { note } : {}),
    ...(dataText !== undefined ? { data: dataText } : {}),
    ...(item.records != null ? { records: item.records } : {}),
    ...(item.dataset != null ? { dataset: item.dataset } : {}),
    ...(item.content_format != null ? { format: item.content_format } : {}),
    ...(item.total_rows != null ? { total_rows: item.total_rows } : {}),
    ...(cut ? { truncated: true } : {}),
    ...(item.url != null ? { download_url: item.url } : {}),
    ...(item.expires_at != null ? { expires_at: item.expires_at } : {}),
    ...(item.source_url != null && item.source_url !== url
      ? { source_url: item.source_url }
      : {}),
    cost: item.cost ?? 0,
  });
  if (!parsed.success) {
    logWireGuardFailure("tako_contents", "output-normalise", parsed.error, raw);
    throw new Error("Tako contents endpoint returned an unexpected shape.");
  }
  return parsed.data;
}

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
    const targets = input.urls ?? (input.url !== undefined ? [input.url] : []);
    if (targets.length === 0) {
      throw new Error(
        "tako_contents needs at least one URL: pass `urls: [\"…\"]` (1-" +
          MAX_CONTENTS_URLS +
          " per call).",
      );
    }
    // Fan out: the backend takes ONE url per request, so a batch is N
    // subrequests issued concurrently. allSettled, not all — one URL's 403
    // (a license-gated card) must not discard the pages that did resolve.
    const settled = await Promise.allSettled(
      targets.map((u) => fetchOne(u, input, ctx)),
    );
    const results = settled.map((s, i) => {
      const url = targets[i] as string;
      if (s.status === "fulfilled") return { ...s.value, url };
      return { url, cost: 0, error: errorText(s.reason) };
    });
    // Every URL failed: there is no partial payload worth returning, so
    // re-throw the first failure. That keeps the single-URL path behaving
    // exactly as before — DjangoHttpError with its self-correcting
    // `modelGuidance` still reaches registerTool's error envelope.
    const firstFailure = settled.find((s) => s.status === "rejected");
    if (firstFailure !== undefined && results.every((r) => r.error !== undefined)) {
      throw (firstFailure as PromiseRejectedResult).reason;
    }
    const parsedBatch = outputSchema.safeParse({
      results,
      cost: results.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    });
    if (!parsedBatch.success) {
      logWireGuardFailure("tako_contents", "output-normalise", parsedBatch.error, results);
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsedBatch.data;
  },
  // The payload (page text / csv / json) reaches the model as plain text —
  // this is where the JSON-escaping tax on 100k-char pages dies — and
  // structuredContent keeps only the metadata. The all-optional outputSchema
  // already validates the slim subset.
  renderText(output, _ctx) {
    void _ctx;
    return renderContentsText(output as unknown as ContentsBatchLike);
  },
  slimStructured(output) {
    return slimContentsStructured(output as unknown as ContentsBatchLike);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
