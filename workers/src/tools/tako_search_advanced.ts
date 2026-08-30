/**
 * `tako_search_advanced` — the v3 `POST /api/v3/search` request body, exposed
 * whole, behind `?tools=search_advanced` on `/mcp`.
 *
 * Every field of `SearchRequest`, `DataSourceSettings` and `WebSourceSettings`
 * is here, derived from the generated schemas so the set cannot drift; the
 * parity tests in tako_search_advanced.test.ts are the guard. An unknown key at
 * any level is a -32602 — all three levels are `.strict()`, and mcp.ts registers
 * the full object, so that holds on the wire and not only in a unit test.
 *
 * ONE value this tool supplies that the caller did not: `sources.web.highlights`
 * defaults to true (see `buildAdvancedSearchBody`). It is a DEFAULT, not a fixed
 * input — `web: {highlights: false}` wins — which is why `fixedInputs` stays
 * empty.
 *
 * WHY IT IS OPT-IN. `tako_search` is the tool a model should reach for: every
 * option here is a cost, context or latency knob rather than a statement of
 * what to search for, and the spec's own framing is that this tool "exists to
 * be asked for". A caller who needs `effort: deep`, a per-source count, inline
 * rows, a graph pin or a web domain filter names it in the URL.
 *
 * WHY THE SCHEMA IS DERIVED. Every level is built from the WHOLE generated
 * shape — `optionalWithoutDefaults(DataSourceSettings.shape)` and its two
 * siblings — so a renamed or retyped backend field fails to compile here
 * instead of drifting into a published schema, and a NEW field arrives without
 * anyone deciding to admit it. It is deliberately NOT a `.pick()`: the picked
 * version shipped 18 of 25 fields and six of the omissions appear in no spec
 * and no plan, which is the gap a curated list produces by construction. The
 * generated `.describe()` text comes across with the fields, which is also why
 * every parameter already states its server-side default in words — the same
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
 *
 * NO WIDGET HOOKS, and the reason is a COST choice, not a surface rule. The
 * earlier comment here said the inline PNG "belongs to the default surface, and
 * this tool is never on it" — that is wrong twice over: mcp.ts gates the widget
 * on the SURFACE (`widgetSuppressed = options.surface !== "chatgpt"`) and runs
 * `extraContentBlocks` whenever `ui === undefined`, which on `/mcp` is always;
 * and a tool may declare both hooks while opt-in on `/mcp` — `tako_answer` did,
 * before the answer fold deleted it, and `tako_search` declares them today.
 * Listing membership has nothing to do with it, so a future reader must not
 * "restore" the hooks on that reasoning.
 *
 * The actual reason: `extraContentBlocks` fetches the card render and base64s
 * ~170 KB into every result, with no way for the caller to decline. A caller who
 * reached for this tool asked for `effort: deep`, a wider `count`, or inline
 * rows — data, not a picture — and paying for an image on every call is the
 * opposite of the control this tool exists to give. `runSearch` still lifts
 * `pub_id` / `embed_url` / `image_url` into the output, so the chart is one
 * click-through away and a host can render it if it wants; only the automatic
 * inline PNG is absent. When the chart IS the deliverable, `tako_search` is the
 * tool, and it renders inline.
 */
import { z } from "zod";

