/**
 * `tako_contents` — fetch what is behind a result url in full: a web page's
 * extracted text, or an exportable Tako card's data rows. Wraps
 * `POST /api/v1/contents`, one subrequest per url, fanned out concurrently;
 * each url is billed independently and one url's failure never fails the rest.
 *
 * Both result channels carry the whole payload (spec:
 * 2026-08-26-model-facing-surface-redesign, D3). The projection and the
 * advertised shape live in `_contents.ts`, the text rendering in
 * `_render_markdown.ts`; the note there records what the old
 * payload-in-structured-only split cost on the hosts that read `content`.
 *
 * Delivery and serialization are no longer the caller's decision. `mode` and
 * `content_format` are gone from the input surface: every call is `inline`
 * (the MCP-ergonomics divergence from the backend's `url` default — an agent
 * wants to read the data, and a 5-minute presigned S3 link is 1,560 chars a
 * model cannot use) and every card comes back as `json_compact`, projected to
 * one `rows` shape. That is why `data`, `records`, `dataset` and `format` are
 * gone from the output too.
 *
 * A Tako card export returns the WHOLE card by default, up to the backend's
 * 2,000-row ceiling; `max_rows` caps it lower. Every row delivered bills per
 * 1,000 — tako#29572 (2026-08-21) removed the row allowance, so no copy here
 * may describe a row as costless. An inline card preview inside a SEARCH
 * response is a different, much smaller cap (`INLINE_PREVIEW_ROW_CAP` in
 * `_search_results.ts`); conflating the two is where a stale 20-row claim here
 * came from.
 *
 * Not every card is exportable. The backend's export gate 403s cards
 * without exportable data, and it is STRICTER than the `exportable` flag
 * search sets (`supports_data_export()` vs `export_safe()`), so an
 * `exportable: true` card can still refuse — which is why the description
 * tells the model to read the headline rather than retry.
 */
import { z } from "zod";

import { DjangoError, DjangoHttpError, DjangoNotFoundError, djangoPost, extractErrorDetail } from "../django.js";
import { ContentsRequest, ContentsResponse } from "../generated/schemas.js";
import {
  contentsOutputShape,
  contentsUsage,
  projectContentsItem,
  type ContentsOutput,
  type ProjectedContentsItem,
} from "./_contents.js";
import { looseArray } from "./_loose_array.js";
import { logWireGuardFailure } from "./_log.js";
import { renderContentsText } from "./_render_markdown.js";
import type { ToolContext, ToolModule } from "./types.js";

/** Max urls per call. The backend takes one url per request, so a batch fans
 *  out to N subrequests; this bounds both the Workers subrequest budget and
 *  the bill a single call can run up. */
export const MAX_CONTENTS_URLS = 10;

/**
 * Per-call ceiling on TOTAL default (caller did not set `max_chars`) web-text
 * characters across a batch, divided evenly across the urls being fetched.
 *
 * Single-url calls are unaffected: `Math.min(100_000, floor(250_000 / 1))` is
 * still 100_000, the existing default. The problem is purely a batch one —
 * the 100_000-per-url default exists because the backend's own default (the
 * full page, up to 1,000,000 chars / ~250k tokens) was observed in the wild
 * and unreadable for any client, but that guard was written before batching:
 * at `MAX_CONTENTS_URLS` (10), ten pages defaulting to 100k each rebuilds the
 * exact ~250k-token blowup the 100k default prevents, spread across urls.
 * Dividing a fixed total across the batch keeps that ceiling meaningful
 * however many urls a call fans out to.
 *
 * ⚠️ Judgment call: 250_000 is a picked starting number, not a measured one,
 * chosen to hold the total roughly FLAT against the single-url default rather
 * than scale it up. A 10-url batch lands at 25k chars/page (~6k tokens) —
 * plenty for a news page, tight for a dense filing, which is exactly the case
 * where a caller should fetch that url alone, set `query` (passages bypass
 * this split entirely — see `fetchOne`), or set `max_chars` explicitly.
 *
 * It did NOT move when both channels started carrying the payload, and the
 * reasoning matters to whoever revisits it: duplication doubles WIRE bytes,
 * not model context — 14 of the 17 harnesses in the consensus audit feed the
 * model exactly one channel, so chars-per-url in context are unchanged for
 * them. Only Hermes, Cline and Eve read both, and they pay 2× on every field
 * of every tool. Halving this to protect three hosts would thin every other
 * host's batch fetch to 12.5k chars/page.
 *
 * `fetchOne` logs (`console.warn`, grep "batch max_chars cap bit") whenever
 * this DERIVED cap actually cuts a page — the signal for whether 250_000
 * needs to move, rather than waiting for someone to notice a truncated batch.
 *
 * It bounds only the SILENT DEFAULT: a caller that sets `max_chars` keeps that
 * value as-is, multiplied by however many urls they batch. An explicit ask is
 * the caller's informed choice, not a default any url count should override.
 */
