/**
 * The model-facing projection for `tako_contents` (spec:
 * 2026-08-26-model-facing-surface-redesign, "Per-tool shape").
 *
 * The tool used to put its payload in `structuredContent` only and emit a
 * POINTER in the text channel ("page text: 2120 chars in
 * structuredContent.results[].data"). Measured on prod 2026-08-30: 150 text
 * chars against 2,284 structured for one web page. On the 9 harnesses the
 * consensus audit found that feed the model `content` only — Cursor, Gemini
 * CLI, Goose, OpenCode, the Vercel AI SDK, LangChain, the OpenAI Agents SDK,
 * Excel/Outlook, the Messages API connector — that pointer WAS the whole
 * result of a call the caller had already been billed for. Both channels now
 * carry the payload; `renderContentsText` is the other half.
 *
 * One payload shape, not three. The tool always requests `json_compact` and
 * projects it, so `content_format` is gone from the input and `data` /
 * `records` / `dataset` / `format` are gone from the output. CSV lost the
 * decision on nulls: a sparse comparison card — every "X vs Y" card is one —
 * serializes as `2026-01-25 00:00:00+00:00,74.9967,` with a trailing bare
 * comma for the missing series, which is the most misparsed construct in the
 * format. Positional JSON writes `null`. Measured cost of the switch, same 6
 * rows across 8 cards: 1.05-1.32x the CSV, not the 2x the raw `dataset`
 * suggests — the rest was `ref`/`sources`/`provenance`/`type`/`"unit":null`,
 * all of which this projection drops.
 *
 * `_`-prefixed so `gen-registry.ts` skips it — this is not a tool module.
 */
import { z } from "zod";

import { TakoDataset } from "../generated/schemas.js";
import { extractPassages } from "./_passages.js";
import {
  columnName,
  projectedRowsShape,
  usageAdvertisedSchema,
  type ProjectedRows,
} from "./_search_results.js";


/**
 * One requested url's result. Exactly one payload field rides per item:
 * `rows` for a Tako card, `text` for a web page, `error` for a url that
 * failed on its own.
 *
 * `truncated` sits HERE rather than inside `rows` (where the spec's shape puts
 * it for search) because an item has exactly one payload: a row cap, a
 * `max_chars` cut and a passage extraction are the same fact about the same
 * item, and giving it two homes is what this pass removes everywhere else.
 */
const projectedContentsItemShape = z.looseObject({
  // Declaration order IS the shipped order. `contentsOutputShape.safeParse` in
  // the handler rebuilds every object in SHAPE order, not in the order the
  // projection spread it, so this list is what a truncating host reads.
  // Anchor, then the note that explains the payload, then the payload, then
  // the chrome; `cost` stays last so a cut tail loses it and never the rows.
  url: z.string().describe("The url this entry is for."),
  note: z.string().optional().describe("What the `query` match found."),
  rows: projectedRowsShape.optional().describe("Tako cards only: the card's data."),
  text: z.string().optional().describe("Web pages only: the page text."),
  error: z.string().optional().describe("Why this url alone failed; the others are unaffected."),
  truncated: z.boolean().optional().describe("Part of this payload was cut."),
  source_url: z.string().optional().describe("Where a redirect landed."),
  cost: z.number().describe("USD billed for this url."),
});

export type ProjectedContentsItem = z.infer<typeof projectedContentsItemShape>;

/**
 * The advertised `structuredContent`. `results` is positionally aligned with
 * the requested urls INCLUDING the failures, which carry `error` in place of a
 * payload — a compacted array would silently re-map every index after the
 * first failure.
 *
 * Root money is `usage`, the same field name and shape `tako_search`
 * advertises, rather than the bare `cost` this tool used to carry (D2.9, one
 * name for one thing). Per-item `cost` stays: in a batch it is the only way to
 * learn WHICH url was expensive, which is the fact a caller acts on by
 * lowering `max_rows` on that one url.
 */
export const contentsOutputShape = z.looseObject({
  results: z.array(projectedContentsItemShape).describe("One per requested url, in order."),
  usage: usageAdvertisedSchema.describe("What this request cost."),
});

export type ContentsOutput = z.infer<typeof contentsOutputShape>;

/** The wire fields this projection reads. A subset of the generated
 *  `ContentItem`, typed loosely for the same reason `resultContentSchema` is:
 *  the projection, not a hard-required field, is the drift guard. */
export interface ContentsWireItem {
  content_format?: string | null | undefined;
  data?: string | null | undefined;
  dataset?: z.infer<typeof TakoDataset> | null | undefined;
  total_rows?: number | null | undefined;
  truncated?: boolean | null | undefined;
  cost?: number | null | undefined;
  source_url?: string | null | undefined;
}