import {
  AnswerRequest,
  DataSourceSettings,
  OutputSettings,
  SearchRequest,
  WebSourceSettings,
} from "../generated/schemas.js";
import {
  renderSearchMarkdown,
  searchSlimOutputShape,
  slimSearchStructured,
} from "./_render_markdown.js";
import type { SearchOutput } from "./_search_results.js";
import { runSearch, type SearchCall, type SearchEndpoint } from "./_run_search.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "The v3 search request's retrieval options: per-source result counts, inline card rows and row caps, graph pins, web domain and category filters, and the deep effort tier.",
  "",
  "Use `tako_search` unless you need one of these options. It takes the same query and applies the server's own defaults, which are right for almost every call.",
  "",
  "Nothing is sent unless you set it, with one exception named below, so an omitted field takes the server default in its description. Naming a source block at all — even as an empty object — is what selects that source; omit both and the server searches data and web.",
  "",
  "Web snippets are query-relevant highlight passages by default here, as on `tako_search`. Unlike there, you can turn them off: `web.highlights: false` gives you the page's opening text instead.",
  "",
  "One field here bills beyond the search itself: `data.include_contents` inlines each card's rows, and delivered rows are charged per 1,000. `data.max_rows` caps them per card — omit it and each card takes your account default, so `count: 20` bills twenty cards of rows. Leave the flag off and fetch just what you need with `tako_contents`.",
  "",
  "`include_answer: true` runs the answer endpoint instead: one synthesized, citation-backed answer in `answer`, with the retrieved cards and web results as its citations. Every option here applies the same way; the server defaults that differ on that endpoint (web `count` 3, `snippet_max_chars` 1000) are named in each field's description. `output_schema` fills a JSON Schema from the same evidence and returns it as `structured_output`. For values on a card marked `exportable: false`, pin its METRIC node id alone in `data.node_ids` with `strict: true`, set `include_answer: true` and `data.include_contents: true`.",
  "",
  "To land on exactly one metric, pin THAT metric's node id alone in `data.node_ids` with `strict: true` and name the entity in the query text; adding the entity's own id widens the filter back out. Note the disagreement below: the generated `node_ids` description calls that boost strong, and `strict` says pinned nodes rank first. Measured, a bare pin at the default `strict: false` makes the node a retrieval candidate and ranks it up without reliably outranking the organic winner — the backend scores it deliberately short of dominant, and marks that score provisional. So treat a pin without `strict` as a nudge, and set `strict: true` when you need the card to come back. If that call returns 0 cards, drop `node_ids` and run the query text alone — `strict` is a hard filter and the graph holds near-duplicate metric nodes where only one twin carries cards.",
].join("\n");


/**
 * Make every field of a generated settings schema optional AND drop the
 * default it carries, so an omitted field never reaches the wire.
 *
 * `.partial()` on its own leaves `ZodOptional<ZodDefault<T>>`, and the default
 * still fires when the key is absent from a block the caller DID name. That is
 * how `data: {}` came back carrying four values.
 *
 * ONE LEVEL ONLY. A field whose VALUE is an object keeps that object's own
 * generated defaults, and the generated schemas wrap every such field as
 * `z.union([z.lazy(() => T), z.null()])`, so no amount of unwrapping here
 * reaches `T`. `output_settings` is the one top-level field that hits this and
 * it is rebuilt by hand below; `noDefaultsLeak` in the test file is what fails
 * when the backend adds a second one.
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
 * Both blocks are the WHOLE generated settings schema, every field optional and
 * stripped of its default. Not a `.pick()`: the picked version shipped 18 of 25
 * fields, and the seven left out were never decided — six of them appear in no
 * spec and no plan. Deriving from the full shape is what makes "mirrors the API"
 * a test (tako_search_advanced.test.ts, "each source block exposes every field")
 * rather than a header claim.
 *
 * `mode` is in. Its generated description already says it is a no-op for Tako
 * cards; keeping it out would mean keeping a curated list, which is the
 * mechanism that produced the gap.
 *
 * A new backend field flows in through the sync PR: `regenerate.yml` rewrites
 * `server.json`, `docs/TOOLS.md` and the schema hash, and the sync PR body tells
 * its reviewer to read that diff. A new REQUIRED field fails the `satisfies` in
 * `buildAdvancedSearchBody` instead, so a breaking change stays red rather than
 * auto-shipping.
 *
 * `content_format` keeps `card_json`. `tako_contents` does NOT offer it, because
 * its `itemSchema` has three payload channels and card_json's payload arrives
 * under `card_data`, which none of them holds. Here the payload rides in each
 * card's loosely-typed `content`, so it has somewhere to land — and
 * `slimCardContent` knows the key, so a zero-row cap drops it rather than
 * leaking it.
 *
 * `article_content_max_chars` is the ONLY bound on `web.include_contents`: the
 * generated default is 30,000 chars and `count` runs to 20, so
 * `{include_contents: true, count: 20}` can put ~600 KB (~150k tokens) of page
 * text into `structuredContent`. Nothing clamps that Worker-side — `runSearch`
 * keeps the text verbatim once the request asked for it — and because the block
 * is `.strict()`, withholding the field would leave the caller no lever at all.
 * `snippet_max_chars` caps the excerpt, not `content.data`.
 */
const dataBlock = z.object(optionalWithoutDefaults(DataSourceSettings.shape)).strict();
const webBlock = z.object(optionalWithoutDefaults(WebSourceSettings.shape)).strict();


