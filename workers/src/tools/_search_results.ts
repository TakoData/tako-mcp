/**
 * Shared shapes for the v3 search/answer surface used by `tako_search`
 * and `tako_answer`. The TakoCard + WebResult schemas mirror the backend
 * `app/backend/knowledge/api/ga/v3/search/types.py`. Auto-chain widget
 * fields (pub_id, embed_url, …) are lifted to the output root by
 * `buildSearchOutput` so the chart widget renders the top card inline.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */
import { z } from "zod";

import type { Env } from "../env.js";
import {
  HTTP_URL_REGEX,
  DEFAULT_DARK_MODE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  buildChartUrls,
} from "./_chart_widget.js";

// Backend ResultContent (api/ga/content_types.py) — a result's inline data,
// populated only when include_contents was requested for that source. format is
// "csv" (Tako card data) or "text" (web page text); data is null unless inlined;
// CSV is capped at 1000 rows (total_rows is the true count, truncated flags the
// cap). cost is the USD quote for fetching this result.
export const resultContentSchema = z
  .object({
    format: z.string(),
    cost: z.number(),
    data: z.string().nullable(),
    total_rows: z.number().nullable(),
    truncated: z.boolean(),
  })
  .loose();
export type ResultContent = z.infer<typeof resultContentSchema>;

// Backend TakoCard (api/ga/v3/search/types.py::TakoCard). Loose so a richer
// backend card doesn't break parsing. Shared by tako_search + tako_answer.
export const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
    // Inline card CSV — present only when include_contents was set for the tako source.
    content: resultContentSchema.nullable().optional(),
  })
  .loose();
export type TakoCard = z.infer<typeof takoCardSchema>;

export const webResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    publish_date: z.string().nullable().optional(),
    // 1-based citation index — set on Agent API results, null on raw retrieval.
    citation_number: z.number().nullable().optional(),
    // Inline web page text — present only when include_contents was set for the web source.
    content: resultContentSchema.nullable().optional(),
  })
  .loose();
export type WebResult = z.infer<typeof webResultSchema>;

// Auto-chain widget fields lifted to the output root when the top card
// has a card_id. Read by the chart widget (tako_search inline render).
export const autoChainShape = {
  pub_id: z.string().optional(),
  embed_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "embed_url must be http(s)" })
    .optional(),
  image_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "image_url must be http(s)" })
    .optional(),
  dark_mode: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
} as const;

// tako_search output: v3 cards + web_results + request_id + the widget
// fields for the top card. Mirrors tako_answer's {cards, web_results,
// request_id} plus the inline-render plumbing.
export const searchOutputShape = {
  cards: z.array(takoCardSchema),
  web_results: z.array(webResultSchema),
  // Summed USD quote of all inlined results (0 when include_contents is off).
  contents_total_cost: z.number(),
  request_id: z.string(),
  ...autoChainShape,
} as const;

export type SearchOutput = {
  cards: TakoCard[];
  web_results: WebResult[];
  contents_total_cost: number;
  request_id: string;
  pub_id?: string;
  embed_url?: string;
  image_url?: string;
  dark_mode?: boolean;
  width?: number;
  height?: number;
};

/**
 * Build the tako_search output: the cards + web_results + request_id, plus
 * auto-chain widget fields lifted from the top card when it has a card_id
 * (so the host renders that chart inline). Endpoint-agnostic — only needs
 * a card_id, which v3 TakoCards carry.
 */
export function buildSearchOutput(
  cards: TakoCard[],
  webResults: WebResult[],
  requestId: string,
  contentsTotalCost: number,
  env: Env,
): SearchOutput {
  const base: SearchOutput = {
    cards,
    web_results: webResults,
    contents_total_cost: contentsTotalCost,
    request_id: requestId,
  };
  const topCardId = cards[0]?.card_id;
  if (typeof topCardId === "string" && topCardId !== "") {
    const { embed_url, image_url } = buildChartUrls(
      env,
      topCardId,
      DEFAULT_DARK_MODE,
    );
    return {
      ...base,
      pub_id: topCardId,
      embed_url,
      image_url,
      dark_mode: DEFAULT_DARK_MODE,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
  }
  return base;
}
