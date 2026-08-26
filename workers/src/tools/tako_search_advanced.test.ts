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