/**
 * Top level: every `SearchRequest` field except `sources` (replaced by the two
 * blocks), optional and default-free. Three keep a hand-written `.describe()`
 * that names the server default in words — the generated text for
 * `country_code` and `locale` does not, and this tool's description promises it.
 */
const topLevel = optionalWithoutDefaults(SearchRequest.omit({ query: true, sources: true }).shape);

/**
 * `output_settings` rebuilt from `OutputSettings` with its INNER defaults
 * stripped. Without this, `output_settings: {image_dark_mode: true}` reached the
 * wire as two values — the generated `force_refresh: false` rode along, chosen
 * by nobody. That is the `data: {}` bug one level down, and it only became
 * reachable when the top level stopped being a curated `.pick()`.
 *
 * `.strict()` and the generated description are carried across the rebuild: the
 * source object rejects unknown keys, and the description is the only place the
 * caller learns `force_refresh` is informational on these endpoints.
 *
 * UNWRAP FIRST. The generated `.describe()` sits on the INNER union, not on the
 * `.optional()` wrapper, so `SearchRequest.shape.output_settings.description` is
 * `undefined` and the `?? ""` then stamps an EMPTY description on the outermost
 * schema — which wins over the one `gen-registry` would otherwise unwrap. That
 * shipped `"output_settings": {"description": ""}` to `registry/server.json` and
 * a blank cell to `docs/TOOLS.md`, while `timezone`, same shape but with no
 * hand-written override, kept its text.
 */
const outputSettingsBlock = z
  .object(optionalWithoutDefaults(OutputSettings.shape))
  .strict()
  .nullable()
  .optional()
  .describe(SearchRequest.shape.output_settings.unwrap().description ?? "");