/** What an item says when the backend delivered neither rows nor text. One
 *  message for both shapes: the cause is the same — the payload channel this
 *  item declared arrived empty — and a card-specific and a page-specific
 *  wording would be two names for one state. */
export const EMPTY_PAYLOAD_ERROR =
  "Tako returned no data for this url. Retry once; if it persists, flag it to the Tako team.";


/**
 * Project one wire item into the model-facing shape. Pure — no network, no
 * env — so `gen-registry.ts` runs the fixture through this exact function to
 * generate the `docs/TOOLS.md` samples.
 *
 * A Tako card is identified by a NON-NULL `content_format` (cards always carry
 * one, web text never does). That discriminator predates this projection and
 * is kept deliberately: keying off `dataset != null` instead would silently
 * reclassify a card whose dataset failed to build as a web page.
 */
export function projectContentsItem(
  item: ContentsWireItem,
  url: string,
  opts: { passageQuery?: string | undefined; effectiveMaxChars?: number | undefined },
): ProjectedContentsItem {
  const isCard = item.content_format != null;
  let cut = item.truncated === true;
  let rows: ProjectedRows | undefined;
  let text: string | undefined;
  let note: string | undefined;

  if (isCard) {
    const dataset = item.dataset;
    if (dataset != null) {
      rows = { columns: dataset.columns.map(columnName), rows: dataset.rows };
      // The card's true size, wherever the backend put it. Omitted rather than
      // faked when neither carries it: a fabricated 0 reads as "no data".
      const total = typeof item.total_rows === "number" ? item.total_rows : dataset.total_rows;
      if (typeof total === "number") rows.total_rows = total;
      if (dataset.truncated === true) cut = true;
    }
  } else if (typeof item.data === "string") {
    text = item.data;
    // Derived truncation for capped web text: the backend's `truncated` flag is
    // rows-only and never set on the web route, so a page cut at max_chars
    // would otherwise arrive reading as complete. Length AT the cap counts as
    // cut — the false positive (a page exactly cap-length) is vanishingly rare
    // next to a guaranteed false "complete" on every long page.
    //
    // It assumes the extractor cuts AT the cap. `ContentsRequest.max_chars`
    // does not promise that, and if it ever trims to a word or paragraph
    // boundary instead, every truncated page starts reporting complete again —
    // the exact failure this branch exists to prevent, and silent. A backend
    // change there needs a tolerance here, or `truncated` on the web route.
    const cap = opts.effectiveMaxChars;
    if (cap !== undefined && text.length >= cap) cut = true;
    if (opts.passageQuery !== undefined) {
      const extracted = extractPassages(text, opts.passageQuery);
      text = extracted.data;
      note = extracted.note;
      cut = cut || extracted.truncated;
    }
  }

  // An item carries exactly one payload, or an error saying why it does not.
  // Neither branch firing is the shape backend drift takes: every payload
  // field on the generated `ContentItem` is `.optional()`, so
  // `ContentsResponse.safeParse` accepts an item whose `dataset` was renamed,
  // and `ContentsWireItem` widens all of them, so `tsc` accepts it too. This
  // branch is the only guard between that and a billed item the caller reads
  // as an empty success.
  const empty = rows === undefined && text === undefined;

  // Built in the shape's declared order so the two agree on sight. The order
  // that actually SHIPS is the shape's, because the handler re-parses this
  // object -- reordering here alone would change nothing.
  return {
    url,
    ...(note !== undefined ? { note } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(cut ? { truncated: true } : {}),
    ...(item.source_url != null && item.source_url !== url ? { source_url: item.source_url } : {}),
    cost: item.cost ?? 0,
    ...(empty ? { error: EMPTY_PAYLOAD_ERROR } : {}),
  };
}

/** Sum the per-url charges into the root `usage`.
 *
 *  Rounded, because this is the one place a Tako usage total is COMPUTED
 *  rather than quoted: search reads `total_cost_usd` straight off the backend,
 *  while a contents batch adds up one charge per subrequest. Raw float
 *  addition renders `usage: $0.30000000000000004` — in both channels, so
 *  parity holds and no test is wrong; it just reads as a defect. Charges run
 *  to about four decimals, so six loses nothing real. */
export function contentsUsage(results: ReadonlyArray<ProjectedContentsItem>): { total_cost_usd: number } {
  const total = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  return { total_cost_usd: Math.round(total * 1e6) / 1e6 };
}
