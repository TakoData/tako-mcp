/**
 * `tako_visualize` — create an embeddable Tako card directly from the
 * caller's OWN structured data, backed by `POST /api/v1/thin_viz/create/`
 * (the SDK's `client.create_card`). Unlike `tako_search`, this does NOT
 * search Tako's knowledge graph — it renders data the agent already has.
 *
 * The created card auto-renders inline as a chart: the backend returns a
 * `card_id` (+ embed/image URLs), which the tool lifts into the same widget
 * fields `tako_search` uses, sharing `_chart_widget.ts`.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import { CreateCardRequest, KnowledgeCard } from "../generated/schemas.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartUrls,
  DEFAULT_DARK_MODE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  fetchImageDataUrlAndDims,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import { autoChainShape } from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

// Mirrors VALID_COMPONENT_TYPES in the backend
// (app/backend/knowledge/api/ga/v1/thinviz/views.py): COMPONENT_BUILDERS
// keys plus "header" and "person_card". Keep in sync if the backend adds
// a builder.
const COMPONENT_TYPES = [
  "header",
  "generic_timeseries",
  "categorical_bar",
  "choropleth",
  "data_table_chart",
  "histogram",
  "pie",
  "table",
  "financial_boxes",
  "timeline",
  "treemap",
  "heatmap",
  "marimekko",
  "boxplot",
  "waterfall",
  "sankey",
  "scatter",
  "bubble",
  "top_level_metric",
  "person_card",
] as const;

const DESCRIPTION =
  "Create an embeddable Tako chart/card directly from data you ALREADY HAVE (not from search). Provide one or more typed `components`, each with a `component_type` and a `config` object holding that type's data (e.g. `generic_timeseries`, `categorical_bar`, `table`, `financial_boxes`, `header`). The card auto-renders inline as a chart and returns `webpage_url` / `embed_url` for sharing or embedding. Use `tako_search` to FIND existing Tako data; use `tako_visualize` when you already have the numbers. " +
  "Worked example — a bar chart with a title is two components: " +
  '`{\"title\": \"Monthly Revenue\", \"components\": [{\"component_type\": \"header\", \"config\": {\"title\": \"Monthly Revenue\"}}, {\"component_type\": \"categorical_bar\", \"config\": {\"datasets\": [{\"label\": \"Sales\", \"units\": \"USD\", \"data\": [{\"x\": \"NA\", \"y\": 500}, {\"x\": \"EU\", \"y\": 300}]}]}}]}`. ' +
  "For per-`component_type` `config` shapes and more worked examples, see Tako's 'Agent Skills → Visualize Your Data' docs and the Thin-Viz chart-creation reference. NOTE: `person_card` must be the ONLY component when used. **Always include `[Open in Tako](embed_url)` once at the end of your reply.**";

const inputSchema = z.object({
  components: z
    .array(
      z.object({
        component_type: z
          .enum(COMPONENT_TYPES)
          .describe("Component type; each type expects a different `config` shape."),
        component_variant: z
          .string()
          .optional()
          .describe("Optional component variant (e.g. 'simple', 'financial')."),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            "Data/configuration object for this `component_type`; its shape varies by type and is validated server-side. " +
              'Examples — `header`: `{"title": "Monthly Revenue"}`. ' +
              '`categorical_bar`: `{"datasets": [{"label": "Sales", "units": "USD", "data": [{"x": "NA", "y": 500}, {"x": "EU", "y": 300}]}]}` ' +
              "(each dataset is a labeled series; `data` is an array of `{x, y}` points). " +
              "For shapes of other types (e.g. `generic_timeseries`, `table`, `financial_boxes`, `pie`) see Tako's 'Visualize Your Data' docs.",
          ),
      }),
    )
    .min(1)
    .describe("One or more components making up the card, rendered top to bottom."),
  title: z.string().optional().describe("Card title (falls back to a header component's title)."),
  description: z.string().optional().describe("Card description."),
  source: z.string().optional().describe("Data source attribution, shown in the footer."),
  height: z
    .number()
    .int()
    .min(100)
    .max(2000)
    .optional()
    .describe("Chart height in pixels (100–2000). Overrides the default aspect-ratio height."),
  normalize_currencies: z
    .string()
    .optional()
    .describe(
      "Target ISO 4217 currency code (e.g. 'USD'). Converts recognized currency-denominated datasets to this currency using historical rates.",
    ),
});

// Parity-check outcome: Path 2 — keep the hand-written outputSchema as the
// MCP facade (always returns the card_id + widget fields for inline render)
// and validate the raw wire against the generated KnowledgeCard contract
// before extracting card_id.
//
// The generated KnowledgeCard has many fields the MCP tool does not surface
// (sources, methodologies, source_indexes, card_type, data_url, relevance,
// visualization_data) and lacks the auto-chain widget fields (pub_id,
// embed_url, image_url, dark_mode, width, height) that are built from the
// card_id by buildChartUrls. If we switched to outputSchema = KnowledgeCard
// directly the inline render would break and the existing widget tests would
// fail. KnowledgeCard is therefore used as the wire-guard only.
const outputSchema = z.object({
  card_id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  webpage_url: z.string().optional(),
  ...autoChainShape,
});

type Output = z.infer<typeof outputSchema>;
type Input = z.infer<typeof inputSchema>;

/**
 * Map the MCP input into the backend's CreateCardRequest body.
 * Exported for the contract-guard test.
 *
 * The `satisfies z.input<typeof CreateCardRequest>` annotation is the
 * build-time guard: if the backend request contract changes (new required
 * field, renamed key, changed enum) this line fails to compile.
 *
 * postmessage_embed and image_ttl_minutes are intentionally excluded —
 * the MCP tool does not expose them.
 */
