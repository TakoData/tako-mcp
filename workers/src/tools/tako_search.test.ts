/**
 * Tests for `tako_search`.
 *
 * Fast-only, synchronous search backed by `POST /api/v3/search`. No
 * deep/async path: the handler issues one POST and shapes the response
 * into `{ cards, web_results, request_id }` plus top-level auto-chain
 * widget fields when the top card carries a `card_id`. Zero matches
 * come back as a clean empty result (no throw) — deep/multi-step
 * research is delegated to the Tako agent.
 *
 * Locked properties:
 *   1. `sources` array → per-source `sources` object on the wire (count +
 *      include_contents per source); path is `/api/v3/search`.
 *   2. `sources: ["tako","web"]` → both keys present in the object.
 *   3. `effort` omitted → no `effort` key; `effort: "instant"` → passed;
 *      schema rejects `effort: "deep"`.
 *   4. `count` → per-source `count`.
 *   5. v3 card mapping (webpage_url) + `request_id` surfaced.
 *   6. `web_results` surfaced.
 *   7. Top-card auto-chain widget fields populated from `card_id`.
 *   8. Clean empty (0 cards + 0 web_results) → resolves, no throw, no widget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import tako_search from "./tako_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "claude",
};

// Defaults the handler expects post-zod parse (the MCP framework applies
// schema defaults before invoking the handler, so direct handler calls
// must pass the resolved shape — `sources` included).
const DEFAULTS = {
  sources: ["data"] as ("data" | "web")[],
  count: 10,
  include_contents: false,
  country_code: "US",
  locale: "en-US",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_search input schema", () => {
  it("defaults count to 10", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.count).toBe(10);
  });

  it("defaults sources to [\"tako\",\"web\"]", () => {
    const parsed = tako_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sources).toEqual(["data", "web"]);
  });

  it("accepts effort=fast", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "fast",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts effort=instant", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "instant",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects effort=deep", () => {
    const parsed = tako_search.inputSchema.safeParse({
      query: "x",
      effort: "deep",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("tako_search request body", () => {
  it("posts to /api/v3/search with a per-source sources object (no flat source_indexes/output_settings)", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "gold price", ...DEFAULTS }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(req.url).pathname).toBe("/api/v3/search/");
    const body = await bodyOf(req);
    expect(body.sources).toEqual({ data: { count: 10, include_contents: false } });
    expect(body.source_indexes).toBeUndefined();
    expect(body.output_settings).toBeUndefined();
    expect(body.query).toBe("gold price");
  });

  it("maps sources [\"tako\",\"web\"] to both keys of the sources object", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["data", "web"] },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({
      data: { count: 10, include_contents: false },
      web: { count: 10, include_contents: false },
    });
  });

  it("sets include_contents on each selected source when requested", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["data", "web"], include_contents: true },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({
      data: { count: 10, include_contents: true },
      web: { count: 10, include_contents: true },
    });
  });

  it("omits effort from the body when not provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect("effort" in body).toBe(false);
  });

  it("passes effort=instant through to the body", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler(
      { query: "x", ...DEFAULTS, effort: "instant" },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.effort).toBe("instant");
  });

  it("maps count into each selected source", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "r" }),
    ]);

    await tako_search.handler({ query: "x", ...DEFAULTS, count: 5 }, CTX);

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.sources).toEqual({ data: { count: 5, include_contents: false } });
  });
});

describe("tako_search response mapping", () => {
  it("maps a v3 card (webpage_url) and surfaces request_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "abc",
            title: "T",
            description: "d",
            webpage_url: "https://trytako.com/c/abc",
            image_url: "https://trytako.com/img.png",
            embed_url: "https://trytako.com/embed/abc",
          },
        ],
        web_results: [],
        request_id: "req-1",
      }),
    ]);

    const out = await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.webpage_url).toBe("https://trytako.com/c/abc");
    expect(out.request_id).toBe("req-1");
  });

  it("surfaces web_results", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [],
        web_results: [
          {
            title: "A web result",
            url: "https://example.com/a",
            snippet: "snip",
            source_name: "Example",
          },
        ],
        request_id: "req-web",
      }),
    ]);

    const out = await tako_search.handler(
      { query: "x", ...DEFAULTS, sources: ["web"] },
      CTX,
    );

    expect(out.web_results).toHaveLength(1);
    expect(out.web_results[0]?.url).toBe("https://example.com/a");
  });

  it("populates auto-chain widget fields when the top card has card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          { card_id: "aapl-price", title: "AAPL", webpage_url: "u" },
        ],
        web_results: [],
        request_id: "req-2",
      }),
    ]);

    const out = await tako_search.handler({ query: "AAPL", ...DEFAULTS }, CTX);

    expect(out.pub_id).toBe("aapl-price");
    expect(out.embed_url).toBe(
      "https://staging.trytako.com/embed/aapl-price/?dark_mode=auto",
    );
    expect(out.image_url).toBe(
      "https://staging.trytako.com/api/v1/image/aapl-price/?dark_mode=true",
    );
    expect(out.dark_mode).toBe(true);
    expect(out.width).toBe(900);
    expect(out.height).toBe(720);
  });

  it("returns a clean empty result (no throw, no widget fields) on zero matches", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-empty" }),
    ]);

    const out = await tako_search.handler(
      { query: "obscure query with no matches", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.cards).toEqual([]);
    expect(out.web_results).toEqual([]);
    expect(out.request_id).toBe("req-empty");
    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
  });

  it("omits widget fields when the top card has no card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [{ card_id: null, title: "Metadata only", webpage_url: "u" }],
        web_results: [],
        request_id: "req-3",
      }),
    ]);

    const out = await tako_search.handler({ query: "x", ...DEFAULTS }, CTX);

    expect(out.cards).toHaveLength(1);
    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
  });
});
