import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { jsonResponse, mockFetchSequence, noopSendProgress } from "./__test_helpers.js";
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
  it("exposes the top level plus the two per-source blocks", () => {
    expect(Object.keys(tako_search_advanced.inputSchema.shape).sort()).toEqual([
      "country_code",
      "data",
      "effort",
      "locale",
      "query",
      "web",
    ]);
  });

  it("declares no defaults of its own — an omitted field never reaches the wire", () => {
    const parsed = tako_search_advanced.inputSchema.parse({ query: "x" });
    expect(parsed).toEqual({ query: "x" });
    expect(buildAdvancedSearchBody(parsed)).toEqual({ query: "x" });
  });

  it("strips no generated default into an empty source block", () => {
    // .partial() must remove the generated .default() too, or naming a block
    // would silently send count:5 / include_contents:false / strict:false and
    // the no-defaults rule would be a lie.
    const parsed = tako_search_advanced.inputSchema.parse({ query: "x", data: {}, web: {} });
    expect(buildAdvancedSearchBody(parsed).sources).toEqual({ data: {}, web: {} });
  });

  it("omits sources entirely when the caller names neither block", () => {
    // Absent sources means the API searches data and web with its own
    // defaults; sending {} would be a different request.
    const body = buildAdvancedSearchBody(tako_search_advanced.inputSchema.parse({ query: "x" }));
    expect("sources" in body).toBe(false);
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

  it("rejects an unexposed field at the TOP level too, not just on the blocks", () => {
    // The header and llms-full.txt both promise a -32602 for these four, and the
    // promise was false while the top level was a bare `z.object`: that STRIPS
    // unknown keys rather than rejecting them, so `location` and friends dropped
    // in silence. Only the nested case was ever tested. Every one of the four
    // named in the header is checked here so a later `.pick()` widening cannot
    // leave the doc claim half true.
    for (const field of ["location", "timezone", "output_settings", "include_related"]) {
      expect(
        tako_search_advanced.inputSchema.safeParse({ query: "x", [field]: "anything" }).success,
        `top-level ${field} must be rejected, not stripped`,
      ).toBe(false);
    }
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
    const content = out.web_results[0]?.content as { data?: unknown } | null | undefined;
    expect(content?.data).toBeNull();
    // The citation fields survive the drop — that is the whole point of slimming
    // rather than deleting `content`.
    expect(out.web_results[0]?.url).toBe("https://example.com/nvda");
    expect(out.web_results[0]?.snippet).toBe("Data center revenue rose…");
  });

  it("tako_search always drops it — the simple tool cannot request it", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search.handler({ query: "nvda", sources: ["data", "web"] }, CTX);
    const content = out.web_results[0]?.content as { data?: unknown } | null | undefined;
    expect(content?.data).toBeNull();
  });
});

// The absence of widget hooks here is DELIBERATE and cost-driven, and it was
// previously justified by a false claim ("the inline PNG belongs to the default
// surface, and this tool is never on it"). mcp.ts gates the widget on the SURFACE
// — `widgetSuppressed = options.surface !== "chatgpt"` — and runs
// `extraContentBlocks` whenever `ui === undefined`, which on /mcp is always. So a
// hook declared here WOULD fire; nothing structural prevents it. tako_answer is
// the counterexample: opt-in on /mcp, and it declares both.
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

// tako_search forces web.highlights:true; this tool forces nothing. Correct under
// the mirror-the-API rule, and a silent downgrade for a caller who moved here for
// effort:deep — the generated field description explains what highlights DO and
// cannot mention what the other tool does. So DESCRIPTION carries the asymmetry,
// and this pins all three halves of it: the other tool forces it, this one does
// not, and the text says so. Adding a fixedInput here to "fix" the downgrade
// would fail the second assertion, which is the intended signal.
describe("the highlights asymmetry with tako_search is stated, not silent", () => {
  it("tako_search forces it and this tool forces nothing", () => {
    expect(tako_search.fixedInputs).toEqual([
      expect.objectContaining({ field: "sources.web.highlights", value: "true" }),
    ]);
    expect(tako_search_advanced.fixedInputs).toEqual([]);
  });

  it("the published description warns that highlights defaults off here", () => {
    const d = tako_search_advanced.description;
    expect(d).toMatch(/highlights/);
    expect(d).toMatch(/tako_search\b/);
    // The actionable half: what the caller gets if they do nothing.
    expect(d).toMatch(/opening text|page's opening/i);
  });

  it("still accepts highlights as a normal optional field", () => {
    const parsed = tako_search_advanced.inputSchema.parse({
      query: "x",
      web: { highlights: true },
    });
    expect(buildAdvancedSearchBody(parsed).sources).toEqual({ web: { highlights: true } });
    // And omitting it sends nothing, so the server default applies.
    const bare = tako_search_advanced.inputSchema.parse({ query: "x", web: {} });
    expect(buildAdvancedSearchBody(bare).sources).toEqual({ web: {} });
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

  const datasetOf = (out: { cards: Array<{ content?: unknown }> }) =>
    (out.cards[0]?.content as { dataset?: unknown } | null | undefined)?.dataset;

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
    expect(datasetOf(out)).toBeNull();
    // total_rows is METADATA, not a payload channel: it survives the drop so the
    // model still knows rows exist and can fetch them with tako_contents.
    expect((out.cards[0]?.content as { total_rows?: unknown })?.total_rows).toBe(1);
  });

  it("tako_search always drops them — the simple tool cannot request them", async () => {
    mockFetchSequence([searchResponse()]);
    const out = await tako_search.handler({ query: "us gdp", sources: ["data"] }, CTX);
    expect(datasetOf(out)).toBeNull();
  });
});
