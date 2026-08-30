import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Env } from "../env.js";
import {
  AnswerRequest,
  DataSourceSettings,
  SearchRequest,
  Sources,
  WebSourceSettings,
} from "../generated/schemas.js";
import { jsonResponse, mockFetchSequence, noopSendProgress, requestFrom } from "./__test_helpers.js";
import {
  CHATGPT_TOOL_NAMES,
  FREE_TIER_TOOL_NAMES,
  GENERIC_DEFAULT_TOOL_NAMES,
} from "./_surface.js";
import tako_search_advanced, { buildAdvancedSearchBody } from "./tako_search_advanced.js";
import tako_search from "./tako_search.js";
import type { ToolContext } from "./types.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  surface: "generic",
};

/**
 * A field's emitted JSON Schema with `description` and `default` removed, as a
 * comparable string.
 *
 * Those two are the only divergences the tool is allowed: it overrides some
 * descriptions to name the server default in words, and `optionalWithoutDefaults`
 * strips defaults on purpose. Compare the emitted schema rather than the zod
 * internals — it is what `gen-registry.ts` publishes and the only stable view of
 * a `z.lazy`.
 */
function schemaFingerprint(field: z.ZodType): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key !== "description" && key !== "default") out[key] = strip(inner);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(z.toJSONSchema(field, { io: "input" })));
}

/**
 * The fields of a generated request schema whose VALUE is an object.
 *
 * That is the class `optionalWithoutDefaults` cannot reach: it unwraps one
 * level, and the generator emits every such field as
 * `z.union([z.lazy(() => T), z.null()])`, so T's own defaults survive. Read off
 * the emitted JSON Schema rather than the zod internals, which is what
 * `gen-registry.ts` publishes from and the only stable view of `z.lazy`.
 */
function objectValuedFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const out: string[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const json = z.toJSONSchema(field as z.ZodType, { io: "input" }) as {
      type?: string;
      anyOf?: Array<{ type?: string }>;
      oneOf?: Array<{ type?: string }>;
    };
    const branches = json.anyOf ?? json.oneOf ?? [json];
    if (branches.some((branch) => branch?.type === "object")) out.push(name);
  }
  return out;
}

// A web result carrying inline page text, which is what the backend returns when
// the request set sources.web.include_contents.
const webResultWithText = () => ({
  title: "Nvidia Q3 FY25",
  url: "https://example.com/nvda",
  snippet: "Data center revenue rose…",
  content: { content_format: null, cost: 0, data: "FULL PAGE TEXT BODY" },
});