export const BATCH_CHAR_BUDGET = 250_000;

// No mention of `include_contents` here, and it cannot be reintroduced: no tool
// on either of this tool's surfaces accepts it. D4 removed it from
// `tako_search`, and the one tool that still takes it
// (`tako_search_advanced`) is opt-in, which `phantom_tool.test.ts` forbids a
// default-listed tool from naming. After D4 a search result carries no rows on
// any reachable path, which is exactly why this tool exists.
//
// NO "needs a signed-in connection" line. `FREE_TIER_TOOL_NAMES`
// (`_surface.ts`) holds `tako_search` alone, so four of the five default tools
// are auth-gated at dispatch and a sentence here would read as a property that
// distinguishes this one. The dispatch gate states it where it applies
// (`GENERIC_SIGN_IN_HINT`), and a search that found no card already branches on
// reachability before naming this tool (`_search_results.ts`). #274 deleted the
// mirror claim — "`tako_available_data` is free" — from the instructions for
// the same reason: the credit-and-auth axis is not what a model routes on.
//
// NO recovery for a locked card either, beyond the precondition. "Read the
// headline from the card's `description`" is what the 403 `modelGuidance`
// below says, and D3 puts license-gated recovery in the result, once, where
// the model reads it at the moment it applies. The description carries the
// precondition; the guidance carries what to do when the precondition held and
// the export gate refused anyway.
//
// NO routing sentence for "search returned web results but no card". It reads
// as a condition ON fetching a web result, and the condition is false — you
// fetch a page whenever you need its text, card or no card. `instructions.ts`
// owns tool routing, and `_search_results.ts`'s zero-card guidance already
// names this tool only when the connection can actually call it.
const DESCRIPTION = [
  `Fetch the full content behind a url: a web page's text, or an exportable Tako card's data rows. Batch up to ${MAX_CONTENTS_URLS} urls in one call — each one is billed and fails on its own.`,
  "",
  "Fetch only cards that `tako_search` marked `exportable: true`. Rows bill per 1,000 delivered, so set `max_rows` when the recent rows are enough. If a page is long, such as a filing or an annual report, set `query` to get back only the passages that match.",
  "",
  // `Best for:` last, the shape the other four default tools use (AGENTS.md's
  // tool-description rule; compare `tako_search`).
  "Best for: reading one source in full — a page you need to quote, or the rows behind a card you need to compute over.",
].join("\n");

