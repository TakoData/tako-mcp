/**
 * Shared shapes for the v3 search/answer surface used by `tako_search`
 * and `tako_answer`. The TakoCard + WebResult schemas mirror the backend
 * `app/backend/knowledge/api/ga/v3/search/types.py`. Auto-chain widget
 * fields (pub_id, embed_url, …) are lifted to the output root by
 * `buildSearchOutput` so the chart widget renders the top card inline.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import { z } from "zod";

import type { Env } from "../env.js";
import {
  HTTP_URL_REGEX,
  DEFAULT_DARK_MODE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  buildChartUrls,
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
 * the default `strict:false` did not steer retrieval at all — a deliberately
 * WRONG node changed nothing, and pinning a metric node without strict
 * returned a DIFFERENT metric's card. The same metric node WITH `strict:true`
 * returned exactly that card. So "pinning its node_ids" alone described the
 * variant that does nothing; this names the one that works.
 *
 * Exported because `tako_answer`'s zero-card guidance needs the identical
 * recipe: two tools whose recovery advice drifts apart teach the model two
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
 * per-handle numbers live in `_available_data.ts`'s `buildPairSummary` comment
 * (pinned vs unpinned, by handle) and in the commit that introduced this hatch;
 * cite those rather than looking for a script to re-run.
 */
export const PINNED_RETRY =
  "pin the METRIC's node_id ALONE (from structuredContent.matches[].coverage.items[]) with strict:true, naming the entity in the query text — adding the entity's node id widens the filter back out, and a pin at the default strict:false does not steer retrieval at all. If that pinned call returns 0 cards, run it once more with `node_ids` removed before concluding the data is absent: `strict` is a hard filter and the graph holds near-duplicate metric nodes where only one twin carries cards, so the pin itself is sometimes what empties the result";

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
 * DECLARED HERE, above `takoCardSchema`, deliberately: the `values_hint` field
 * description interpolates it, and that schema is built at module evaluation
 * time. Declared after the schema it would be in its temporal dead zone, and
 * importing this module would throw ReferenceError on load.
 */
export const PINNED_FROM_CARD =
  "pin that card's METRIC node id ALONE (the `mt::` entry in its `nodes`) with strict:true — pinning every node id on the card, or omitting strict, does not steer retrieval";