describe("tako_search_advanced surface membership", () => {
  it("is opt-in on /mcp and absent from the chatgpt surface", () => {
    expect(GENERIC_DEFAULT_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
    expect(CHATGPT_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
  });

  it("never executes anonymously — it can bill rows", () => {
    expect(FREE_TIER_TOOL_NAMES.has("tako_search_advanced")).toBe(false);
  });

  it("declares fixedInputs (empty — mirroring the API is the point) and all four hints", () => {
    expect(tako_search_advanced.fixedInputs).toEqual([]);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      expect(typeof tako_search_advanced.annotations[hint]).toBe("boolean");
    }
  });
});

describe("tako_search_advanced mirrors the v3 SearchRequest", () => {
  it("exposes every top-level SearchRequest field, with sources as two blocks", () => {
    // A LIST here would be the thing that drifts. The previous version of this
    // tool shipped 18 of 25 generated fields and the seven missing ones were
    // never decided — six appear in no spec and no plan. Derived from the
    // generated shape, "mirrors the API" is checked rather than asserted in a
    // header.
    const expected = Object.keys(AnswerRequest.shape).filter((k) => k !== "sources");
    expect(Object.keys(tako_search_advanced.inputSchema.shape).sort()).toEqual(
      [...expected, "data", "web", "include_answer"].sort(),
    );
  });

  it("each derived field carries the generated CONSTRAINTS, not just the generated name", () => {
    // KEY PARITY IS NOT ENOUGH, and this is the test that says so. The two
    // assertions around it compare `Object.keys`, which is blind to a field
    // whose type, bounds, pattern or optionality diverged — `query` shipped as
    // a re-authored `z.string().min(1)`, dropping the generated `/\S/`, and
    // every key-parity assertion stayed green while `query: "   "` went on the
    // wire and came back a paid 400.
    //
    // `description` and `default` are the two legitimate divergences: the tool
    // overrides some descriptions to name the server default in words, and
    // `optionalWithoutDefaults` strips defaults on purpose so an omitted field
    // stays omitted. Everything else must be identical.
    //
    // NO EXCEPTION LIST. Every derived field matches today, so an exception
    // list would be four hardcoded names waiting to go stale; a genuine future
    // divergence should fail here and be argued, not pre-authorized.
    const generated = {
      ...SearchRequest.shape,
      output_schema: AnswerRequest.shape.output_schema,
    } as unknown as Record<string, z.ZodType>;
    const diverged: string[] = [];
    for (const [name, field] of Object.entries(tako_search_advanced.inputSchema.shape)) {
      const generatedField = generated[name];
      // `data`, `web` and `include_answer` are Worker-authored; the block
      // assertions below own the first two.
      if (generatedField === undefined) continue;
      if (schemaFingerprint(field) !== schemaFingerprint(generatedField)) diverged.push(name);
    }
    expect(diverged, "these fields no longer match their generated schema").toEqual([]);
  });

  it("each source block's fields carry the generated constraints too", () => {
    const shape = tako_search_advanced.inputSchema.shape;
    const block = (schema: z.ZodType): Record<string, z.ZodType> =>
      (schema as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap().shape as unknown as Record<
        string,
        z.ZodType
      >;
    for (const [name, generated, label] of [
      ["data", DataSourceSettings, "DataSourceSettings"],
      ["web", WebSourceSettings, "WebSourceSettings"],
    ] as const) {
      const fields = block(shape[name]);
      const generatedFields = generated.shape as Record<string, z.ZodType>;
      const diverged = Object.keys(fields).filter((key) => {
        const mine = fields[key];
        const theirs = generatedFields[key];
        if (mine === undefined || theirs === undefined) return true;
        return schemaFingerprint(mine) !== schemaFingerprint(theirs);
      });
      expect(diverged, `${name} block fields no longer match ${label}`).toEqual([]);
    }
  });

  it("each source block exposes every field of its generated settings schema", () => {
    const shape = tako_search_advanced.inputSchema.shape;
    const block = (schema: z.ZodType): string[] =>
      Object.keys((schema as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap().shape).sort();
    expect(block(shape.data)).toEqual(Object.keys(DataSourceSettings.shape).sort());
    expect(block(shape.web)).toEqual(Object.keys(WebSourceSettings.shape).sort());
  });

  it("forwards every top-level field it accepts, so parity is not only a schema claim", () => {
    // A field can be exposed and then dropped on the way to the wire, which
    // reads to the caller exactly like the silent-strip bug. Parse-then-build
    // and compare against the generated key set.
    const input = tako_search_advanced.inputSchema.parse({
      query: "US CPI",
      include_answer: true,
      output_schema: { type: "object" },
      effort: "deep",
      country_code: "GB",
      locale: "en-GB",
      location: { latitude: 51.5, longitude: -0.1 },
      timezone: "Europe/London",
      output_settings: { image_dark_mode: true },
      include_related: 3,
      data: { mode: "inline" },
      web: { published_after: "2026-01-01", published_before: "2026-06-30" },
    });
    const body = buildAdvancedSearchBody(input);
    expect(Object.keys(body).sort()).toEqual(Object.keys(AnswerRequest.shape).sort());
    expect(body.location).toEqual({ latitude: 51.5, longitude: -0.1 });
    expect(body.timezone).toBe("Europe/London");
    expect(body.output_settings).toEqual({ image_dark_mode: true });
    expect(body.include_related).toBe(3);
    expect(body.sources).toEqual({
      data: { mode: "inline" },
      web: { published_after: "2026-01-01", published_before: "2026-06-30", highlights: true },
    });
  });

  it("PARSING adds nothing: no generated default survives onto the input", () => {
    // The wire-side default (web.highlights) is applied in the BODY BUILDER, on
    // purpose and in one visible place. Parsing must stay inert, or an omitted
    // field would carry a value nobody chose — how `data: {}` once came back as
    // count:5 / include_contents:false / strict:false.
    expect(tako_search_advanced.inputSchema.parse({ query: "x" })).toEqual({ query: "x" });
    expect(tako_search_advanced.inputSchema.parse({ query: "x", data: {}, web: {} })).toEqual({
      query: "x",
      data: {},
      web: {},
    });
  });

  it("noDefaultsLeak: naming an object-valued field adds no key the caller did not send", () => {
    // `optionalWithoutDefaults` unwraps ONE level, and every object-valued field
    // is generated as `z.union([z.lazy(() => T), z.null()])`, so it cannot reach
    // T's own defaults. `output_settings` hit this — `{image_dark_mode: true}`
    // parsed back with `force_refresh: false` attached — and is rebuilt by hand.
    //
    // THE FIELD SET IS DERIVED, NOT LISTED. A hand-written list is the exact
    // mechanism this whole tool stopped using: the fields flow in through
    // `optionalWithoutDefaults(SearchRequest...)`, so a new object-valued field
    // added upstream would reach the schema automatically and be absent from a
    // hand-written loop, with nothing failing. Only the SAMPLE VALUES are
    // authored, and the two assertions below fail in both directions — a new
    // field with no sample, and a sample left behind by a removed field.
    const samples: Record<string, unknown> = {
      location: { latitude: 1, longitude: 2 },
      output_settings: { image_dark_mode: true },
      data: { count: 3 },
      web: { count: 3 },
    };
    // `sources` is the one field the tool does not expose under its own name:
    // the two blocks replace it (see `dataBlock` / `webBlock`).
    const expected = objectValuedFields(SearchRequest)
      .flatMap((field) => (field === "sources" ? ["data", "web"] : [field]))
      .sort();
    expect(
      Object.keys(samples).sort(),
      "SearchRequest's object-valued fields changed: add or drop a sample value above",
    ).toEqual(expected);

    for (const field of expected) {
      const value = samples[field];
      const parsed = tako_search_advanced.inputSchema.parse({ query: "x", [field]: value }) as Record<
        string,
        unknown
      >;
      expect(parsed[field], `${field} must parse back exactly as sent`).toEqual(value);
    }
  });

  it("rejects a whitespace-only query locally, as the generated schema does", () => {
    // The generated `query` is `z.string().regex(/\S/).min(1)`. A re-authored
    // `z.string().min(1)` dropped the regex, so `"   "` reached the wire and
    // came back a paid 400. The parity test compares key NAMES and cannot see a
    // constraint go missing, so this pins the constraint itself.
    expect(tako_search_advanced.inputSchema.safeParse({ query: "   " }).success).toBe(false);
    expect(tako_search_advanced.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(tako_search_advanced.inputSchema.safeParse({ query: "US GDP" }).success).toBe(true);
  });

  it("exposes effort deep, which the simple tool cannot reach", () => {
    expect(tako_search_advanced.inputSchema.safeParse({ query: "x", effort: "deep" }).success).toBe(true);
    expect(tako_search_advanced.inputSchema.safeParse({ query: "x", effort: "nope" }).success).toBe(false);
  });

  it("keeps card_json: advanced means every content_format the API has", () => {
    const parsed = tako_search_advanced.inputSchema.safeParse({
      query: "x",
      data: { include_contents: true, content_format: "card_json" },
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a full SearchRequest", () => {
    // Deliberately NO include_answer: this is the /v3/search body, and
    // output_schema must never appear on it.
    const input = tako_search_advanced.inputSchema.parse({
      query: "US CPI",
      effort: "deep",
      country_code: "GB",
      locale: "en-GB",
      data: {
        count: 3,
        include_contents: true,
        max_rows: 500,
        content_format: "json_records",
        node_ids: ["mt::cpi::1"],
        strict: true,
      },
      web: {
        count: 2,
        include_contents: true,
        include_domains: ["bls.gov"],
        exclude_domains: ["example.com"],
        category: "news",
        snippet_max_chars: 1500,
        highlights: true,
      },
    });
    expect(buildAdvancedSearchBody(input)).toEqual({
      query: "US CPI",
      effort: "deep",
      country_code: "GB",
      locale: "en-GB",
      sources: {
        data: {
          count: 3,
          include_contents: true,
          max_rows: 500,
          content_format: "json_records",
          node_ids: ["mt::cpi::1"],
          strict: true,
        },
        web: {
          count: 2,
          include_contents: true,
          include_domains: ["bls.gov"],
          exclude_domains: ["example.com"],
          category: "news",
          snippet_max_chars: 1500,
          highlights: true,
        },
      },
    });
  });

  it("rejects a field the API does not have on a source block", () => {
    // The blocks are picked off the generated settings schemas, which are
    // .strict() — so a typo fails here instead of 400-ing at the backend.
    expect(
      tako_search_advanced.inputSchema.safeParse({ query: "x", data: { counts: 3 } }).success,
    ).toBe(false);
  });

  it("rejects a top-level key the API does not have", () => {
    // `.strict()` at the top level, and since mcp.ts registers the full schema
    // this holds on the wire too (mcp.test.ts, "object-level schema checks reach
    // the wire"). A bare `z.object` would STRIP the key and serve the call.
    expect(
      tako_search_advanced.inputSchema.safeParse({ query: "x", bogus: 1 }).success,
    ).toBe(false);
  });

  it("exposes the cap on the payload include_contents stops discarding", () => {
    // `article_content_max_chars` is the ONLY bound on `web.include_contents`:
    // the generated default is 30,000 chars and `count` runs to 20, so without
    // it a caller has no way to keep a 20-result call from inlining ~600 KB of
    // page text — and `.strict()` means they cannot pass it unless it is picked.
    const parsed = tako_search_advanced.inputSchema.parse({
      query: "x",
      web: { include_contents: true, article_content_max_chars: 4000 },
    });
    expect(parsed.web?.article_content_max_chars).toBe(4000);
    // It must reach the wire, not just the schema.
    const body = buildAdvancedSearchBody(parsed);
    expect(body.sources?.web?.article_content_max_chars).toBe(4000);
  });
});

// The advertised `web.include_contents` was inert: slimWebResult dropped page
// text unconditionally, so this tool published the generated description ("Tako
// returns it free of charge") and threw the result away. That is the
// dishonest-parameter shape spec D4's problem statement #3 raises about
// preview_rows, reintroduced on the new tool — and nothing exercised it, which is
// why it shipped.
//
// The retention rule is DERIVED from the wire body, not passed by the caller, so
// the two search tools cannot disagree with what was actually requested.
describe("web include_contents is honoured, not advertised and dropped", () => {
  const searchResponse = () =>
    jsonResponse(200, {
      cards: [],
      web_results: [webResultWithText()],
      request_id: "req-web",
    });

  it("keeps page text when the caller sets web.include_contents", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "nvda", web: { include_contents: true } }),
      CTX,
    );
    const content = out.web_results[0]?.content as { data?: unknown } | null | undefined;
    expect(content?.data).toBe("FULL PAGE TEXT BODY");
  });

  it("drops page text when the caller names the web block without the flag", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "nvda", web: {} }),
      CTX,
    );
    // No content key at all: the projection drops the channel when the wire
    // wasn't asked for it. The citation fields survive.
    expect(out.web_results[0]).not.toHaveProperty("content");
    expect(out.web_results[0]?.url).toBe("https://example.com/nvda");
    expect(out.web_results[0]?.snippet).toBe("Data center revenue rose…");
  });

  it("tako_search always drops it — the simple tool cannot request it", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search.handler({ query: "nvda", sources: ["data", "web"] }, CTX);
    expect(out.web_results[0]).not.toHaveProperty("content");
  });
});