const inputSchema = z.object({
  // looseArray: a host that sends one url as a bare string, or the array as
  // JSON text, gets it coerced instead of a -32602. Deliberately NOT
  // `commaSeparated`: the item schema has no url format check, so splitting
  // 'https://en.wikipedia.org/wiki/Washington,_D.C.' would pass validation as
  // two urls and bill two fetches for the wrong pages. See _loose_array.ts.
  //
  // REQUIRED, which it could not be while the deprecated single-url `url`
  // field existed — that field is why the handler used to carry a runtime
  // "at least one url" guard the schema should have owned. Dropping it moved
  // the check back into the schema: a caller that sends the old shape reads
  // one validation error naming `urls` and retries on the same turn, which is
  // what makes removing an alias safe on a hosted server whose clients are
  // models rather than compiled code.
  //
  // The item is a plain `z.string()`, NOT `ContentsRequest.shape.url`. That
  // generated schema carries a 150-char description asserting "A Tako card URL
  // yields a CSV of the card's data" — false since this tool started requesting
  // `json_compact`, and it publishes into the input schema (and from there into
  // `registry/server.json` and `docs/TOOLS.md`) where `flattenParameters` never
  // shows it, so no prose budget catches it. Fixing it upstream is the tako
  // repo's schema builder; not inheriting it is this file's call. Nothing is
  // lost as a contract link: `buildContentsBody`'s
  // `satisfies z.input<typeof ContentsRequest>` is what breaks on a renamed or
  // retyped `url`, and it covers the whole body rather than one field.
  urls: looseArray(
    z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_CONTENTS_URLS)
      .describe(
        // The count and the cap live in the schema (`min`/`max` above) and the
        // batch instruction lives in the description. What only this line can
        // say is why batching pays.
        "The urls to fetch: a Tako card url or a web result url. One call for 8 urls costs the same as 8 separate calls and saves 7 round trips.",
      ),
    { field: "tako_contents.urls" },
  ),
  // Bounded to the backend's 2,000-row ceiling here so the cap is explicit in
  // the discovery card and an over-ask fails fast at the MCP layer instead of
  // being silently clamped server-side. The default is NOT 20: omitting it
  // returns the whole card up to that ceiling.
  max_rows: z
    .number()
    .int()
    .gte(1)
    .lte(2000)
    .optional()
    .describe(
      "Tako cards only: how many rows to return. Omit it for the whole card, up to 2,000 rows. Every row delivered is billed, so lower it when the recent rows are enough.",
    ),
  // Kept `.optional()` with NO zod default so `fetchOne` can tell "caller asked
  // for this cap" from "caller said nothing" — only the second is split across
  // a batch, and only the second is pinned to the ceiling when `query` is set.
  max_chars: z
    .number()
    .int()
    .gte(1)
    .lte(1_000_000)
    .optional()
    .describe(
      "Web pages only: character cap on the extracted text. Inline fetches default to 100,000 per url, less across a batch. Raise it for a long document; `truncated` reports a cut.",
    ),
  // An MCP-layer feature, deliberately NOT a wire field (`fetchOne` strips it):
  // the Worker fetches the page text and slices out the passages around the
  // matches, so a long-document read is one wave, not
  // fetch → cover page → refetch.
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Web pages only: return the passages around matches of this phrase instead of the whole page. The full page is always scanned, so no match means the phrase isn't there.",
    ),
});

type Input = z.infer<typeof inputSchema>;

/** One url's failure, as text the model can act on. Prefers the
 *  self-correcting `modelGuidance` any DjangoError path attaches (403/404
 *  today), so a gated card inside a batch still explains itself instead of
 *  surfacing a bare status. Gated on `DjangoError` — the base class every
 *  transport error extends — not `DjangoHttpError`, one of several SIBLING
 *  subclasses (DjangoNotFoundError, DjangoUnauthorizedError,
 *  DjangoBadRequestError, DjangoTimeoutError, DjangoResponseParseError; see
 *  django.ts). Gating on the subclass silently dropped 404's modelGuidance
 *  and, for the rest, leaked `Django returned <status> for POST
 *  /api/v1/contents/` (the internal path) into model-visible text. `body`
 *  lives on most but not all subclasses (DjangoTimeoutError and
 *  DjangoResponseParseError carry no response body), hence the guard. */
