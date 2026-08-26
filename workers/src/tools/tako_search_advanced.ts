/**
 * `tako_search_advanced` — the v3 `POST /api/v3/search` request body exposed
 * one-to-one, behind `?tools=search_advanced` on `/mcp`.
 *
 * WHY IT IS OPT-IN. `tako_search` is the tool a model should reach for: every
 * option here is a cost, context or latency knob rather than a statement of
 * what to search for, and the spec's own framing is that this tool "exists to
 * be asked for". A caller who needs `effort: deep`, a per-source count, inline
 * rows, a graph pin or a web domain filter names it in the URL.
 *
 * WHY THE SCHEMA IS DERIVED. Both blocks are `.pick()`ed off the generated
 * `DataSourceSettings` / `WebSourceSettings`, so a renamed or retyped backend
 * field fails to compile here instead of drifting into a published schema. The
 * generated `.describe()` text comes with them, which is also why every
 * parameter already states its server-side default in words — the same
 * no-defaults rule `tako_search` follows.
 *
 * `optionalWithoutDefaults` is load-bearing, not cosmetic. `.partial()` alone
 * is NOT enough: zod keeps the inner `ZodDefault`, so `data: {}` parsed back
 * `{count: 5, include_contents: false, content_format: "json_compact",
 * strict: false}` and naming a block would have silently sent four values the
 * caller never chose — the no-defaults rule broken in the one tool whose job is
 * to mirror the API exactly. Each field is unwrapped past its default first.
 *
 * NOT ON THE CHATGPT SURFACE and not anonymous-executable: it can bill rows.
 * It also declares no widget hooks — the chart widget and the inline PNG belong
 * to the default surface, and this tool is never on it.
 */
import { z } from "zod";

import {
  DataSourceSettings,
  SearchEffortLevel,
  SearchRequest,
  WebSourceSettings,
} from "../generated/schemas.js";
import {
  renderSearchMarkdown,
  searchSlimOutputShape,
  slimSearchStructured,
} from "./_render_markdown.js";
import type { SearchOutput } from "./_search_results.js";
import { runSearch } from "./tako_search.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Full control over the v3 search request: per-source result counts, inline card rows and row caps, graph pins, web domain and category filters, and the deep effort tier.",
  "",
  "Use `tako_search` unless you need one of these options. It takes the same query and applies the server's own defaults, which are right for almost every call.",
  "",
  "Nothing is sent unless you set it, so an omitted field takes the server default named in its description. Naming a source block at all — even as an empty object — is what selects that source; omit both and the server searches data and web.",
  "",
  "To land on exactly one metric, pin THAT metric's node id alone in `data.node_ids` with `strict: true` and name the entity in the query text; adding the entity's own id widens the filter back out, and a pin at the default `strict: false` does not steer retrieval. If that call returns 0 cards, drop `node_ids` and run the query text alone — `strict` is a hard filter and the graph holds near-duplicate metric nodes where only one twin carries cards.",
].join("\n");


/**
 * Make every field of a generated settings schema optional AND drop the
 * default it carries, so an omitted field never reaches the wire.
 *
 * `.partial()` on its own leaves `ZodOptional<ZodDefault<T>>`, and the default
 * still fires when the key is absent from a block the caller DID name. That is
 * how `data: {}` came back carrying four values.
 */
function optionalWithoutDefaults<T extends z.ZodRawShape>(shape: T): {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]>;
} {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    const bare = field instanceof z.ZodDefault ? field.unwrap() : field;
    out[key] = (bare as z.ZodType).optional();
  }
  return out as never;
}

/**
 * The data block. Exactly the fields spec D4 enumerates, picked off the
 * generated settings schema (which is `.strict()`, so a typo fails here rather
 * than 400-ing at the backend).
 *
 * `content_format` keeps `card_json`. `tako_contents` does NOT offer it,
 * because its `itemSchema` has three payload channels and card_json's payload
 * arrives under `card_data`, which none of them holds. Here the payload rides
 * in each card's loosely-typed `content`, so it has somewhere to land — and
 * `slimCardContent` knows the key, so a zero-row cap drops it rather than
 * leaking it.
 */
const dataBlock = z
  .object(
    optionalWithoutDefaults(
      DataSourceSettings.pick({
        count: true,
        include_contents: true,
        max_rows: true,
        content_format: true,
        node_ids: true,
        strict: true,
      }).shape,
    ),
  )
  .strict();

