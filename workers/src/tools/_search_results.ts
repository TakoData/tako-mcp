/**
 * Shared shapes for the v3 search/answer surface used by `tako_search` and
 * `tako_search_advanced` (which reaches /v1/answer via `include_answer`). The
 * TakoCard + WebResult schemas mirror the backend
 * `app/backend/knowledge/api/ga/v3/search/types.py`. Auto-chain widget
 * fields (pub_id, embed_url, …) are lifted to the output root by
 * `buildSearchOutput` so the chart widget renders the top card inline.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import { z } from "zod";

import type { Env } from "../env.js";
import type { Tier } from "../freetier.js";
import { AnswerStructuredOutputError, RelatedSuggestion } from "../generated/schemas.js";
import { logWireGuardFailure } from "./_log.js";
import {
  HTTP_URL_REGEX,
  DEFAULT_DARK_MODE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  buildChartUrls,
  withShareOptIn,
} from "./_chart_widget.js";

// Backend ResultContent (api/ga/content_types.py) — a result's export
// descriptor + inline data. It rides on every EXPORTABLE result (even when
// include_contents is false, carrying just the cost quote); `data` is
// populated only when contents were requested. `content_format` ("csv" for
// Tako card data, "text" for web page text) is null when no payload is
// delivered. A card with NO `content` (missing or null) is not exportable:
// the backend's export-safe gate 403s a tako_contents call on its URL. Since
// TakoData/tako#27989 the adapter gates `content` (and the sibling
// `exportable` flag) on the same fail-closed export_safe() that
// /api/v1/contents enforces, so presence matches the gate by construction —
// though a rare card can still 403 at export time (tako_contents maps it to a
// self-correcting message). The descriptor must survive slimming
// (slimCardContent strips rows but always keeps the object).
//
// Every field is optional/nullable on purpose: this is a RESPONSE the tool only
// surfaces for the model to read (nothing in code branches on it), and the
// backend evolves its shape independently. Hard-requiring a field here turns a
// benign backend change into a total-outage second-stage guard failure — which
// is exactly what the `format` -> `content_format` rename did in prod. Mirror
// the generated ResultContent's optionality and stay loose so new fields
// (records/dataset/url/export_pricing/…) pass through untouched.
export const resultContentSchema = z
  .object({
    content_format: z.string().nullable().optional(),
    cost: z.number().nullable().optional(),
    data: z.string().nullable().optional(),
    total_rows: z.number().nullable().optional(),
    truncated: z.boolean().nullable().optional(),
  })
  .loose();
export type ResultContent = z.infer<typeof resultContentSchema>;

/**
 * How to spend the ONE pinned retry. Measured on prod (2026-07-29): a pin at
 * the default `strict:false` did not change which card came back — a deliberately
 * WRONG node changed nothing, and pinning a metric node without strict
 * returned a DIFFERENT metric's card. The same metric node WITH `strict:true`
 * returned exactly that card. So "pinning its node_ids" alone described the
 * WEAKER variant; this names the one that works.
 *
 * "Weaker", not inert, and the distinction matters to whoever re-reads this:
 * `s25b_kg_v2_matches/pinned_nodes.py` injects a pinned node with a dedicated
 * MatchBucket — a guaranteed allocation slot — and PINNED_NODE_MATCH_SCORE = 3.5
 * against an organic ceiling of ~3.0, unconditional on `strict`. That comment
 * calls the score "deliberately NOT score-dominant" and "Provisional; tune with
 * evals". So the reading below is: the pin IS applied, and is simply too weak to
 * change which card wins. Do not restate it as "the pin does nothing" — the next
 * author who checks the backend will find the opposite and distrust the rest.
 *
 * Exported for the guards, not for a caller — see the reader note below the
 * docstring. The reason it stays a constant at all is unchanged: two verdicts
 * whose recovery advice drifts apart teach the model two different pin forms,
 * and only one of them works.
 *
 * THE UNPIN ESCAPE HATCH, and why advice about how to pin ends with advice to
 * stop pinning. A later matched-arm run on staging (2026-07-31: 20 handles, 3
 * repeats, the only variable being whether the resolved node is pinned) found
 * 11 of 20 retrieve FEWER cards pinned than unpinned — `strict` is a hard
 * filter and the graph holds near-duplicate metric nodes where only one twin
 * carries cards (KE-812). "Carnival Corporation passenger cruise days" went
 * pinned [0,0,0] / unpinned [3,3,3], and the recovered cards were verified BY
 * TITLE to be the requested metric rather than a lookalike.
 *
 * The two measurements do not disagree — the 2026-07-29 run asked how to pin
 * so the pin bites, this one asks whether biting helps — but the ADVICE built
 * on the first was wrong on its own: it made a pinned zero read as proof of
 * absence. Both halves have to ride together, or `tako_available_data` tells
 * the model to unpin while these two tell it to pin, which is the same drift
 * this constant exists to prevent, one level up.
 *
 * Neither run is checked in — both were driven by hand against staging. The
 * per-handle numbers live in `_available_data.ts`'s `buildPairNextCall` comment
 * (pinned vs unpinned, by handle) and in the commit that introduced this hatch;
 * cite those rather than looking for a script to re-run.
 */
// NO PRODUCTION READER, same as {@link PINNED_FROM_CARD} below, and kept for
// the same reason: this is the canonical phrasing of the pin form, read by
// `_pin_form.test.ts` and named in `gen-registry.ts`'s failure message, so a
// surface that needs the recipe interpolates it instead of restating a form
// that drifted back to the broken variant twice before. Its last interpolation
// was the answer data-gap verdict, cut when every guidance branch went to two
// sentences; `tako_search_advanced`'s `data.node_ids` describe now carries the
// short form. Do not reintroduce it into any `tako_search` guidance — that tool
// takes no `node_ids`/`strict`, so the canonical NAME is its recovery path.
export const PINNED_RETRY =
  "pin the METRIC's node_id ALONE (from structuredContent.matches[].coverage.items[]) with strict:true, naming the entity in the query text — adding the entity's node id widens the filter back out, and a pin at the default strict:false only boosts the node rather than selecting it, which measured as not enough to land the metric. If that pinned call returns 0 cards, run it once more with `node_ids` removed before concluding the data is absent: `strict` is a hard filter and the graph holds near-duplicate metric nodes where only one twin carries cards, so the pin itself is sometimes what empties the result";

/**
 * The same recipe for the card-in-hand case. {@link PINNED_RETRY} sources the
 * id from `tako_available_data`'s `coverage.items[]`, which is the wrong place
 * to point a caller who already holds a search card — its ids are on
 * `cards[].nodes[]`. Two constants rather than one because the SOURCE of the id
 * genuinely differs; the pin FORM (metric node alone, `strict:true`) must not.
 * Both exist so `tako_search`'s description stops restating the form by hand:
 * it was restated in two places and both drifted back to the broken variant
 * (every node id on the card, no `strict`) — the one measured to misfire.
 *
 * NO PRODUCTION READER TODAY. `values_hint` used to interpolate it — that is
 * why it is declared above `takoCardSchema` — but that field's routing was
 * rewritten when `tako_answer` moved behind `?tools=answer`, and nothing else
 * picked the wording up. Its two remaining consumers are
 * `_pin_form.test.ts`, which guards the wording against drift, and
 * `gen-registry.ts`, whose failure message tells an author to reuse it by
 * name. Kept for that second reason: the constant is the canonical phrasing
 * for the card-in-hand case, and a descriptor that needs it should
 * interpolate this rather than restate the form — which is exactly how the
 * broken variant got in twice before. Delete it only together with that
 * guidance message.
 *
 * Keep the declaration ABOVE `takoCardSchema` if a descriptor does start
 * interpolating it again: that schema is built at module evaluation time, so
 * a later declaration would sit in its temporal dead zone and importing this
 * module would throw ReferenceError on load.
 */
export const PINNED_FROM_CARD =
  "pin that card's METRIC node id ALONE (the `mt::` entry in its `nodes`) with strict:true — pinning every node id on the card re-admits its other cards, and omitting strict only boosts, which measured as not enough to land the metric";

// Backend TakoCard (api/ga/v3/search/types.py::TakoCard). Loose so a richer
// backend card doesn't break parsing. Shared by both search tools.
export const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
    // Export descriptor + inline preview. Rides on exportable cards even with
    // include_contents off (carrying the cost quote). Missing/null → NOT
    // exportable (403); present → necessary for export, not a guarantee.
    content: resultContentSchema
      .nullable()
      .optional()
      .describe(
        "Raw export descriptor + inline data preview. Read the sibling `exportable` boolean as the call/skip signal instead of inferring from this field's presence. Missing or null here is equivalent to exportable:false. Present is necessary for a tako_contents export but not a guarantee (a rare card still 403s — fall back to the preview/chart).",
      ),
    // Explicit export-eligibility flag. The backend emits it authoritatively
    // (TakoData/tako#27989, computed with the same fail-closed export_safe
    // gate as /contents); `projectCard` passes a wire value through and derives
    // from `content` presence only when an older backend omits it. Emitted so
    // the model reads a POSITIVE "no" rather than having to notice a MISSING
    // `content` key, which LLMs routinely overlook — then call tako_contents
    // anyway and draw a 403. false is authoritative; true is eligible-not-guaranteed.
    exportable: z
      .boolean()
      .optional()
      .describe(
        "Whether this card's underlying data can be fetched with tako_contents. false → NOT exportable: do NOT call tako_contents on this card, use its inline preview/chart. true → eligible, but not a guarantee — a rare card still 403s, so on error fall back rather than retry.",
      ),
    // Graph nodes (entities/metrics) this card was built from, returned by the
    // backend by default. Slim shape (id/name/type) — pass these ids into
    // sources.data.node_ids to pin the same nodes in a follow-up search.
    nodes: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          // Loose string, NOT a strict enum: nothing branches on this (it is
          // surfaced read-only to the model), and hard-coding the node-type
          // enum here would reintroduce the exact drift failure this file's
          // content_format fix removed — a new backend node type would pass the
          // generated wire guard but fail this hand-written facade, throwing
          // "unexpected shape" on every response.
          type: z.string(),
        }),
      )
      .nullable()
      .optional(),
  })
  .loose();
export type TakoCard = z.infer<typeof takoCardSchema>;

export const webResultSchema = z
  .object({
    title: z.string(),
    url: z
      .string()
      .describe(
        "The web page URL. Always fetchable via tako_contents for the page's full text (web urls need no `exportable` flag, unlike cards) — a fallback you can read when no Tako data card fits the query.",
      ),
    // Tako asks for Exa highlights (see buildSearchBody / buildAnswerBody), so
    // this is query-selected passages, not the page's opening text: it can be
    // absent, and it can be non-contiguous. The MODEL-FACING wording for that
    // lives on `web_results` in the two slim shapes in _render_markdown.ts —
    // this schema is the wire-parse guard and the internal shape, neither of
    // which is advertised, so a `.describe()` here would document the field
    // for maintainers only. Kept as a plain field to avoid implying otherwise.
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    publish_date: z.string().nullable().optional(),
    // 1-based citation index — set on Agent API results, null on raw retrieval.
    citation_number: z.number().nullable().optional(),
    // Inline web page text — present only when include_contents was set for the
    // web source. Unlike Tako cards, a web URL is exempt from the export gate:
    // it can be passed to tako_contents (extracted page text) whether or not
    // this descriptor rides along.
    content: resultContentSchema.nullable().optional(),
  })
  .loose();
