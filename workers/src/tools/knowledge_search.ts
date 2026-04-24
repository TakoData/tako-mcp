/**
 * `knowledge_search` — semantic search over Tako's curated chart knowledge base.
 *
 * Ports `knowledge_search` from `src/tako_mcp/server.py:85` (Python legacy).
 * Posts to `/api/v1/knowledge_search`, flattens `outputs.knowledge_cards[]` into
 * a `results[]` shape, and adds `open_ui_tool` / `open_ui_args` hints so an LLM
 * can chain into `open_chart_ui` without re-deriving the card id.
 *
 * `search_effort` is optional; omitted → run `fast` first, escalate to `deep`
 * only if `fast` returns zero cards. Deep against staging/prod returns a
 * 202 with `{ task_id, status: "pending" }` and expects the caller to poll
 * `GET /api/v1/knowledge_search/async/status/?task_id=<id>` until
 * `status: "COMPLETED"` (the cards land on `result.outputs.knowledge_cards[]`).
 * This tool does NOT poll yet — an explicit `search_effort="deep"` call will
 * silently return `[]` because the 202 body has no `outputs.knowledge_cards`.
 * Legacy Python MCP had the same gap. Implementing polling (budgeted against
 * the 60s tool timeout) is tracked separately.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue").',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of matching cards to return (1–20)."),
  search_effort: z
    .enum(["fast", "medium", "deep", "auto"])
    .optional()
    .describe(
      "Search depth: `fast` (lexical), `medium` / `auto` (balanced), `deep` (Orca research pipeline, higher credit cost). Omit to let the tool run `fast` first and escalate to `deep` only if `fast` returns zero cards — deep against staging/prod is fragile (Orca redirect round-trip) and often empty, so the fallback avoids spending a credit unless `fast` couldn't answer.",
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z
    .string()
    .default("en-US")
    .describe("Locale for results."),
});

const visualizationSchema = z.object({
  card_id: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  source: z.string().nullable(),
  open_ui_tool: z.string().optional(),
  open_ui_args: z.object({ pub_id: z.string() }).optional(),
});

const outputSchema = z.object({
  results: z.array(visualizationSchema),
  count: z.number().int().nonnegative(),
});

type DjangoResponse = {
  outputs?: {
    knowledge_cards?: Array<{
      card_id?: string | null;
      title?: string | null;
      description?: string | null;
      url?: string | null;
      source?: string | null;
    }>;
  };
};

const knowledge_search = {
  name: "knowledge_search",
  description:
    "Use this to find existing charts and live-data visualizations on almost any topic. Tako's knowledge base covers economics, finance (stocks, crypto, FX), demographics, technology, weather and forecasts, polls and elections, prediction markets (Polymarket), internet and app traffic (SimilarWeb), sports, real-estate, energy, health, and more — plus real-time / live data via the deep-research pipeline. Default to calling this first whenever a user asks about any trend, comparison, statistic, current value, forecast, or betting/prediction-market odds, even if the topic seems outside traditional 'chart' categories — Tako very likely has a relevant card.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search Charts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const runSearch = async (effort: "fast" | "medium" | "deep" | "auto") => {
      const body = {
        inputs: { text: input.query, count: input.count },
        source_indexes: ["tako"],
        search_effort: effort,
        country_code: input.country_code,
        locale: input.locale,
      };
      const data = await djangoPost<DjangoResponse>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search",
        body,
        { timeoutMs: 60_000 },
      );
      return data.outputs?.knowledge_cards ?? [];
    };

    // When caller omits `search_effort`, orchestrate fast → deep. Deep
    // against staging/prod frequently returns empty (Orca redirect path
    // is fragile from Workers), while fast is reliable and credit-cheap,
    // so running fast first avoids wasted deep calls on common queries.
    // Any explicit effort — including "fast" — is a directive: single call.
    let cards = await runSearch(input.search_effort ?? "fast");
    if (input.search_effort === undefined && cards.length === 0) {
      cards = await runSearch("deep");
    }
    const results = cards.map((card) => {
      const cardId = card.card_id ?? null;
      const base = {
        card_id: cardId,
        title: card.title ?? null,
        description: card.description ?? null,
        url: card.url ?? null,
        source: card.source ?? null,
      };
      if (cardId !== null && cardId !== "") {
        return {
          ...base,
          open_ui_tool: "open_chart_ui" as const,
          open_ui_args: { pub_id: cardId },
        };
      }
      return base;
    });
    return { results, count: results.length };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default knowledge_search;
