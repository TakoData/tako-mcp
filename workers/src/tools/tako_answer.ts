import { z } from "zod";

import { djangoPost } from "../django.js";
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
});

// Minimal TakoCard mirror (backend api/ga/v3/search/types.py::TakoCard). Loose
// so a richer backend card doesn't break parsing.
const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
  })
  .loose();

const webResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
  })
  .loose();

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
    title: "Tako: Grounded Answer",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    // GA /api/v1/answer takes the v3 SearchRequest shape: top-level `query`
    // (NOT inputs.text) + `source_indexes`. Answer runs the fast pipeline +
    // arbiter (sync, ~120s ceiling) — no async/deep path, so no polling.
    const body = {
      query: input.query,
      source_indexes: input.sources,
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