function errorText(reason: unknown): string {
  if (reason instanceof DjangoError) {
    if (reason.modelGuidance !== undefined) return reason.modelGuidance;
    const body = "body" in reason ? (reason as { body: string }).body : undefined;
    const detail = body !== undefined ? extractErrorDetail(body) : undefined;
    const status = reason.status !== undefined ? String(reason.status) : "transport error";
    return `Fetch failed (${status}${detail !== undefined ? `: ${detail}` : ""}).`;
  }
  if (reason instanceof ContentsFetchError) return reason.message;
  // Anything else is a bug, not a fetch outcome. Its message is unreviewed
  // text on a model-visible surface, so it stays in the log.
  console.warn(`[tako] tako_contents unexpected failure kind=${reason instanceof Error ? reason.name : typeof reason}`);
  return "Fetch failed for this url. Retry once; if it persists, flag it to the Tako team.";
}

/** The single-url default web-text cap. `BATCH_CHAR_BUDGET` divides down from
 *  here, so a one-url call is unaffected by the batch split. */
export const DEFAULT_MAX_CHARS = 100_000;

/** The per-url share of the batch's default character budget. */
function perUrlCharCap(batchSize: number): number {
  return Math.max(1, Math.floor(BATCH_CHAR_BUDGET / batchSize));
}

/** The cap a caller who set no `max_chars` gets, for a batch of this size.
 *
 *  Exported because `gen-registry.ts` needs the same number to build the
 *  `docs/TOOLS.md` sample. It used to re-derive the expression by hand, so
 *  moving `BATCH_CHAR_BUDGET` published a sample the server would not produce. */
export function defaultMaxChars(batchSize: number): number {
  return Math.min(DEFAULT_MAX_CHARS, perUrlCharCap(batchSize));
}

/** Our own aborts, as opposed to a transport failure or a bug. `errorText`
 *  renders these verbatim and everything else generically, so a `TypeError`
 *  thrown inside the projection cannot reach a model as batch entry text. */
export class ContentsFetchError extends Error {}

/**
 * The wire body for ONE url. Exported for the `fixedInputs` drift guard, which
 * asserts the `mode` and `content_format` rows this tool publishes are really
 * what the handler sends — the declaration is hand-written and nothing else
 * links it to the body.
 *
 * `query` never goes on the wire (the backend's extra="forbid" would 400 it);
 * `mode` and `content_format` always do, because the backend defaults to "url"
 * and "csv" and this tool serves neither.
 *
 * The effective character cap: `query` pins the ceiling so passages scan the
 * whole page — a capped scan turns "term at char 300k" into a false
 * "deterministic miss" — and the batch split does not apply there, since
 * `extractPassages` trims the output far below whatever was fetched. A plain
 * fetch with no caller cap defaults to 100k, split across the batch. An
 * EXPLICIT `max_chars` is left untouched at any batch size.
 */
export function buildContentsBody(
  url: string,
  input: Input,
  batchSize: number,
): z.input<typeof ContentsRequest> & { max_chars: number } {
  const maxChars =
    input.query !== undefined
      ? 1_000_000
      : input.max_chars ?? defaultMaxChars(batchSize);
  // `satisfies` sits on the LITERAL, not on the variable. Object-literal
  // freshness is lost on assignment, so `const body = {…}; return body
  // satisfies T` type-checks a key the target no longer declares — which is
  // the drift that matters here: a backend that renames `mode` or
  // `content_format` would keep receiving the dead key and silently serve its
  // own "url" / "csv" defaults, and the whole one-delivery-one-serialization
  // design rides on those two.
  const body = {
    url,
    mode: "inline" as const,
    content_format: "json_compact" as const,
    max_chars: maxChars,
    ...(input.max_rows !== undefined ? { max_rows: input.max_rows } : {}),
  } satisfies z.input<typeof ContentsRequest>; // ← build-time guard: backend request drift breaks here
  return body;
}