// The absence of widget hooks here is DELIBERATE and cost-driven, and it was
// previously justified by a false claim ("the inline PNG belongs to the default
// surface, and this tool is never on it"). mcp.ts gates the widget on the SURFACE
// — `widgetSuppressed = options.surface !== "chatgpt"` — and runs
// `extraContentBlocks` whenever `ui === undefined`, which on /mcp is always. So a
// hook declared here WOULD fire; nothing structural prevents it. An opt-in tool
// on /mcp can declare both hooks — tako_answer did, before the fold deleted it.
//
// Pin both halves, because each is what the next author gets wrong: no hooks, AND
// the chart is still reachable. Restoring the hooks is a real decision (~170 KB
// base64 per result, not declinable) and should fail this test, not slip in on
// the belief that the old comment was right.
describe("no auto-rendered chart, on purpose", () => {
  it("declares none of the three widget hooks", () => {
    const asRecord = tako_search_advanced as unknown as Record<string, unknown>;
    for (const hook of ["extraMeta", "extraContentBlocks", "appUiResource"]) {
      expect(asRecord[hook], hook).toBeUndefined();
    }
  });

  it("still hands back the chart, so dropping the render costs no capability", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [{ card_id: "cpi", title: "US CPI", webpage_url: "https://trytako.com/c/cpi" }],
        web_results: [],
        request_id: "req-chart",
      }),
    ]);
    const out = (await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "us cpi", data: {} }),
      CTX,
    )) as unknown as Record<string, unknown>;
    expect(out.pub_id).toBe("cpi");
    expect(out.embed_url).toContain("/embed/cpi/");
    expect(out.image_url).toContain("/api/v1/image/cpi/");
  });

  it("tako_search DOES declare them — the asymmetry is the point", () => {
    const asRecord = tako_search as unknown as Record<string, unknown>;
    for (const hook of ["extraMeta", "extraContentBlocks", "appUiResource"]) {
      expect(asRecord[hook], hook).toBeDefined();
    }
  });
});

