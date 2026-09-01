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
 * Exported because the ANSWER path's zero-card guidance needs the identical
 * recipe: two verdicts whose recovery advice drifts apart teach the model two
 * different pin forms, and only one of them works. One string, one place.
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
// READER: `tako_search_advanced` ONLY — both its endpoints, since the answer
// data-gap verdict interpolates this too. `tako_search` took no
// `node_ids`/`strict` after the D4 split, so its zero-card guidance stopped
// advising a pin — advice for parameters the tool would reject. Do not
// reintroduce this into any `tako_search` guidance; the canonical NAME is that
// tool's recovery path. (The other reader was `tako_answer`, deleted in the
// answer fold.)
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

export const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

// Date-only per the field vocabulary: recency matters, time-of-day doesn't.
const dateOnly = (v: unknown): string | undefined => {
  const s = nonEmpty(v);
  if (s === undefined) return undefined;
  const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
  return m ? m[0] : s;
};

const sourceNamesOf = (rec: Record<string, unknown>): string[] => {
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
  rows?: Record<string, unknown>;
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

/**
 * The keys an inlined `rows` object may carry: every payload channel, plus the
 * three metadata keys that describe one.
 *
 * DERIVED from {@link CONTENT_PAYLOAD_KEYS}, never re-spelled. That constant is
 * bound to the generated `ContentItem` by a drift test; a literal list here
 * would not be, so a fifth upstream payload channel would be classified there,
 * turn the drift test green, and still never reach `tako_search_advanced`'s
 * inlined rows. That exact drift already shipped once against
 * `slimCardContent` (see the CONTENT_PAYLOAD_KEYS docstring: three keys against
 * ContentItem's four).
 */
// Exported for the drift guard ONLY. A test that retypes these names instead
// of importing them pins nothing: renaming `content_format` here to `format`
// — which drops it from every `rows` object `tako_search_advanced` inlines —
// left all 1267 tests green.
//
// `manifest` is on this list because it is the ONLY carrier of per-column
// `unit`, `metric` and `entity`. `slimCardContent` already classifies it as
// metadata to keep, and this loop used to filter it back out — so a
// json_records inline arrived as `[{"col": 12.4}]` with nothing saying
// whether 12.4 is USD, USD billions or a percent.
export const ROWS_META_KEYS = ["total_rows", "truncated", "content_format", "manifest"] as const;
const ROWS_KEYS: readonly string[] = [...CONTENT_PAYLOAD_KEYS, ...ROWS_META_KEYS];
const PAYLOAD_KEY_SET: ReadonlySet<string> = new Set<string>(CONTENT_PAYLOAD_KEYS);

/** Project one wire card into the model-facing shape. Pure and immutable. */
export function projectCard(card: TakoCard, capRows: number | "all" | null): ProjectedCard {
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
        const rows: Record<string, unknown> = {};
        for (const key of ROWS_KEYS) {
          const v = capped[key];
          if (v !== null && v !== undefined) rows[key] = v;
        }
        // Metadata alone is not rows: a descriptor with a cost quote and no
        // payload channel would otherwise ship an empty `rows` object.
        if (Object.keys(rows).some((k) => PAYLOAD_KEY_SET.has(k))) {
          out.rows = rows;
        }
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
  rows: z.looseObject({}).optional().describe("Inlined rows — only when the request asked to inline them."),
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

export const searchOutputShape = {
  cards: z.array(projectedCardShape),
  web_results: z.array(projectedWebResultShape),
  // Cost-plus usage for this request (null when it was not metered/billed).
  usage: usageSchema.nullable(),
  request_id: z.string(),
  // Present ONLY on a zero-result response: the verdict (which corpora this
  // response is evidence about) and the one next action.
  guidance: z.string().optional(),
  metric_definitions: z
    .record(z.string(), z.string())
    .optional()
    .describe("What each metric means (unit, basis, caveats), keyed by the metric name the cards carry."),
  source_notes: z
    .record(z.string(), z.string())
    .optional()
    .describe("What each source is and how it builds its data, keyed by a card's `source` field verbatim."),
  // Follow-up queries, present only when the request set `include_related`.
  related: z.array(RelatedSuggestion).optional(),
  // The three /v1/answer fields. Present only on the answer endpoint, which
  // only `tako_search_advanced` with `include_answer: true` reaches.
  answer: z.string().optional(),
  structured_output: z.record(z.string(), z.unknown()).optional(),
  structured_output_error: AnswerStructuredOutputError.optional(),
  ...autoChainShape,
} as const;

export type SearchOutput = {
  cards: ProjectedCard[];
  web_results: ProjectedWebResult[];
  usage: Usage | null;
  request_id: string;
  guidance?: string;
  metric_definitions?: Record<string, string>;
  source_notes?: Record<string, string>;
  related?: z.infer<typeof RelatedSuggestion>[];
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

// REFINE_WEB_FREELY was deleted with the two-sentence guidance rewrite: its
// carve-out ("refining a WEB query converges; hunting for a CARD does not")
// is now scoped into each branch's verdict sentence, and the fan-out-narrow-
// queries lesson lives in the tool description. The measured incident that
// created it (a blanket no-re-search ban losing docs questions to a
// competing web-search MCP by 5-6 targeted calls) stays the reason the
// verdicts blame the DATA GRAPH, never re-searching as such.

/**
 * The same carve-out for the ANSWER path, where the move is DECOMPOSITION
 * rather than refinement.
 *
 * An answer call synthesizes one answer per call, so a question spanning several
 * entities or providers ("how does each of these APIs handle X") gets one
 * blended answer built from whatever the single retrieval happened to surface.
 * Re-asking the same broad question is the loop that does not converge; asking
 * it once per entity is not a retry at all, it is the shape the tool wants —
 * the same "one entity per query" rule its own description gives for the data
 * side.
 *
 * Stated as guidance rather than implemented as internal fan-out on purpose:
 * splitting a question server-side would multiply a priced call without the
 * caller asking, and the model is the only party that knows which entities the
 * question actually covers.
 */
export const DECOMPOSE_WEB_ASK =
  "If the answer lives on the web rather than in the data graph, do not re-ask this same question: DECOMPOSE it. One narrow question per entity, provider or site, asked in parallel, beats one broad question — that is not a retry, it is the shape this tool answers best, and it is how a multi-part web question gets a complete answer instead of a blended one.";

/**
 * The one carve-out on the BOTH-empty stop — nothing from the data graph and
 * nothing from the web.
 *
 * It exists because the two surfaces once CONTRADICTED each other here: the
 * answer path allowed one narrower web attempt while `tako_search`'s equivalent
 * branch ended flatly at "stop calling Tako for this question" — same
 * situation, opposite verdict, on the most common Tako-has-nothing path. A
 * model that reads both surfaces learns that one of them is wrong. Same drift
 * {@link PINNED_RETRY} and {@link DECOMPOSE_WEB_ASK} exist to prevent.
 *
 * ONE INTERPOLATION LEFT, and that is deliberate — do not "fix" it by pushing
 * this string back into `buildZeroResultGuidance`. Every branch there is capped
 * at TWO sentences (spec: 2026-08-26-model-facing-surface-redesign, "guidance"
 * decision), and this is a ~250-char third one; the search path therefore
 * states the same carve-out as a CLAUSE ("or try one genuinely narrower web
 * question"). The full sentence stays on the answer path, which has no sentence
 * budget and needs the reason it carries — an empty web result usually means
 * the question was too broad, which is the half that actually stops the retry
 * loop.
 *
 * So the guarantee is the INVARIANT, not the string: both surfaces permit
 * exactly one narrower web attempt, and neither forbids re-searching the web.
 * "both zero-result surfaces permit exactly one narrower web attempt" in
 * `_search_results.test.ts` is what holds it — a string-identity test cannot,
 * now that only one side can afford the sentence.
 *
 * Used only where the web was ACTUALLY searched and came back empty. On a
 * data-only call there is no empty web result to reinterpret — that path tells
 * the caller to search the web at all, which is a different (and cheaper) move.
 */
export const NARROWER_WEB_ATTEMPT =
  "One exception to the stop, on the WEB axis only: a genuinely narrower question (one entity, one provider, one site) is worth a single attempt, because an empty web result usually means the question was too broad rather than unanswerable.";

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
 * results ground the
 * answer. With web grounding the prose may be a complete, correct answer
 * (e.g. "who won the game?") — the verdict must scope itself to the data
 * index, not read as "this answer failed". Without web grounding it is the
 * hard anti-retry stop. Both are deterministic (cards.length === 0), never
 * inferred from the prose.
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
  registered?: ReadonlySet<string>,
): string {
  // A tool RESULT that names a tool is an instruction the model acts on, and
  // `?tools=` REPLACES the defaults — `?tools=answer` registers
  // `tako_search_advanced` ALONE, so on the connection that reaches this
  // function most often, BOTH tools named below are unregistered and every
  // recovery step here resolved to the SDK's bare "tool not found".
  const has = (name: string): boolean => registered === undefined || registered.has(name);
  const coverage = has("tako_available_data");
  const contents = has("tako_contents");
  // Each optional clause carries its own leading space, so dropping one
  // leaves no double space behind.
  const confirmFirst = coverage ? "confirm coverage once with tako_available_data, then " : "";
  if (!hasWebResults && !searchedWebToo) {
    const noContents = contents
      ? " Do NOT reach for tako_contents: it returns rows only for an exportable card you already have, and 403s on license-gated ones."
      : "";
    return `Data-coverage verdict: ZERO curated data cards ground this answer (machine check: cards.length === 0). This ran with the DATA source only, so nothing here says anything about web coverage — do not read it as "not available anywhere". Cheapest next step: re-ask with sources:["data","web"] (same price) before concluding the figure is unavailable. If you want the proprietary series specifically, ${confirmFirst}re-ask ONCE — ${PINNED_RETRY} — stating the period you need.${noContents}`;
  }
  if (hasWebResults) {
    const noContents = contents
      ? " Do NOT reach for tako_contents: it cannot return rows for a card this answer did not cite, and it always 403s on license-gated cards."
      : "";
    return `Data-coverage note: ZERO curated data cards ground this answer — it is web-grounded only (machine check: cards.length === 0). If the prose answers the question, use it as-is. If you specifically wanted Tako's proprietary series, do NOT rephrase-and-retry the answer call for it (priced, rarely converges): ${confirmFirst}re-ask ONCE — ${PINNED_RETRY} — and state the period you need in the query.${noContents} ${DECOMPOSE_WEB_ASK}`;
  }
  const recover = coverage
    ? `Recover in ONE step: call tako_available_data to confirm coverage, then re-ask HERE once (${PINNED_RETRY}), stating the period you need in the query.`
    : `Recover in ONE step: re-ask HERE once (${PINNED_RETRY}), stating the period you need in the query.`;
  const noContents = contents
    ? " Do NOT reach for tako_contents — it returns rows only for an exportable card you already have, and 403s on license-gated ones."
    : "";
  const verdict = coverage
    ? " If tako_available_data shows no coverage, the metric is genuinely absent from the graph: say so and use another source."
    : " If that retry also comes back empty, the metric is genuinely absent from the graph: say so and use another source.";
  return `Data-coverage verdict: ZERO curated data cards AND zero web results ground this answer — treat the metric as NOT in Tako's data index for this phrasing (machine check: cards.length === 0). Do NOT rephrase-and-retry the answer call hoping the same question lands a data series; every retry is priced and that loop rarely converges. ${recover}${noContents}${verdict} ${NARROWER_WEB_ATTEMPT}`;
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
 * "Empty result (zero cards)" bullet. What must stay consistent is the
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
 * than unpinned, while the canonical name helped 9 of 15. `PINNED_RETRY` still
 * exists for the ANSWER path, which keeps both parameters — do not route it
 * back here.
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
          ? 'Answer from the web_results; if you want a chart or dataset, re-run with sources:["data","web"] (same price) or check tako_available_data (free).'
          : 'Answer from the web_results; if you want a chart or dataset, re-run with sources:["data","web"] (same price).',
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
  const cards = ordered.map((c) => projectCard(c, opts.rowCap));
  const web = webResults.map((w) => projectWebResult(w, opts.keepWebText));
  const base: SearchOutput = {
    cards,
    web_results: web,
    usage,
    request_id: requestId,
    ...(extras.related !== undefined ? { related: extras.related } : {}),
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
                    opts.registeredTools,
                  )
                : buildZeroResultGuidance(
                    webResults.length > 0,
                    searchedSources,
                    tier,
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