export type WebResult = z.infer<typeof webResultSchema>;

// The DEFAULT most-recent-rows cap for the inline card preview, matched to
// the backend's own inline cap: search/answer inline at most 20 rows per
// card server-side (tako_inline_cap_for; a larger legacy cap exists only for
// entitled enterprise accounts), so this is the honest ceiling of what
// actually arrives — the MCP can only cap DOWN what the backend shipped,
// never raise it.
//
// EVERY delivered row is billed, per 1k — tako#29572 (2026-08-21) removed the
// row allowance entirely. No descriptor may describe any row here as costless:
// the copy that survived that change billed silently for four days. For more
// rows, a separate tako_contents call (max_rows up to 2,000, billed the same
// way).
//
// `preview_rows` above this cap is therefore inert today; the input keeps the
// wider 1..MAX_PREVIEW_ROWS range so a future backend row-count knob can
// light it up without an input-surface change.
export const INLINE_PREVIEW_ROW_CAP = 20;
export const MAX_PREVIEW_ROWS = 250;

// `content` carries the heavy inline row payload under keys the hand-written
// resultContentSchema passes through loosely (records/dataset are not in its
// explicit shape). Type them here so the slim helpers can touch them.
type LooseContent = ResultContent & {
  records?: Array<Record<string, unknown>> | null;
  dataset?: { columns?: unknown; rows?: unknown[] } | null;
  // card_json's payload (generated `ContentItem.card_data`). Card-type-specific,
  // so it has no generic row axis to slice — but it IS a row payload for
  // billing and for context, so it has to be droppable alongside the other
  // three. Its sibling `card_data_schema` is the SHAPE, not the payload, and
  // deliberately stays in `meta`: a url-mode or quote response returns it
  // beside a null `card_data`, so dropping it would lose the only thing those
  // two shapes carry.
  card_data?: unknown;
};

// Column types the backend uses for the temporal axis of a dataset. Detecting
// this column lets the cap keep the *newest* rows regardless of sort order.
const TEMPORAL_COL_TYPES = new Set(["datetime", "date", "timestamp", "time"]);

// Parse a cell into a comparable epoch magnitude, or null when it isn't
// date-like. Numbers pass through (epoch/serial); strings must parse as a date.
// Returning null on non-dates is what keeps a plain numeric value column from
// being mistaken for a timestamp.
function temporalMagnitude(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Parse a cell into an epoch-ms magnitude comparable ACROSS cards, or null.
 *
 * `temporalMagnitude` is safe where it is used by `capRecentRows`, which only
 * ever compares two values from the SAME card and so cannot mix scales. Card
 * ORDERING compares across cards, where a bare number passed through unchanged
 * is not comparable to a `Date.parse` result: an annual series whose `date`-typed
 * column holds `2024` yields 2024 against ~1.7e12 for any string-dated card,
 * sorting it below every one of them — including genuinely staler series.
 *
 * So each recognised shape is converted to epoch-ms, and anything unrecognised
 * returns null rather than a number on an unknown scale. A null simply means
 * "no freshness signal from this cell", which the caller already handles.
 */
function comparableEpoch(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // A bare year, the shape annual series use.
    if (v >= 1000 && v <= 9999) return Date.UTC(Math.trunc(v), 0, 1);
    // Epoch seconds vs milliseconds, split by magnitude. Both bounds cover
    // 1973-2286, comfortably outside the year range above and either side of
    // any date this data carries.
    if (v >= 1e8 && v < 1e11) return v * 1000;
    if (v >= 1e11 && v < 1e14) return v;
    return null;
  }
  return temporalMagnitude(v);
}

// Order of a row sequence from the temporal value of its first vs last row:
//   +1 descending (newest first) · -1 ascending (newest last) · 0 unknown.
function orderDirection(firstVal: unknown, lastVal: unknown): 1 | -1 | 0 {
  const a = temporalMagnitude(firstVal);
  const b = temporalMagnitude(lastVal);
  if (a === null || b === null || a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * Keep the `cap` MOST-RECENT rows of an already-sorted sequence.
 *
 * Backend row order is card-type-dependent (timeseries ascending, stock cards
 * descending / newest-first), so a blind tail slice would hand a stock card its
 * OLDEST rows and drop the latest value. We detect the direction from a temporal
 * accessor and slice the end that holds the newest rows; when the accessor gives
 * no date signal we fall back to the tail (the prior behavior).
 */
function capRecentRows<T>(rows: T[], cap: number, temporalOf: (r: T) => unknown): T[] {
  if (rows.length <= cap) return rows;
  const dir = orderDirection(temporalOf(rows[0] as T), temporalOf(rows[rows.length - 1] as T));
  return dir > 0 ? rows.slice(0, cap) : rows.slice(-cap);
}

type DatasetColumn = { name?: unknown; type?: unknown };

// Index of the dataset's temporal column (by declared type), or -1.
function temporalColumnIndex(columns: unknown): number {
  if (!Array.isArray(columns)) return -1;
  return columns.findIndex(
    (c) =>
      !!c &&
      typeof (c as DatasetColumn).type === "string" &&
      TEMPORAL_COL_TYPES.has(((c as DatasetColumn).type as string).toLowerCase()),
  );
}

// Best-effort temporal key for json_records rows (which carry no column types):
// the first key whose value is a NON-numeric string that parses as a date.
function recordDateKey(records: Array<Record<string, unknown>>): string | undefined {
  const first = records[0];
  if (!first) return undefined;
  for (const [k, v] of Object.entries(first)) {
    if (typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(v.trim()) && temporalMagnitude(v) !== null) {
      return k;
    }
  }
  return undefined;
}

// Cap a CSV payload to the header + the `cap` most-recent data lines, instead of
// dropping it. Direction is detected from the first column (the temporal/label
// column in Tako's timeseries CSVs); falls back to the tail otherwise. A simple
// comma split — not a full CSV parser — which is fine for a bounded preview
// (the exact, full export is always a separate tako_contents call).
function capCsv(csv: string, cap: number): { data: string; truncated: boolean } {
  const lines = csv.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= 1) return { data: csv, truncated: false };
  const header = lines[0] as string;
  const dataLines = lines.slice(1);
  if (dataLines.length <= cap) return { data: csv, truncated: false };
  const kept = capRecentRows(dataLines, cap, (line) => line.split(",")[0]);
  return { data: [header, ...kept].join("\n"), truncated: true };
}

/**
 * Slim a Tako card's `content` for the model-facing response.
 *
 * The inline row payload (`data`/`records`/`dataset`) is what bloats the
 * model's context — and BOTH channels the model can see derive from the tool
 * output (mcp.ts stringifies `output` into `content.text` AND sets it as
 * `structuredContent`, which counts toward context on claude.ai), so removing
 * rows here shrinks both at once. Metadata (content_format / cost / total_rows
 * / truncated / export_pricing / url) is always kept so the "N rows available,
 * priced — call tako_contents" signal survives.
 *
 *   capRows === null  → drop all rows (the model fetches via tako_contents).
 *   capRows === N     → keep the N most-recent rows (order-aware, a bounded peek).
 *   capRows === "all" → keep what the backend sent, untouched.
 *
 * "all" exists for `tako_search_advanced`, which sends `sources.data.max_rows`
 * on the wire. The backend has therefore already applied the caller's own cap —
 * including the 2,000-row ceiling the simple tool cannot reach — so a second
 * cap here could only clamp BELOW what the caller asked and paid for. Passing
 * `null` there would be worse still: it would discard the account-default rows
 * of a caller who set include_contents and omitted max_rows.
 */
/**
 * The four keys that carry a ROW PAYLOAD, and the ten that carry metadata about
 * one. Declared rather than left implicit in the destructure below because the
 * `card_data` leak was exactly this list falling behind the backend: it named
 * three keys while the generated `ContentItem` had four, so a call asking to drop
 * every row shipped the whole rich card_json object.
 *
 * The destructure stays a destructure — it is type-checked, and a runtime array
 * cannot drive one — so these consts are bound to reality by two tests instead:
 * one asserts slimCardContent actually nulls every PAYLOAD key, the other
 * asserts every `ContentItem` key is classified here. A fifth payload channel
 * upstream then fails a test rather than silently leaking.
 *
 * `card_data_schema` is METADATA on purpose: it is the SHAPE, not the payload,
 * and a url-mode or quote response returns it beside a null `card_data`, so
 * dropping it would lose the only thing those two shapes carry.
 */
export const CONTENT_PAYLOAD_KEYS = ["data", "records", "dataset", "card_data"] as const;
export const CONTENT_META_KEYS = [
  "content_format",
  "cost",
  "card_data_schema",
  "url",
  "expires_at",
  "total_rows",
  "truncated",
  "export_pricing",
  "manifest",
  "source_url",
] as const;

export function slimCardContent(
  content: ResultContent | null | undefined,
  capRows: number | "all" | null,
): ResultContent | null | undefined {
  if (content == null) return content;
  // The backend already applied this caller's cap — see the "all" note above.
  if (capRows === "all") return content;
  // Strip the four row-payload keys out; `meta` keeps everything else
  // (content_format/cost/total_rows/truncated/export_pricing/url/
  // card_data_schema/…).
  const { data: rawData, records, dataset, card_data: cardData, ...meta } = content as LooseContent;
  if (capRows === null) {
    return { ...meta, data: null, records: null, dataset: null, card_data: null } as ResultContent;
  }

  // CSV payload lives in `data` — cap it in place rather than blanking it, so an
  // include_contents caller still gets rows if a csv content_format is ever
  // threaded through (today the worker never requests csv, so this is inert).
  const isCsv = typeof meta.content_format === "string" && meta.content_format.toLowerCase() === "csv";
  let cappedData: string | null = null;
  let csvTruncated = false;
  if (isCsv && typeof rawData === "string") {
    const r = capCsv(rawData, capRows);
    cappedData = r.data;
    csvTruncated = r.truncated;
  }

  // json_records: keep the newest `capRows`, order detected from a date-valued key.
  const dateKey = Array.isArray(records) ? recordDateKey(records) : undefined;
  const cappedRecords = Array.isArray(records)
    ? capRecentRows(records, capRows, (r) => (dateKey ? r[dateKey] : undefined))
    : (records ?? null);
  const slicedRecords = Array.isArray(records) && records.length > capRows;

  // json_compact dataset: keep the newest `capRows`, order detected from the
  // declared temporal column.
  let cappedDataset = dataset ?? null;
  let slicedRows = false;
  if (dataset && Array.isArray(dataset.rows)) {
    const idx = temporalColumnIndex(dataset.columns);
    const temporalOf = (row: unknown) => (idx >= 0 && Array.isArray(row) ? row[idx] : undefined);
    slicedRows = dataset.rows.length > capRows;
    cappedDataset = { ...dataset, rows: capRecentRows(dataset.rows, capRows, temporalOf) };
  }

  // Rows lead, descriptor metadata trails: JSON.stringify preserves insertion
  // order and result-size-capped clients truncate the TAIL of the serialized
  // payload — were the rows last (the wire order), a capped client would keep
  // the metadata and cut the data points, defeating include_contents entirely.
  return {
    data: cappedData,
    records: cappedRecords,
    dataset: cappedDataset,
    // Passed through, not sliced: the backend truncates card_json to the same
    // max_rows as every other format, and the object is card-type-specific, so
    // there is no generic row axis to cut here. Only the null branch above
    // touches it. Reachable only if a numeric cap is ever paired with
    // card_json — no caller does that today (the simple tool requests no
    // content_format and the advanced tool passes "all").
    card_data: cardData ?? null,
    ...meta,
    truncated: slicedRecords || slicedRows || csvTruncated || meta.truncated || false,
  } as ResultContent;
}

// Backend Usage — cost-plus usage for one metered request (mirrors the generated
// `Usage` in generated/schemas.ts). `total_cost_usd` is the total quoted charge;
// `compute` (the flat search/answer per-request rate) and `data` (the
// include_contents inline-data charge) are the additive breakdown and appear only
// where they apply. Null on the output when the request was not metered/billed.
// Loose so a richer usage payload doesn't break parsing.
export const usageSchema = z
  .object({
    total_cost_usd: z.number(),
    compute: z.object({ cost_usd: z.number() }).loose().nullable().optional(),
    data: z.object({ cost_usd: z.number(), datasets: z.number().int() }).loose().nullable().optional(),
  })
  .loose();
export type Usage = z.infer<typeof usageSchema>;

/**
 * The ADVERTISED shape of `usage` — the headline figure only.
 *
 * `usageSchema` above stays the internal contract (it parses and types the
 * wire, breakdown included, and the breakdown is still EMITTED). This declares
 * just `total_cost_usd` because publishing the nested compute/data objects cost
 * 197 tokens on each of tako_search and the answer tool — ~394 of a 7,235-token
 * connect surface — to describe a per-call cost breakdown no routing decision
 * reads. Loose, so the emitted breakdown still validates: nested loose objects
 * publish permissive `additionalProperties`, unlike the top level which the SDK
 * rebuilds strict.
 */
export const usageAdvertisedSchema = z
  .object({ total_cost_usd: z.number() })
  .loose();

// Auto-chain widget fields lifted to the output root when the top card
// has a card_id. Read by the chart widget (tako_search inline render).
export const autoChainShape = {
  pub_id: z.string().optional(),
  embed_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "embed_url must be http(s)" })
    .optional(),
  image_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "image_url must be http(s)" })
    .optional(),
  dark_mode: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
} as const;

