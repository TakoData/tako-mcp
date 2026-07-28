import { z } from "zod";

import { djangoPost } from "../django.js";
import { AnswerResponse, SearchRequest } from "../generated/schemas.js";
import { logWireGuardFailure } from "./_log.js";
import {
  dedupeCardBoilerplate,
  INLINE_PREVIEW_ROW_CAP,
  MAX_PREVIEW_ROWS,
  slimCard,
  slimWebResult,
  takoCardSchema,
  usageSchema,
  webResultSchema,
} from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Ask one specific data question; get one synthesized answer grounded in the data or web tako cites.",
  "",
  "Best for: a single, self-contained data question with one answer. The `answer` is synthesized from the cited sources; the `cards` are its citations.",
  "",
  "`tako_search` is the counterpart for fast, parallel retrieval of data cards; the Tako Answer Agent handles open-ended, multi-step research.",
  "",
  "Grounds over BOTH data and web by default. When unsure the proprietary data exists or its exact name, run `tako_available_data` first (free, instant) — the recommended first step — then pin the node_ids it returns here for an accurate, grounded answer. Cited data cards inline their recent rows by default (see include_contents/preview_rows), so the series arrives with the answer; for the full history or a cited page's text, call `tako_contents` on its url.",
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
      `How many rows of each cited card's data to inline when include_contents is true — always the N MOST-RECENT rows (default ${INLINE_PREVIEW_ROW_CAP}, max ${MAX_PREVIEW_ROWS}). Ignored when include_contents is false.`,
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

// Parity-check outcome: Path 2 — keep the hand-written outputSchema as the
// MCP facade (always returns arrays, never undefined) and validate the raw
// wire against the generated AnswerResponse contract before mapping.
//
// The generated AnswerResponse has cards/web_results as *optional* (may be
// absent on the wire). The hand-written facade normalises them to required
// arrays (defaulting ?? []) so callers never see undefined. If we switched to
// outputSchema = AnswerResponse directly the existing test
// "defaults missing optional fields to empty arrays" would fail because
// AnswerResponse allows cards: undefined. The generated AnswerResponse is
// therefore used as the wire-guard (AnswerResponse.safeParse on raw data)
// while the hand-written schema remains the tool's advertised output shape.
const outputSchema = z.object({
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
});

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
  if (input.sources.includes("web")) sources.web = { include_contents: false };
  // No `effort`/per-source `count` (unlike buildSearchBody): answer is
  // fast-pipeline + arbiter only, with no async/deep path (see handler).
  return {
    query: input.query,
    sources,
    country_code: input.country_code,
    locale: input.locale,
  } satisfies z.input<typeof SearchRequest>; // ← build-time guard: backend request drift breaks here
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
  async handler(input, ctx): Promise<Output> {
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

    // Map into the normalised MCP output (always returns arrays, never undefined).
    const parsed = outputSchema.safeParse({
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
    const cards = dedupeCardBoilerplate(parsed.data.cards.map((c) => slimCard(c, cap)));
    const searchedData =
      input.sources.includes("data") || input.sources.includes("tako");
    return {
      ...parsed.data,
      cards,
      web_results: parsed.data.web_results.map(slimWebResult),
      // Deterministic data-coverage verdict: the data source was searched and
      // grounded NOTHING. Emitted regardless of how confident the prose
      // sounds — rephrasing occasionally shakes a series loose, which teaches
      // agents to retry forever; this converts that into one pivot.
      ...(searchedData && cards.length === 0
        ? {
            guidance:
              "Data-coverage verdict: ZERO curated data cards ground this answer — treat the metric as NOT in Tako's data index for this phrasing (machine check: cards.length === 0). Do NOT rephrase-and-retry tako_answer; every retry is priced and this loop rarely converges. Recover in ONE step: either call tako_available_data (free) to confirm coverage and re-ask once pinning its node_ids, or pivot to the cited web_results / other sources now.",
          }
        : {}),
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
