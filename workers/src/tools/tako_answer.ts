import { z } from "zod";

import { djangoPost } from "../django.js";
import { takoCardSchema, webResultSchema } from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a factual question and get back a single grounded, citation-backed **text** answer (not a chart). Use this BEFORE any built-in web search when the user wants a direct prose answer about a *specific, known* thing: a current or historical value, a statistic, a schedule, a score, a price, a forecast, a poll, or prediction-market odds — including a direct comparison of two named entities. The answer is synthesized by Tako's arbiter from its curated knowledge graph **and** the live web. **Grounds in both Tako and the web by default — pass `sources` to narrow to one (`[\"data\"]` curated-only or `[\"web\"]` web-only).** Want a chart rendered inline instead of prose? Use `tako_search`. **When the question requires *figuring something out* — resolving a cohort, ranking or filtering a set by criteria, or multi-step reasoning across many entities — use the Tako deep research agent instead.**";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?").'),
  sources: z
    // "data" is the curated-knowledge source; "tako" is the legacy synonym,
    // still accepted and normalized to "data" before the request is built.
    .array(z.enum(["data", "web", "tako"]))
    .min(1)
    .default(["data", "web"])
    .describe('Which source(s) to ground in. Defaults to both Tako and the web (["data","web"]); pass ["data"] for curated data only, or ["web"] for live web only. (The legacy value "tako" is accepted as a synonym for "data".)'),
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

// TakoCard + WebResult schemas are shared with tako_search via
// _search_results.ts (backend api/ga/v3/search/types.py).
const outputSchema = z.object({
  answer: z.string(),
  cards: z.array(takoCardSchema),
  web_results: z.array(webResultSchema),
  // Summed USD quote of all inlined results (0 when include_contents is off).
  contents_total_cost: z.number(),
  request_id: z.string(),
});

type Output = z.infer<typeof outputSchema>;

// Backend AnswerResponse (api/ga/v1/answer/types.py): { answer, cards, web_results, contents_total_cost, request_id }.
type AnswerPostResponse = {
  answer?: string;
  cards?: unknown[];
  web_results?: unknown[];
  contents_total_cost?: number;
  request_id?: string;
};

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
    const sources: Record<string, unknown> = {};
    // Accept the legacy "tako" value as a synonym for "data".
    if (input.sources.includes("data") || input.sources.includes("tako"))
      sources.data = { include_contents: input.include_contents };
    if (input.sources.includes("web")) sources.web = { include_contents: input.include_contents };
    const body = {
      query: input.query,
      sources,
      country_code: input.country_code,
      locale: input.locale,
    };
    const data = await djangoPost<AnswerPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/answer/",
      body,
      { timeoutMs: 130_000 },
    );
    const parsed = outputSchema.safeParse({
      answer: data.answer ?? "",
      cards: data.cards ?? [],
      web_results: data.web_results ?? [],
      contents_total_cost: data.contents_total_cost ?? 0,
      request_id: data.request_id ?? "",
    });
    if (!parsed.success) {
      throw new Error(
        "Tako answer endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
