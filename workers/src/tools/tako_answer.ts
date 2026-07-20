import { z } from "zod";

import { djangoPost } from "../django.js";
import { AnswerResponse, SearchRequest } from "../generated/schemas.js";
import { slimCard, slimWebResult, takoCardSchema, usageSchema, webResultSchema } from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a specific data question and get back **one** synthesized, citation-backed **prose** answer (not a chart or a list of cards), plus the supporting cards it cites. Tako's arbiter reads across its curated knowledge graph **and** the live web and writes a single grounded answer. **Reach for this when you want a direct, written answer to a *specific, known* question in a single call** — a current or historical value, a statistic, a schedule, a score, a price, a forecast, a poll, or prediction-market odds, including a direct comparison of two named entities. Best for a *single, self-contained* question — the answer comes back written for you, so you don't touch the underlying rows. **If you instead want the actual data to work with — to compute over, chart, or synthesize your own thesis — or your question is broad/multi-part (several entities or metrics), use `tako_search` and PARALLELIZE it: fire several NARROW single entity+metric searches concurrently rather than asking one broad multi-part question here (e.g. for \"CPI, core CPI, PCE and core PCE\" run four separate `tako_search` calls, not one `tako_answer`). This tool returns one written answer; `tako_search` returns the data. When the question needs *figuring out* — resolving a cohort, ranking or filtering a set by criteria, or multi-step reasoning across many entities — use the Tako Answer Agent.** **Use BEFORE any built-in web search** for the direct-answer case. **Grounds in both Tako and the web by default — pass `sources` to narrow to one (`[\"data\"]` curated-only or `[\"web\"]` web-only).** **Grounding with the data graph:** resolve entities/metrics with `tako_graph_search` + `tako_graph_related`, then pass the resolved ids in `node_ids` (max 20) to pin them (strong retrieval boost). Set `strict: true` to hard-filter to only cards matching a pinned node (requires non-empty `node_ids`); leave it false (default) to boost pinned nodes while still returning organic results. Skip `web` when you're confident Tako has the data.";

// Hand-authored, LLM-ergonomic flat input (the curated facade).
const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?").'),
  sources: z
    .array(z.enum(["data", "web", "tako"]))
    .min(1)
    .default(["data", "web"])
    .describe('Which source(s) to ground in. Defaults to both Tako data and the web (["data","web"]); pass ["data"] for curated data only, or ["web"] for live web only. ("tako" is accepted as a legacy synonym for "data".)'),
  // No `include_contents` knob: the synthesized `answer` prose IS the payload,
  // so cited cards never inline their row data (it would be redundant bloat).
  // When the model wants the underlying rows behind a specific cited card — or
  // the full text of a cited web page — it calls tako_contents on that result's
  // url. Keeps the answer response compact and its cost predictable.
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
      "Graph node ids (from tako_graph_search / tako_graph_related) to PIN into the Tako data source. Pinned nodes get a strong retrieval boost. Max 20. Applies only to the 'data' source.",
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
    > = { include_contents: false };
    if (input.node_ids !== undefined && input.node_ids.length > 0) {
      data.node_ids = input.node_ids;
    }
    if (input.strict) {
      data.strict = true;
    }
    sources.data = data;
  }
  // include_contents pinned false on every source: answer never inlines row
  // data (see inputSchema) — the arbiter's prose is the payload. Web text in
  // particular is billed per page, so never auto-fetch it here.
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
      throw new Error(
        "Tako answer response could not be normalised into the expected output shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    // Defensively strip any inline row payload the backend attached to cited
    // results (a `content` preview rides along even with include_contents
    // false). Answer is prose-first: rows/web-text are fetched on demand via
    // tako_contents, never inlined here. Drops from BOTH model-visible channels
    // at once (content.text + structuredContent are both derived from this).
    return {
      ...parsed.data,
      cards: parsed.data.cards.map((c) => slimCard(c, null)),
      web_results: parsed.data.web_results.map(slimWebResult),
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
