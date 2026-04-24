/**
 * `list_chart_schemas` — list available ThinViz chart templates.
 *
 * Ports `list_chart_schemas` from `src/tako_mcp/server.py:435`. First step of
 * the 3-tool chart-creation flow (`list_chart_schemas` → `get_chart_schema` →
 * `create_chart`). Agent-native endpoint — not called from the web frontend.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({});

const schemaSummarySchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  components: z.array(z.unknown()),
});

const outputSchema = z.object({
  schemas: z.array(schemaSummarySchema),
  count: z.number().int().nonnegative(),
});

type DjangoSchema = {
  name?: string | null;
  description?: string | null;
  components?: unknown[];
};

const list_chart_schemas = {
  name: "list_chart_schemas",
  description:
    "Use this when you want to see all available chart templates before creating a custom chart. Returns the full list of ThinViz schemas including timeseries, bar charts, pie charts, scatter plots, maps, and more. Call this first when the user wants to create a new visualization.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: List Chart Types",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(_input, ctx) {
    const data = await djangoGet<DjangoSchema[]>(
      ctx.env,
      ctx.token,
      "/api/v1/thin_viz/default_schema/",
      { timeoutMs: 30_000 },
    );
    const schemas = (data ?? []).map((s) => ({
      name: s.name ?? null,
      description: s.description ?? null,
      components: s.components ?? [],
    }));
    return { schemas, count: schemas.length };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default list_chart_schemas;
