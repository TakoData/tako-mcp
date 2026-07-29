import { z } from "zod";

import { djangoPost } from "../django.js";
import { AnswerResponse, SearchRequest } from "../generated/schemas.js";
import { logWireGuardFailure } from "./_log.js";
import {
  answerSlimOutputShape,
  renderAnswerMarkdown,
  slimAnswerStructured,
  type AnswerFullOutput,
} from "./_render_markdown.js";
import {
  hoistSourceGlossary,
  INLINE_PREVIEW_ROW_CAP,
  MAX_PREVIEW_ROWS,
  searchedData,
  slimCard,
  slimWebResult,
  takoCardSchema,
  usageSchema,
  webResultSchema,
} from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "START HERE for any question that wants a value, figure, or finding: ask one specific data question, get one synthesized answer grounded in the data or web tako cites.",
  "",
  "It is the only tool whose single response can finish the job: it reads the cited pages internally, inlines the cited cards' rows, and returns a coverage verdict. Retrieval hands back captions and links you must then chase, and every extra round trip re-sends the whole conversation.",
  "",
  "Best for: a single, self-contained data question with one answer. The `answer` is synthesized from the cited sources; the `cards` are its citations. Also the values channel for non-exportable cards: when a card is `exportable: false` (usually license-gated), ask here with its node_ids pinned to get the figures.",
  "",
  "Reach past it only for a different job: `tako_search` for breadth recon and chart cards (it locates data, it does not carry values), `tako_available_data` when the question is what Tako covers, the Answer Agent for open-ended research.",
  "",
  "Grounds over BOTH data and web by default; pin node_ids when you have them. Cited cards inline their recent rows (see include_contents/preview_rows), so the series arrives with the answer; for full history or a cited page's text, call `tako_contents` on its url.",
  "",
  "Results arrive as markdown: the synthesized answer first, then its cited data cards (headline, exportable flag, node ids, a rows-count pointer) and web citations, then source notes. The cited cards' actual rows ride in structuredContent (cards[].content), not the markdown, alongside machine essentials (request_id, usage, guidance).",
].join("\n");

// Hand-authored, LLM-ergonomic flat input (the curated facade).
const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?"). Website-traffic data is keyed by domain — ask about "openai.com monthly visits", not "OpenAI website visits".'),
  sources: z
    .array(z.enum(["data", "web", "tako"]))
    .min(1)
    .default(["data", "web"])
    .describe('Source(s) to ground in. Default ["data","web"] (both) — keep BOTH enabled unless you have a confirmed reason to narrow. Narrow to ["data"] only once `tako_available_data` has confirmed the proprietary data exists (web is the fallback when it does not). Narrow to ["web"] only for content a data graph cannot hold (news articles, page text, qualitative claims) — never because a metric merely feels web-native: website traffic, app usage, and similar digital metrics ARE in the proprietary data graph. ("tako" is a legacy synonym for "data".)'),
  // The prose `answer` alone proved an unreliable payload in agent traces: it
  // sometimes carries the series and sometimes only teases it ("latest value
  // 59.2%"), and a teased agent escalates into a costly multi-wave retry
  // cascade. Inlining the cited cards' recent rows by default makes the first
  // response dense, converting those cascades into single-call runs.
  include_contents: z
    .boolean()
    .default(true)
    .describe(
      "Inline each cited data card's recent rows alongside the answer (default true; preview_rows sets how many) — the values arrive with the prose, no follow-up fetch. Set false — prose + citations only — for broad fan-outs or when coverage is unconfirmed (no prior tako_available_data check). DATA cards only; cited web pages are never auto-inlined (billed per page — use tako_contents).",
    ),
  preview_rows: z
    .number()
    .int()
    .min(1)
    .max(MAX_PREVIEW_ROWS)
    .default(INLINE_PREVIEW_ROW_CAP)
    .describe(
      `Cap on the rows of each cited card's data inlined when include_contents is true — always the N MOST-RECENT rows (default ${INLINE_PREVIEW_ROW_CAP}, the free inline allowance the server ships; values above your account's allowance have no effect). For more rows, call tako_contents on the card's url (priced beyond the first ${INLINE_PREVIEW_ROW_CAP}). Ignored when include_contents is false.`,
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
  node_ids: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "Graph node ids (from tako_available_data) to PIN into the proprietary data source. Pinned nodes get a strong retrieval boost. Max 20. Applies only to the 'data' source.",
    ),
  strict: z
    .boolean()
    .default(false)
    .describe(
      "Hard filter. When true, return ONLY cards matching at least one node in node_ids (which must then be non-empty — empty node_ids + strict is a 400). When false (default), pinned nodes are preferred/boosted but organic results still return.",
    ),
});
type Input = z.infer<typeof inputSchema>;