// tako_search output: v3 cards + web_results + request_id + the widget
// fields for the top card. Mirrors the answer response's {cards, web_results,
// request_id} plus the inline-render plumbing.
/**
 * The six widget fields, all present or the value is `undefined`.
 *
 * Whole-or-nothing rather than `Partial<>` because of the spread site: under
 * `exactOptionalPropertyTypes` spreading an optional property widens it to
 * `| undefined`, which `SearchOutput` then rejects. Returning the complete set
 * keeps the literal inside this function checked key-by-key — which is the
 * whole point of typing it at all — and callers spread `?? {}`.
 */
type AutoChainFields = z.infer<z.ZodObject<typeof autoChainShape>>;
export type TopCardChartFields = {
  // `-?` drops the optionality and `NonNullable` drops the `| undefined` that
  // `.optional()` leaves in the VALUE. `Required<>` alone keeps the latter,
  // which is still the widening `exactOptionalPropertyTypes` rejects.
  [K in keyof AutoChainFields]-?: NonNullable<AutoChainFields[K]>;
};

// ---------------------------------------------------------------------------
// Model-facing projection (spec: 2026-08-26-model-facing-surface-redesign)
//
// The projection REPLACES the passthrough-plus-loose-schema pattern for the
// search tools: every field below is mapped on purpose, so an unknown backend
// key cannot leak into the model's context, and the advertised schema can be
// a real typed card. Wire-drift protection moves from "loose schema" to
// "explicit mapping + the conformance test in _search_results.test.ts".
//
// THE PASSTHROUGH SLIMMERS ARE GONE, not parked. `slimCard`, `slimWebResult`
// and `hoistSourceGlossary` served `tako_answer`, which #273 folded into
// `tako_search_advanced`; both search tools now share this projection, so the
// three had no caller left. They were briefly kept "for the answer pass" —
// a pass that no longer exists. Do not restore one to shortcut a future
// tool: project explicitly, or the unknown-key leak comes back with it.
// `slimCardContent` survives because `projectCard` caps inlined rows with it.
// ---------------------------------------------------------------------------

// Exported for `_agent_run.ts`, which projects the same vocabulary (`url`,
// `source`, `last_updated`) off a different wire shape. A second copy would
// let one channel start trimming dates differently from the other.
export const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

// Date-only per the field vocabulary: recency matters, time-of-day doesn't.
export const dateOnly = (v: unknown): string | undefined => {
  const s = nonEmpty(v);
  if (s === undefined) return undefined;
  const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
  return m ? m[0] : s;
};