/**
 * `tako_answer` sent `web.highlights: true` on every call, because on
 * /v1/answer the snippet is not a preview — it IS the grounding text the
 * arbiter reads, and a page's opening characters are usually nav chrome. This
 * tool replaces that one and must not regress it.
 *
 * `tako_search` FORCES the value (no `highlights` field on its input at all).
 * This tool DEFAULTS it: mirroring the API means the caller keeps the lever.
 */
describe("web highlights default", () => {
  const bodyOf = (input: Record<string, unknown>) =>
    buildAdvancedSearchBody(tako_search_advanced.inputSchema.parse({ query: "q", ...input }));

  it("names no block: materializes the backend's own default source set, with highlights on", () => {
    // NOT `{web: {highlights: true}}` — that is a WEB-ONLY request. Sources
    // includes an index only if its key is present, and an absent `sources`
    // means both, so dropping `data` here would turn every default call into a
    // web search.
    expect(bodyOf({}).sources).toEqual({ data: {}, web: { highlights: true } });
  });

  it("names web: fills highlights and keeps the caller's other web fields", () => {
    expect(bodyOf({ web: { count: 10 } }).sources).toEqual({ web: { count: 10, highlights: true } });
  });

  it("explicit false wins — this is a default, not a fixed input", () => {
    expect(bodyOf({ web: { highlights: false } }).sources).toEqual({ web: { highlights: false } });
  });

  it("data only: sends no web block, so no highlights", () => {
    expect(bodyOf({ data: { count: 3 } }).sources).toEqual({ data: { count: 3 } });
  });

  it("the materialized default set still matches the backend's Sources", () => {
    // The no-block branch hardcodes the source set. A third backend source would
    // be silently missing from every default call; fail here instead.
    expect(Object.keys(Sources.shape).sort()).toEqual(["data", "web"]);
  });

  it("tako_search still FORCES it, and declares that as a fixed input", () => {
    // The two tools differ on purpose: `tako_search` has no highlights field to
    // set, so the row belongs in its fixedInputs. This tool's value IS
    // overridable, so a fixedInput row here would be a false claim.
    expect(tako_search.fixedInputs).toEqual([
      expect.objectContaining({ field: "sources.web.highlights", value: "true" }),
    ]);
    expect(tako_search_advanced.fixedInputs).toEqual([]);
  });
});