// INTERNAL full output shape: normalises the wire into the handler's return
// value (always arrays, never undefined; the generated AnswerResponse stays
// the wire-guard). NOT the advertised schema — the full content reaches the
// model as rendered markdown (renderText below), and the ADVERTISED
// outputSchema is the slim structuredContent shape so hosts that count
// structuredContent toward context don't pay for the content twice.
const fullOutputSchema = z.object({
  answer: z.string(),
  cards: z.array(takoCardSchema),
  web_results: z.array(webResultSchema),
  // Cost-plus usage for this request (null when it was not metered/billed).
  usage: usageSchema.nullable(),
  request_id: z.string(),
  // Present ONLY when the data source was searched and returned ZERO cards: a
  // deterministic coverage verdict. The prose `answer` phrases a miss softly
  // ("I couldn't find it in the provided sources"), which agents read as "try
  // another wording" — this field is the machine-checkable "not in the data
  // index" that converts rephrase-retry loops into a single pivot.
  guidance: z.string().optional(),
  // Source/methodology paragraphs hoisted out of the cited cards (one copy
  // each, keyed by name) — appended last so truncating clients lose
  // boilerplate before data. Mirrors tako_search, .describe() included: the
  // declared outputSchema is the only place the model learns what this
  // Record<string,string> is.
  sources_glossary: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Source/methodology descriptions shared by the cards, keyed by name — hoisted here so each rides once instead of once per card.",
    ),
});

// Advertised (slim) schema — see the fullOutputSchema comment above.
const outputSchema = answerSlimOutputShape;

type Output = z.infer<typeof outputSchema>;

/**
 * Reshape the flat MCP input into the backend's nested SearchRequest body.
 * Exported for the contract-guard test.
 *
 * The `satisfies z.input<typeof SearchRequest>` annotation is the build-time
 * guard: if the backend request contract changes (new required field, renamed
 * key, changed enum) this line fails to compile — the intended signal.
 */
export function buildAnswerBody(input: Input): z.input<typeof SearchRequest> {
  // Typed against the contract (not Record<string, …>) so a renamed/added
  // `Sources` key or a new required per-source sub-field breaks compilation here.
  const sources: NonNullable<z.input<typeof SearchRequest>["sources"]> = {};
  if (input.sources.includes("data") || input.sources.includes("tako")) {
    const data: NonNullable<
      NonNullable<z.input<typeof SearchRequest>["sources"]>["data"]
    > = { include_contents: input.include_contents ?? true };
    if (input.node_ids !== undefined && input.node_ids.length > 0) {
      data.node_ids = input.node_ids;
    }
    if (input.strict) {
      data.strict = true;
    }
    sources.data = data;
  }
  // Web include_contents stays pinned false regardless of the input flag:
  // page text is billed per page and is a large prose blob — never auto-fetch
  // it here (the model pulls it via tako_contents when it needs it).
  // snippet_max_chars 2000 (backend default 1000): meatier free excerpts so a
  // follow-up tako_contents lands on the right cited page. Mirrors tako_search.
  if (input.sources.includes("web")) {
    sources.web = { include_contents: false, snippet_max_chars: 2000 };
  }
  // No `effort`/per-source `count` (unlike buildSearchBody): answer is
  // fast-pipeline + arbiter only, with no async/deep path (see handler).
  return {
    query: input.query,
    sources,
    country_code: input.country_code,
    locale: input.locale,
  } satisfies z.input<typeof SearchRequest>; // ← build-time guard: backend request drift breaks here
}

/**
 * The zero-data-card verdict, worded by whether web results ground the
 * answer. With web grounding the prose may be a complete, correct answer
 * (e.g. "who won the game?") — the verdict must scope itself to the data
 * index, not read as "this answer failed". Without web grounding it is the
 * hard anti-retry stop. Both are deterministic (cards.length === 0), never
 * inferred from the prose.
 */