// Exported for `_agent_run.ts`, for the reason `nonEmpty` and `dateOnly` are:
// a second copy lets one channel start naming sources differently from the
// other.
export const sourceNamesOf = (rec: Record<string, unknown>): string[] => {
  if (!Array.isArray(rec.sources)) return [];
  const names: string[] = [];
  for (const entry of rec.sources) {
    if (entry === null || typeof entry !== "object") continue;
    const name = nonEmpty((entry as Record<string, unknown>).source_name);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
};

/**
 * The key a card's reference notes join under — EXACTLY the string
 * `projectCard` writes into the card's `source` field.
 *
 * One derivation, because the join is the whole point of `source_notes` and
 * `metric_definitions`: the model reads `source` off a card and looks it up in
 * the map. A key built any other way (a `methodology_name`, or just
 * `sources[0]` on a two-source card) files the prose under something no card
 * carries, and the model can see the paragraph but cannot attribute it. The
 * advertised schema promises "keyed by source name", so this is the promise.
 *
 * `undefined` when the card names no source at all — there is nothing to join
 * to, and the caller drops rather than inventing a key.
 */
const sourceKeyOf = (sources: readonly string[]): string | undefined =>
  sources.length > 0 ? sources.join(", ") : undefined;

export const projectedNodeSchema = z
  .object({ id: z.string(), name: z.string(), type: z.string() })
  .loose();
export type ProjectedNode = z.infer<typeof projectedNodeSchema>;

/** The model-facing card: ten fields, every one with a reader. */
export type ProjectedCard = {
  title?: string;
  /** The headline value + range — on many cards this IS the answer. */
  description?: string;
  exportable: boolean;
  /** The one URL — the `tako_contents` handle. */
  url?: string;
  source?: string;
  /** Where the DATA ends. The field that answers "is this the latest
   *  figure?" — `last_updated` does not: a card refreshed today can end in
   *  2024. Reduced ISO precision, at the series' own granularity ("2026",
   *  "2026-06", "2026-06-30"), so do not parse it as a full date. */
  coverage_end?: string;
  last_updated?: string;
  total_rows?: number;
  relevance?: string;
  nodes?: ProjectedNode[];
  /** Inlined rows — present ONLY when the request asked to inline
   *  (`tako_search_advanced` with `include_contents`); `tako_search`
   *  never sets it. */
  rows?: ProjectedCardRows;
};

export type ProjectedWebResult = {
  title?: string;
  url: string;
  /** Query-selected passages; `null` when the page had no relevant one. */
  snippet?: string | null;
  source?: string;
  published?: string | null;
  /** Page text — present ONLY when the request asked for it
   *  (`tako_search_advanced` web `include_contents`). */
  content?: Record<string, unknown>;
};

/** The column name a model reads, with the unit folded in when the backend's
 *  name does not already carry it. Structural, off the backend's own `unit`
 *  field — not a table of known units.
 *
 *  The test is for `(unit)`, the convention the backend's own names use, and
 *  NOT for the unit as a bare substring. `"Team Payroll".includes("m")` is
 *  true, so raw containment drops every short unit — `%`, `m`, `M`, `t`, `B`,
 *  all documented values of `TakoDatasetColumn.unit` — and hands the model an
 *  unlabeled number in a `columns` array whose description promises the unit
 *  is in the name. A name that spells the unit out ("Revenue in USD") gains a
 *  redundant `(USD)`, which costs 6 chars and loses nothing. */
export function columnName(column: { name: string; unit?: string | null | undefined }): string {
  const unit = column.unit;
  if (unit === null || unit === undefined || unit === "") return column.name;
  return column.name.includes(`(${unit})`) ? column.name : `${column.name} (${unit})`;
}

/**
 * One cell, declared permissively on purpose.
 *
 * A `z.union([string, number, boolean, null])` here publishes an 88-char
 * `anyOf` that can only ever REJECT: the wire guard (`TakoDataset` in
 * `ContentsResponse`) already constrains cells to those four types, so the
 * union adds no validation the payload has not passed — while a strict client
 * (Cursor, claude.ai) would throw out a whole billed result if our own
 * projection ever emitted something else. D4: the schema is validation
 * infrastructure, and a deep one adds failure modes, not model context. What
 * the model needs — that a missing cell is `null` rather than an empty
 * string — is one clause in `rows`'s own description, where it is read.
 */
const cellSchema = z.unknown();

/**
 * A Tako card's rows. Field name and inner shape are the spec's
 * (`rows` as `{columns, rows, total_rows}`), shared by `tako_contents` items
 * and `tako_search_advanced`'s inlined card rows so there is one vocabulary
 * for the same thing. The search side takes it through
 * {@link projectedCardRowsShape}, which drops `total_rows` (the card already
 * carries it) and adds the two payloads that are not row-shaped.
 *
 * `columns` is a bare name array, not `{name, unit}` objects: checked across 8
 * cards / ~20 columns on prod, every non-null `unit` was ALREADY inside the
 * column name ("… (USD)", "… (Percentage)", "… (BTUs)"), so objects would pay
 * `{"name":…}` per column to restate it — 160 chars on a 16-column card.
 * `columnName` appends the unit when the name lacks it, so the assumption
 * cannot fail silently. `type` is dropped because in positional
 * JSON the value IS the type (`74.9967` vs `"60"` vs `null`), and on NBA
 * standings the backend declares `Wins` a `string` — true of its storage,
 * misleading as a semantic.
 */
// LIVES HERE, not in `_contents.ts`, only because of the import direction:
// `_contents.ts` already takes `usageAdvertisedSchema` from this module, so
// importing back the other way closes a cycle and `module_cycles.test.ts`
// fails. Both readers — `tako_contents` items and `tako_search_advanced`
// inlined card rows — get one definition of what a row payload looks like.
export const projectedRowsShape = z.object({
  columns: z.array(z.string()).describe("Column names, in row order; the unit is in the name."),
  rows: z.array(z.array(cellSchema)).describe("Positional cells; a missing cell is null."),
  // `.int()` deliberately absent: it publishes `minimum`/`maximum` at the
  // JS safe-integer bounds, ~90 chars that no real row count can violate and
  // that can only reject. Same reasoning as `cellSchema`.
  total_rows: z.number().optional().describe("Rows behind the card, before `max_rows`."),
});

export type ProjectedRows = z.infer<typeof projectedRowsShape>;

/**
 * A card's INLINED rows, `tako_search_advanced` with
 * `data.include_contents: true`. Derived from {@link projectedRowsShape} so
 * the two tools cannot drift into two vocabularies for one thing.
 *
 * Two deliberate differences from the contents shape:
 *
 *  - `total_rows` is dropped. The card already carries it, and before this
 *    projection the same count shipped THREE times per card — `card.total_rows`,
 *    `rows.total_rows` and `rows.dataset.total_rows`.
 *  - Every field is optional, and `format`/`data`/`card_data` exist, because
 *    this tool publishes `data.content_format` and `tako_contents` does not.
 *    Two of the four formats are row-shaped and normalize into
 *    `columns`/`rows` (`json_compact` from `dataset`, `json_records` from
 *    `records`); `csv` and `card_json` are not, so they ride verbatim under
 *    the key that names them, with `format` saying which. Parsing a CSV
 *    string back into cells would invent quoting rules the caller did not ask
 *    for; a caller who requested CSV gets CSV.
 *
 * What is NOT here is the point: `dataset.ref` (duplicates `card.url`),
 * `dataset.sources` (duplicates `card.source`) and `dataset.provenance` used
 * to ride inside every inlined card, ~200 chars per card in BOTH channels,
 * paid once per `data.count`.
 */
export const projectedCardRowsShape = projectedRowsShape
  .omit({ total_rows: true })
  .partial()
  .extend({
    format: z
      .string()
      .optional()
      .describe("The content_format, when the payload is not `columns`/`rows`."),
    data: z.string().optional().describe("csv format only: the rows as CSV text."),
    card_data: z
      .looseObject({})
      .optional()
      .describe("card_json format only: the card-type-specific object."),
    truncated: z
      .boolean()
      .optional()
      .describe("Not all the rows; the card's `total_rows` has the full count."),
  })
  .loose();

export type ProjectedCardRows = z.infer<typeof projectedCardRowsShape>;

/**
 * Normalize one card's inlined content into {@link projectedCardRowsShape}.
 *
 * `manifest` is the fallback unit carrier, not a shipped field: `TakoDataset`
 * columns carry their own `unit`, but a `json_records` payload has only bare
 * keys, and the per-column `unit` then exists ONLY in `manifest`. Folding it
 * into the column name (via {@link columnName}) puts it where the model reads
 * the number instead of on a separate line it has to join by position — and
 * lets the manifest itself go, which was 4 keys per column of `metric` and
 * `entity` prose that repeat the card title.
 *
 * Returns `undefined` when no payload channel arrived: a descriptor carrying
 * only a cost quote is not rows, and an empty `rows: {}` would read as "this
 * card has no data" when the truth is "you did not ask to inline it".
 *
 * `log` names the caller for the drop breadcrumb below. OPTIONAL, unlike the
 * `toolName` `buildSearchOutput` requires: there a missing name reaches the
 * MODEL as another tool's argument syntax, here it only degrades a log line,
 * and requiring it would rewrite two dozen projection tests that log nothing.
 */
export function projectCardRows(
  content: Record<string, unknown>,
  manifest: ReadonlyArray<Record<string, unknown>> | undefined,
  log?: CardProjectionLog,
): ProjectedCardRows | undefined {
  const out: ProjectedCardRows = {};
  // JOIN BY NAME, NEVER BY POSITION. `ColumnDescriptor.name` is documented as
  // "the CSV header, the json_records key, and the dataset column label", so
  // the key is exact — and the two orders genuinely differ. The records branch
  // below derives its column order FIRST-SEEN across records, because the
  // backend omits a key whose value is null for that row; a positional join
  // therefore slid every unit after the first hole onto the wrong column.
  // Measured on a 3-column card whose first record was missing `revenue`:
  // `margin` came back labelled `(USD)` and `revenue` `(%)`. That is worse
  // than the unlabelled number this fold exists to prevent — the model reads a
  // confidently wrong unit instead of asking.
  const unitByName = new Map<string, string>();
  for (const entry of manifest ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, unit } = entry as { name?: unknown; unit?: unknown };
    if (typeof name === "string" && name !== "" && typeof unit === "string" && unit !== "") {
      unitByName.set(name, unit);
    }
  }
  const dataset = content.dataset as Record<string, unknown> | null | undefined;
  // FILTER ONCE, BEFORE BOTH LOOPS. The key scan below skipped non-object
  // entries and the row build did not, so a single `null` in `records` threw a
  // TypeError — after the upstream call was billed, and inside a projection
  // whose whole input is a deliberately `.loose()` wire guard that validates
  // nothing here. One list keeps the two loops reading the same rows, which is
  // the real invariant: the column ORDER comes from one and the CELLS from the
  // other, so they cannot be allowed to disagree about which records exist.
  // Arrays are excluded too — `Object.keys([1,2])` is `["0","1"]`, which would
  // invent positional columns out of a malformed payload.
  const rawRecords = content.records;
  const records = Array.isArray(rawRecords)
    ? rawRecords.filter(
        (r): r is Record<string, unknown> =>
          r !== null && typeof r === "object" && !Array.isArray(r),
      )
    : [];
  if (dataset != null && Array.isArray(dataset.columns) && Array.isArray(dataset.rows)) {
    out.columns = dataset.columns.map((c, i) => {
      const col = (c ?? {}) as { name?: unknown; unit?: unknown };
      const name = typeof col.name === "string" ? col.name : String(i);
      const unit =
        typeof col.unit === "string" && col.unit !== "" ? col.unit : unitByName.get(name);
      return columnName({ name, ...(unit !== undefined ? { unit } : {}) });
    });
    out.rows = dataset.rows as unknown[][];
  } else if (records.length > 0) {
    // `records.length > 0` where the dataset branch accepts an EMPTY `rows`,
    // and the asymmetry is correct rather than an oversight: a dataset DECLARES
    // its columns, so `{columns:[...], rows:[]}` is a real answer ("no rows for
    // these columns"), while a records payload DERIVES its columns from the
    // entries, so an empty array can describe nothing at all. Returning
    // `undefined` there says "you did not ask to inline", which is the only
    // honest reading. Do not "align" the two.
    //
    // Column order is FIRST-SEEN across every record, not the first record's
    // keys: the backend omits a key whose value is null for that row, so
    // reading row 0 alone drops a column the rest of the payload has.
    const keys: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
    out.columns = keys.map((name) => {
      const unit = unitByName.get(name);
      return columnName({ name, ...(unit !== undefined ? { unit } : {}) });
    });
    // `?? null` and not `?? undefined`: a hole in a positional row has to be a
    // cell, or every column after it shifts left by one.
    out.rows = records.map((record) => keys.map((key) => record[key] ?? null));
  } else if (typeof content.data === "string" && content.data !== "") {
    out.format = typeof content.content_format === "string" ? content.content_format : "csv";
    out.data = content.data;
  } else if (content.card_data != null && typeof content.card_data === "object") {
    out.format = typeof content.content_format === "string" ? content.content_format : "card_json";
    out.card_data = content.card_data as Record<string, unknown>;
  } else {
    return undefined;
  }
  // A non-tabular payload still gets `columns` when the manifest names them,
  // and it is the unit that makes this worth the duplicated header: a CSV
  // header is bare names, so without this a `csv` inline reaches the model as
  // a column of numbers with nothing saying whether they are USD, USD billions
  // or a percent — the same gap `json_records` had. The tabular branches above
  // already fold the unit into the name and never reach here.
  if (out.columns === undefined && manifest !== undefined) {
    const named = manifest
      .map((c) => {
        // This branch walks the manifest itself, so the descriptor beside the
        // name IS this column's — no join, positional or otherwise.
        const name =
          c !== null && typeof c === "object" && typeof c.name === "string" && c.name !== ""
            ? c.name
            : undefined;
        if (name === undefined) return undefined;
        const unit = unitByName.get(name);
        return columnName({ name, ...(unit !== undefined ? { unit } : {}) });
      })
      .filter((c): c is string => c !== undefined);
    if (named.length > 0) out.columns = named;
  }
  // Either level may carry it: the cap can be applied to the response as a
  // whole (`content.truncated`) or inside the dataset the backend built.
  const truncated =
    content.truncated === true || (dataset != null && dataset.truncated === true);
  if (truncated) out.truncated = true;
  // THE PUBLISHED SHAPE IS THE PREDICATE, not a hand-written check per branch.
  //
  // `resultContentSchema` is deliberately `.loose()` with every field optional
  // — the wire guard must not turn a benign backend change into an outage —
  // so nothing upstream of here constrains what a payload actually holds, and
  // the two casts below this comment's reach (`dataset.rows as unknown[][]`,
  // `card_data as Record<string, unknown>`) assert a shape rather than check
  // one. A `rows: [[1], "oops"]` or an ARRAY `card_data` therefore passed the
  // wire guard and then failed the tool's OWN outputSchema — and `mcp.ts`
  // serves a non-conforming structuredContent anyway (it logs and moves on),
  // so a spec-compliant client discards the whole billed result, text block
  // included.
  //
  // Parsing against the shape we publish covers every branch here and every
  // branch added later, which a per-branch guard would not. A card that fails
  // ships with NO `rows`: `exportable` and `total_rows` still route the model
  // to `tako_contents`, which is a worse answer than inlined rows and a much
  // better one than a discarded response.
  const conforms = projectedCardRowsShape.safeParse(out);
  if (!conforms.success) {
    // The card's own `content` carries no `request_id`, so passing it here
    // logged `tool=projectCardRows request_id=(none)` — the one guard that
    // drops a payload the caller was BILLED for, and the only one an on-call
    // could tie to neither a tool nor a backend request.
    logWireGuardFailure(
      log?.toolName ?? "projectCardRows",
      "inlined-rows",
      conforms.error,
      log === undefined ? undefined : { request_id: log.requestId },
    );
    return undefined;
  }
  return out;
}

// No list of "the channels projectCardRows reads" lives here any more, and
// that is the point. It was a hand-retyped copy of {@link CONTENT_PAYLOAD_KEYS}
// compared to it by a test — which meant a fifth upstream channel went GREEN as
// soon as someone added the name here, with no branch above to read it: the
// silent drop that guard was written to prevent. The old `ROWS_KEYS` did not
// have that hole because it was derived AND drove the loop; a list that only a
// test reads cannot inherit that property.
//
// `_search_results.test.ts` now feeds `projectCardRows` one sample per key of
// `CONTENT_PAYLOAD_KEYS` and asserts each comes back projected, so the guard
// fails until a real branch exists. Do not reintroduce a name list to satisfy
// it.

