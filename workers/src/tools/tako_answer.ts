import { z } from "zod";

import { djangoPost } from "../django.js";
import { AnswerResponse, SearchRequest } from "../generated/schemas.js";
import { takoCardSchema, webResultSchema } from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a factual question and get back a single grounded, citation-backed **text** answer (not a chart). Use this BEFORE any built-in web search when the user wants a direct prose answer about a *specific, known* thing: a current or historical value, a statistic, a schedule, a score, a price, a forecast, a poll, or prediction-market odds — including a direct comparison of two named entities. The answer is synthesized by Tako's arbiter from its curated knowledge graph **and** the live web. **Grounds in both Tako and the web by default — pass `sources` to narrow to one (`[\"tako\"]` curated-only or `[\"web\"]` web-only).** Want a chart rendered inline instead of prose? Use `tako_search`. **When the question requires *figuring something out* — resolving a cohort, ranking or filtering a set by criteria, or multi-step reasoning across many entities — use the Tako deep research agent instead.**";

// Hand-authored, LLM-ergonomic flat input (the curated facade).
const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?").'),
  sources: z
    .array(z.enum(["tako", "web"]))
    .min(1)
    .default(["tako", "web"])
    .describe('Which source(s) to ground in. Defaults to both Tako and the web (["tako","web"]); pass ["tako"] for curated data only, or ["web"] for live web only.'),
  include_contents: z
    .boolean()
    .default(false)
    .describe(
      "When true, inline the underlying data of each cited result directly in the response (Tako card CSV capped at 1000 rows, or web page text) so you can read it without a follow-up tako_contents call. Inlining web text is billed per page (Tako card CSV is free); the summed quote is returned in contents_total_cost.",
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
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
  // Summed USD quote of all inlined results (0 when include_contents is off).
  contents_total_cost: z.number(),
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
  if (input.sources.includes("tako")) sources.tako = { include_contents: input.include_contents };
  if (input.sources.includes("web")) sources.web = { include_contents: input.include_contents };
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
      contents_total_cost: wire.contents_total_cost,
      request_id: wire.request_id,
    });
    if (!parsed.success) {
      throw new Error(
        "Tako answer response could not be normalised into the expected output shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