export function buildVisualizeBody(input: Input): z.input<typeof CreateCardRequest> {
  const body: z.input<typeof CreateCardRequest> = { components: input.components };
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.source !== undefined) body.source = input.source;
  if (input.height !== undefined) body.height = input.height;
  if (input.normalize_currencies !== undefined) {
    body.normalize_currencies = input.normalize_currencies;
  }
  return body satisfies z.input<typeof CreateCardRequest>; // ← build-time guard: backend request drift breaks here
}

const tako_visualize = {
  name: "tako_visualize",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Visualize",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const body = buildVisualizeBody(input);

    const data = await djangoPost<unknown>(
      ctx.env,
      ctx.token,
      "/api/v1/thin_viz/create/",
      body,
      { timeoutMs: 130_000 },
    );

    // Wire-contract guard: validate against the generated KnowledgeCard
    // before extracting card_id.
    const wireCheck = KnowledgeCard.safeParse(data);
    if (!wireCheck.success) {
      throw new Error(
        "Tako visualize endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    const wire = wireCheck.data;

    const cardId = wire.card_id ?? "";
    if (cardId === "") {
      throw new Error(
        "Tako visualize endpoint did not return a card_id. Retry once; if it persists, flag it to the Tako team.",
      );
    }

    // Build canonical widget URLs from the card_id (same as tako_search),
    // so inline render works regardless of the URL form the backend returns.
    const { embed_url, image_url } = buildChartUrls(ctx.env, cardId, DEFAULT_DARK_MODE);
    const parsed = outputSchema.safeParse({
      card_id: cardId,
      title: wire.title ?? undefined,
      description: wire.description ?? undefined,
      webpage_url: wire.webpage_url ?? undefined,
      pub_id: cardId,
      embed_url,
      image_url,
      dark_mode: DEFAULT_DARK_MODE,
      width: DEFAULT_WIDTH,
      height: input.height ?? DEFAULT_HEIGHT,
    });
    if (!parsed.success) {
      throw new Error(
        "Tako visualize endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
  async extraMeta(output, ctx) {
    // Skip the PNG prefetch on ChatGPT (its widget renders embed_url
    // directly) — mirrors tako_search.
    if (ctx.client === "chatgpt") return undefined;
    if (output.image_url === undefined) return undefined;
    const fetched = await fetchImageDataUrlAndDims(output.image_url);
    if (fetched === undefined) return undefined;
    return {
      image_data_url: fetched.dataUrl,
      image_natural_width: fetched.naturalWidth,
      image_natural_height: fetched.naturalHeight,
    };
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    void _ctx;
    if (output.image_url === undefined) return [];
    return fetchPngContentBlock(output.image_url);
  },
  appUiResource(env): AppUiResource {
    return buildChartAppUiResourceFromOutputPubId(env);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_visualize;