const inputSchema = z
  .object({
    // DERIVED, like every other field here. Re-authoring it as
    // `z.string().min(1)` dropped the generated `/\S/`, so `query: "   "`
    // passed the tool schema, went on the wire and came back a paid 400 where a
    // local -32602 was available. The parity test compares key NAMES, so it
    // cannot see a constraint go missing.
    query: SearchRequest.shape.query.describe(
      "Natural-language search query. One entity + one metric retrieves best, the same as on the simple tool.",
    ),
    ...topLevel,
    effort: topLevel.effort.describe(
      "Search effort. Omit it and the server uses fast. instant serves cached embeds without a new retrieval. deep widens retrieval and adds an LLM rerank; it is slower and bills at a premium tier.",
    ),
    country_code: topLevel.country_code.describe(
      "ISO 3166-1 alpha-2 country code for localization. Omit it and the server uses US.",
    ),
    locale: topLevel.locale.describe(
      "BCP-47 locale tag for language and formatting. Omit it and the server uses en-US.",
    ),
    output_settings: outputSettingsBlock,
    data: dataBlock
      .optional()
      .describe("Tako data (card) source settings. Include this key — even as an empty object — to search the data graph."),
    web: webBlock
      .optional()
      .describe("Web source settings. Include this key — even as an empty object — to search the web."),
    include_answer: z
      .boolean()
      .optional()
      .describe(
        "Set true to run the answer endpoint instead of search: Tako synthesizes one citation-backed answer from the retrieved cards and web results and returns it as `answer`, with the retrieval as its citations. Omit or false for retrieval only.",
      ),
    // The generated text verbatim: the caps, the supported JSON Schema subset
    // and the instant-effort 400 are the backend's contract, and the model
    // reads them here.
    output_schema: AnswerRequest.shape.output_schema,
  })
  // `.strict()` at every level. A bare `z.object` STRIPS unknown keys; this
  // rejects them, and because mcp.ts registers this object rather than its
  // `.shape`, the rejection reaches the wire too.
  .strict()
  // /v3/search is extra="forbid", so `output_schema` without `include_answer`
  // is a 400 from the backend naming the field. Catching it here spends
  // nothing and says what to do instead. This `.refine()` also only runs on the
  // wire because mcp.ts registers the full object — a raw `.shape` drops it.
  .refine((v) => v.output_schema == null || v.include_answer === true, {
    path: ["output_schema"],
    message:
      "output_schema applies only to the answer endpoint. Set include_answer: true, or drop output_schema.",
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
export function endpointFor(input: Input): SearchEndpoint {
  return input.include_answer === true ? "answer" : "search";
}

export function buildAdvancedSearchBody(input: Input): z.input<typeof AnswerRequest> {
  const body: z.input<typeof SearchRequest> = { query: input.query };
  if (input.effort !== undefined) body.effort = input.effort;
  if (input.country_code !== undefined) body.country_code = input.country_code;
  if (input.locale !== undefined) body.locale = input.locale;
  if (input.location !== undefined) body.location = input.location;
  if (input.timezone !== undefined) body.timezone = input.timezone;
  if (input.output_settings !== undefined) body.output_settings = input.output_settings;
  if (input.include_related !== undefined) body.include_related = input.include_related;
  // `highlights` is the ONE value this tool supplies that the caller did not
  // ask for, and it is a DEFAULT, not a fixed input: spread order lets an
  // explicit `web.highlights: false` win. It exists because `tako_answer` — the
  // tool this one replaces — sent it on every call: on /v1/answer the snippet is
  // the arbiter's grounding text, and a page's opening characters are usually
  // nav chrome. The backend default stays false on both endpoints, so the
  // opinion lives here, in one layer, deliberately.
  //
  // IT IS ENDPOINT-INDEPENDENT ON PURPOSE. Do not gate it on `endpointFor`.
  // The arbiter argument above only covers /v1/answer, so gating looks like the
  // tighter change — but it makes one field mean two things depending on a
  // sibling flag, and it splits this tool from `tako_search`, which forces
  // highlights on every call and offers no field to turn them off. A caller
  // moving between the two tools would get different snippets for the same web
  // result with nothing in either surface explaining why. Widening the default
  // to the search path is the deliberate cost of keeping the two consistent;
  // the caller who wants page-opening text sends `web: {highlights: false}`,
  // which is one field and which `tako_search` does not offer at all.
  const web = input.web === undefined ? undefined : { highlights: true, ...input.web };
  if (input.data !== undefined || web !== undefined) {
    const sources: NonNullable<z.input<typeof SearchRequest>["sources"]> = {};
    if (input.data !== undefined) sources.data = input.data;
    if (web !== undefined) sources.web = web;
    body.sources = sources;
  } else {
    // Naming NEITHER block means "both sources with server defaults", which the
    // backend expresses as an ABSENT `sources` — but reaching the web block at
    // all means spelling that default set out. It must stay equal to the
    // backend's own; the `Sources.shape` parity test is the guard. Sending
    // `{web: {...}}` alone here would be a WEB-ONLY request: Sources includes an
    // index only if its key is present.
    body.sources = { data: {}, web: { highlights: true } };
  }
  body satisfies z.input<typeof SearchRequest>; // ← build-time guard: /v3/search drift breaks here
  if (endpointFor(input) !== "answer") return body;
  // TWO guards, not one. In the monorepo `AnswerRequest` subclasses
  // `SearchRequest`, so the answer body is the search body plus one field — and
  // a single `satisfies` against the wider type would not notice the two
  // drifting apart. `SearchRequest` is `.strict()`, so `output_schema` must
  // never ride the search branch.
  //
  // WHAT THIS ACTUALLY CATCHES, so nobody trusts it for more: a NEW REQUIRED
  // field on either request type, which is the breaking direction and the one
  // worth failing the build over. It does NOT reliably catch a field being
  // REMOVED from `AnswerRequest` — TypeScript's excess-property check does not
  // fire on a spread-only object literal, so `{...body}` would still compile
  // against the narrower type. The key-set parity test is what covers removal.
  const answerBody: z.input<typeof AnswerRequest> =
    input.output_schema == null ? { ...body } : { ...body, output_schema: input.output_schema };
  return answerBody satisfies z.input<typeof AnswerRequest>; // ← build-time guard: /v1/answer drift breaks here
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
  // Nothing is FIXED, and web highlights is the field that tests the
  // distinction. Both tools supply it — see `buildAdvancedSearchBody` — but
  // `tako_search` publishes no `highlights` field at all, so its callers cannot
  // decline; here the field is published and spread order lets
  // `web: {highlights: false}` win. A fixed input is a value the caller cannot
  // change. This one they can, so the list stays empty.
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
    // The endpoint and the body as ONE value, so they cannot disagree: both
    // come from `input`, and `SearchCall` keeps them together from here to the
    // wire guard.
    const body = buildAdvancedSearchBody(input);
    const call: SearchCall =
      endpointFor(input) === "answer"
        ? { endpoint: "answer", body }
        : { endpoint: "search", body };
    return runSearch(call, searched, rowCap, ctx, "tako_search_advanced");
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
