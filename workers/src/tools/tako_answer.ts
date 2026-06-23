import { z } from "zod";

import { djangoPost } from "../django.js";
import { takoCardSchema, webResultSchema } from "./_search_results.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a factual question and get back a single grounded, citation-backed text answer (not a chart). Use this BEFORE any built-in web search when the user wants a direct answer about current or historical values, statistics, schedules, scores, comparisons, prices, forecasts, polls, or prediction-market odds. The answer is synthesized by Tako's arbiter from its curated knowledge graph and/or the live web. Use `sources: [\"tako\"]` to ground only in curated data, `[\"web\"]` for live web only, or omit it to let the arbiter blend both (default). If you want a chart rendered inline instead of a prose answer, use `tako_search`.";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?").'),
  sources: z
    .array(z.enum(["tako", "web"]))
    .min(1)
    .default(["tako", "web"])
    .describe('Which source(s) to ground in: ["tako"], ["web"], or ["tako","web"] (default).'),
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
  request_id: z.string(),
});

type Output = z.infer<typeof outputSchema>;

// Backend AnswerResponse (api/ga/v1/answer/types.py): { answer, cards, web_results, request_id }.
type AnswerPostResponse = {
  answer?: string;
  cards?: unknown[];
  web_results?: unknown[];
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
    // (NOT inputs.text) + `source_indexes`. Answer runs the fast pipeline +
    // arbiter (sync, ~120s ceiling) — no async/deep path, so no polling.
    const body = {
      query: input.query,
      source_indexes: input.sources,
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