/** Fetch ONE url. Throws on failure so the caller can decide whether a single
 *  url's error degrades to an entry or fails the whole batch. */
async function fetchOne(
  url: string,
  input: Input,
  ctx: ToolContext,
  batchSize: number,
): Promise<ProjectedContentsItem> {
  const body = buildContentsBody(url, input, batchSize);
  const maxChars = body.max_chars;
  let raw: unknown;
  try {
    raw = await djangoPost<unknown>(ctx.env, ctx.token, "/api/v1/contents/", body, {
      timeoutMs: 60_000,
      caller: ctx.caller,
    });
  } catch (err) {
    // Map the two "this url has no exportable content" statuses to
    // self-correcting messages so the model stops retrying and reads the card's
    // headline instead. Per the OpenAPI contract: 403 is the export gate,
    // 404 is "does not exist or has no exportable data". Two sentences each —
    // verdict, then the one action (spec: guidance is two sentences per
    // branch). Both are framed as the LIKELY cause, not asserted fact, since a
    // 403 can have other causes. The backend's detail is spliced in only when
    // `extractErrorDetail` recognises a structured envelope — a raw slice would
    // flood the model with an edge/WAF HTML block page.
    //
    // The 403 message does NOT claim the card lacked a `content` attribute:
    // search sets that via the lenient `supports_data_export()` while this
    // endpoint gates on the stricter `export_safe()`, so the card that lands
    // here may well have carried one.
    //
    // Attached via `modelGuidance` on the ORIGINAL DjangoError, re-thrown whole:
    // `registerTool` then routes it through `djangoErrorToToolResult`, so a
    // contents 403/404 keeps the same `_meta["tako/error"]` envelope every
    // other tool emits while the model still reads the guidance in the text
    // channel.
    if (err instanceof DjangoHttpError && err.status === 403) {
      const detail = extractErrorDetail(err.body);
      err.modelGuidance = `Tako's export gate refused this card${detail !== undefined ? ` (${detail})` : ""}, so its rows can't be returned on any path — an \`exportable: true\` card can still land here. Read the headline value from the card's \`description\` instead of retrying.`;
      throw err;
    }
    if (err instanceof DjangoNotFoundError) {
      const detail = extractErrorDetail(err.body);
      err.modelGuidance = `Nothing downloadable exists at that url${detail !== undefined ? ` (${detail})` : ""}. Check the url came verbatim from a search result, and fetch only cards marked \`exportable: true\`.`;
      throw err;
    }
    throw err;
  }
  // Validate the raw wire response against the generated ContentsResponse so a
  // restructured `contents` array throws here rather than projecting to
  // nothing. It does NOT catch a renamed payload field: every one of them is
  // `.optional()` on the generated `ContentItem`, so an item that lost
  // `dataset` still parses. `projectContentsItem`'s empty-payload branch is
  // what turns that into a readable error instead of a billed blank.
  const wireResult = ContentsResponse.safeParse(raw);
  if (!wireResult.success) {
    // Zod detail goes to the server log only — the raw issue dump is
    // upstream-echoed content and noise for the model (Safety Rules).
    logWireGuardFailure("tako_contents", "ContentsResponse", wireResult.error, raw);
    throw new ContentsFetchError(
      "Tako contents endpoint returned an unexpected wire shape. Retry once; if it persists, flag it to the Tako team.",
    );
  }
  const item = wireResult.data.contents?.[0];
  if (!item) {
    logWireGuardFailure("tako_contents", "empty-contents", undefined, raw);
    throw new ContentsFetchError("Tako contents endpoint returned no downloadable content for that url.");
  }
  const projected = projectContentsItem(item, url, {
    ...(input.query !== undefined ? { passageQuery: input.query } : {}),
    effectiveMaxChars: maxChars,
  });
  // Observability for tuning BATCH_CHAR_BUDGET (a guessed starting number —
  // see its doc comment): only when the DERIVED default actually bit, i.e.
  // batching drove the per-url cap below the single-url 100k default AND the
  // page was long enough to reach it. An explicit caller cap getting cut is
  // normal and not logged.
  if (
    projected.truncated === true &&
    projected.text !== undefined &&
    input.max_chars === undefined &&
    input.query === undefined &&
    defaultMaxChars(batchSize) < DEFAULT_MAX_CHARS
  ) {
    console.warn(
      `[tako] tako_contents batch max_chars cap bit tool=tako_contents batch_size=${batchSize} per_url_cap=${perUrlCharCap(batchSize)}`,
    );
  }
  return projected;
}