// Backend TakoCard (api/ga/v3/search/types.py::TakoCard). Loose so a richer
// backend card doesn't break parsing. Shared by tako_search + tako_answer.
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
    // gate as /contents); slimCard passes a wire value through and derives
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
    // MCP-synthesized routing hint, stamped in slimCard on exportable:false
    // cards only (never on the wire): tells the model where the values live
    // instead of letting it burn a doomed tako_contents call.
    values_hint: z
      .string()
      .optional()
      .describe(
        `Present only on non-exportable (exportable:false, usually license-gated) cards: where this card's values live — headline in \`description\` when the card carries one, specific figures via tako_answer, where you ${PINNED_FROM_CARD}.`,
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
// the backend's free inline allowance: search/answer inline at most
// CSV_FREE_ROWS = 20 rows per card server-side (tako_inline_cap_for; a
// larger legacy cap exists only for entitled enterprise accounts), so this
// is the honest ceiling of what actually arrives — the MCP can only cap
// DOWN what the backend shipped, never raise it. Rows beyond 20 are the
// priced product: a separate tako_contents call (max_rows up to 2,000; the
// first 20 stay free there too). `preview_rows` above the allowance is
// therefore inert today; the input keeps the wider 1..MAX_PREVIEW_ROWS
// range so a future backend row-count knob can light it up without an
// input-surface change.
export const INLINE_PREVIEW_ROW_CAP = 20;
export const MAX_PREVIEW_ROWS = 250;

// `content` carries the heavy inline row payload under keys the hand-written
// resultContentSchema passes through loosely (records/dataset are not in its
// explicit shape). Type them here so the slim helpers can touch them.
type LooseContent = ResultContent & {
  records?: Array<Record<string, unknown>> | null;
  dataset?: { columns?: unknown; rows?: unknown[] } | null;
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
 *   capRows === null → drop all rows (the model fetches via tako_contents).
 *   capRows === N    → keep the N most-recent rows (order-aware, a bounded peek).
 */
export function slimCardContent(
  content: ResultContent | null | undefined,
  capRows: number | null,
): ResultContent | null | undefined {
  if (content == null) return content;
  // Strip the three row-payload keys out; `meta` keeps everything else
  // (content_format/cost/total_rows/truncated/export_pricing/url/…).
  const { data: rawData, records, dataset, ...meta } = content as LooseContent;
  if (capRows === null) {
    return { ...meta, data: null, records: null, dataset: null } as ResultContent;
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
    ...meta,
    truncated: slicedRecords || slicedRows || csvTruncated || meta.truncated || false,
  } as ResultContent;
}

// Model-facing key order for a card. The backend's wire order leads every
// card with ~1.5k chars of descriptive metadata (title, description, the full
// per-source paragraph, methodologies) and puts `content` — the data — near
// the end; a client with a result-size cap then truncates away exactly the
// rows include_contents paid to inline. Serialize the identifying essentials
// and the data first, boilerplate last. Keys absent from the card are
// skipped; unknown keys keep their relative order after the known ones (so a
// new backend field degrades to "after the essentials", never "lost").
const CARD_KEY_ORDER = [
  "card_id",
  "title",
  // `description` rides third: on non-exportable (exportable:false) cards it
  // IS the data — the backend puts the headline value + % change there — so
  // it must precede the URL/methodology chrome a truncating client drops.
  "description",
  "values_hint",
  "exportable",
  "content",
  "nodes",
  "card_type",
  "data_freshness",
  "relevance_score",
  "relevance",
  "metric_definitions",
  "webpage_url",
  "image_url",
  "embed_url",
  "sources",
  "methodologies",
  "source_indexes",
  "semantic_description",
] as const;

function orderCardKeys(card: TakoCard): TakoCard {
  const source = card as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CARD_KEY_ORDER) {
    if (key in source) out[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (!(key in out)) out[key] = source[key];
  }
  return out as TakoCard;
}

/**
 * Immutable: return a new card, slimmed and tagged with an explicit
 * `exportable` flag — a positive boolean so the model reads an explicit "no"
 * instead of having to notice a MISSING `content` key (which LLMs overlook,
 * then call tako_contents anyway and draw a 403). The backend emits the flag
 * authoritatively (TakoData/tako#27989, same fail-closed gate as /contents),
 * so a wire value passes through untouched; deriving from `content` presence
 * is only the fallback for older backends. Keys are re-ordered data-first
 * (see CARD_KEY_ORDER). Pure in-memory — no I/O.
 */
export const slimCard = (card: TakoCard, capRows: number | null): TakoCard => {
  const exportable = card.exportable ?? card.content != null;
  const slimmed =
    card.content == null
      ? { ...card, exportable }
      : { ...card, exportable, content: slimCardContent(card.content, capRows) };
  return orderCardKeys(
    exportable ? slimmed : { ...slimmed, values_hint: valuesHint(card) },
  );
};

// Routing hint for a non-exportable (exportable:false) card. Such cards carry
// no rows on any surface — specific figures come from tako_answer — so the
// hint makes that routing per-card and deterministic instead of a
// tool-description recall exercise. Wording stays NEUTRAL ("not exportable",
// not "license-gated"): the backend's export_safe() also fails closed on
// blank/unresolvable source names and config-alignment errors, and narrating
// those as a licensing decision would keep real bugs from being reported.
// The "headline value is in description" clause is asserted only when the
// card actually carries a description — an unverified pointer is worse than
// none.
function valuesHint(card: TakoCard): string {
  // Pin the METRIC node ALONE, with strict. This used to emit every node id on
  // the card — entity AND metric — and never mentioned `strict`, which is the
  // one combination measured to do nothing: at the default `strict:false` a pin
  // does not steer retrieval at all, and under `strict:true` the entity id
  // re-admits every other card for that entity (strict is an OR over pinned
  // nodes), which once turned "no such card" into a plausible-looking WRONG
  // metric. Same correction already applied to next_call and the zero-card
  // guidance; this hint was the last place still advising the broken form.
  //
  // `type` is the wire's own discriminator; the `mt::` id prefix is a fallback
  // for cards whose nodes arrive untyped. With neither, no pin is advised —
  // silence beats steering the model into the variant that misfires.
  const nodes = card.nodes ?? [];
  const metricIds = nodes
    .filter((n) => n.type === "metric" || n.id.startsWith("mt::"))
    .map((n) => n.id);
  const pin =
    metricIds.length > 0
      ? ` with node_ids ${JSON.stringify(metricIds)} pinned and strict:true`
      : "";
  const headline =
    typeof card.description === "string" && card.description.trim() !== ""
      ? "headline value is in description; "
      : "";
  return `rows not exportable; ${headline}for specific figures call tako_answer${pin}`;
}

// Only paragraph-length strings are worth hoisting — moving a short label
// out of the card would cost more glossary overhead than it saves.
const GLOSSARY_MIN_CHARS = 120;

/**
 * Hoist per-card source/methodology boilerplate into one top-level glossary.
 * The backend repeats the full source paragraph on EVERY card from that
 * source (five same-source cards → five copies of the same ~1k-char
 * description), which crowds the actual data out of any client-side
 * result-size budget. Each paragraph moves out of the cards into
 * `glossary[name]` (one copy, keyed by the entry's own name field), and the
 * caller serializes the glossary at the END of the output so truncating
 * clients lose boilerplate last, data never. An entry with no usable name, or
 * a same-name entry carrying DIFFERENT text, stays inline — nothing is ever
 * lost. Immutable — untouched cards are returned as-is.
 */
export function hoistSourceGlossary(cards: TakoCard[]): {
  cards: TakoCard[];
  glossary: Record<string, string> | undefined;
} {
  const glossary: Record<string, string> = {};
  const hoistArray = (items: unknown, nameKey: string, textKey: string): unknown => {
    if (!Array.isArray(items)) return items;
    let changed = false;
    const out = items.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const rec = item as Record<string, unknown>;
      const name = rec[nameKey];
      const text = rec[textKey];
      if (
        typeof name !== "string" || name === "" ||
        typeof text !== "string" || text.length < GLOSSARY_MIN_CHARS
      ) {
        return item;
      }
      const existing = glossary[name];
      if (existing !== undefined && existing !== text) return item;
      glossary[name] = text;
      changed = true;
      const { [textKey]: _hoisted, ...rest } = rec;
      return rest;
    });
    return changed ? out : items;
  };
  const outCards = cards.map((card) => {
    const rec = card as Record<string, unknown>;
    const next: Record<string, unknown> = { ...rec };
    let changed = false;
    for (const [arrayKey, nameKey, textKey] of [
      ["sources", "source_name", "source_description"],
      ["methodologies", "methodology_name", "methodology_description"],
    ] as const) {
      const hoisted = hoistArray(rec[arrayKey], nameKey, textKey);
      if (hoisted !== rec[arrayKey]) {
        next[arrayKey] = hoisted;
        changed = true;
      }
    }
    return changed ? (next as TakoCard) : card;
  });
  return {
    cards: outCards,
    glossary: Object.keys(glossary).length > 0 ? glossary : undefined,
  };
}

