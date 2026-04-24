/**
 * `create_chart` — create a new interactive Tako chart from component configs.
 *
 * Hits the ThinViz direct-create endpoint (`POST /api/v1/thin_viz/create/`) —
 * the schema-name-based flow (`/thin_viz/default_schema/{name}/create/`) is
 * deprecated and no longer supported. Clients supply full component
 * configurations directly; no prior schema lookup is required.
 *
 * The ONLY write tool in the Phase 2 surface: `readOnlyHint: false`,
 * `openWorldHint: true` (creates a publicly-hostable chart URL).
 *
 * Components are typed loosely (`z.array(z.looseObject(...))`) — every
 * ThinViz `component_type` (header, generic_timeseries, categorical_bar,
 * data_table_chart, financial_boxes, table, choropleth, heatmap, histogram,
 * pie, scatter, boxplot, treemap, waterfall, bubble, …) declares its own
 * `config` shape, validated server-side.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const componentSchema = z
  .object({
    component_type: z.string(),
    config: z.record(z.string(), z.unknown()),
  })
  .loose();

const inputSchema = z.object({
  components: z
    .array(componentSchema)
    .min(1)
    .describe(
      "Array of component configurations. Each component has `component_type` (e.g. \"header\", \"generic_timeseries\", \"categorical_bar\", \"choropleth\", \"pie\", \"scatter\", \"treemap\"), optional `component_variant`, and a `config` object whose shape depends on the component type.",
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Optional card title. Falls back to the header component's title if not provided.",
    ),
  description: z
    .string()
    .optional()
    .describe("Optional card description."),
  source: z
    .string()
    .optional()
    .describe(
      'Optional data-source attribution displayed in the card footer (e.g. "Yahoo Finance", "Company Reports").',
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
    "Use this when you need to create a new chart from raw data. Pass an array of component configurations (header + one or more visualization components) to generate an interactive, shareable Tako visualization. Supports 15+ component types (timeseries, bar, scatter, maps, etc.).",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Create Chart",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const body: Record<string, unknown> = { components: input.components };
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.source !== undefined) body.source = input.source;
    // Chart creation 400s carry actionable validation detail (missing
    // component fields, invalid component_type, wrong config shape, etc.).
    // `DjangoBadRequestError` keeps that detail on `.body`; the MCP
    // adapter (`djangoErrorToToolResult`) splices `.body` into the tool's
    // text content so the LLM can read Tako's validation guidance and
    // retry. Let the error propagate — no per-tool try/catch needed.
    const data = await djangoPost<DjangoResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/thin_viz/create/",
      body,
      { timeoutMs: 60_000 },
    );
    const cardId = data.card_id ?? null;
    const base = {
      card_id: cardId,
      title: data.title ?? null,
      description: data.description ?? null,
      webpage_url: data.webpage_url ?? null,
      embed_url: data.embed_url ?? null,
      image_url: data.image_url ?? null,
    };
    if (cardId !== null && cardId !== "") {
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