function buildDataGapGuidance(hasWebResults: boolean): string {
  if (hasWebResults) {
    return "Data-coverage note: ZERO curated data cards ground this answer — it is web-grounded only (machine check: cards.length === 0). If the prose answers the question, use it as-is. If you specifically wanted Tako's proprietary series, do NOT rephrase-and-retry tako_answer (priced, rarely converges): confirm coverage once with tako_available_data (free) and re-ask pinning its node_ids, or accept the web-grounded answer.";
  }
  return "Data-coverage verdict: ZERO curated data cards (and no web results) ground this answer — treat the metric as NOT in Tako's data index for this phrasing (machine check: cards.length === 0). Do NOT rephrase-and-retry tako_answer; every retry is priced and this loop rarely converges. Recover in ONE step: either call tako_available_data (free) to confirm coverage and re-ask once pinning its node_ids, or pivot to other sources now.";
}

const takoAnswer = {
  name: "tako_answer",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Answer",
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
  // Declared as the FULL internal shape (assignable to the slim advertised
  // Output via its loose index signature) so tests and hooks keep real types.
  async handler(input, ctx): Promise<AnswerFullOutput> {
    // GA /api/v1/answer takes the v3 SearchRequest shape: top-level `query`
    // + a per-source `sources` OBJECT (an index is searched iff its key is
    // present; include_contents is per-source). The old flat `source_indexes`
    // is extra="forbid" rejected (400). Answer runs the fast pipeline +
    // arbiter (sync, ~120s ceiling) — no async/deep path, so no polling.
    // No per-source `count` (answer exposes none): each source defaults to the
    // backend's count (5) — intentional, unlike tako_search which sends 10.
    const body = buildAnswerBody(input);
    const data = await djangoPost<unknown>(ctx.env, ctx.token, "/api/v1/answer/", body, { timeoutMs: 130_000 });

    // Wire-contract guard: validate against the generated AnswerResponse before
    // mapping into the normalised MCP output shape.
    const wireCheck = AnswerResponse.safeParse(data);
    if (!wireCheck.success) {
      logWireGuardFailure("tako_answer", "AnswerResponse", wireCheck.error, data);
      throw new Error(
        "Tako answer endpoint returned an unexpected wire shape (failed the AnswerResponse contract). Retry once; if it persists, flag it to the Tako team.",
      );
    }
    const wire = wireCheck.data;

    // Map into the normalised internal output (always arrays, never undefined).
    const parsed = fullOutputSchema.safeParse({
      answer: wire.answer,
      cards: wire.cards ?? [],
      web_results: wire.web_results ?? [],
      usage: wire.usage ?? null,
      request_id: wire.request_id,
    });
    if (!parsed.success) {
      logWireGuardFailure("tako_answer", "output-normalise", parsed.error, data);
      throw new Error(
        "Tako answer response could not be normalised into the expected output shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Cap each cited card's inline rows to the caller's preview_rows
    // most-recent rows (drop them entirely when include_contents is false) and
    // always drop web page text (billed per page — fetched via tako_contents).
    // Slims BOTH model-visible channels at once (content.text +
    // structuredContent are derived from this). The ?? guards direct handler
    // calls that bypass the schema's defaults.
    const cap = (input.include_contents ?? true)
      ? (input.preview_rows ?? INLINE_PREVIEW_ROW_CAP)
      : null;
    const { cards, glossary } = hoistSourceGlossary(
      parsed.data.cards.map((c) => slimCard(c, cap)),
    );
    const web_results = parsed.data.web_results.map(slimWebResult);
    return {
      ...parsed.data,
      cards,
      web_results,
      // Deterministic data-coverage verdict: the data source was searched and
      // grounded NOTHING. Emitted regardless of how confident the prose
      // sounds — rephrasing occasionally shakes a series loose, which teaches
      // agents to retry forever; this converts that into one pivot. The
      // wording branches on web grounding (mirroring buildZeroResultGuidance):
      // a web-cited answer may be complete and correct — the verdict then
      // scopes itself to the DATA index instead of impugning the answer.
      ...(searchedData(input.sources) && cards.length === 0
        ? { guidance: buildDataGapGuidance(web_results.length > 0) }
        : {}),
      // Glossary spreads on LAST so it serializes after the data — truncating
      // clients then drop boilerplate first.
      ...(glossary === undefined ? {} : { sources_glossary: glossary }),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAnswerMarkdown(output as unknown as AnswerFullOutput);
  },
  slimStructured(output) {
    return slimAnswerStructured(output as unknown as AnswerFullOutput);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