/**
 * Slim a web result's `content`. Web `content.data` is the page's full
 * extracted text — always dropped: it is billed per page AND is a large prose
 * blob, so it is never auto-inlined. The model pulls it via tako_contents(url)
 * when it actually needs the page text (title/url/snippet stay for citation).
 */
export const slimWebResult = (w: WebResult): WebResult =>
  w.content == null
    ? w
    : { ...w, content: slimCardContent(w.content, null) };

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
 * 197 tokens on each of tako_search and tako_answer — ~394 of a 7,235-token
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
// fields for the top card. Mirrors tako_answer's {cards, web_results,
// request_id} plus the inline-render plumbing.
export const searchOutputShape = {
  cards: z.array(takoCardSchema),
  web_results: z.array(webResultSchema),
  // Cost-plus usage for this request (null when it was not metered/billed).
  usage: usageSchema.nullable(),
  request_id: z.string(),
  // Present ONLY on a zero-result response: tells the model how to recover
  // without burning priced calls on reworded retries.
  guidance: z.string().optional(),
  // Source/methodology paragraphs hoisted out of the cards (one copy each,
  // keyed by name). The caller appends this AFTER every other field so
  // truncating clients lose boilerplate last.
  sources_glossary: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Source/methodology descriptions shared by the cards, keyed by name — hoisted here so each rides once instead of once per card.",
    ),
  ...autoChainShape,
} as const;

