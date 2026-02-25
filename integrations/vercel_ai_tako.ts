/**
 * Tako integration for the Vercel AI SDK.
 *
 * Provides Vercel AI SDK-compatible tool definitions that wrap the Tako API,
 * enabling AI applications built with the Vercel AI SDK to search for charts,
 * create visualisations, list chart schemas, retrieve AI-generated insights,
 * and fetch chart images.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { createTakoTools } from "./integrations/vercel_ai_tako";
 *
 * const takoTools = createTakoTools("your-tako-api-token");
 *
 * const result = await generateText({
 *   model: openai("gpt-4o"),
 *   tools: takoTools,
 *   prompt: "Find charts about US GDP growth",
 * });
 * ```
 */

import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by {@link createTakoTools}. */
export interface TakoToolsOptions {
  /** Tako API token (from https://tako.com account settings). */
  apiToken: string;
  /** Base URL for the Tako API. Defaults to "https://api.tako.com". */
  apiUrl?: string;
}

/** A single chart search result. */
export interface TakoSearchResult {
  card_id: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  source: string | null;
}

/** Response from the knowledge search endpoint. */
export interface TakoSearchResponse {
  results: TakoSearchResult[];
  count: number;
}

/** Response from the create chart endpoint. */
export interface TakoCreateChartResponse {
  card_id: string | null;
  title: string | null;
  description: string | null;
  webpage_url: string | null;
  embed_url: string | null;
  image_url: string | null;
}

/** A single schema entry returned by list schemas. */
export interface TakoSchema {
  name: string | null;
  description: string | null;
  components: unknown[];
}

/** Response from the list schemas endpoint. */
export interface TakoListSchemasResponse {
  schemas: TakoSchema[];
  count: number;
}

/** Response from the chart insights endpoint. */
export interface TakoInsightsResponse {
  pub_id: string;
  insights: string;
  description: string;
}

/** Response from the chart image endpoint. */
export interface TakoChartImageResponse {
  image_url: string;
  pub_id: string;
  dark_mode: boolean;
}

/** Error response shape. */
export interface TakoErrorResponse {
  error: string;
  message?: string;
  suggestion?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_API_URL = "https://api.tako.com";

function buildHeaders(apiToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiToken,
  };
}