const takoContents = {
  name: "tako_contents",
  description: DESCRIPTION,
  inputSchema,
  // The ADVERTISED output IS the projected shape (`_contents.ts`), typed field
  // by field: the handler builds every key, so nothing needs a loose stub and
  // no undeclared wire key can reach a strict client. The wire guard stays the
  // generated `ContentsResponse` safeParse above. No per-surface variant — no
  // widget reads this tool's output on any surface.
  outputSchema: contentsOutputShape,
  annotations: {
    title: "Tako: Fetch Contents",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Open-world on EVERY surface: the call fetches arbitrary public web pages, a system outside
    // Tako's first-party context. That is open-world under MCP's reading
    // (domain of interaction) and under OpenAI's Apps review guideline
    // ("tools that interact with external systems ... must be explicitly
    // labeled"). See `annotationsBySurface` in types.ts.
    openWorldHint: true,
  },
  fixedInputs: [
    {
      field: "mode",
      value: '"inline"',
      note: "The content comes back in the response to read. The API default is a presigned download link, which a model cannot use.",
    },
    {
      field: "content_format",
      value: '"json_compact"',
      note: "One row serialization, projected to `rows`. CSV writes a missing cell as an empty field; positional JSON writes null.",
    },
    {
      field: "max_chars (when omitted)",
      value: `min(${DEFAULT_MAX_CHARS}, ${BATCH_CHAR_BUDGET} / batch size)`,
      note: "Per-url character cap for web text; 1,000,000 when `query` is set, so passages scan the whole page.",
    },
    {
      field: "query",
      value: "(stripped from the request)",
      note: "Passage extraction runs in the Worker; the API has no such field.",
    },
  ],
  async handler(input, ctx): Promise<ContentsOutput> {
    const targets = input.urls;
    // Fan out: the backend takes ONE url per request, so a batch is N
    // subrequests issued concurrently. allSettled, not all — one url's 403 (a
    // license-gated card) must not discard the pages that did resolve.
    const settled = await Promise.allSettled(
      targets.map((u) => fetchOne(u, input, ctx, targets.length)),
    );
    const results: ProjectedContentsItem[] = settled.map((s, i) => {
      const url = targets[i] as string;
      if (s.status === "fulfilled") return s.value;
      return { url, error: errorText(s.reason), cost: 0 };
    });
    // Every url failed: there is no partial payload worth returning, so
    // re-throw the first failure. That keeps the single-url path behaving as
    // before — a DjangoHttpError with its self-correcting `modelGuidance`
    // still reaches registerTool's error envelope.
    const firstFailure = settled.find((s) => s.status === "rejected");
    if (firstFailure !== undefined && results.every((r) => r.error !== undefined)) {
      throw (firstFailure as PromiseRejectedResult).reason;
    }
    const parsed = contentsOutputShape.safeParse({ results, usage: contentsUsage(results) });
    if (!parsed.success) {
      logWireGuardFailure("tako_contents", "output-projection", parsed.error, results);
      throw new ContentsFetchError("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderContentsText(output as ContentsOutput);
  },
  // No slimStructured hook: the handler's output IS the advertised shape, so
  // `structuredContentFor`'s pickDeclared narrowing is the whole job.
} satisfies ToolModule<typeof inputSchema, ContentsOutput>;

export default takoContents;