export type SearchOutput = {
  cards: TakoCard[];
  web_results: WebResult[];
  usage: Usage | null;
  request_id: string;
  guidance?: string;
  sources_glossary?: Record<string, string>;
  pub_id?: string;
  embed_url?: string;
  image_url?: string;
  dark_mode?: boolean;
  width?: number;
  height?: number;
};

// Which sources a search actually hit, for tailoring zero-result guidance.
// "tako" is a legacy alias for "data" (see tako_search's sources enum).
// searchedData is exported for tako_answer's data-gap guidance gate — one
// definition of "did this request search the data source" across both tools.
type SearchedSources = readonly string[];
export const searchedData = (s: SearchedSources): boolean =>
  s.includes("data") || s.includes("tako");
const searchedWeb = (s: SearchedSources): boolean => s.includes("web");

/**
 * The WEB axis carve-out — the other half of the anti-retry rule.
 *
 * "Do not rephrase and retry" was measured on DATA queries, where rewording
 * almost never flips a miss into a hit and every attempt is priced. It was
 * then written as advice about the whole call, which made it misfire on
 * questions the data graph was never going to answer: a zero-card
 * `tako_search` told the model "the data graph does not cover this — do NOT
 * re-search with rephrasings" even when the question was a docs or reference
 * lookup whose answer is entirely on the web, and where re-searching per
 * entity or per provider is precisely the strategy that works. Measured
 * against the field, a competing web-search MCP wins those questions with
 * 5-6 targeted calls per question; our own guidance was telling the model to
 * stop after one.
 *
 * So the ban is scoped to what it was measured on. Rephrasing to hunt for a
 * CARD does not converge. Refining a WEB query does, and fanning out narrow
 * queries beats one broad one — the same rule the tool descriptions already
 * give for the data side ("one entity + one metric per query"), applied to
 * the web side.
 *
 * `sources: ["web"]` on those follow-ups is not a guess: a response carrying
 * web results and zero cards has just DEMONSTRATED the graph does not hold
 * this, which is the exact precondition `sources`' own description sets for
 * narrowing ("only for content a data graph cannot hold").
 *
 * Exported so `tako_answer`'s data-gap guidance carries the identical
 * carve-out. Two tools whose recovery advice disagrees teach the model that
 * one of them is wrong.
 */
export const REFINE_WEB_FREELY =
  'Re-searching is NOT banned here — what does not converge is rephrasing to hunt for a data CARD. If what you actually need is web content (docs, reference pages, news, qualitative claims), refine and re-search freely: prefer SEVERAL narrow queries (one per entity, provider or site) over one broad one, and pass sources:["web"] on them, since this response has already shown the graph does not hold it.';

