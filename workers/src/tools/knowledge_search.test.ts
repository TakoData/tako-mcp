/**
 * Tests for `knowledge_search` after the async-split.
 *
 * Locked properties:
 *   1. Default (no explicit `search_effort`) → call `fast` first.
 *   2. Empty `fast` result + default effort → kick off `deep` async,
 *      return `{ task_id, status: "pending", search_effort: "deep" }`.
 *      No polling.
 *   3. Non-empty `fast` result → return results, no escalation.
 *   4. Explicit `search_effort: "fast"` returning empty → return empty
 *      results path (no escalation).
 *   5. Explicit `search_effort: "deep"` → single POST, return kickoff
 *      payload immediately on async response.
 *   6. Explicit `search_effort: "deep"` returning sync cards → return
 *      sync results path (defensive against backend serving deep sync).
 *   7. Schema rejects `medium` and `auto`.
 *   8. Default `count` is 10.
 *   9. Auto-chain widget fields populated on sync results path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import knowledge_search from "./knowledge_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchOnce,
  mockFetchSequence,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

// Defaults the handler expects post-zod parse. count is 10 after this change.
const DEFAULTS = { count: 10, country_code: "US", locale: "en-US" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("knowledge_search input schema", () => {
  it("defaults count to 10", () => {
    const parsed = knowledge_search.inputSchema.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.count).toBe(10);
  });

  it("rejects search_effort=medium", () => {
    const parsed = knowledge_search.inputSchema.safeParse({
      query: "x",
      search_effort: "medium",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects search_effort=auto", () => {
    const parsed = knowledge_search.inputSchema.safeParse({
      query: "x",
      search_effort: "auto",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts search_effort=fast", () => {
    const parsed = knowledge_search.inputSchema.safeParse({
      query: "x",
      search_effort: "fast",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts search_effort=deep", () => {
    const parsed = knowledge_search.inputSchema.safeParse({
      query: "x",
      search_effort: "deep",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("knowledge_search sync results path", () => {
  it("defaults to search_effort=fast on the initial POST", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "abc",
              title: "Gold",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    await knowledge_search.handler({ query: "gold price", ...DEFAULTS }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("fast");
  });

  it("returns results without escalation when fast returns at least one card", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "abc",
              title: "Gold",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "gold price", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect("task_id" in out).toBe(false);
    if (!("task_id" in out)) {
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("abc");
    }
  });

  it("returns the empty fast result (no escalation) when caller forces search_effort=fast", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
    ]);

    const out = await knowledge_search.handler(
      { query: "obscure", search_effort: "fast", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect("task_id" in out).toBe(false);
    if (!("task_id" in out)) {
      expect(out.count).toBe(0);
    }
  });

  it("populates auto-chain widget fields when top card has card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "aapl-price",
              title: "AAPL",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "AAPL", ...DEFAULTS },
      CTX,
    );

    expect("task_id" in out).toBe(false);
    if (!("task_id" in out)) {
      expect(out.pub_id).toBe("aapl-price");
      expect(out.embed_url).toBe(
        "https://staging.trytako.com/embed/aapl-price/?theme=dark",
      );
      expect(out.image_url).toBe(
        "https://staging.trytako.com/api/v1/image/aapl-price/?dark_mode=true",
      );
      expect(out.dark_mode).toBe(true);
      expect(out.width).toBe(900);
      expect(out.height).toBe(720);
    }
  });

  it("omits auto-chain widget fields when no card has card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: null,
              title: "Metadata only",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "x", search_effort: "fast", ...DEFAULTS },
      CTX,
    );

    expect("task_id" in out).toBe(false);
    if (!("task_id" in out)) {
      expect(out.pub_id).toBeUndefined();
      expect(out.embed_url).toBeUndefined();
      expect(out.image_url).toBeUndefined();
    }
  });
});

describe("knowledge_search async kickoff path", () => {
  it("kicks off deep and returns task_id (no polling) when fast returns empty under default effort", async () => {
    const fetchMock = mockFetchSequence([
      // 1: fast POST (sync, empty)
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
      // 2: deep POST → 202 async-task initiation
      jsonResponse(202, { task_id: "task-async-1", status: "pending" }),
    ]);

    const out = await knowledge_search.handler(
      { query: "obscure thing", ...DEFAULTS },
      CTX,
    );

    // Exactly two POSTs and ZERO status GETs — proves no polling.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fastBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    const deepBody = await bodyOf(requestFrom(fetchMock.mock.calls[1]));
    expect(fastBody.search_effort).toBe("fast");
    expect(deepBody.search_effort).toBe("deep");

    expect("task_id" in out).toBe(true);
    if ("task_id" in out) {
      expect(out.task_id).toBe("task-async-1");
      expect(out.status).toBe("pending");
      expect(out.search_effort).toBe("deep");
      expect(out.message).toMatch(/wait_for_knowledge_search/);
    }
  });

  it("kicks off deep directly (no fast pre-call) when caller sets search_effort=deep", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(202, { task_id: "task-deep-direct", status: "pending" }),
    ]);

    const out = await knowledge_search.handler(
      { query: "x", search_effort: "deep", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("deep");

    expect("task_id" in out).toBe(true);
    if ("task_id" in out) {
      expect(out.task_id).toBe("task-deep-direct");
    }
  });

  it("returns sync results path when explicit deep responds synchronously (defensive)", async () => {
    // Backend isn't strictly contractually obligated to return 202 for
    // deep — fixtures or future fast-deep paths may serve sync. Tool
    // must surface those cards on the results path.
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "deep-sync",
              title: null,
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "x", search_effort: "deep", ...DEFAULTS },
      CTX,
    );

    expect("task_id" in out).toBe(false);
    if (!("task_id" in out)) {
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("deep-sync");
    }
  });
});

// Minimal valid PNG bytes used by extraMeta tests.
const MINIMAL_VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x03, 0x84,
  0x00, 0x00, 0x02, 0xd0,
]);

function pngResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

function autoChainOutput() {
  return {
    results: [
      {
        card_id: "top-1",
        title: "Top",
        description: null,
        url: null,
        source: null,
      },
    ],
    count: 1,
    pub_id: "top-1",
    embed_url: "https://staging.trytako.com/embed/top-1/?theme=dark",
    image_url:
      "https://staging.trytako.com/api/v1/image/top-1/?dark_mode=true",
    dark_mode: true,
    width: 900,
    height: 720,
  };
}

describe("knowledge_search extraMeta / extraContentBlocks (sync results path only)", () => {
  it("inlines PNG as data URI on _meta when image_url present", async () => {
    mockFetchOnce(pngResponse(MINIMAL_VALID_PNG));
    const meta = await knowledge_search.extraMeta!(autoChainOutput(), CTX);
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      image_natural_width: 900,
      image_natural_height: 720,
    });
  });

  it("returns undefined when output has no image_url (kickoff response)", async () => {
    const meta = await knowledge_search.extraMeta!(
      {
        task_id: "t",
        status: "pending",
        message: "...",
        search_effort: "deep",
      } as unknown as Parameters<typeof knowledge_search.extraMeta>[0],
      CTX,
    );
    expect(meta).toBeUndefined();
  });

  it("emits image content block on extraContentBlocks when image_url present", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFetchOnce(pngResponse(png));
    const blocks = await knowledge_search.extraContentBlocks!(
      autoChainOutput(),
      CTX,
    );
    expect(blocks).toHaveLength(1);
  });

  it("emits [] on extraContentBlocks for kickoff payload", async () => {
    const blocks = await knowledge_search.extraContentBlocks!(
      {
        task_id: "t",
        status: "pending",
        message: "...",
        search_effort: "deep",
      } as unknown as Parameters<typeof knowledge_search.extraContentBlocks>[0],
      CTX,
    );
    expect(blocks).toEqual([]);
  });
});

describe("knowledge_search appUiResource", () => {
  it("uses output.pub_id for dynamic resource URI on results path", () => {
    const ui = knowledge_search.appUiResource!(ENV);
    const uri = ui.dynamic!.resolveUriFromInput(
      { query: "anything", count: 10, country_code: "US", locale: "en-US" },
      autoChainOutput(),
    );
    expect(uri).toBe("ui://tako/embed/chart/top-1");
  });

  it("falls back to static URI when output is undefined or has no pub_id", () => {
    const ui = knowledge_search.appUiResource!(ENV);
    expect(
      ui.dynamic!.resolveUriFromInput(
        { query: "anything", count: 10, country_code: "US", locale: "en-US" },
        undefined,
      ),
    ).toBe("ui://tako/embed/chart");

    expect(
      ui.dynamic!.resolveUriFromInput(
        { query: "anything", count: 10, country_code: "US", locale: "en-US" },
        {
          task_id: "t",
          status: "pending",
          message: "...",
          search_effort: "deep",
        },
      ),
    ).toBe("ui://tako/embed/chart");
  });
});