/**
 * Identifies the call behind a dropped row payload. Threaded from
 * {@link buildSearchOutput}, which holds both halves; see `projectCardRows`
 * for why it is optional.
 */
export interface CardProjectionLog {
  toolName: SearchToolName;
  requestId: string;
}

/** Project one wire card into the model-facing shape. Pure and immutable. */
export function projectCard(
  card: TakoCard,
  capRows: number | "all" | null,
  log?: CardProjectionLog,
): ProjectedCard {
  const rec = card as Record<string, unknown>;
  const out: ProjectedCard = { exportable: card.exportable ?? card.content != null };
  const title = nonEmpty(card.title);
  if (title !== undefined) out.title = title;
  const description = nonEmpty(card.description);
  if (description !== undefined) out.description = description;
  const url = nonEmpty(card.webpage_url);
  if (url !== undefined) out.url = url;
  const sources = sourceNamesOf(rec);
  if (sources.length > 0) out.source = sources.join(", ");
  const freshness = rec.data_freshness;
  if (freshness !== null && typeof freshness === "object") {
    const f = freshness as Record<string, unknown>;
    // BOTH dates, because they answer different questions and every member of
    // `DataFreshness` is optional AND nullable. Reading `last_updated` alone
    // left a card shipping `{coverage_end: "2026-06", last_updated: null}` with
    // no freshness at all, and left every other card claiming a refresh date
    // where the model needed the coverage date: a card refreshed today can end
    // in 2024, so `last_updated` cannot answer "is this the latest figure?".
    //
    // `dateOnly` passes reduced precision through untouched (its regex needs a
    // full YYYY-MM-DD), which is required here — `coverage_end` reports at the
    // series' own granularity.
    const coverageEnd = dateOnly(f.coverage_end);
    if (coverageEnd !== undefined) out.coverage_end = coverageEnd;
    const updated = dateOnly(f.last_updated);
    if (updated !== undefined) out.last_updated = updated;
  }
  // One relevance field: the entitled numeric relevance_score when present
  // (dropping it would silently remove a paid feature's output), else the
  // coarse "High"/"Low" string every account gets.
  const relevanceScore = rec.relevance_score;
  const relevance =
    typeof relevanceScore === "number" ? String(relevanceScore) : nonEmpty(rec.relevance);
  if (relevance !== undefined) out.relevance = relevance;
  if (Array.isArray(card.nodes) && card.nodes.length > 0) {
    out.nodes = card.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type }));
  }
  // total_rows is lifted OUT of `content` so the count survives the drop of
  // the export descriptor. Locked cards ship `content: null`, so no count
  // exists to report there — by design (a fabricated 0 would read as "no
  // data exists" when the truth is "data you can't have").
  const content = card.content as Record<string, unknown> | null | undefined;
  if (content != null) {
    const dataset = content.dataset as Record<string, unknown> | null | undefined;
    const totalRows =
      typeof content.total_rows === "number"
        ? content.total_rows
        : dataset != null && typeof dataset.total_rows === "number"
          ? dataset.total_rows
          : undefined;
    // GATED ON `exportable`, matching the field's own published describe
    // ("Rows behind `url` (exportable cards only)"). The text channel renders
    // the count only in the exportable arm, so a count on a locked card would
    // sit in structuredContent and nowhere else — a channel-equivalence hole,
    // against a promise already published to clients. Today the backend's
    // shared export gate (TakoData/tako#27989) means a locked card ships
    // `content: null` and never reaches here; the guard is what keeps the two
    // channels agreeing if that ever changes.
    if (totalRows !== undefined && out.exportable) out.total_rows = totalRows;
    // Rows ride only when the caller asked to inline them; the null-noise
    // keys and the billing descriptor never do.
    if (capRows !== null) {
      const capped = slimCardContent(card.content, capRows) as
        | Record<string, unknown>
        | null
        | undefined;
      if (capped != null) {
        const manifest = Array.isArray(capped.manifest)
          ? (capped.manifest as Array<Record<string, unknown>>)
          : undefined;
        const rows = projectCardRows(capped, manifest, log);
        if (rows !== undefined) out.rows = rows;
      }
    }
  }
  return out;
}

/** Project one wire web result into the model-facing shape. */
export function projectWebResult(w: WebResult, keepWebText: boolean): ProjectedWebResult {
  const rec = w as Record<string, unknown>;
  const out: ProjectedWebResult = { url: w.url };
  const title = nonEmpty(w.title);
  if (title !== undefined) out.title = title;
  if (w.snippet !== undefined) out.snippet = w.snippet ?? null;
  const source = nonEmpty(rec.source_name);
  if (source !== undefined) out.source = source;
  if (rec.publish_date !== undefined) out.published = dateOnly(rec.publish_date) ?? null;
  if (keepWebText) {
    const content = rec.content as Record<string, unknown> | null | undefined;
    if (content != null) {
      const kept: Record<string, unknown> = {};
      for (const key of ["data", "truncated"]) {
        const v = content[key];
        if (v !== null && v !== undefined) kept[key] = v;
      }
      if ("data" in kept) out.content = kept;
    }
  }
  return out;
}

/**
 * One follow-up query, projected.
 *
 * `RelatedSuggestion` ships three fields and the wire sends `node_ids: []`
 * whenever the graph could not resolve them — an empty array per suggestion in
 * both channels, and one the text channel had no way to render, so it was a
 * structured-only field on a tool whose text channel 9 audited harnesses read
 * as the whole result. Empty arrays are dropped; a resolved one rides, because
 * pinning the follow-up is what the ids are for.
 */
export const projectedRelatedQueryShape = z.looseObject({
  query: z.string().describe("Send this as the `query` of the next search request."),
  description: z.string().optional().describe("What the query asks for, when its text does not say."),
  node_ids: z
    .array(z.string())
    .optional()
    .describe("Pass as `data.node_ids` on the follow-up to return this data."),
});

export type ProjectedRelatedQuery = z.infer<typeof projectedRelatedQueryShape>;

export function projectRelatedQuery(r: z.infer<typeof RelatedSuggestion>): ProjectedRelatedQuery {
  const out: ProjectedRelatedQuery = { query: r.query };
  const description = nonEmpty(r.description);
  if (description !== undefined) out.description = description;
  if (Array.isArray(r.node_ids) && r.node_ids.length > 0) out.node_ids = r.node_ids;
  return out;
}

/**
 * The two reference-prose maps, deduped ACROSS cards (spec, "Per-tool shape"):
 *
 *   - `metric_definitions`: what each metric MEANS — the misquote-preventer
 *     (unit, basis, the "segment revenue ≠ total revenue" caveat). Keyed by
 *     the metric name the cards already carry; a same-name-different-text
 *     conflict disambiguates the key with the card's source ("Revenue —
 *     Fiscal.ai") so text is never dropped.
 *   - `source_notes`: who a source is and how it builds its data — the
 *     source_description and methodology_description paragraphs merged under
 *     `sourceKeyOf`, the card's whole `source` string. Same-key different
 *     text joins with a blank line.
 *
 * Both serialize LAST in both channels so truncating hosts lose reference
 * prose before data. Empty maps are omitted (the backend sends paragraphs on
 * some sources only).
 */
export function buildReferenceMaps(cards: readonly TakoCard[]): {
  metric_definitions?: Record<string, string>;
  source_notes?: Record<string, string>;
} {
  // NULL-PROTOTYPE, and the type system cannot enforce it. Every key here is an
  // upstream string (`source_name`, `methodology_name`, a metric `name`), so a
  // source called `constructor` or `toString` reads back Object.prototype's
  // member instead of undefined; `appendNote` then calls `.includes` on a
  // function and throws, failing the call AFTER the backend round-trip is
  // billed. Both maps are typed `Record<string, string>`, so `existing` is a
  // `string` at compile time and every lookup below typechecks.
  const metricDefs: Record<string, string> = Object.create(null);
  const sourceNotes: Record<string, string> = Object.create(null);
  const addMetric = (name: string, text: string, source: string | undefined): void => {
    if (metricDefs[name] === undefined) {
      metricDefs[name] = text;
      return;
    }
    if (metricDefs[name] === text) return;
    const preferred = source !== undefined ? `${name} — ${source}` : undefined;
    if (preferred !== undefined && (metricDefs[preferred] === undefined || metricDefs[preferred] === text)) {
      metricDefs[preferred] = text;
      return;
    }
    let i = 2;
    while (metricDefs[`${name} (${i})`] !== undefined && metricDefs[`${name} (${i})`] !== text) i += 1;
    metricDefs[`${name} (${i})`] = text;
  };
  const appendNote = (key: string, text: string): void => {
    const existing = sourceNotes[key];
    if (existing === undefined) sourceNotes[key] = text;
    else if (!existing.includes(text)) sourceNotes[key] = `${existing}\n\n${text}`;
  };
  for (const card of cards) {
    const rec = card as Record<string, unknown>;
    const sources = sourceNamesOf(rec);
    if (Array.isArray(rec.metric_definitions)) {
      for (const entry of rec.metric_definitions) {
        if (entry === null || typeof entry !== "object") continue;
        const def = entry as Record<string, unknown>;
        const name = nonEmpty(def.name);
        const text = nonEmpty(def.definition);
        // `sourceKeyOf`, never `sources[0]`: the suffix has to name the card's
        // WHOLE source string. With `sources[0]` a two-source card's definition
        // filed as "Revenue — Fiscal.ai" while a DIFFERENT, Fiscal.ai-only card
        // owned the bare "Revenue" — so the suffix attributed a blended
        // definition to one source that did not produce it. A wrong definition
        // under a plausible source name is the misquote this map exists to
        // prevent.
        if (name !== undefined && text !== undefined) addMetric(name, text, sourceKeyOf(sources));
      }
    }
    if (Array.isArray(rec.sources)) {
      for (const entry of rec.sources) {
        if (entry === null || typeof entry !== "object") continue;
        const src = entry as Record<string, unknown>;
        const name = nonEmpty(src.source_name);
        const text = nonEmpty(src.source_description);
        // `sourceKeyOf`, never the bare `source_name`. A card carries ONE
        // source field and it is the joined list, so on a two-source card a
        // note filed under "Fiscal.ai" is prose no card can reach: the map
        // held "Fiscal.ai", "S&P Global" AND "Fiscal.ai, S&P Global", and the
        // only key `source` matched carried the methodology alone, with both
        // source descriptions unattributable.
        //
        // The name moves into the VALUE when the key names more than one
        // source: two descriptions under one key otherwise merge into a blob
        // with nothing saying which source each sentence is about. Generated
        // `TakoCardSource.source_description` is "The description of the
        // source" and does not promise to name it.
        const key = sourceKeyOf(sources);
        if (name !== undefined && text !== undefined && key !== undefined) {
          appendNote(key, sources.length > 1 ? `${name}: ${text}` : text);
        }
      }
    }
    if (Array.isArray(rec.methodologies)) {
      for (const entry of rec.methodologies) {
        if (entry === null || typeof entry !== "object") continue;
        const m = entry as Record<string, unknown>;
        const text = nonEmpty(m.methodology_description);
        if (text === undefined) continue;
        // NEVER `methodology_name` (spec: "bare methodology_name dies"). It
        // appears on no projected card, so a note filed under it is prose the
        // model can read and cannot attribute — the exact failure these maps
        // replaced. A card naming no source has no key at all and the note is
        // dropped: the paragraph already names its own source (the generated
        // KnowledgeCardMethodology calls it "the source and what it measures"),
        // so an unattributable copy adds nothing a reader can act on.
        const key = sourceKeyOf(sources);
        if (key !== undefined) appendNote(key, text);
      }
    }
  }
  const out: { metric_definitions?: Record<string, string>; source_notes?: Record<string, string> } = {};
  if (Object.keys(metricDefs).length > 0) out.metric_definitions = metricDefs;
  if (Object.keys(sourceNotes).length > 0) out.source_notes = sourceNotes;
  return out;
}

