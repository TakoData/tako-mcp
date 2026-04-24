/**
 * `get_chart_schema` — fetch the exact data shape a chart template expects.
 *
 * Ports `get_chart_schema` from `src/tako_mcp/server.py:490`. Second step of
 * the chart-creation flow. Use before `create_chart` to understand the
 * components array each template needs.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  schema_name: z
    .string()
    .min(1)
    .describe(
      'Name of the schema (e.g. "stock_card", "bar_chart", "pie_chart", "scatter_chart", "choropleth", "timeseries_card"). List options via list_chart_schemas.',
    ),
});

const outputSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  components: z.array(z.unknown()),
  template: z.unknown().nullable(),
});

type DjangoResponse = {
  name?: string | null;
  description?: string | null;
  components?: unknown[];
  template?: unknown;
};

const get_chart_schema = {
  name: "get_chart_schema",
  description:
    "Use this when you need to understand the exact data format required for a specific chart type. Returns the schema definition including required fields, data structure, and configuration options. Always call this before create_chart to understand what data is needed.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Get Chart Schema",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const schemaName = encodeURIComponent(input.schema_name);
    const data = await djangoGet<DjangoResponse>(
      ctx.env,
      ctx.token,
      `/api/v1/thin_viz/default_schema/${schemaName}/`,
      { timeoutMs: 30_000 },
    );
    return {
      name: data.name ?? null,
      description: data.description ?? null,
      components: data.components ?? [],
      template: data.template ?? null,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_chart_schema;