/**
 * The web block. Spec D4's enumeration, which is a SUBSET of
 * `WebSourceSettings`: `article_content_max_chars`, `published_after` and
 * `published_before` are deliberately out of this pass. Add them here when
 * they are wanted — the `.pick()` is the only place that needs to change.
 */
const webBlock = z
  .object(
    optionalWithoutDefaults(
      WebSourceSettings.pick({
        count: true,
        include_contents: true,
        include_domains: true,
        exclude_domains: true,
        category: true,
        snippet_max_chars: true,
        highlights: true,
      }).shape,
    ),
  )
  .strict();

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Natural-language search query. One entity + one metric retrieves best, the same as on the simple tool."),
  effort: SearchEffortLevel.optional().describe(
    "Search effort. Omit it and the server uses fast. instant serves cached embeds without a new retrieval. deep widens retrieval and adds an LLM rerank; it is slower and bills at a premium tier.",
  ),
  country_code: z
    .string()
    .optional()
    .describe("ISO 3166-1 alpha-2 country code for localization. Omit it and the server uses US."),
  locale: z
    .string()
    .optional()
    .describe("BCP-47 locale tag for language and formatting. Omit it and the server uses en-US."),
  data: dataBlock
    .optional()
    .describe("Tako data (card) source settings. Include this key — even as an empty object — to search the data graph."),
  web: webBlock
    .optional()
    .describe("Web source settings. Include this key — even as an empty object — to search the web."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = searchSlimOutputShape;
type Output = z.infer<typeof outputSchema>;

/**
 * Reshape the flat MCP input into the backend's nested SearchRequest body.
 * Exported for the contract-guard test.
 *
 * The `satisfies z.input<typeof SearchRequest>` annotation is the build-time
 * guard: if the backend request contract changes (new required field, renamed
 * key, changed enum) this line fails to compile — the intended signal.
 */
export function buildAdvancedSearchBody(input: Input): z.input<typeof SearchRequest> {
  const body: z.input<typeof SearchRequest> = { query: input.query };
  if (input.effort !== undefined) body.effort = input.effort;
  if (input.country_code !== undefined) body.country_code = input.country_code;
  if (input.locale !== undefined) body.locale = input.locale;
  // `sources` is omitted entirely when the caller names neither block: absent
  // means "search data and web with the server's defaults", while `{}` would be
  // a different request (an explicit empty source set).
  if (input.data !== undefined || input.web !== undefined) {
    const sources: NonNullable<z.input<typeof SearchRequest>["sources"]> = {};
    if (input.data !== undefined) sources.data = input.data;
    if (input.web !== undefined) sources.web = input.web;
    body.sources = sources;
  }
  return body satisfies z.input<typeof SearchRequest>; // ← build-time guard: backend request drift breaks here
}

const tako_search_advanced = {
  name: "tako_search_advanced",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search (advanced)",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Declared even though this tool is opt-in on /mcp only and never reaches
    // the chatgpt surface: the annotation convention is per-TOOL, not per
    // membership, so the semantics stay right if it is ever submitted. Apps
    // review reads `openWorldHint` as "publishes/mutates public or third-party
    // state", not MCP's domain-of-interaction — retrieval is closed-world
    // there. See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  // Nothing is fixed. Mirroring the API one-to-one is this tool's entire job;
  // the one opinionated override in the surface (web highlights) lives on
  // `tako_search`, where a caller who wants it off has nowhere else to go.
  fixedInputs: [],
  async handler(input, ctx): Promise<SearchOutput> {
    const named: Array<"data" | "web"> = [];
    if (input.data !== undefined) named.push("data");
    if (input.web !== undefined) named.push("web");
    // Naming neither block means the server searches BOTH, so the zero-card
    // guidance has to read it that way too — otherwise an empty result would
    // report a coverage verdict about a source the request never narrowed.
    const searched: Array<"data" | "web"> = named.length > 0 ? named : ["data", "web"];
    // "all", never a number: this tool SENDS sources.data.max_rows on the wire,
    // so the backend has already truncated to exactly what the caller asked
    // for — including the 2,000-row ceiling the simple tool cannot reach. A
    // Worker-side re-cap could only clamp that back DOWN, and `null` would
    // discard the account-default rows of a caller who set include_contents and
    // omitted max_rows.
    const rowCap = input.data?.include_contents === true ? "all" : null;
    return runSearch(buildAdvancedSearchBody(input), searched, rowCap, ctx);
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderSearchMarkdown(output as SearchOutput);
  },
  slimStructured(output) {
    return slimSearchStructured(output as SearchOutput);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_search_advanced;
