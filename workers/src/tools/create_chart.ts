/**
 * `create_chart` — create a new interactive Tako chart from raw data.
 *
 * Ports `create_chart` from `src/tako_mcp/server.py:537`. The ONLY write tool
 * in the Phase 2 surface: `readOnlyHint: false`, `openWorldHint: true` (creates
 * a publicly-hostable chart URL).
 *
 * Components are intentionally typed loosely (`z.array(z.looseObject(...))`):
 * each template under `/api/v1/thin_viz/default_schema/*` declares its own
 * component shape. LLMs are expected to call `get_chart_schema(name)` first to
 * learn the shape, then pass matching `components[]` here.
 */
import { z } from "zod";

import { DjangoBadRequestError, djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const componentSchema = z
  .object({
    component_type: z.string(),
    config: z.record(z.string(), z.unknown()),
  })
  .loose();

const inputSchema = z.object({
  schema_name: z
    .string()
    .min(1)
    .describe(
      'Name of the ThinViz template to instantiate (e.g. "bar_chart", "stock_card"). Learn valid names via list_chart_schemas.',
    ),
  components: z
    .array(componentSchema)
    .min(1)
    .describe(
      "Array of component objects matching the template's required shape. Each component has `component_type` and `config` fields. Use get_chart_schema first to learn the exact shape per template.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      'Optional attribution text (e.g. "Yahoo Finance", "Company Reports").',
    ),
});

const outputSchema = z.object({
  card_id: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  webpage_url: z.string().nullable(),
  embed_url: z.string().nullable(),
  image_url: z.string().nullable(),
  open_ui_tool: z.string().optional(),
  open_ui_args: z.object({ pub_id: z.string() }).optional(),
});

type DjangoResponse = {
  card_id?: string | null;
  title?: string | null;
  description?: string | null;
  webpage_url?: string | null;
  embed_url?: string | null;
  image_url?: string | null;
};

const create_chart = {
  name: "create_chart",
  description:
    "Use this when you need to create a new chart from raw data. Pass a schema name and your data components to generate an interactive, shareable Tako visualization. Supports 15+ chart types (timeseries, bar, scatter, maps, etc.). Workflow: list_chart_schemas → get_chart_schema → create_chart.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Create Chart",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const schemaName = encodeURIComponent(input.schema_name);
    const body: Record<string, unknown> = { components: input.components };
    if (input.source !== undefined) {
      body.source = input.source;
    }
    let data: DjangoResponse;
    try {
      data = await djangoPost<DjangoResponse>(
        ctx.env,
        ctx.token,
        `/api/v1/thin_viz/default_schema/${schemaName}/create/`,
        body,
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      // Chart creation 400s carry actionable per-schema validation detail
      // (missing component fields, wrong dataset shape, etc.). `DjangoBadRequestError`
      // keeps that detail on `.body` rather than in `.message` (log-injection
      // guard in `django.ts`) — re-throw with the body so the LLM can read
      // Tako's validation guidance and correct the components on retry.
      if (err instanceof DjangoBadRequestError) {
        throw new Error(
          `Tako rejected create_chart for schema "${input.schema_name}" (400): ${err.body}`,
        );
      }
      throw err;
    }
    const cardId = data.card_id ?? null;
    const base = {
      card_id: cardId,
      title: data.title ?? null,
      description: data.description ?? null,
      webpage_url: data.webpage_url ?? null,
      embed_url: data.embed_url ?? null,
      image_url: data.image_url ?? null,
    };
    if (cardId !== null && cardId !== undefined && cardId !== "") {
      return {
        ...base,
        open_ui_tool: "open_chart_ui" as const,
        open_ui_args: { pub_id: cardId },
      };
    }
    return base;
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default create_chart;