// The PROJECTED card/web-result element schemas — real typed shapes, since
// the projection controls every key. Elements stay `.loose()` as a belt
// (an added projection field ships before its schema line in a bad merge),
// but the projection, not this schema, is the drift guard now.
export const projectedCardShape = z.looseObject({
  title: z.string().optional(),
  description: z.string().optional().describe("Headline value and range — often the answer itself."),
  exportable: z.boolean().describe("true → tako_contents on `url` returns the rows; false → rows are locked, read the headline from `description`."),
  url: z.string().optional().describe("The card page — the tako_contents handle."),
  source: z.string().optional(),
  coverage_end: z
    .string()
    .optional()
    .describe(
      'Where the DATA ends — use this, not `last_updated`, to judge whether a figure is current. Reduced ISO precision at the series\' own granularity ("2026", "2026-06", "2026-06-30"), and it can be in the future on a card with projections.',
    ),
  last_updated: z.string().optional().describe("Date Tako last refreshed this card — NOT where its data ends."),
  total_rows: z.number().int().optional().describe("Rows behind `url` (exportable cards only)."),
  // TWO forms in one string field, and the model has to be told which it got:
  // entitled accounts get the numeric score ("4.5" on a 1.0-5.0 scale, 5.0 =
  // exact match), every other account gets the coarse word. Undescribed, "3"
  // reads as a rank or a count beside a neighbouring card's "High".
  relevance: z
    .string()
    .optional()
    .describe('Either a 1.0-5.0 score as a string ("4.5", 5.0 = exact match) on entitled accounts, or a coarse word ("High"). Higher is more relevant in both forms.'),
  nodes: z.array(projectedNodeSchema).optional().describe("Graph handles — pass ids to tako_graph_related."),
});

/** The card `tako_search_advanced` publishes: the same nine fields plus the
 *  rows only it can inline. Split from {@link projectedCardShape} for the
 *  reason the answer-fold fields are split from the core shape — a tool must
 *  not advertise a field it cannot return. `tako_search` passes `rowCap: null`
 *  on every call, so `rows` there was 711 chars of schema describing an
 *  outcome its handler makes unreachable. */
export const projectedCardWithRowsShape = projectedCardShape.extend({
  rows: projectedCardRowsShape
    .optional()
    .describe("Inlined rows — only when the request asked to inline them."),
});
export const projectedWebResultShape = z.looseObject({
  title: z.string().optional(),
  url: z.string(),
  snippet: z
    .string()
    .nullable()
    .optional()
    // NEVER assert the cause, always keep the action. `f5fd69d` measured this:
    // the backend emits `" … "` in one place, but a source page's own ellipsis
    // survives cleaning and is indistinguishable from it — the text arm, which
    // structurally cannot carry a backend join, still reported 2 of 260. Zero
    // joins were confirmed in that run. A consumer cannot tell the two apart
    // either, so the contract names the discontinuity and what to do about it.
    // "the published snippet contract" in _search_results.test.ts pins the
    // actionable clause; three commits have now moved this string.
    .describe(
      "Passages selected against the query. A ' … ' marks a discontinuity — joined passages or the page's own ellipsis — so never quote across it as one sentence. null → no relevant passage, url still fetchable.",
    ),
  source: z.string().optional(),
  published: z.string().nullable().optional(),
  content: z.looseObject({}).optional().describe("Page text — only when the request asked for it."),
});

// `searchOutputShape` lived here and was DELETED: an exported object literal
// that no tool published and nothing imported. It looked like the search
// surface's declared shape, so a change meant for the wire — `related` retyped
// from the wire suggestion to `projectedRelatedQueryShape` — was made here and
// shipped nothing. The shapes tools actually publish are in
// `_render_markdown.ts` (`searchGenericOutputShape`, `searchChatgptOutputShape`,
// `searchAdvancedOutputShape`); `SearchOutput` below types the handler return.

/** What every search handler returns, before `mcp.ts` narrows it per surface.
 *  A TYPE, not a published schema: the widget fields at the bottom ride on
 *  `/mcp/chatgpt` only, and `pickDeclared` is what drops them elsewhere. */
export type SearchOutput = {
  cards: ProjectedCard[];
  web_results: ProjectedWebResult[];
  usage: Usage | null;
  request_id: string;
  guidance?: string;
  metric_definitions?: Record<string, string>;
  source_notes?: Record<string, string>;
  related?: ProjectedRelatedQuery[];
  answer?: string;
  structured_output?: Record<string, unknown>;
  structured_output_error?: z.infer<typeof AnswerStructuredOutputError>;
  pub_id?: string;
  embed_url?: string;
  image_url?: string;
  dark_mode?: boolean;
  width?: number;
  height?: number;
};

// Which sources a search actually hit, for tailoring zero-result guidance.
// searchedData is exported for the answer path's data-gap guidance gate — one
// definition of "did this request search the data source" across both tools.
export type SearchedSources = ReadonlyArray<"data" | "web">;
export const searchedData = (s: SearchedSources): boolean => s.includes("data");
const searchedWeb = (s: SearchedSources): boolean => s.includes("web");

/** Which tool a guidance string is being written for. Guidance names an
 *  ARGUMENT the model then sends, and the two tools spell the same request
 *  differently, so one shared string cannot be right for both. */
export type SearchToolName = "tako_search" | "tako_search_advanced";

/**
 * How each tool spells "search data and web".
 *
 * `tako_search` publishes a `sources` ARRAY. `tako_search_advanced` publishes
 * no `sources` key at all — it takes the two blocks at the TOP level, and
 * every level is `.strict()`, so a `sources` key there is a -32602 before the
 * request leaves the Worker. Both guidance builders named `tako_search`'s form
 * unconditionally, which put an unsendable argument on the two paths that
 * exist to stop a priced retry loop: the model's one recovery step failed
 * schema validation.
 *
 * The OBJECT is the source of truth and the prose is derived from it, so the
 * advertised argument cannot drift from the sendable one.
 * `_search_results.test.ts` parses each entry against that tool's own
 * published input schema, which is the assertion a hand-written string could
 * never carry.
 */
export const BOTH_SOURCES_ARG: Record<SearchToolName, Record<string, unknown>> = {
  tako_search: { sources: ["data", "web"] },
  tako_search_advanced: { data: {}, web: {} },
};

/** {@link BOTH_SOURCES_ARG} as the fragment a caller pastes into its arguments
 *  object — the braces stripped, so it reads as "add these keys". */
const bothSourcesArg = (tool: SearchToolName): string =>
  `\`${JSON.stringify(BOTH_SOURCES_ARG[tool]).slice(1, -1)}\``;

// REFINE_WEB_FREELY was deleted with the two-sentence guidance rewrite: its
// carve-out ("refining a WEB query converges; hunting for a CARD does not")
// is now scoped into each branch's verdict sentence, and the fan-out-narrow-
// queries lesson lives in the tool description. The measured incident that
// created it (a blanket no-re-search ban losing docs questions to a
// competing web-search MCP by 5-6 targeted calls) stays the reason the
// verdicts blame the DATA GRAPH, never re-searching as such.

/**
 * The verdict when a `strict: true` pin returned nothing: about the FILTER, not
 * about coverage. Shared by BOTH endpoints' zero-card paths — the answer path
 * reaches it through `tako_search_advanced`, which is the only pin-capable tool.
 *
 * IT WINS OVER EVERY OTHER ZERO-CARD VERDICT, and the caller in
 * `buildSearchOutput` is the one place that ordering lives. Every other verdict
 * reports something about COVERAGE, and under a hard filter that report is
 * unsupported: a `strict: true` pin returns only cards matching a pinned node,
 * and the graph holds near-duplicate metric nodes where only one twin carries
 * cards. KE-812 measured pinned handles returning FEWER cards than the same
 * query unpinned on 11 of 20 pairs. Reporting a coverage gap there is
 * mid-failure copy that contradicts the tool's own description, which tells the
 * caller to drop `node_ids` and retry.
 */
export function strictPinGuidance(tier: Tier): string {
  // Two sentences (spec, "guidance" decision): the verdict and the one next
  // action. Under a `strict: true` pin, zero cards is evidence about the
  // FILTER, not coverage — KE-812 measured pinned handles returning FEWER
  // cards than the same query unpinned on 11 of 20 pairs. Reachable only from
  // `tako_search_advanced`, which never executes anonymously — `tier` stays a
  // parameter so this signature cannot silently diverge from the other
  // branches if that invariant (held in `_surface.ts`) ever moves.
  void tier;
  return [
    "No data cards, but this request pinned `node_ids` with `strict: true` — a hard filter — so zero cards is evidence about the filter, not about coverage.",
    "Re-run the same query text without `node_ids` before concluding anything.",
  ].join(" ");
}

/**
 * The zero-data-card verdict for the ANSWER endpoint, worded by whether web
 * results ground the answer. With web grounding the prose may be a complete,
 * correct answer (e.g. "who won the game?") — the verdict must scope itself to
 * the data index, not read as "this answer failed". Without web grounding it
 * is the hard anti-retry stop. Both are deterministic (cards.length === 0),
 * never inferred from the prose.
 *
 * TWO SENTENCES PER BRANCH, like every other guidance branch: the verdict
 * (which corpora this response is evidence about) and the one next action
 * (spec, "guidance" decision). These three were the last branches left at the
 * old length — five to six sentences, up to 740 chars, three of them spent on
 * anti-instructions ("do NOT rephrase-and-retry", "Do NOT reach for
 * tako_contents") that restate what the one action already implies.
 *
 * `searchedWebToo` is what keeps the no-web-results branch honest. It used to
 * read "ZERO curated data cards (and no web results)" off `hasWebResults`
 * alone, so a deliberate `sources: ["data"]` ask — where the web was never
 * queried — was told the web had come back empty as well, and then told to
 * treat the metric as absent. Two sources' worth of verdict from one source's
 * evidence. When web was not searched, the honest recovery is to search it.
 */
