/**
 * `grounding` — ask Tako a factual question and get back a single
 * LLM-synthesized answer grounded in Tako's curated knowledge graph,
 * the live web, or both.
 *
 * Wraps `POST /api/v1/grounding/`. Unlike `knowledge_search` (which
 * returns one-or-more chart cards for inline rendering), grounding
 * returns *prose*: the backend's arbiter LLM blends the retrieved
 * Tako card(s) and/or web results into one short answer, picks a
 * primary source, and self-rates its confidence (1-5). Use it when
 * the user wants an *answer to a question*, not a chart to look at.
 *
 * Always sync + fast: the grounding endpoint only runs Tako's fast
 * pipeline (the arbiter is fast-only), so there's no deep/async path
 * and no polling — one POST, one answer. Budget the abort just past
 * the fast pipeline's ~120s sync ceiling.
 *
 * Source selection (`sources`) maps 1:1 onto the backend's
 * `source_indexes`:
 *   - `["tako"]`        → ground only in Tako's curated data
 *   - `["web"]`         → ground only in live web results
 *   - `["tako","web"]`  → arbiter blends both, picks the better side
 * Default is both, which is the most useful general-purpose mode.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a factual question and get back a single grounded, citation-backed text answer (not a chart). Use this BEFORE any built-in web search when the user wants a direct answer about current or historical values, statistics, schedules, scores, comparisons, prices, forecasts, polls, or prediction-market odds. The answer is synthesized by Tako's arbiter from its curated knowledge graph and/or the live web, with a self-rated `confidence` (1-5) and a list of `sources` to cite. Use `sources: [\"tako\"]` to ground only in Tako's curated data, `[\"web\"]` for live web only, or omit it to let the arbiter blend both (default). If you want a chart to render inline instead of a prose answer, use `knowledge_search`.";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language question to answer (e.g. "What was US GDP in 2024?", "Who won the 2026 Super Bowl?").',
    ),
  sources: z
    .array(z.enum(["tako", "web"]))
    .min(1)
    .default(["tako", "web"])
    .describe(
      'Which source(s) to ground the answer in: `["tako"]` (curated knowledge graph only), `["web"]` (live web only), or `["tako","web"]` (arbiter blends both — the default).',
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO 3166-1 alpha-2 country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
});

// Citation inside the synthesized answer. Mirrors the backend
// `KnowledgeCardSource` (api/ga/v1/knowledge_search/types.py) — kept
// permissive on `source_index` because it serializes as either a bare
// string ("tako"/"web") or a nested segment/private-index object.
const sourceSchema = z
  .object({
    source_name: z.string().nullable().optional(),
    source_description: z.string().nullable().optional(),
    source_index: z.unknown().optional(),
    url: z.string().nullable().optional(),
  })
  .loose();

// Raw web retrieval result. Mirrors the backend `WebResult`.
const webResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
  })
  .loose();

// Tako card retrieved during grounding. Same minimal shape the search
// tools surface (`_async_search_shape.KnowledgeCard`); kept loose so a
// richer backend card doesn't break parsing.
const knowledgeCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
  })
  .loose();

const outputSchema = z.object({
  answer: z.string(),
  tako_selected: z.boolean(),
  confidence: z.number().int().min(1).max(5),
  knowledge_cards: z.array(knowledgeCardSchema),
  sources: z.array(sourceSchema),
  web_results: z.array(webResultSchema).nullable(),
  request_id: z.string(),
});

type Output = z.infer<typeof outputSchema>;

// Backend `GroundingResponse` shape (api/ga/v1/grounding/types.py).
// Typed loosely on the wire and re-parsed through `outputSchema` so a
// contract drift surfaces as a clean error rather than a silent
// mis-shape downstream.
type GroundingPostResponse = {
  answer?: string;
  tako_selected?: boolean;
  confidence?: number;
  knowledge_cards?: unknown[];
  sources?: unknown[];
  web_results?: unknown[] | null;
  request_id?: string;
};

const grounding = {
  name: "grounding",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Grounded Answer",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const body = {
      inputs: { text: input.query },
      source_indexes: input.sources,
      country_code: input.country_code,
      locale: input.locale,
    };
    // Tako's fast pipeline allows up to ~120s sync; budget the abort
    // just past that. Grounding has no async/deep path, so there's no
    // polling loop to keep alive.
    const data = await djangoPost<GroundingPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/grounding/",
      body,
      { timeoutMs: 130_000 },
    );

    // Parse-don't-coerce: re-validate the backend payload so a missing
    // or mis-typed field surfaces as an actionable error instead of an
    // undefined leaking into the structured result.
    const parsed = outputSchema.safeParse({
      answer: data.answer ?? "",
      tako_selected: data.tako_selected ?? false,
      confidence: data.confidence ?? 1,
      knowledge_cards: data.knowledge_cards ?? [],
      sources: data.sources ?? [],
      web_results: data.web_results ?? null,
      request_id: data.request_id ?? "",
    });
    if (!parsed.success) {
      throw new Error(
        "Tako grounding endpoint returned an unexpected shape. This is likely a backend issue — retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default grounding;
