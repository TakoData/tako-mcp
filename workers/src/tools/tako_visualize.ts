/**
 * `tako_visualize` — create a PUBLIC, PERSISTENT Tako card directly from the
 * caller's OWN structured data, backed by `POST /api/v1/thin_viz/create/`
 * (the SDK's `client.create_card`). Unlike `tako_search`, this does NOT
 * search Tako's knowledge graph — it renders data the agent already has.
 *
 * The created card auto-renders inline as a chart: the backend returns a
 * `card_id` (+ embed/image URLs), which the tool lifts into the same widget
 * fields `tako_search` uses, sharing `_chart_widget.ts`.
 *
 * This is the one tool on the surface that WRITES, and what it writes is
 * world-readable: the supplied data is stored by Tako and the resulting
 * `webpage_url` / `embed_url` are viewable by anyone holding the link, with
 * no expiry. Three things encode that, and they have to stay in agreement —
 * the `DESCRIPTION` disclosure the model reads before calling, the
 * `readOnlyHint: false` / ChatGPT `openWorldHint: true` annotation pair that
 * makes the call confirmation-worthy, and the matching justifications in
 * `chatgpt-app-submission.json`.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import { CreateCardRequest, ThinVizCard } from "../generated/schemas.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartUrls,
  DEFAULT_DARK_MODE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  buildChartExtraMeta,
  fetchPngContentBlock,
} from "./_chart_widget.js";
import { looseArray } from "./_loose_array.js";
import { logWireGuardFailure } from "./_log.js";
import { autoChainShape } from "./_search_results.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

// Mirrors VALID_COMPONENT_TYPES in the backend
// (app/backend/knowledge/api/ga/v1/thinviz/views.py): COMPONENT_BUILDERS
// keys plus "header" and "person_card". Keep in sync if the backend adds
// a builder.
export const COMPONENT_TYPES = [
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

// The first two lines are a DISCLOSURE, not marketing copy, and they lead on
// purpose. This tool publishes: the supplied data leaves the conversation,
// lands in Tako's storage, and becomes a page anyone holding the link can
// open, with no expiry. "Embeddable" alone (the previous wording) described
// the mechanism and hid the consequence — and a model that does not know the
// output is public cannot warn the user before pasting their data into it,
// which is exactly the gap OpenAI's app review flags. The sensitive-data
// sentence is addressed to the MODEL because the model is what assembles the
// `components` payload; it is the only party positioned to refuse.
const DESCRIPTION = [
  "Create a PUBLIC, PERSISTENT Tako chart/card from data you ALREADY HAVE — use `tako_search` to find existing Tako data instead. The data you supply is sent to and stored by Tako, the card does not expire, and anyone with the returned link can view it without signing in. Confirm the user wants a public chart before calling.",
  "",
  "NEVER put sensitive data in `components`: no passwords, API keys or tokens, payment-card or bank details, health information, government identifiers (SSN, passport, driver's licence), precise home addresses, or anyone's personal data they have not agreed to publish. Aggregate or anonymize first, or decline.",
  "",
  "Auto-renders inline; returns `webpage_url` / `embed_url`.",
  "",
  "Input: one or more `components`, each `{component_type, config}`. `config` is typed per `component_type` — `header`, `categorical_bar`, `generic_timeseries`, `table`, `financial_boxes`, and `pie` carry their required fields inline; other types accept a documented passthrough config. `component_variant` is optional and rarely needed.",
  "",
  "Example — a titled bar chart is two components:",
  '{"components": [{"component_type": "header", "config": {"title": "Revenue"}}, {"component_type": "categorical_bar", "config": {"datasets": [{"label": "Sales", "units": "USD", "data": [{"x": "NA", "y": 500}, {"x": "EU", "y": 300}]}]}}]}',
  "",
  "Tip: `person_card` must be the only component when used. Always end your reply with `[Open in Tako](embed_url)`.",
].join("\n");

// `component_variant` is a free-form, per-`component_type` string with no
// fixed set (backend `ComponentConfig.component_variant: str | None`,
// thinviz/types.py). Optional and rarely needed — most cards omit it.
// No `.describe()`: this field appears in all 20 union members, so any text
// here is duplicated 20× in the emitted schema. The tool DESCRIPTION already
// says it is optional and rarely needed.
const componentVariant = z.string().optional();

// --- Config sub-shapes for the common component types ---
// Each mirrors its backend Pydantic model in
// app/backend/knowledge/api/ga/v1/thinviz/types.py and stays `.passthrough()`
// — data points included, since the backend accepts extra point-level fields
// (e.g. CategoricalDataPoint.highlight/color) that a strip-by-default object
// would silently drop. Only the required fields and the most-used optionals
// are typed here — enough for an agent to build a valid call without guessing.
// Describe strings are deliberately terse: this schema ships in `tools/list`
// on every session, so every word here is standing context for every
// connected agent (see PR #164 review).

const categoricalDataPoint = z
  .object({
    x: z.string().describe("Category label."),
    y: z.number().describe("Value."),
  })
  .passthrough();
const categoricalDataset = z
  .object({
    label: z.string().describe("Legend label."),
    data: z.array(categoricalDataPoint),
    units: z.string().optional().describe("Units for formatting (e.g. '$', '%')."),
  })
  .passthrough();

const timeseriesDataPoint = z
  .object({
    x: z.union([z.string(), z.number()]).describe("Timestamp, date string, or label."),
    y: z.number().optional().describe("Value."),
  })
  .passthrough();
const timeseriesDataset = z
  .object({
    label: z.string().describe("Legend label."),
    data: z.array(timeseriesDataPoint),
    type: z.enum(["line", "bar", "scatter"]).optional().describe("Default 'line'."),
  })
  .passthrough();

const financialBoxItem = z
  .object({
    header: z.string().describe("Metric name (e.g. 'Revenue')."),
    value: z.string().optional().describe("Formatted value (e.g. '$10.5B')."),
    growth: z
      .object({
        formattedValue: z.string().describe("e.g. '5.25% YoY'."),
        value: z.number().describe("e.g. 0.0525 for 5.25%."),
      })
      .optional(),
  })
  .passthrough();

const tableColumn = z
  .object({
    field: z.string().describe("Row key holding this column's value."),
    label: z.string().describe("Column header."),
    type: z
      .enum(["string", "number", "date", "percent", "boolean", "rating", "currency"])
      .optional()
      .describe("Default 'string'."),
    units: z.string().optional(),
    align: z.enum(["left", "right", "center"]).optional(),
  })
  .passthrough();

const headerConfig = z
  .object({
    // Required to match the backend's header template (views.py:183), which
    // lists `title` as its one required field — optional here would only
    // defer the failure to render time.
    title: z.string().describe("Header title."),
    subtitle: z.string().optional(),
  })
  .passthrough();
// The constraints below are intentionally stricter than the backend (which
// accepts empty lists): an empty chart is a meaningless card, so `.min(1)`
// and the timeseries either-or refine reject it early with a clear message
// rather than render nothing.
const categoricalBarConfig = z
  .object({
    datasets: z.array(categoricalDataset).min(1).describe("Labeled series."),
    title: z.string().optional().describe("Tooltip title."),
  })
  .passthrough();
const pieConfig = z
  .object({
    datasets: z
      .array(categoricalDataset)
      .min(1)
      .describe("Slices (x = label, y = value); only the first dataset renders."),
    title: z.string().optional().describe("Tooltip title."),
  })
  .passthrough();
const timeseriesConfig = z
  .object({
    datasets: z
      .array(timeseriesDataset)
      .optional()
      .describe("Provide exactly ONE of `datasets` or `datasets_by_interval`."),
    datasets_by_interval: z
      .record(z.string(), z.array(timeseriesDataset))
      .optional()
      .describe("Keyed by ISO 8601 duration (e.g. 'P1D'). Alternative to `datasets`."),
    title: z.string().optional().describe("Tooltip title."),
  })
  .passthrough()
  .refine((c) => (c.datasets === undefined) !== (c.datasets_by_interval === undefined), {
    message: "Provide exactly one of `datasets` or `datasets_by_interval`.",
  });
const tableConfig = z
  .object({
    columns: z.array(tableColumn).min(1).describe("Column definitions."),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe("Row objects keyed by column `field`."),
    title: z.string().optional(),
  })
  .passthrough();
const financialBoxesConfig = z
  .object({ items: z.array(financialBoxItem).min(1).describe("Metric boxes.") })
  .passthrough();

// A member of the component discriminated union with a concretely-typed config.
const typedComponent = <T extends (typeof COMPONENT_TYPES)[number]>(
  component_type: T,
  config: z.ZodTypeAny,
) => z.object({ component_type: z.literal(component_type), component_variant: componentVariant, config });

// A member whose config stays a passthrough record — the shape is documented in
// Tako's "Visualize Your Data" docs and validated server-side, but not typed
// here (these types are either rarely used from an agent or have large, highly
// variable configs). The typed common types above cover the everyday path.
const passthroughComponent = <T extends (typeof COMPONENT_TYPES)[number]>(component_type: T) =>
  z.object({
    component_type: z.literal(component_type),
    component_variant: componentVariant,
    config: z
      .record(z.string(), z.unknown())
      .describe(`\`${component_type}\` config per Tako's docs; validated server-side.`),
  });

// Discriminated on `component_type` so each type advertises its own config
// shape (the six common types typed; the rest documented passthrough). This
// replaces a single untyped `config` bag, so an agent — or a tool scanner —
// sees the required fields per type instead of "untyped object".
const componentSchema = z
  .discriminatedUnion("component_type", [
    typedComponent("header", headerConfig),
    typedComponent("categorical_bar", categoricalBarConfig),
    typedComponent("generic_timeseries", timeseriesConfig),
    typedComponent("table", tableConfig),
    typedComponent("financial_boxes", financialBoxesConfig),
    typedComponent("pie", pieConfig),
    passthroughComponent("choropleth"),
    passthroughComponent("data_table_chart"),
    passthroughComponent("histogram"),
    passthroughComponent("timeline"),
    passthroughComponent("treemap"),
    passthroughComponent("heatmap"),
    passthroughComponent("marimekko"),
    passthroughComponent("boxplot"),
    passthroughComponent("waterfall"),
    passthroughComponent("sankey"),
    passthroughComponent("scatter"),
    passthroughComponent("bubble"),
    passthroughComponent("top_level_metric"),
    passthroughComponent("person_card"),
  ])
  .describe("One component: `{component_type, config}`; `config` shape is keyed to `component_type`.");

// Compile-time exhaustiveness guard: every `COMPONENT_TYPES` entry must have
// a union member above. The generic constraint on `typedComponent` /
// `passthroughComponent` already rejects members NOT in the array; this
// closes the other direction — adding a type to the array without adding a
// member makes `MissingComponentTypes` non-`never` and this line fails tsc.
// (See PR #164 review: `z.enum(COMPONENT_TYPES)` used to enforce this for
// free; a discriminated union does not.)
type MissingComponentTypes = Exclude<
  (typeof COMPONENT_TYPES)[number],
  z.infer<typeof componentSchema>["component_type"]
>;
type AssertComponentUnionExhaustive = [MissingComponentTypes] extends [never]
  ? true
  : { missingUnionMembersFor: MissingComponentTypes };
const _componentUnionIsExhaustive: AssertComponentUnionExhaustive = true;
void _componentUnionIsExhaustive;

const inputSchema = z.object({
  // looseArray: a host that sends the components array as JSON text gets it
  // coerced instead of a -32602. `jsonObjectAsItem` is safe here and ONLY here:
  // the item domain is objects, so a single component object is an
  // unambiguous one-item array. See _loose_array.ts.
  components: looseArray(
    z
      .array(componentSchema)
      .min(1)
      .describe("One or more components making up the card, rendered top to bottom."),
    { field: "tako_visualize.components", jsonObjectAsItem: true },
  ),
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
// and validate the raw wire against the generated ThinVizCard contract
// before extracting card_id.
//
// The generated ThinVizCard documents the create response (card_id, title,
// description, webpage_url, image_url, embed_url, card_type,
// visualization_data, embed_mode) but lacks the auto-chain widget fields
// (pub_id, dark_mode, width, height) that are built from the card_id by
// buildChartUrls. If we switched to outputSchema = ThinVizCard directly the
// inline render would break and the existing widget tests would fail.
// ThinVizCard is therefore used as the wire-guard only.
//
// `card_id` is deliberately NOT advertised, even though the handler receives
// one and the whole tool is built on it. `pub_id` carries the identical
// string (see the handler) and has a job — the widget resolves the chart
// through it — so a second copy under an internal-sounding name was pure
// duplication in front of the model, and OpenAI's review asks for exactly
// that to go. The three things a caller actually needs are `webpage_url`
// (share), `embed_url` (embed) and `pub_id` (render).
const outputSchema = z.object({
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
  // The MCP `config` is typed per component_type; the backend contract accepts
  // an untyped `Record<string, any>`. Loosen `config` back to a record at this
  // boundary so the discriminated-union member types satisfy CreateCardRequest.
  const body: z.input<typeof CreateCardRequest> = {
    components: input.components.map((c) => ({
      ...c,
      config: c.config as Record<string, unknown>,
    })),
  };
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
    // idempotentHint false: each call mints a new persistent Tako card.
    idempotentHint: false,
    // Closed domain per the MCP spec's openWorldHint: it renders data the
    // caller already supplied into a card; it does not interact with an
    // open/unpredictable set of external entities the way a web search does.
    openWorldHint: false,
  },
  annotationsBySurface: {
    // The one override that WIDENS a hint: Apps review reads
    // `openWorldHint` as "publishes/mutates publicly visible state", and
    // this call mints a card with publicly accessible webpage/embed URLs.
    // Combined with `readOnlyHint: false` this marks the call
    // confirmation-worthy in ChatGPT even though the tool sits on
    // ChatGPT's default surface — intended: a user-visible prompt before
    // creating a public URL is the honest label for review, and matches
    // the justification in `chatgpt-app-submission.json`. See
    // `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: true },
  },
  fixedInputs: [
    { field: "dark_mode", value: "true", note: "Cards render in the dark theme." },
    { field: "width", value: "900", note: "Card width in pixels." },
    { field: "height (when omitted)", value: "720", note: "Card height in pixels unless height is set." },
  ],
  async handler(input, ctx): Promise<Output> {
    const body = buildVisualizeBody(input);

    const data = await djangoPost<unknown>(
      ctx.env,
      ctx.token,
      "/api/v1/thin_viz/create/",
      body,
      { timeoutMs: 130_000 },
    );

    // Wire-contract guard: validate against the generated ThinVizCard
    // before extracting card_id.
    const wireCheck = ThinVizCard.safeParse(data);
    if (!wireCheck.success) {
      logWireGuardFailure("tako_visualize", "ThinVizCard", wireCheck.error, data);
      throw new Error(
        "Tako visualize endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    const wire = wireCheck.data;

    const cardId = wire.card_id ?? "";
    if (cardId === "") {
      logWireGuardFailure("tako_visualize", "missing-card_id", undefined, data);
      throw new Error(
        "Tako visualize endpoint did not return a card_id. Retry once; if it persists, flag it to the Tako team.",
      );
    }

    // Build canonical widget URLs from the card_id (same as tako_search),
    // so inline render works regardless of the URL form the backend returns.
    const { embed_url, image_url } = buildChartUrls(ctx.env, cardId, DEFAULT_DARK_MODE);
    const parsed = outputSchema.safeParse({
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
      logWireGuardFailure("tako_visualize", "output-normalise", parsed.error, data);
      throw new Error(
        "Tako visualize endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
  async extraMeta(output, ctx) {
    // Skip the PNG prefetch on ChatGPT (its widget renders embed_url
    // directly) — mirrors tako_search.
    // `bakeImage` is FALSE on every call today: `extraMeta` runs only when a
    // widget is live (`ui !== undefined` in mcp.ts), and only the chatgpt
    // surface serves one — so `ctx.surface !== "chatgpt"` cannot be true here.
    // The expression stays because it is what the claude.ai widget fast-follow
    // needs (gated on anthropics/claude-ai-mcp#753 and #40): a widget on the
    // generic surface reads the baked PNG rather than an iframe, so it wants
    // `bakeImage: true`, and this already says so. On the generic surface the
    // inline PNG comes from `extraContentBlocks` instead, which mcp.ts runs on
    // the opposite condition (`ui === undefined`).
    //
    // What the reachable branch does: ChatGPT's widget renders `embed_url` in
    // an iframe and never reads the baked PNG, but it cannot measure that
    // cross-origin iframe, so without the card's real aspect ratio the iframe
    // falls back to a fixed height and leaves empty bands under a wide chart.
    // Dimensions only — a 64-byte ranged read instead of a ~170 KB render.
    return buildChartExtraMeta(output.image_url, {
      bakeImage: ctx.surface !== "chatgpt",
      env: ctx.env,
      origin: ctx.origin,
      pubId: output.pub_id,
    });
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    void _ctx;
    if (output.image_url === undefined) return [];
    return fetchPngContentBlock(output.image_url);
  },
  appUiResource(env, requestOrigin): AppUiResource {
    return buildChartAppUiResourceFromOutputPubId(env, requestOrigin);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_visualize;