export function buildDataGapGuidance(
  hasWebResults: boolean,
  searchedWebToo: boolean,
  toolName: SearchToolName,
  registered?: ReadonlySet<string>,
): string {
  // A tool RESULT that names a tool is an instruction the model acts on, and
  // `?tools=` REPLACES the defaults — `?tools=search_advanced` registers this
  // tool ALONE, so on the connection that reaches this function most often
  // `tako_available_data` is unregistered and naming it resolved to the SDK's
  // bare "tool not found".
  const coverage = registered === undefined || registered.has("tako_available_data");
  if (!hasWebResults && !searchedWebToo) {
    return [
      "No data cards ground this answer, and this request searched the data source only, so it says nothing about web coverage.",
      `Re-ask with both sources — add ${bothSourcesArg(toolName)} — at the same price before treating the figure as unavailable.`,
    ].join(" ");
  }
  if (hasWebResults) {
    return [
      "No data cards ground this answer — it is web-grounded only, so use the prose if it answers the question.",
      coverage
        ? "For Tako's own series instead, get the metric's canonical name from tako_available_data and re-ask once on that name."
        : "For Tako's own series instead, re-ask once naming the metric and the period you need.",
    ].join(" ");
  }
  // The web carve-out rides in this branch's second sentence as a clause, not
  // as its own sentence, and it is not optional: the SEARCH path's both-empty
  // branch permits one narrower web question, and these two surfaces once gave
  // opposite verdicts on the most common Tako-has-nothing path. A model that
  // reads both learns one of them is wrong. `_search_results.test.ts` holds the
  // invariant across both branches, not the wording.
  return [
    "Neither data cards nor web results ground this answer, so treat the metric as absent for this phrasing — rewording alone will not change that, and every retry is priced.",
    coverage
      ? "Confirm coverage once with tako_available_data and re-ask on the canonical name it returns, or try one genuinely narrower web question — one entity, provider or site — then answer from another source."
      : "Try one genuinely narrower web question — one entity, provider or site — then answer from another source.",
  ].join(" ");
}

/**
 * Recovery protocol for a zero-CARD search. Rewording the same query almost
 * never flips a miss into a hit — misses come from query SHAPE (compound
 * query, brand instead of domain, unresolved entity) or from the data simply
 * not being covered, and every retry is a priced call the model burns on a
 * loop that never converges.
 *
 * This protocol is mirrored in the three bundled skills' SKILL.md files
 * under skills/ and their embedded copies in README.md, each as the
 * "Zero cards?" workflow step. What must stay consistent is the
 * RECIPE — free tako_available_data check → ONE retry on the exact metric
 * NAME → stop and answer from the web results — not the phrasing;
 * pin an invariant here rather than a quoted sentence, so a reworded skill
 * does not silently make this comment a lie. Update all four copies together.
 *
 * NOTHING HERE PINS ANY MORE, and the skills never did. This guidance used to
 * interpolate {@link PINNED_RETRY}; after the D4 split `tako_search` takes no
 * `node_ids` / `strict`, so a pin recipe here would prescribe parameters the
 * tool rejects. The two arms now agree on the canonical NAME, which is also the
 * arm the measurement favours: 11 of 20 handles retrieved FEWER cards pinned
 * than unpinned, while the canonical name helped 9 of 15. `PINNED_RETRY` has no
 * production reader at all now — the answer path's last interpolation went when
 * every guidance branch was cut to two sentences, and
 * `tako_search_advanced`'s `data.node_ids` describe carries the short form.
 * Do not route it back here.
 *
 * The web-axis carve-out is deliberately NOT mirrored into those three:
 * they are data-domain skills (equity research, macro indicators, site
 * traffic) whose questions are metric lookups by construction, so the
 * data-axis recipe is the whole story there. The carve-out matters for the
 * TOOL guidance, which serves arbitrary questions — including ones with no
 * data answer at all. Absence from the skills is the intended state, not
 * drift.
 */
/**
 * The recovery protocol a zero-card search ships in its own result.
 *
 * TIER-BRANCHED, unlike every description and the `initialize` string. Those
 * ride the host's cached prefix and are read once; this is a tool RESULT,
 * appended after that prefix and true at the moment the model reads it — the
 * same slot `authRequiredToolResult` occupies. Branching it costs no prompt
 * cache: the prefix is byte-identical either way.
 *
 * It has to branch, because the authenticated protocol routes through
 * `tako_available_data` and `tako_contents`, and an anonymous caller has
 * NEITHER — `tako_search` is the whole anonymous surface. Unbranched, a
 * zero-result anonymous caller got numbered steps in which every step
 * answers a sign-in refusal.
 *
 * NO `strictPin` PARAMETER. The pin verdict outranks every branch here, so the
 * decision lives in `buildSearchOutput`'s ternary, which reaches
 * `strictPinGuidance` directly and never calls this function under a pin. It
 * was a parameter once; the sole caller passed a literal `false`, which left
 * the rule written in two places and a dead branch documented as live.
 */
function buildZeroResultGuidance(
  hasWebResults: boolean,
  sources: SearchedSources,
  tier: Tier,
  toolName: SearchToolName,
  registered?: ReadonlySet<string>,
): string {
  // Every branch is exactly TWO sentences: the verdict (which corpora this
  // response is evidence about) and the one next action (spec:
  // 2026-08-26-model-facing-surface-redesign-design.md, "guidance" decision).
  // Static lessons — query shape, domains-not-brands, the coverage-check-first
  // recipe — live in the tool description and are NOT repeated here.
  //
  // THREE STATES PER TOOL, not two, and tier is only one of them. This
  // branched on `tier === "free"` alone, which is the wrong predicate: a
  // SIGNED-IN `?tools=search` caller registers `tako_search` and nothing else
  // (`?tools=` replaces the defaults, spec D1), took the authenticated arm,
  // and was told to "call tako_available_data (free)" — a tool that
  // connection never registered, whose call resolves to the SDK's bare "tool
  // not found".
  //
  //   "callable" — registered and executable now: name it as the next step.
  //   "gated"    — registered but auth-required on the free tier: the refusal
  //                itself is the conversion prompt, so name it AND say so.
  //   "absent"   — not on this connection at all: never name it.
  //
  // `registered === undefined` means a caller with no registration
  // information (tests, direct handler calls); it degrades to tier-only,
  // which is the behavior before the registered set existed.
  const reach = (name: string): "callable" | "gated" | "absent" => {
    if (registered !== undefined && !registered.has(name)) return "absent";
    return tier === "free" ? "gated" : "callable";
  };
  const coverage = reach("tako_available_data");
  const contents = reach("tako_contents");
  // The strict-pin case never reaches this function: `buildSearchOutput`
  // dispatches it to `strictPinGuidance` first, because under a hard filter
  // every verdict below is unsupported.
  if (hasWebResults) {
    if (!searchedData(sources)) {
      // Web-only search: zero cards BY CONSTRUCTION — no data verdict exists.
      return [
        "This search ran on the web source only, so it says nothing about whether Tako's data graph covers this.",
        coverage === "callable"
          ? `Answer from the web_results; if you want a chart or dataset, re-run with ${bothSourcesArg(toolName)} (same price) or check tako_available_data (free).`
          : `Answer from the web_results; if you want a chart or dataset, re-run with ${bothSourcesArg(toolName)} (same price).`,
      ].join(" ");
    }
    const readPage =
      contents === "callable"
        ? "tako_contents on the most relevant url fetches its full page text"
        : contents === "gated"
          ? "their snippets are in the result; reading a page in full needs a signed-in connection"
          : "their snippets are in the result";
    const thenCoverage =
      coverage === "callable"
        ? "; if you specifically need a chart or dataset, run tako_available_data (free) once and re-search only on the canonical name it returns."
        : ".";
    return [
      "No data cards: the data graph does not cover this query, and rewording alone will not change that.",
      `Answer from the web_results (${readPage})${thenCoverage}`,
    ].join(" ");
  }
  if (!searchedData(sources)) {
    // Web-only search, nothing back: the query is the only lever there is.
    return [
      "The web returned nothing for this query, and the data source was not searched, so this says nothing about Tako's coverage.",
      coverage === "callable"
        ? "Refine to one entity, provider, or site per query and re-search; for a data metric, check tako_available_data (free) first."
        : "Refine to one entity, provider, or site per query and re-search.",
    ].join(" ");
  }
  const narrowerWeb = searchedWeb(sources) ? ", or try one genuinely narrower web question" : "";
  const action =
    coverage === "callable"
      ? `Call tako_available_data (free) to learn the canonical metric name and spend one retry on that name${narrowerWeb}; if it shows no coverage, answer from other sources.`
      : coverage === "gated"
        ? "Make at most one reshaped retry (one metric per query; bare domains for website traffic), then answer from other sources — the coverage check, tako_available_data, needs a signed-in connection."
        : `Make at most one reshaped retry (one metric per query; bare domains for website traffic)${narrowerWeb}, then answer from other sources.`;
  return [
    "No results: either the query shape is off or Tako does not cover this — rewording alone will not change that, and every retry is priced.",
    action,
  ].join(" ");
}

/**
 * The newest data point a card actually carries, as a comparable epoch
 * magnitude — derived from the rows already parsed, so it needs no extra
 * field to be populated and cannot be fooled by a title.
 *
 * null when the card carries no temporal rows: an Overview/summary card, or
 * any card under `include_contents: false`.
 */
function latestDataPoint(card: TakoCard): number | null {
  const content = card.content as LooseContent | null | undefined;
  if (content == null) return null;
  const magnitudes: number[] = [];
  const dataset = content.dataset;
  if (dataset && Array.isArray(dataset.rows)) {
    const idx = temporalColumnIndex(dataset.columns);
    if (idx >= 0) {
      for (const row of dataset.rows) {
        if (!Array.isArray(row)) continue;
        const m = comparableEpoch(row[idx]);
        if (m !== null) magnitudes.push(m);
      }
    }
  } else if (Array.isArray(content.records) && content.records.length > 0) {
    const key = recordDateKey(content.records);
    if (key !== undefined) {
      for (const record of content.records) {
        const m = comparableEpoch(record[key]);
        if (m !== null) magnitudes.push(m);
      }
    }
  }
  return magnitudes.length === 0 ? null : Math.max(...magnitudes);
}

/**
 * The card's declared as-of date as an epoch magnitude. The backend ships
 * `data_freshness` as an OBJECT (`{"data_as_of": "2026-03-31"}`) on search
 * cards and as a bare string elsewhere — accept both, the same way the
 * markdown renderer does.
 *
 * Goes through `comparableEpoch`, not `temporalMagnitude`, for the same reason
 * `latestDataPoint` does: this feeds a CROSS-CARD comparator, so a bare numeric
 * `data_as_of` (`2024`) passed through unchanged would be compared against
 * ~1.7e12 from any string-dated card in the same as-of tier. The backend ships
 * strings today and nothing is broken, but the rule worth being able to state
 * without exception is that every cross-card comparison normalises first.
 */
function freshnessEpoch(card: TakoCard): number | null {
  const value = (card as Record<string, unknown>).data_freshness;
  if (typeof value === "string") return comparableEpoch(value);
  if (value !== null && typeof value === "object") {
    return comparableEpoch((value as { data_as_of?: unknown }).data_as_of);
  }
  return null;
}