// The DATA half of the honoured-parameter rule, and the reason it is here: the
// web trio above covered `web.include_contents` while `data.include_contents` —
// this tool's headline capability, the whole reason rows left `tako_search` —
// had no handler test at all. Mutating the handler's
// `input.data?.include_contents === true ? "all" : null` to a constant `null`
// left ALL 1,245 tests in the default project green: `_search_results.test.ts`
// covers `slimCardContent(…, "all")` in isolation, but nothing bound the
// handler's choice to it, so the tool could advertise rows and throw them away
// exactly as the web side did before it was fixed.
const cardWithRows = () => ({
  card_id: "abc123",
  title: "US GDP",
  webpage_url: "https://trytako.com/charts/us-gdp",
  content: {
    content_format: "json_compact",
    cost: 0.001,
    data: null,
    records: null,
    dataset: {
      columns: [
        { name: "date", type: "date" },
        { name: "v", type: "number" },
      ],
      rows: [["2024-01-01", 29]],
      total_rows: 1,
      truncated: false,
      ref: "https://trytako.com/charts/us-gdp",
      sources: [{ name: "FRED", index: "data" }],
      provenance: "query",
    },
    url: null,
    expires_at: null,
    total_rows: 1,
    truncated: false,
    export_pricing: null,
    source_url: "https://trytako.com/charts/us-gdp",
  },
});

