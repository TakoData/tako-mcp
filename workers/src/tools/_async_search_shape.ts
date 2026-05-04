/**
 * Shared shapes for the async knowledge-search flow.
 *
 * `knowledge_search` (kickoff side) and `wait_for_knowledge_search`
 * (polling side) both speak this shape so the agent reads identical
 * fields whether the task completed synchronously on the kickoff call
 * or via a later wait. Auto-chain widget fields (pub_id, embed_url, …)
 * appear in both places via `buildResultsWithAutoChain`.
 *
 * Intentionally a `_`-prefixed module so the registry codegen
 * (`gen-registry.ts`) skips it — only top-level tool files become
 * registered tools.
 */
import { z } from "zod";

import type { Env } from "../env.js";
import {
  HTTP_URL_REGEX,
  DEFAULT_DARK_MODE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  buildChartUrls,
} from "./_chart_widget.js";

export type KnowledgeCard = {
  card_id?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
};

// Append-only progress event log entry emitted by `run_knowledge_agent_search`
// (Tako's Celery task). Surfaced in error / timeout messages so the
// caller knows how far the pipeline got.
export type AsyncTaskEvent = {
  id: number;
  data?: {
    event_type?: string;
    [key: string]: unknown;
  };
};

export type AsyncTaskStatus = {
  task_id: string;
  status: string;
  result?: {
    outputs?: {
      knowledge_cards?: KnowledgeCard[];
    };
  };
  error?: string;
  events?: AsyncTaskEvent[];
};

export type AsyncTaskInitiation = {
  task_id: string;
  status: string;
  message?: string;
};

export type SyncSearchResponse = {
  outputs?: {
    knowledge_cards?: KnowledgeCard[];
  };
};

export type SearchPostResponse = SyncSearchResponse | AsyncTaskInitiation;

export function isAsyncTaskInitiation(
  data: SearchPostResponse,
): data is AsyncTaskInitiation {
  // `task_id` is the unambiguous async-mode marker — sync responses live
  // under `outputs.knowledge_cards`. Tolerant of `status` casing drift
  // ("pending" vs "PENDING") between POST and GET.
  return (
    typeof data === "object" &&
    data !== null &&
    "task_id" in data &&
    typeof (data as AsyncTaskInitiation).task_id === "string"
  );
}

// Django's task status discriminator. Compared against `.toUpperCase()`
// of the response status so casing drift between POST ("pending") and
// GET ("PENDING") doesn't silently turn a terminal response into an
// infinite loop.
// Source: `tako/app/backend/monolith/models.py:2719` (AsyncTaskStatusChoices).
export const COMPLETED_STATE = "COMPLETED";
export const FAILURE_STATES = new Set(["FAILED", "INTERRUPTED"]);

/**
 * Summarize a status response's events for use in error / timeout
 * messages. Picks the most recent event with a `data.event_type` and
 * returns "<count> events; last: <type>". Falls back gracefully when
 * the backend doesn't include events.
 */
export function summarizeProgress(events: AsyncTaskEvent[] | undefined): string {
  const list = events ?? [];
  if (list.length === 0) return "no progress events emitted";
  // Walk from the tail to find the most recent typed event without
  // allocating a reversed copy. (Array.findLast is ES2023; tsconfig
  // targets earlier so we hand-roll the reverse scan.)
  let lastEventType = "untyped";
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]?.data?.event_type;
    if (typeof t === "string") {
      lastEventType = t;
      break;
    }
  }
  return `${list.length} progress event${list.length === 1 ? "" : "s"}; last: ${lastEventType}`;
}

// Visualization shape returned to the agent for each knowledge card.
// `open_ui_tool` / `open_ui_args` hint that the agent can chain into
// `open_chart_ui` for any card other than the top one (which auto-renders).
export const visualizationSchema = z.object({
  card_id: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  source: z.string().nullable(),
  open_ui_tool: z.string().optional(),
  open_ui_args: z.object({ pub_id: z.string() }).optional(),
});

export type Visualization = z.infer<typeof visualizationSchema>;

// Auto-chain widget fields lifted to the output root when the top card
// has a card_id. Mirrors `open_chart_ui`'s output so the chart widget
// reads the same keys on every tool that may render a chart.
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

// Output shape shared between knowledge_search (sync results) and
// wait_for_knowledge_search (COMPLETED branch). Both tools include
// these fields so the host widget renders identically regardless of
// which tool produced the final cards.
export const resultsOutputShape = {
  results: z.array(visualizationSchema),
  count: z.number().int().nonnegative(),
  ...autoChainShape,
} as const;

export function cardToVisualization(card: KnowledgeCard): Visualization {
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
      open_ui_tool: "open_chart_ui",
      open_ui_args: { pub_id: cardId },
    };
  }
  return base;
}

/**
 * Build the full results-path output (results + count + auto-chain
 * widget fields if the top card has a card_id). Used by both
 * `knowledge_search` (sync path) and `wait_for_knowledge_search`
 * (COMPLETED branch) so they emit identical shapes.
 */
export function buildResultsWithAutoChain(
  cards: KnowledgeCard[],
  env: Env,
): {
  results: Visualization[];
  count: number;
  pub_id?: string;
  embed_url?: string;
  image_url?: string;
  dark_mode?: boolean;
  width?: number;
  height?: number;
} {
  const results = cards.map(cardToVisualization);
  const topCardId = results[0]?.card_id;
  if (typeof topCardId === "string" && topCardId !== "") {
    const { embed_url, image_url } = buildChartUrls(
      env,
      topCardId,
      DEFAULT_DARK_MODE,
    );
    return {
      results,
      count: results.length,
      pub_id: topCardId,
      embed_url,
      image_url,
      dark_mode: DEFAULT_DARK_MODE,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
  }
  return { results, count: results.length };
}