const RELEVANCE_WORDS: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Retrieval relevance as a number: the gated numeric score, else the coarse
 *  word unentitled responses carry instead, else 0. */
function relevanceRank(card: TakoCard): number {
  const rec = card as Record<string, unknown>;
  if (typeof rec.relevance_score === "number") return rec.relevance_score;
  if (typeof rec.relevance === "string") {
    return RELEVANCE_WORDS[rec.relevance.trim().toLowerCase()] ?? 0;
  }
  return 0;
}

/**
 * Order cards most-useful-first. ORDERING ONLY — no card is dropped, nothing
 * is folded, and every tie falls back to the backend's own order.
 *
 * Why this exists: the backend's rank is not recency-aware, and its #1 can be
 * materially staler than its #2. Measured on prod (2026-07-29),
 * `tako_search "US inflation rate"` returned `United States Inflation Rate`
 * (latest row 2024-01-01, 2.9%) ABOVE `United States CPI Inflation Rate
 * (Seasonally Adjusted)` (latest row 2026-06-01, 3.5%). A model reading the
 * document top-down answers from card #1 and reports a 2½-year-old figure as
 * current — a wrong number carrying a citation, which is the worst failure
 * this server can produce. Separately, `Earnings & Estimates Overview` cards
 * (no rows at all) were observed outranking the actual series card.
 *
 * The comparator, in order:
 *   1. cards WITH temporal rows above cards without (series beats Overview)
 *   2. fresher newest-data-point first
 *   3. fresher declared `data_as_of` first (the fallback when rows are absent,
 *      e.g. `include_contents: false`)
 *   4. higher retrieval relevance
 *   5. backend order (stable)
 *
 * Deliberately NOT recency-aware in one respect: an explicitly historical ask
 * ("annual inflation since 1960") wants the older annual series, which this
 * demotes to #2. Demotion is recoverable — the card is still present with its
 * range in the description — which is exactly why this orders instead of
 * pruning.
 */
export function orderCardsByUsefulness(cards: readonly TakoCard[]): TakoCard[] {
  // Decorate-sort-undecorate: computes each signal once, and makes the sort
  // stable regardless of engine so ties keep the backend's ordering.
  return cards
    .map((card, index) => ({
      card,
      index,
      rows: latestDataPoint(card),
      asOf: freshnessEpoch(card),
      relevance: relevanceRank(card),
    }))
    .sort((a, b) => {
      const aHasRows = a.rows !== null;
      const bHasRows = b.rows !== null;
      if (aHasRows !== bHasRows) return aHasRows ? -1 : 1;
      if (a.rows !== null && b.rows !== null && a.rows !== b.rows) return b.rows - a.rows;
      // Declaring an as-of date is itself evidence of a dated series, the same
      // way carrying temporal rows is. Without this, two row-less cards tie and
      // fall through to backend order — which is how `Earnings & Estimates
      // Overview` (no freshness) kept rank 1 over `Actuals - Normalized Gross
      // Margin` (freshness 2025-12-31) on a gross-margin query, both being
      // exportable:false and therefore row-less.
      const aHasAsOf = a.asOf !== null;
      const bHasAsOf = b.asOf !== null;
      if (aHasAsOf !== bHasAsOf) return aHasAsOf ? -1 : 1;
      if (a.asOf !== null && b.asOf !== null && a.asOf !== b.asOf) return b.asOf - a.asOf;
      if (a.relevance !== b.relevance) return b.relevance - a.relevance;
      return a.index - b.index;
    })
    .map((d) => d.card);
}

/** Wire fields that ride into the output when the request asked for them. */
export type SearchOutputExtras = {
  related?: z.infer<typeof RelatedSuggestion>[];
  // The three /v1/answer fields. `answer` also SWITCHES behavior below: it
  // picks the data-gap verdict over the search verdict, and it gates the
  // citation-order check.
  answer?: string;
  structured_output?: Record<string, unknown>;
  structured_output_error?: z.infer<typeof AnswerStructuredOutputError>;
};

/**
 * Build the tako_search output: the cards + web_results + request_id, plus
 * auto-chain widget fields lifted from the top card when it has a card_id
 * (so the host renders that chart inline). Endpoint-agnostic — only needs
 * a card_id, which v3 TakoCards carry.
 */
export function buildSearchOutput(
  rawCards: TakoCard[],
  webResults: WebResult[],
  requestId: string,
  usage: Usage | null,
  env: Env,
  searchedSources: SearchedSources,
  strictPin: boolean,
  tier: Tier,
  opts: {
    /** Per-card inline row budget: `null` drops every row (tako_search),
     *  "all" keeps what the backend sent, a number caps to the N most
     *  recent (tako_search_advanced). */
    rowCap: number | "all" | null;
    /** Keep web page text — true only when the request set
     *  `sources.web.include_contents` (tako_search_advanced). */
    keepWebText: boolean;
    /** The tool names THIS connection registered (`ctx.registeredTools`).
     *  The zero-result guidance names a recovery tool only when the
     *  connection can actually call it — `?tools=` replaces the defaults, so
     *  tier alone is not the predicate. Omitted by non-HTTP callers, which
     *  degrades to tier-only. */
    registeredTools?: ReadonlySet<string> | undefined;
    /** The tool this output belongs to. Guidance names an ARGUMENT, and the
     *  two tools spell the same request differently — see
     *  {@link BOTH_SOURCES_ARG}. Required, because a default would silently
     *  hand one tool's syntax to the other, which is the bug this field
     *  exists to make impossible. */
    toolName: SearchToolName;
  },
  extras: SearchOutputExtras = {},
): SearchOutput {
  // Order BEFORE projecting: the widget fields lift the TOP card, and the
  // projection drops `card_id`, so both the chart lift and the reference
  // maps read the raw ordered cards.
  //
  // UNLESS the prose cites by position. "[1]" refers to the BACKEND's card
  // order, so reordering would silently repoint every citation in the answer.
  // Observed answers carry no positional markers, so this is a safety valve —
  // but a mis-citation is worse than a stale top card, so the ordering yields.
  //
  // THE PATTERN OVER-TRIGGERS, and that is the direction to err in. Any
  // bracketed digit matches: a quoted array index, a footnote marker copied out
  // of a cited page. The cost of a false positive is a stale top card; the cost
  // of a false negative is every citation in the answer pointing at the wrong
  // source. Do not tighten this into something that can miss a real citation.
  const citesByPosition = extras.answer !== undefined && /\[\d+\]/.test(extras.answer);
  const ordered = citesByPosition ? [...rawCards] : orderCardsByUsefulness(rawCards);
  const maps = buildReferenceMaps(ordered);
  const cards = ordered.map((c) =>
    projectCard(c, opts.rowCap, { toolName: opts.toolName, requestId }),
  );
  const web = webResults.map((w) => projectWebResult(w, opts.keepWebText));
  const base: SearchOutput = {
    cards,
    web_results: web,
    usage,
    request_id: requestId,
    ...(extras.related !== undefined ? { related: extras.related.map(projectRelatedQuery) } : {}),
    ...(extras.answer !== undefined ? { answer: extras.answer } : {}),
    ...(extras.structured_output !== undefined
      ? { structured_output: extras.structured_output }
      : {}),
    ...(extras.structured_output_error !== undefined
      ? { structured_output_error: extras.structured_output_error }
      : {}),
    // A miss is billed the same as a hit, and models default to
    // rephrase-and-retry loops that never converge — so any zero-CARD
    // response carries its own recovery verdict. Keyed on cards (not cards
    // AND web) because the default ["data","web"] search almost always
    // returns some web links: gating on both would skip the guidance in
    // exactly the chart-less case the retry loop feeds on.
    ...(cards.length === 0
      ? {
          // Three verdicts, and the order matters. A strict pin makes any
          // coverage claim unsupported, so it wins on both endpoints. Otherwise
          // the ANSWER endpoint gets the data-gap wording, which scopes itself
          // to the data index rather than reading as "this answer failed" —
          // the prose above it may be a complete, correct web-grounded answer.
          guidance:
            strictPin && searchedData(searchedSources)
              ? strictPinGuidance(tier)
              : extras.answer !== undefined
                ? buildDataGapGuidance(
                    webResults.length > 0,
                    searchedSources.includes("web"),
                    opts.toolName,
                    opts.registeredTools,
                  )
                : buildZeroResultGuidance(
                    webResults.length > 0,
                    searchedSources,
                    tier,
                    opts.toolName,
                    opts.registeredTools,
                  ),
        }
      : {}),
    // Reference maps LAST so tail-truncating hosts lose prose before data.
    ...(maps.metric_definitions !== undefined
      ? { metric_definitions: maps.metric_definitions }
      : {}),
    ...(maps.source_notes !== undefined ? { source_notes: maps.source_notes } : {}),
  };
  // Branch rather than `...(x ?? {})`: spreading a union of the full field set
  // and `{}` makes every key optional again, which is exactly the widening
  // `exactOptionalPropertyTypes` rejects against `SearchOutput`.
  const chart = topCardChartFields(ordered, env);
  return chart === undefined ? base : { ...base, ...chart };
}

/**
 * Widget fields for the top card, or `{}` when there is no renderable card.
 *
 * Shared by `tako_search` and `tako_search_advanced` so a chart renders
 * identically whichever produced it. They diverged before this existed: search
 * lifted these fields and answer did not, so an answer's cited card came back as
 * text with no chart even though the card ids were right there in the output.
 *
 * Only the TOP card gets a chart — the widget renders one, and `pub_id` is
 * singular in the output schema.
 */
export function topCardChartFields(
  // `card_id` is nullable on the wire (`takoCardSchema`), so accept null here
  // rather than making each caller narrow it — the `typeof` check below is the
  // one place that decides what counts as renderable.
  cards: readonly { card_id?: string | null | undefined }[],
  env: Env,
  // Typed from `autoChainShape`, NOT `Record<string, unknown>`. These six
  // fields used to be an inline literal inside `buildSearchOutput`, checked
  // against its `SearchOutput` return type — so a renamed or mistyped key was a
  // compile error. Widening to an index signature erased exactly the check that
  // makes "the two tools cannot drift" true: `{...base, ...topCardChartFields()}`
  // would still satisfy `SearchOutput` while emitting `pub_idd`, or a string
  // `height`, and the host would just see a silently missing field on BOTH
  // tools at once. Tying the return to the same shape both advertised schemas
  // are built from restores it, and lets the answer path's hooks read
  // `output.image_url` off a typed value instead of casting.
): TopCardChartFields | undefined {
  const topCardId = cards[0]?.card_id;
  if (typeof topCardId !== "string" || topCardId === "") return undefined;
  const { embed_url, image_url } = buildChartUrls(
    env,
    topCardId,
    DEFAULT_DARK_MODE,
  );
  return {
    pub_id: topCardId,
    embed_url,
    image_url,
    dark_mode: DEFAULT_DARK_MODE,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}