describe("data include_contents is honoured, not advertised and dropped", () => {
  const searchResponse = () =>
    jsonResponse(200, { cards: [cardWithRows()], web_results: [], request_id: "req-data" });

  // Rows now ride under the projected `rows` field (only when requested).
  const datasetOf = (out: { cards: Array<{ rows?: Record<string, unknown> }> }) =>
    (out.cards[0]?.rows as { dataset?: unknown } | undefined)?.dataset;

  it("keeps card rows when the caller sets data.include_contents", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "us gdp", data: { include_contents: true } }),
      CTX,
    );
    expect(datasetOf(out)).toMatchObject({ rows: [["2024-01-01", 29]] });
  });

  it("drops card rows when the caller names the data block without the flag", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "us gdp", data: {} }),
      CTX,
    );
    expect(datasetOf(out)).toBeUndefined();
    // total_rows is METADATA, not a payload channel: the projection lifts it
    // to the card so the model still knows rows exist and can fetch them.
    expect(out.cards[0]?.total_rows).toBe(1);
  });

  it("tako_search always drops them — the simple tool cannot request them", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search.handler({ query: "us gdp", sources: ["data"] }, CTX);
    expect(datasetOf(out)).toBeUndefined();
  });
});

/**
 * `include_related` is an input now, so `SearchResponse.related` has to land in
 * the output. Advertising the flag and dropping the answer would bill the
 * ~2.2s Neo4j fan-out and throw the result away.
 */
describe("include_related is honoured: related suggestions reach the output", () => {
  it("passes the wire's related array through and renders it", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [],
        web_results: [],
        request_id: "req-rel",
        related: [{ query: "US core CPI", node_ids: ["mt::cpi-core"] }],
      }),
    ]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "US CPI", include_related: 3 }),
      CTX,
    );
    expect(out.related).toEqual([{ query: "US core CPI", node_ids: ["mt::cpi-core"] }]);
    const md = tako_search_advanced.renderText(out, CTX);
    expect(md).toContain("## Related queries");
    expect(md).toContain("US core CPI");
  });

  it("omits related when the wire carries none", async () => {
    mockFetchSequence([jsonResponse(200, { cards: [], web_results: [], request_id: "r" })]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "x" }),
      CTX,
    );
    expect(out).not.toHaveProperty("related");
  });
});

/**
 * `include_answer` is the fold: it selects `/v1/answer` instead of `/v3/search`
 * on the same tool with the same body, so a caller who needs synthesis no
 * longer gives up the request surface to get it.
 */