async function takoFetch<T>(
  url: string,
  apiToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...buildHeaders(apiToken),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(errorBody);
    } catch {
      parsed = { raw: errorBody };
    }
    throw Object.assign(
      new Error(`Tako API error: HTTP ${response.status}`),
      { status: response.status, body: parsed },
    );
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create Tako tools for the Vercel AI SDK.
 *
 * @param apiToken - Your Tako API token.
 * @param apiUrl   - Base URL for the Tako API. Defaults to `https://api.tako.com`.
 * @returns An object of named Vercel AI SDK tools.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { createTakoTools } from "./integrations/vercel_ai_tako";
 *
 * const tools = createTakoTools("tak_...");
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   tools,
 *   prompt: "Find charts about global temperature trends",
 * });
 * ```
 */
export function createTakoTools(
  apiToken: string,
  apiUrl: string = DEFAULT_API_URL,
) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  // -----------------------------------------------------------------------
  // searchCharts
  // -----------------------------------------------------------------------
  const searchCharts = tool({
    description:
      "Use this when you need to find existing charts and data visualizations " +
      "on any topic. Searches Tako's curated knowledge base of charts covering " +
      "economics, finance, demographics, technology, and more. Returns matching " +
      "charts with titles, descriptions, URLs, and source information.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          'Natural language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue").',
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Number of results to return (1-20)."),
      searchEffort: z
        .enum(["fast", "deep"])
        .optional()
        .default("deep")
        .describe('Search depth: "fast" or "deep".'),
      countryCode: z
        .string()
        .optional()
        .default("US")
        .describe('ISO country code (e.g. "US", "GB").'),
      locale: z
        .string()
        .optional()
        .default("en-US")
        .describe('Locale string (e.g. "en-US").'),
    }),
    execute: async ({
      query,
      count,
      searchEffort,
      countryCode,
      locale,
    }): Promise<TakoSearchResponse | TakoErrorResponse> => {
      try {
        const data = await takoFetch<{
          outputs?: { knowledge_cards?: Record<string, unknown>[] };
        }>(`${baseUrl}/api/v1/knowledge_search`, apiToken, {
          method: "POST",
          body: JSON.stringify({
            inputs: { text: query, count },
            source_indexes: ["tako"],
            search_effort: searchEffort,
            country_code: countryCode,
            locale,
          }),
        });

        const cards = data.outputs?.knowledge_cards ?? [];
        const results: TakoSearchResult[] = cards.map((card) => ({
          card_id: (card.card_id as string) ?? null,
          title: (card.title as string) ?? null,
          description: (card.description as string) ?? null,
          url: (card.url as string) ?? null,
          source: (card.source as string) ?? null,
        }));

        return { results, count: results.length };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Search failed",
          message,
          suggestion:
            'Try search_effort "fast" or a more specific query. Check your API token.',
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // createChart
  // -----------------------------------------------------------------------
  const createChart = tool({
    description:
      "Use this when you need to create a new chart from raw data. Pass a " +
      "schema name and component configurations to generate an interactive Tako " +
      "visualisation. Supports 15+ chart types. Call listChartSchemas first to " +
      "see available chart types.",
    parameters: z.object({
      schemaName: z
        .string()
        .describe(
          'Chart schema name (e.g. "bar_chart", "timeseries_card", "pie_chart").',
        ),
      components: z
        .array(z.record(z.unknown()))
        .describe(
          'Component configurations. Each object needs "component_type" and "config".',
        ),
      source: z
        .string()
        .optional()
        .describe('Optional attribution text (e.g. "Yahoo Finance").'),
    }),
    execute: async ({
      schemaName,
      components,
      source,
    }): Promise<TakoCreateChartResponse | TakoErrorResponse> => {
      try {
        const payload: Record<string, unknown> = { components };
        if (source) {
          payload.source = source;
        }

        const data = await takoFetch<Record<string, unknown>>(
          `${baseUrl}/api/v1/thin_viz/default_schema/${encodeURIComponent(schemaName)}/create/`,
          apiToken,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return {
          card_id: (data.card_id as string) ?? null,
          title: (data.title as string) ?? null,
          description: (data.description as string) ?? null,
          webpage_url: (data.webpage_url as string) ?? null,
          embed_url: (data.embed_url as string) ?? null,
          image_url: (data.image_url as string) ?? null,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Chart creation failed",
          message,
          suggestion:
            "Verify the schema name and component structure. Use listChartSchemas to see valid names.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // listChartSchemas
  // -----------------------------------------------------------------------
  const listChartSchemas = tool({
    description:
      "Use this when you want to see all available chart templates before " +
      "creating a custom chart. Returns the full list of Tako chart schemas " +
      "including timeseries, bar charts, pie charts, scatter plots, maps, and more.",
    parameters: z.object({}),
    execute: async (): Promise<
      TakoListSchemasResponse | TakoErrorResponse
    > => {
      try {
        const schemas = await takoFetch<Record<string, unknown>[]>(
          `${baseUrl}/api/v1/thin_viz/default_schema/`,
          apiToken,
        );

        const result: TakoSchema[] = schemas.map((s) => ({
          name: (s.name as string) ?? null,
          description: (s.description as string) ?? null,
          components: (s.components as unknown[]) ?? [],
        }));

        return { schemas: result, count: result.length };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Failed to list schemas",
          message,
          suggestion: "Check your API token is valid and try again.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // getChartInsights
  // -----------------------------------------------------------------------
  const getChartInsights = tool({
    description:
      "Use this when you want AI-generated analysis of a chart's data. Returns " +
      "bullet-point insights and a natural language description summarising " +
      "trends, outliers, and key takeaways from the chart.",
    parameters: z.object({
      pubId: z
        .string()
        .describe("The chart's unique identifier (pub_id / card_id)."),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .default("medium")
        .describe('Reasoning depth: "low", "medium", or "high".'),
    }),
    execute: async ({
      pubId,
      effort,
    }): Promise<TakoInsightsResponse | TakoErrorResponse> => {
      try {
        const params = new URLSearchParams({ effort });
        const data = await takoFetch<Record<string, unknown>>(
          `${baseUrl}/api/v1/internal/chart-configs/${encodeURIComponent(pubId)}/chart-insights/?${params.toString()}`,
          apiToken,
        );

        return {
          pub_id: pubId,
          insights: (data.insights as string) ?? "",
          description: (data.description as string) ?? "",
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Failed to get insights",
          message,
          suggestion: "Verify the pub_id/card_id is correct.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // getChartImage
  // -----------------------------------------------------------------------
  const getChartImage = tool({
    description:
      "Use this when you need a static preview image of a chart to display or " +
      "embed. Returns a direct URL to a PNG image of the chart.",
    parameters: z.object({
      pubId: z
        .string()
        .describe("The chart's unique identifier (pub_id / card_id)."),
      darkMode: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to return the dark-mode version (default: true)."),
    }),
    execute: async ({
      pubId,
      darkMode,
    }): Promise<TakoChartImageResponse | TakoErrorResponse> => {
      try {
        const params = new URLSearchParams({
          dark_mode: String(darkMode),
        });
        const url = `${baseUrl}/api/v1/image/${encodeURIComponent(pubId)}/?${params.toString()}`;

        // We only need to verify the endpoint is reachable; the image URL
        // itself is what we return.
        const response = await fetch(url, {
          method: "GET",
          headers: buildHeaders(apiToken),
        });

        if (response.status === 200) {
          return {
            image_url: url,
            pub_id: pubId,
            dark_mode: darkMode,
          };
        } else if (response.status === 404) {
          return {
            error: "Chart image not found",
            suggestion: "Verify the pub_id/card_id is correct.",
          };
        } else if (response.status === 408) {
          return {
            error: "Image generation timed out",
            suggestion: "Wait a few seconds and try again.",
          };
        } else {
          return {
            error: `Unexpected HTTP ${response.status}`,
            suggestion: "Check your API token and try again.",
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Failed to get chart image",
          message,
          suggestion: "Check your API token and try again.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // exploreKnowledgeGraph
  // -----------------------------------------------------------------------
  const exploreKnowledgeGraph = tool({
    description:
      "Use this when you need to discover what data is available before searching. " +
      "Helps find entities (companies, countries), metrics (revenue, GDP), cohorts " +
      "(S&P 500, G7), and time periods in Tako's knowledge graph.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          'Natural language query to explore (e.g. "tech companies", "GDP metrics").',
        ),
      nodeTypes: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by node types: entity, metric, cohort, db, units, time_period, property.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Maximum results per type (1-50)."),
    }),
    execute: async ({ query, nodeTypes, limit }) => {
      try {
        const data = await takoFetch<Record<string, unknown>>(
          `${baseUrl}/api/v1/explore/`,
          apiToken,
          {
            method: "POST",
            body: JSON.stringify({
              query,
              node_types: nodeTypes,
              limit,
            }),
          },
        );

        return {
          query: data.query as string,
          total_matches: (data.total_matches as number) ?? 0,
          entities: (data.entities as unknown[]) ?? [],
          metrics: (data.metrics as unknown[]) ?? [],
          cohorts: (data.cohorts as unknown[]) ?? [],
          time_periods: (data.time_periods as unknown[]) ?? [],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Exploration failed",
          message,
          suggestion:
            "Try a more specific query or filter by nodeTypes.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // getChartSchema
  // -----------------------------------------------------------------------
  const getChartSchema = tool({
    description:
      "Use this when you need the exact data format for a specific chart type. " +
      "Returns schema details including required fields and configuration. " +
      "Always call this before createChart.",
    parameters: z.object({
      schemaName: z
        .string()
        .describe(
          'Schema name (e.g. "bar_chart", "timeseries_card", "pie_chart").',
        ),
    }),
    execute: async ({ schemaName }) => {
      try {
        const data = await takoFetch<Record<string, unknown>>(
          `${baseUrl}/api/v1/thin_viz/default_schema/${encodeURIComponent(schemaName)}/`,
          apiToken,
        );

        return {
          name: (data.name as string) ?? null,
          description: (data.description as string) ?? null,
          components: (data.components as unknown[]) ?? [],
          template: data.template ?? null,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: "Failed to get schema",
          message,
          suggestion:
            "Use listChartSchemas to see available schema names.",
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // openChartUi
  // -----------------------------------------------------------------------
  const openChartUi = tool({
    description:
      "Use this when you want to display a fully interactive chart. Returns an " +
      "embed URL with zooming, panning, and hover interactions. No API call needed.",
    parameters: z.object({
      pubId: z
        .string()
        .describe("The chart's unique identifier (pub_id / card_id)."),
      darkMode: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to use dark mode (default: true)."),
    }),
    execute: async ({ pubId, darkMode }) => {
      const theme = darkMode ? "dark" : "light";
      const embedUrl = `https://tako.com/embed/${pubId}/?theme=${theme}`;
      return {
        pub_id: pubId,
        embed_url: embedUrl,
        dark_mode: darkMode,
      };
    },
  });

  return {
    searchCharts,
    exploreKnowledgeGraph,
    createChart,
    listChartSchemas,
    getChartSchema,
    getChartInsights,
    getChartImage,
    openChartUi,
  } as const;
}

/** The return type of {@link createTakoTools}. */
export type TakoTools = ReturnType<typeof createTakoTools>;