/**
 * The same carve-out for `tako_answer`, where the move is DECOMPOSITION rather
 * than refinement.
 *
 * `tako_answer` synthesizes one answer per call, so a question spanning several
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
 * Shared rather than written twice. `tako_answer` carried this sentence inline
 * while `tako_search`'s equivalent branch ended flatly at "stop calling Tako for
 * this question", so on the single most common Tako-has-nothing path the two
 * tools disagreed about whether one narrower web attempt was allowed. That is
 * the same drift {@link PINNED_RETRY} and {@link DECOMPOSE_WEB_ASK} exist to
 * prevent, and it is the reason it belongs in a constant: a model that reads
 * both surfaces learns that one of them is wrong.
 *
 * Interpolated only where the web was ACTUALLY searched and came back empty. On
 * a data-only call there is no empty web result to reinterpret — that path tells
 * the caller to search the web at all, which is a different (and cheaper) move.
 */
export const NARROWER_WEB_ATTEMPT =
  "One exception to the stop, on the WEB axis only: a genuinely narrower question (one entity, one provider, one site) is worth a single attempt, because an empty web result usually means the question was too broad rather than unanswerable.";

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
 * NAME, unpinned → stop and answer from the web results — not the phrasing;
 * pin an invariant here rather than a quoted sentence, so a reworded skill
 * does not silently make this comment a lie. Update all four copies together.
 *
 * WHY THE SKILLS DO NOT PIN, while {@link PINNED_RETRY} here does. Not drift —
 * the same measurement under a tighter budget. `PINNED_RETRY` describes a TWO
 * step sequence (pin correctly; if that comes back empty, drop the pin), which
 * the tool guidance can afford because it is advising a caller with no fixed
 * call budget. The skills cap at 2 priced searches per question, so they have
 * exactly ONE retry to spend and have to pick an arm: measured, 11 of 20 handles
 * retrieve FEWER cards pinned than unpinned, while the canonical NAME helps 9 of
 * 15. So the skills spend their one retry on the name and skip the pin, and
 * mention pinning only for what it is good at — disambiguating a near-duplicate
 * metric once one has actually shown up. Same knowledge, one call instead of two.
 *
 * {@link REFINE_WEB_FREELY} is deliberately NOT mirrored into those three:
 * they are data-domain skills (equity research, macro indicators, site
 * traffic) whose questions are metric lookups by construction, so the
 * data-axis recipe is the whole story there. The carve-out matters for the
 * TOOL guidance, which serves arbitrary questions — including ones with no
 * data answer at all. Absence from the skills is the intended state, not
 * drift.
 */