describe("include_answer selects the endpoint", () => {
  it("omitted: /api/v3/search/ with no output_schema on the wire", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);
    await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "q" }),
      CTX,
    );
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toContain("/api/v3/search/");
    expect(await req.clone().json()).not.toHaveProperty("output_schema");
  });

  it("true: /api/v1/answer/, and the answer survives to the output and the text channel", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { answer: "US GDP was $29T.", cards: [], web_results: [], request_id: "r" }),
    ]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({ query: "US GDP", include_answer: true }),
      CTX,
    );
    expect(requestFrom(fetchMock.mock.calls[0]).url).toContain("/api/v1/answer/");
    expect(out.answer).toBe("US GDP was $29T.");
    expect(tako_search_advanced.renderText(out, CTX).startsWith("US GDP was $29T.")).toBe(true);
  });

  it("forwards output_schema, and returns the filled structured_output", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        answer: "x",
        cards: [],
        web_results: [],
        request_id: "r",
        structured_output: { v: 1 },
      }),
    ]);
    const schema = { type: "object", properties: { v: { type: "number" } } };
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({
        query: "q",
        include_answer: true,
        output_schema: schema,
      }),
      CTX,
    );
    expect(await requestFrom(fetchMock.mock.calls[0]).clone().json()).toMatchObject({
      output_schema: schema,
    });
    expect(out.structured_output).toEqual({ v: 1 });
  });

  it("rejects output_schema without include_answer before any request is sent", () => {
    // /v3/search is extra="forbid": output_schema there is a 400 naming the
    // field. Catching it here spends nothing and says what to do.
    const result = tako_search_advanced.inputSchema.safeParse({
      query: "q",
      output_schema: { type: "object" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["output_schema"]);
    expect(result.error?.issues[0]?.message).toContain("include_answer");
  });

  it("the answer body satisfies AnswerRequest and the search body satisfies SearchRequest", () => {
    const answerInput = tako_search_advanced.inputSchema.parse({
      query: "q",
      include_answer: true,
      output_schema: { type: "object" },
      data: { node_ids: ["mt::x"], strict: true },
    });
    expect(() => AnswerRequest.parse(buildAdvancedSearchBody(answerInput))).not.toThrow();
    const searchInput = tako_search_advanced.inputSchema.parse({ query: "q", include_related: 2 });
    expect(() => SearchRequest.parse(buildAdvancedSearchBody(searchInput))).not.toThrow();
    // SearchRequest is .strict(): output_schema on it is a parse error, so the
    // search branch must never carry the field.
    expect(() => SearchRequest.parse({ query: "q", output_schema: {} })).toThrow();
  });

  it("inlines rows on the answer path when data.include_contents is set (the license-gated values path)", async () => {
    // The one workflow that needs pins AND synthesis on the same call: a card
    // marked exportable:false cannot be read with tako_contents, so its figures
    // only ever arrive inlined beside an answer.
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Core CPI was 2.6%.",
        cards: [
          {
            card_id: "cpi",
            title: "US Core CPI",
            exportable: false,
            content: {
              content_format: "json_compact",
              cost: 0,
              total_rows: 3,
              // TakoDataset requires total_rows / truncated / ref / sources —
              // the wire guard rejects a looser fixture, which is the point.
              dataset: {
                columns: [
                  { name: "Timestamp", type: "datetime" },
                  { name: "v", type: "number" },
                ],
                rows: [
                  ["2026-04-30", 2.4],
                  ["2026-05-31", 2.5],
                  ["2026-06-30", 2.6],
                ],
                total_rows: 3,
                truncated: false,
                ref: "https://trytako.com/charts/us-core-cpi",
                sources: [{ name: "BLS", index: "data" }],
                provenance: "query",
              },
            },
          },
        ],
        web_results: [],
        request_id: "r",
      }),
    ]);
    const out = await tako_search_advanced.handler(
      tako_search_advanced.inputSchema.parse({
        query: "US core CPI",
        include_answer: true,
        data: { include_contents: true, max_rows: 3, node_ids: ["mt::cpi"], strict: true },
      }),
      CTX,
    );
    const ds = (out.cards[0]?.rows as { dataset: { rows: unknown[] } }).dataset;
    expect(ds.rows).toHaveLength(3);
    expect(out.guidance).toBeUndefined();
  });
});
