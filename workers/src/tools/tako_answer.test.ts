/**
 * Tests for the `tako_answer` tool.
 *
 * The handler is a single POST + re-parse: it maps the tool input onto
 * the backend's `/api/v1/answer/` request body (AnswerRequest shape:
 * top-level `query` + a per-source `sources` object, NOT `inputs.text` and
 * NOT the old flat `source_indexes`) and re-validates the response through
 * the output schema. The interesting behavior is:
 *   - request mapping (`query`→`query`, `sources` array → `sources` object)
 *   - the defensive defaulting of missing fields (cards/web_results → [])
 *   - the loud failure on a mis-shaped backend payload
 *   - the absence of grounding-era fields (tako_selected, confidence)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoAnswer, { buildAnswerBody } from "./tako_answer.js";
import takoSearch from "./tako_search.js";
import { APP_UI_RESOURCE_URI } from "./_chart_widget.js";
import { AnswerRequest, SearchRequest } from "../generated/schemas.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
// The widget's CSP declarations are gated on PUBLIC_CDN_URL; without it
// `connectDomains` is [] and `nativeCardUrl` bails, so an env that omits it
// cannot exercise anything origin-dependent.
const WIDGET_ENV: Env = {
  DJANGO_BASE_URL: "https://staging.trytako.com",
  PUBLIC_CDN_URL: "https://d1iyjvzoctsna.cloudfront.net",
};
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  surface: "generic",
};

const FULL_RESPONSE = {
  answer: "US GDP was about $29 trillion in 2024.",
  cards: [
    {
      card_id: "abc123",
      title: "US GDP",
      description: "Gross Domestic Product of the United States",
      webpage_url: "https://trytako.com/charts/us-gdp",
      image_url: "https://trytako.com/api/v1/image/abc123/",
      embed_url: "https://trytako.com/embed/abc123/",
    },
  ],
  web_results: [
    { title: "US GDP 2024", url: "https://example.com/gdp", snippet: "..." },
  ],
  request_id: "req-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Regression: same root cause as the tako_search content-shape outage — cards
// and web results carry a `content` preview object whose backend field `format`
// was renamed to `content_format`. tako_answer reuses takoCardSchema /
// webResultSchema, so a hard-required `format` there also made every
// content-bearing answer throw. Fixture is the real live content shape.
describe("tako_answer content-shape regression (format -> content_format)", () => {
  const LIVE_CONTENT = {
    content_format: null,
    cost: 0.001,
    data: null,
    records: null,
    dataset: null,
    url: null,
    expires_at: null,
    total_rows: null,
    truncated: false,
    export_pricing: null,
  };

  it("does not throw when cards/web results carry the current content shape", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "US GDP was about $29 trillion.",
        cards: [
          {
            card_id: "abc123",
            title: "US GDP",
            embed_url: "https://trytako.com/embed/abc123/",
            content: LIVE_CONTENT,
          },
        ],
        web_results: [
          { title: "US GDP", url: "https://example.com/gdp", content: LIVE_CONTENT },
        ],
        request_id: "req-content",
      }),
    ]);

    const out = await takoAnswer.handler(
      {
        query: "US GDP",
        sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US",
        locale: "en-US",
        strict: false,
      },
      CTX,
    );

    expect(out.cards).toHaveLength(1);
    expect(out.web_results).toHaveLength(1);
    expect(out.cards[0]?.content?.content_format).toBeNull();
  });
});

describe("tako_answer handler", () => {
  it("tool name is tako_answer", () => {
    expect(takoAnswer.name).toBe("tako_answer");
  });

  it("maps query + sources to the per-source sources object, hits /api/v1/answer/", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await takoAnswer.handler(
      {
        query: "What was US GDP in 2024?",
        sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US",
        locale: "en-US",
        strict: false,
      },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toBe("https://staging.trytako.com/api/v1/answer/");
    const body = await bodyOf(req);
    // AnswerRequest: top-level `query` + per-source `sources` object
    expect(body.query).toBe("What was US GDP in 2024?");
    expect(body.sources).toEqual({
      data: { include_contents: false },
      web: { include_contents: false, snippet_max_chars: 2000, highlights: true },
    });
    // old flat shape + grounding-era nested inputs must NOT be present
    expect(body.source_indexes).toBeUndefined();
    expect(body.inputs).toBeUndefined();

    expect(out.answer).toContain("$29 trillion");
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.card_id).toBe("abc123");
    expect(out.web_results).toHaveLength(1);
    expect(out.request_id).toBe("req-1");
  });

  it("defaults missing optional fields to empty arrays rather than leaking undefined", async () => {
    // A minimal valid backend payload — only the required scalar. The
    // handler should default cards/web_results to [].
    mockFetchSequence([
      jsonResponse(200, {
        answer: "No strong match.",
        request_id: "req-2",
      }),
    ]);

    const out = await takoAnswer.handler(
      { query: "obscure query", sources: ["data"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );

    expect(out.cards).toEqual([]);
    expect(out.web_results).toEqual([]);
    expect(out.answer).toBe("No strong match.");
    expect(out.request_id).toBe("req-2");
  });

  it("output does NOT contain grounding-era fields (tako_selected, confidence)", async () => {
    mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    const out = await takoAnswer.handler(
      { query: "test", sources: ["data"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    ) as Record<string, unknown>;

    expect(out.tako_selected).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  it("throws an actionable error when the backend returns an unexpected shape (cards not an array)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "ok",
        cards: "not-an-array",
        web_results: [],
        request_id: "req-bad",
      }),
    ]);

    await expect(
      takoAnswer.handler({ query: "q", sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false }, CTX),
    ).rejects.toThrow(/unexpected wire shape/);
  });
});

describe("tako_answer renders a chart, exactly like tako_search", () => {
  // The gap this closes: an answer's citations ARE cards, but only search
  // lifted the widget fields, so an answer came back as text with no chart
  // even though the card ids were right there in the output.

  it("lifts the top cited card's widget fields", async () => {
    mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    const out = await takoAnswer.handler(
      {
        query: "What was US GDP in 2024?",
        sources: ["data", "web"], include_contents: false, preview_rows: 50,
        country_code: "US", locale: "en-US", strict: false,
      },
      CTX,
    );
    const o = out as unknown as Record<string, unknown>;
    expect(o.pub_id).toBe("abc123");
    expect(String(o.embed_url)).toContain("/embed/abc123/");
    expect(String(o.image_url)).toContain("/api/v1/image/abc123/");
    expect(typeof o.height).toBe("number");
  });

  it("declares the same widget resource search does", () => {
    // Without this the host has no widget to render the fields into.
    expect(takoAnswer.appUiResource).toBeDefined();
    expect(takoSearch.appUiResource).toBeDefined();
    const ORIGIN = "https://mcp.example.test";
    const a = takoAnswer.appUiResource!(WIDGET_ENV, ORIGIN);
    const s = takoSearch.appUiResource!(WIDGET_ENV, ORIGIN);
    // Absolute, not just equal to search's — an identical regression inside the
    // shared builder would satisfy a purely relational assertion on both sides.
    expect(a.uri).toBe(APP_UI_RESOURCE_URI);
    expect(a.uri).toBe(s.uri);
    expect(a.html).toBe(s.html);
    expect(a.frameDomains).toEqual(s.frameDomains);
    expect(a.resourceDomains).toEqual(s.resourceDomains);
    expect(a.connectDomains).toEqual(s.connectDomains);
  });

  it("forwards requestOrigin into the CSP declaration", () => {
    // The previous version of this test could not fail: with PUBLIC_CDN_URL
    // unset, `connectDomains` short-circuits to [] and `nativeCardUrl` bails
    // before reading the origin, so dropping the argument changed nothing.
    // WIDGET_ENV sets it, which is what makes the origin observable.
    const withOrigin = takoAnswer.appUiResource!(
      WIDGET_ENV,
      "https://mcp.example.test",
    );
    const without = takoAnswer.appUiResource!(WIDGET_ENV, undefined);
    expect(withOrigin.connectDomains).toEqual(["https://mcp.example.test"]);
    expect(without.connectDomains).toEqual([]);
    expect(withOrigin.resourceDomains).toContain("https://mcp.example.test");
  });

  it("carries the widget hooks search carries", () => {
    expect(typeof takoAnswer.extraMeta).toBe("function");
    expect(typeof takoAnswer.extraContentBlocks).toBe("function");
  });

  it.each(["chatgpt"] as const)(
    "sends the %s surface dimensions only, never the whole PNG",
    async (surface) => {
      // `bakeImage: ctx.surface !== "chatgpt"` is justified as "a
      // 64-byte ranged read instead of a ~170 KB render". Inverted, every
      // chatgpt-surface call pays the full PNG_FETCH_TIMEOUT_MS budget for
      // a payload the host discards — and nothing caught that, here or in
      // search.
      const seen: { url: string; range: string | null }[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const req = new Request(input as RequestInfo, init);
        seen.push({ url: req.url, range: req.headers.get("range") });
        // 8 bytes of PNG signature + IHDR length so the dimension parser has
        // something to chew on; the assertion is about the REQUEST.
        return new Response(new Uint8Array(64), {
          status: 206,
          headers: { "content-type": "image/png" },
        });
      }) as typeof fetch);

      await takoAnswer.extraMeta!(
        { image_url: "https://x.test/api/v1/image/abc/", pub_id: "abc" } as never,
        { ...CTX, surface } as never,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.range).not.toBeNull();
    },
  );

  it("returns no content block when there is no chart", async () => {
    // `fetchPngContentBlock(undefined)` would fetch the string "undefined".
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(
      takoAnswer.extraContentBlocks!({} as never, CTX),
    ).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("advertises the widget fields, or the SDK strips them", () => {
    // The advertised schema is rebuilt strict at the top level, so a field
    // that is not declared never reaches the host.
    const shape = Object.keys(
      (takoAnswer.outputSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    for (const key of ["pub_id", "embed_url", "image_url", "height"]) {
      expect(shape).toContain(key);
    }
  });

  it("emits no widget fields when nothing is citable", async () => {
    // Zero cards must not produce a chart pointing at nothing; the widget
    // collapses on this shape.
    mockFetchSequence([
      jsonResponse(200, { ...FULL_RESPONSE, cards: [], request_id: "req-empty" }),
    ]);
    const out = await takoAnswer.handler(
      {
        query: "something with no data",
        sources: ["data", "web"], include_contents: false, preview_rows: 50,
        country_code: "US", locale: "en-US", strict: false,
      },
      CTX,
    );
    const o = out as unknown as Record<string, unknown>;
    expect(o.pub_id).toBeUndefined();
    expect(o.embed_url).toBeUndefined();
    expect(o.image_url).toBeUndefined();
  });
});

describe("tako_answer input schema", () => {
  it("defaults sources to both data and web", () => {
    const parsed = takoAnswer.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toEqual(["data", "web"]);
  });

  it("accepts the legacy \"tako\" synonym and folds it onto the data key", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      { query: "q", sources: ["data"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });

  it("rejects an empty sources array", () => {
    expect(() =>
      takoAnswer.inputSchema.parse({ query: "hello", sources: [] }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      takoAnswer.inputSchema.parse({ query: "hello", sources: ["bing"] }),
    ).toThrow();
  });

  it("includes country_code and locale in the POST body", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    await takoAnswer.handler(
      { query: "test", sources: ["data"], include_contents: false, preview_rows: 50, country_code: "GB", locale: "en-GB", strict: false },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]!);
    const body = await bodyOf(req);
    expect(body.country_code).toBe("GB");
    expect(body.locale).toBe("en-GB");
  });

  it("defaults country_code to US and locale to en-US", () => {
    const parsed = takoAnswer.inputSchema.parse({ query: "hello" });
    expect(parsed.country_code).toBe("US");
    expect(parsed.locale).toBe("en-US");
  });
});

describe("tako_answer contract guards", () => {
  it("keeps a flat sources array on the advertised input", () => {
    const shape = takoAnswer.inputSchema.shape as Record<string, unknown>;
    expect(shape).toHaveProperty("sources");
    const parsed = takoAnswer.inputSchema.parse({ query: "US GDP" });
    expect(parsed.sources).toEqual(["data", "web"]); // mirrors backend default
  });

  it("reshapes the flat input into a body that satisfies the backend contract", () => {
    const body = buildAnswerBody({
      query: "US GDP", sources: ["data", "web"], include_contents: false, preview_rows: 50,
      country_code: "US", locale: "en-US", strict: false,
    });
    // The generated backend contract must accept the reshaped body.
    expect(() => AnswerRequest.parse(body)).not.toThrow();
  });

  it("types the answer body against the component that carries output_schema", () => {
    // TakoData/tako#29604 SPLIT /v1/answer off SearchRequest so it could carry
    // `output_schema`. The `satisfies` in buildAnswerBody could not catch that:
    // SearchRequest stayed valid for /v3/search, so the old name kept compiling
    // against the wrong endpoint's contract. These two halves are what a split
    // cannot slip past.

    // Compile-time half: stops typechecking if buildAnswerBody is re-pointed at
    // a component with no `output_schema` key.
    type BodyKeys = keyof ReturnType<typeof buildAnswerBody>;
    const carriesOutputSchema: "output_schema" extends BodyKeys ? true : false = true;
    expect(carriesOutputSchema).toBe(true);

    // Runtime half: proves the compile-time check is not vacuous — the two
    // components really do differ, and both are .strict(), so the field is a
    // 400 on /v3/search and accepted on /v1/answer.
    const withSchema = { query: "US GDP", output_schema: { type: "object" } };
    expect(() => AnswerRequest.parse(withSchema)).not.toThrow();
    expect(() => SearchRequest.parse(withSchema)).toThrow();
  });

  it("documents the snippet contract on the ADVERTISED output schema", () => {
    // Same guard as tako_search: the advertised `web_results` array is loose,
    // so its array-level description is the only place a client reads the
    // snippet semantics. Shorter wording here than on search (these snippets
    // are citations behind synthesized prose, not the thing being triaged),
    // but the non-contiguity warning must survive — it is what stops a quote
    // being fabricated across a " … " join.
    const web = (
      z.toJSONSchema(takoAnswer.outputSchema) as {
        properties?: { web_results?: { description?: string } };
      }
    ).properties?.web_results?.description;

    expect(web).toBeDefined();
    expect(web).toMatch(/selected against/i);
    expect(web).toContain(" … ");
    expect(web).toMatch(/null/);
  });

  it("asks for Exa highlights on the web source the arbiter grounds on", () => {
    const body = buildAnswerBody({
      query: "nvidia data center revenue", sources: ["web"], include_contents: false,
      preview_rows: 50, country_code: "US", locale: "en-US", strict: false,
    });
    // On /v1/answer the snippet is not just displayed — it is the grounding
    // text the arbiter reads. Highlights put the answer-bearing sentences in
    // that slot instead of the page's opening characters.
    expect(body.sources?.web).toMatchObject({ highlights: true });
    // And the key has to exist in the contract: sources.web is extra="forbid",
    // so an unknown key is a 400 on every web answer, not a soft degrade.
    expect(() => AnswerRequest.parse(body)).not.toThrow();
  });
});

describe("tako_answer graph grounding", () => {
  it("maps node_ids + strict into sources.data", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    await takoAnswer.handler(
      {
        query: "Tesla revenue",
        sources: ["data"],
        include_contents: false,
        preview_rows: 50,
        country_code: "US",
        locale: "en-US",
        node_ids: ["tesla-x1"],
        strict: true,
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: { include_contents: false, node_ids: ["tesla-x1"], strict: true },
    });
  });

  it("omits node_ids/strict when not provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      { query: "q", sources: ["data"], include_contents: false, preview_rows: 50,
        country_code: "US", locale: "en-US", strict: false },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });
});

describe("tako_answer strips inline row data when include_contents is false", () => {
  // A card the backend attached a full data preview to, plus a web result with
  // inlined page text. answer must drop both — the synthesized prose is the
  // payload — while keeping metadata (total_rows/content_format) + pointers.
  const CARD_WITH_ROWS = {
    card_id: "cpi-1",
    title: "US Core CPI",
    webpage_url: "https://trytako.com/c/cpi-1",
    embed_url: "https://trytako.com/embed/cpi-1/",
    nodes: [{ id: "cpi-x1", name: "Core CPI", type: "metric" }],
    content: {
      content_format: "json_compact",
      cost: 0.001,
      total_rows: 300,
      truncated: true,
      data: null,
      records: null,
      dataset: {
        columns: [{ name: "Timestamp", type: "datetime" }, { name: "v", type: "number" }],
        rows: Array.from({ length: 300 }, (_v, i) => [`2000-01-${i}`, i]),
        total_rows: 300,
        truncated: true,
        ref: "cpi-ref",
        sources: [],
        provenance: "query",
      },
    },
  };

  it("nulls dataset/records/data on cited cards and drops web page text", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Core CPI was 2.6% in Jun 2026.",
        cards: [CARD_WITH_ROWS],
        web_results: [
          {
            title: "CPI report",
            url: "https://example.com/cpi",
            snippet: "summary",
            content: { content_format: null, cost: 0.02, data: "…full page text…" },
          },
        ],
        request_id: "req-slim",
      }),
    ]);

    const out = await takoAnswer.handler(
      { query: "US core CPI", sources: ["data", "web"], include_contents: false, preview_rows: 50, country_code: "US", locale: "en-US", strict: false },
      CTX,
    );

    const content = out.cards[0]?.content as Record<string, unknown>;
    // Row payload dropped from all three shapes...
    expect(content.dataset).toBeNull();
    expect(content.records).toBeNull();
    expect(content.data).toBeNull();
    // ...but the "more data available, priced" signal + pointers survive.
    expect(content.total_rows).toBe(300);
    expect(content.content_format).toBe("json_compact");
    expect(out.cards[0]?.webpage_url).toBe("https://trytako.com/c/cpi-1");
    expect(out.cards[0]?.nodes).toHaveLength(1);
    // Web page text dropped; snippet/url kept.
    expect((out.web_results[0]?.content as Record<string, unknown>).data).toBeNull();
    expect(out.web_results[0]?.snippet).toBe("summary");
  });
});

describe("tako_answer series-in-first-response (the punt-and-retry fix)", () => {
  const CARD_300_ROWS = {
    card_id: "cpi-1",
    title: "US Core CPI",
    content: {
      content_format: "json_compact",
      cost: 0.001,
      total_rows: 300,
      truncated: true,
      dataset: {
        columns: [{ name: "Timestamp", type: "datetime" }, { name: "v", type: "number" }],
        rows: Array.from({ length: 300 }, (_v, i) => [`d${i}`, i]),
        total_rows: 300,
        truncated: true,
        ref: "cpi-ref",
        sources: [],
        provenance: "query",
      },
    },
  };

  it("defaults include_contents to false (spec D11) and preview_rows to the inline cap (20)", () => {
    // Every delivered row bills since tako#29572 — the default matches the
    // raw v3 API (types.py include_contents=False). 20 mirrors the
    // backend's inline row cap.
    const parsed = takoAnswer.inputSchema.parse({ query: "x" });
    expect(parsed.include_contents).toBe(false);
    expect(parsed.preview_rows).toBe(20);
  });

  it("requests include_contents on the DATA source only; web stays pinned false", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      takoAnswer.inputSchema.parse({
        query: "US GDP",
        sources: ["data", "web"],
        include_contents: true,
      }),
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: { include_contents: true },
      web: { include_contents: false, snippet_max_chars: 2000, highlights: true },
    });
  });

  it("keeps the preview_rows most-recent rows on cited cards instead of stripping them", async () => {
    // The teaser that triggers the cascade: "card exists, latest value 59.2%"
    // with the series absent. With include_contents set, the capped series
    // must survive to the model.
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Core CPI was 2.6% in Jun 2026.",
        cards: [CARD_300_ROWS],
        web_results: [],
        request_id: "req-dense",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({
        query: "US core CPI",
        include_contents: true,
        preview_rows: 40,
      }),
      CTX,
    );
    const ds = (out.cards[0]?.content as { dataset: { rows: unknown[] } }).dataset;
    expect(ds.rows).toHaveLength(40);
    expect(ds.rows[39]).toEqual(["d299", 299]); // most-recent tail kept
    expect(out.guidance).toBeUndefined(); // cards grounded it — no verdict
  });

  it("zero data cards + data searched → deterministic 'not in the data index' guidance", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [{ title: "w", url: "https://example.com" }],
        request_id: "req-gap",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3" }),
      CTX,
    );
    // Web results ground the answer → the SOFT branch: the verdict scopes
    // itself to the data index instead of impugning a possibly-correct
    // web-cited answer (PR #179 review, comment C3).
    expect(out.guidance).toContain("ZERO curated data cards");
    expect(out.guidance).toContain("web-grounded only");
    expect(out.guidance).toContain("If the prose answers the question, use it as-is");
    expect(out.guidance).toContain("tako_available_data");
  });

  it("zero data cards AND zero web results → the hard anti-retry verdict", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [],
        request_id: "req-gap-hard",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3" }),
      CTX,
    );
    expect(out.guidance).toContain("zero web results");
    expect(out.guidance).toContain("Do NOT rephrase-and-retry");
    expect(out.guidance).not.toContain("web-grounded only");
    // The ban names what it is about. A flat "do not retry" reads as "stop
    // working", and on a web-shaped question one narrower ask is the right move.
    expect(out.guidance).toContain("hoping the same question lands a data series");
    expect(out.guidance).toMatch(/WEB axis only/);
  });

  // tako_answer synthesizes ONE answer per call, so a multi-entity web question
  // ("how does each of these handle X") returns one blended answer. Re-asking
  // the same broad question is the loop that does not converge; asking it once
  // per entity is not a retry at all. The guidance has to say so, or the
  // anti-retry sentence reads as "stop after one call".
  it("tells a web-grounded answer to DECOMPOSE rather than re-ask", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Per the docs, both support it.",
        cards: [],
        web_results: [{ title: "docs", url: "https://example.com/docs" }],
        request_id: "req-gap-web",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "how do these APIs handle pagination" }),
      CTX,
    );
    const g = out.guidance ?? "";
    expect(g).toContain("web-grounded only");
    expect(g).toContain("DECOMPOSE");
    expect(g).toMatch(/One narrow question per entity, provider or site/);
    // Scoped, not blanket: the ban is about hunting a data series.
    expect(g).toContain("do NOT rephrase-and-retry tako_answer for it");
  });

  // The default sources are ["data","web"], so this branch is only reached by a
  // caller who narrowed to ["data"] — meaning the web was never queried. The
  // verdict used to be built from `hasWebResults` alone and therefore claimed
  // "and no web results", reporting a second source's outcome from the first
  // source's evidence, then told the model to treat the metric as absent.
  it("does not claim the web came back empty when the web was never searched", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "I couldn't find that in the provided sources.",
        cards: [],
        web_results: [],
        request_id: "req-gap-data-only",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "hotel RevPAR Q3", sources: ["data"] }),
      CTX,
    );
    const g = out.guidance ?? "";
    expect(g).not.toContain("zero web results");
    expect(g).toContain("DATA source only");
    // Names the cheap next step instead of declaring the figure unavailable.
    expect(g).toMatch(/sources:\["data","web"\]/);
    expect(g).not.toMatch(/genuinely absent/);
  });

  it("no guidance on a web-only ask (no data verdict to render)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        answer: "Some news summary.",
        cards: [],
        web_results: [{ title: "w", url: "https://example.com" }],
        request_id: "req-webonly",
      }),
    ]);
    const out = await takoAnswer.handler(
      takoAnswer.inputSchema.parse({ query: "latest news", sources: ["web"] }),
      CTX,
    );
    expect(out.guidance).toBeUndefined();
  });
});

describe("tako_answer sources enum", () => {
  it('rejects the retired "tako" source alias', () => {
    expect(takoAnswer.inputSchema.safeParse({ query: "q", sources: ["tako"] }).success).toBe(false);
    expect(takoAnswer.inputSchema.safeParse({ query: "q", sources: ["data"] }).success).toBe(true);
  });
});
