/**
 * `knowledge_search` — semantic search over Tako's curated chart knowledge base.
 *
 * Ports `knowledge_search` from `src/tako_mcp/server.py:85` (Python legacy).
 * Posts to `/api/v1/knowledge_search`, flattens `outputs.knowledge_cards[]` into
 * a `results[]` shape, and adds `open_ui_tool` / `open_ui_args` hints so an LLM
 * can chain into `open_chart_ui` without re-deriving the card id.
 *
 * `search_effort` default ("deep") matches the Python tool. On the backend, deep
 * mode delegates to the Orca/orchestrator async pipeline — legacy Python MCP
 * relied on the sync endpoint's transparent redirect; that behavior is
 * preserved here.
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
    .default("deep")
    .describe(
      "Search depth: `fast` (lexical), `medium` / `auto` (balanced), `deep` (Orca research pipeline, higher credit cost).",
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
    "Use this when you need to find existing charts and data visualizations on any topic. Searches Tako's curated knowledge base of charts covering economics, finance, demographics, technology, and more. Start here when a user asks about data trends, comparisons, or statistics — Tako likely already has a relevant visualization.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search Charts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const body = {
      inputs: { text: input.query, count: input.count },
      source_indexes: ["tako"],
      search_effort: input.search_effort,
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
    const cards = data.outputs?.knowledge_cards ?? [];
    const results = cards.map((card) => {
      const cardId = card.card_id ?? null;
      const base = {
        card_id: cardId,
        title: card.title ?? null,
        description: card.description ?? null,
        url: card.url ?? null,
        source: card.source ?? null,
      };
      if (cardId !== null && cardId !== undefined && cardId !== "") {
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
