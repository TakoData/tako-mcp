/**
 * `explore_knowledge_graph` — surface entities, metrics, cohorts, and time
 * periods available in Tako's knowledge graph for a query.
 *
 * Ports `explore_knowledge_graph` from `src/tako_mcp/server.py:299`. Posts to
 * `/api/v1/explore/`. The endpoint is agent-native — the web frontend does not
 * call it today (verified by grep over `app/frontend/src`).
 *
 * Response trimming mirrors the Python tool: cap aliases / sample-members at
 * small N per item so the payload stays LLM-friendly.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const nodeTypeSchema = z.enum([
  "entity",
  "metric",
  "cohort",
  "db",
  "units",
  "time_period",
  "property",
]);

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language query (e.g. "tech companies", "GDP metrics", "automotive industry").',
    ),
  node_types: z
    .array(nodeTypeSchema)
    .optional()
    .describe(
      "Optional filter for specific node types: entity, metric, cohort, db, units, time_period, property.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of results per type (1–50)."),
});

const entitySchema = z.object({
  name: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  available_tables: z.array(z.string()),
  node_id: z.string().nullable(),
});

const metricSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  units: z.array(z.string()),
  time_periods: z.array(z.string()),
  compatible_tables: z.array(z.string()),
  node_id: z.string().nullable(),
});

const cohortSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  member_count: z.number().nullable(),
  sample_members: z.array(z.string()),
  node_id: z.string().nullable(),
});

const outputSchema = z.object({
  query: z.string().nullable(),
  total_matches: z.number().int().nonnegative(),
  entities: z.array(entitySchema),
  metrics: z.array(metricSchema),
  cohorts: z.array(cohortSchema),
  time_periods: z.array(z.unknown()),
  execution_time_ms: z.number().nonnegative(),
});

type DjangoResponse = {
  query?: string | null;
  total_matches?: number;
  entities?: Array<{
    name?: string | null;
    type?: string | null;
    description?: string | null;
    aliases?: string[];
    available_tables?: string[];
    node_id?: string | null;
  }>;
  metrics?: Array<{
    name?: string | null;
    description?: string | null;
    units?: string[];
    time_periods?: string[];
    compatible_tables?: string[];
    node_id?: string | null;
  }>;
  cohorts?: Array<{
    name?: string | null;
    description?: string | null;
    member_count?: number | null;
    sample_members?: string[];
    node_id?: string | null;
  }>;
  time_periods?: unknown[];
  execution_time_ms?: number;
};

const explore_knowledge_graph = {
  name: "explore_knowledge_graph",
  description:
    "Use this when you need to discover what data is available before searching. Finds entities (companies, countries), metrics (revenue, GDP), cohorts (S&P 500, G7), and time periods. Use to disambiguate queries or understand what data Tako has before calling knowledge_search.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Explore Knowledge Graph",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const body = {
      query: input.query,
      node_types: input.node_types ?? null,
      limit: input.limit,
    };
    const data = await djangoPost<DjangoResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/explore/",
      body,
      { timeoutMs: 60_000 },
    );
    return {
      query: data.query ?? null,
      total_matches: data.total_matches ?? 0,
      entities: (data.entities ?? []).map((e) => ({
        name: e.name ?? null,
        type: e.type ?? null,
        description: e.description ?? null,
        aliases: (e.aliases ?? []).slice(0, 3),
        available_tables: (e.available_tables ?? []).slice(0, 3),
        node_id: e.node_id ?? null,
      })),
      metrics: (data.metrics ?? []).map((m) => ({
        name: m.name ?? null,
        description: m.description ?? null,
        units: (m.units ?? []).slice(0, 3),
        time_periods: (m.time_periods ?? []).slice(0, 3),
        compatible_tables: (m.compatible_tables ?? []).slice(0, 3),
        node_id: m.node_id ?? null,
      })),
      cohorts: (data.cohorts ?? []).map((c) => ({
        name: c.name ?? null,
        description: c.description ?? null,
        member_count: c.member_count ?? null,
        sample_members: c.sample_members ?? [],
        node_id: c.node_id ?? null,
      })),
      time_periods: data.time_periods ?? [],
      execution_time_ms: data.execution_time_ms ?? 0,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default explore_knowledge_graph;