function buildZeroResultGuidance(
  hasWebResults: boolean,
  sources: SearchedSources,
): string {
  if (hasWebResults) {
    // A web-only search has zero cards BY CONSTRUCTION — the data index was
    // never queried — so the branch below would report a graph verdict from
    // evidence that does not exist, and `REFINE_WEB_FREELY` would close with
    // "this response has already shown the graph does not hold it", which it has
    // not. That is precisely the defect `buildDataGapGuidance` fixes via
    // `searchedWebToo`, in the mirror direction: one source's outcome reported as
    // two sources' worth of verdict.
    //
    // Nothing on the data axis belongs here either — no coverage check, no pin
    // recipe — because the caller narrowed the sources deliberately. The one
    // useful data-side sentence is how to GET a coverage answer, which is the
    // cheap re-ask.
    if (!searchedData(sources)) {
      return [
        "This search returned web results. It ran on the WEB source only, so it says NOTHING about whether Tako's data graph covers this — do not report a coverage gap on the strength of it.",
        "Answer from the web_results (tako_contents on the most relevant url fetches its full page text).",
        "Need more? Refine and re-search freely: prefer SEVERAL narrow queries (one per entity, provider or site) over one broad one.",
        'If a chart, dataset or proprietary figure is what you actually want, re-run with sources:["data","web"] (same price) or check tako_available_data (free) — that is what answers the coverage question.',
      ].join(" ");
    }
    return [
      "This search returned web results but no data cards. That is a verdict about the DATA GRAPH only: it does not cover this query, and rewording will not change that.",
      "Answer from the web_results (tako_contents on the most relevant url fetches its full page text).",
      `If you specifically need a chart or dataset, run tako_available_data (free) once; re-search only if it confirms coverage, and then ${PINNED_RETRY}.`,
      REFINE_WEB_FREELY,
    ].join(" ");
  }
  if (!searchedData(sources)) {
    // Web-only search, nothing back. There is no data verdict to report here —
    // the data source was never queried — and a bare "do not retry" was simply
    // wrong: on a web-only query, the QUERY is the only lever there is, so
    // refining it is the whole recovery. This branch used to ban the one move
    // available.
    return [
      "No results from the web for this query. The data source was not searched, so this is NOT a coverage verdict about Tako's graph — it means the query itself came back empty.",
      "Refine and re-search: narrow to one entity, provider or site per query rather than one broad query, or name the specific doc/page you expect to find.",
      "If a data metric is what you are actually after, check tako_available_data (free) for coverage and run ONE data-source search.",
      "Stop only once a couple of genuinely different framings have come back empty.",
    ].join(" ");
  }
  return [
    "No results — do NOT retry this query or rephrasings of it hoping a data card appears; every search is priced, and empty means the query shape is off or the data is not covered, not that the wording was unlucky.",
    "Recover in order: (1) call tako_available_data (free) with the entity to learn the exact metric names + node_ids Tako actually has;",
    `(2) if it confirms coverage, spend your ONE remaining search on that exact name and ${PINNED_RETRY}` +
      (searchedWeb(sources)
        ? ";"
        : ' (adding "web" as a fallback source on that same single retry is fine);'),
    "(3) if it shows no coverage, stop calling Tako for this question and answer from other sources",
    '— except website-traffic asks: the graph misses long-tail domains SimilarWeb still covers, so there the real coverage test is the one retry itself, as a bare-domain query ("kagi.com monthly visits").',
    'Rule out the usual shape mistakes before that one retry: one entity + one metric per query (split compound asks into parallel searches), and domains not brand names for website traffic ("netflix.com", not "Netflix").',
    // Only when the web was actually searched and returned nothing — the same
    // precondition tako_answer's equivalent branch carries, so the two tools give
    // the identical verdict on the identical situation. When web was NOT
    // searched, step (2) above already offers it as a fallback source, which is
    // the cheaper move and would contradict this one.
    ...(searchedWeb(sources) ? [NARROWER_WEB_ATTEMPT] : []),
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
  searchedSources: readonly string[],
): SearchOutput {
  // Order before anything reads cards[0]: the widget/pub_id fields below lift
  // the TOP card, so the chart the host renders follows the same ordering the
  // model reads instead of diverging from it.
  const cards = orderCardsByUsefulness(rawCards);
  const base: SearchOutput = {
    cards,
    web_results: webResults,
    usage,
    request_id: requestId,
    // A miss is billed the same as a hit, and models default to
    // rephrase-and-retry loops that never converge — so any zero-CARD
    // response carries its own recovery protocol instead of a bare empty
    // array. Keyed on cards (not cards AND web) because the default
    // ["data","web"] search almost always returns some web links: gating on
    // both would skip the guidance in exactly the chart-less case the
    // retry loop feeds on.
    ...(cards.length === 0
      ? {
          guidance: buildZeroResultGuidance(
            webResults.length > 0,
            searchedSources,
          ),
        }
      : {}),
  };
  const topCardId = cards[0]?.card_id;
  if (typeof topCardId === "string" && topCardId !== "") {
    const { embed_url, image_url } = buildChartUrls(
      env,
      topCardId,
      DEFAULT_DARK_MODE,
    );
    return {
      ...base,
      pub_id: topCardId,
      embed_url,
      image_url,
      dark_mode: DEFAULT_DARK_MODE,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
  }
  return base;
}
