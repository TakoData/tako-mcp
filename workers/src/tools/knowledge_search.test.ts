/**
 * Tests for `knowledge_search` covering the fast-first-deep-fallback
 * behavior AND the async-task polling that backs deep mode (TAKO-2686).
 *
 * Observed on staging: `search_effort="deep"` returns
 * `202 {task_id, status: "pending"}` and the cards land asynchronously
 * on `GET /api/v1/knowledge_search/async/status/?task_id=<id>` once the
 * task reaches `COMPLETED`. The tool defaults to `fast` (sync, lexical,
 * cheap) and only escalates to `deep` when `fast` returns zero cards.
 *
 * Locked properties:
 *   1. Default (no explicit `search_effort`) → call `fast` first.
 *   2. Empty `fast` result → retry with `deep`; poll until completion.
 *   3. Non-empty `fast` result → no retry.
 *   4. Explicit `deep` → single POST + polling loop, no prior `fast`.
 *   5. Async POST response (`{task_id}`) triggers polling against the
 *      status endpoint.
 *   6. `COMPLETED` status returns `result.outputs.knowledge_cards[]`.
 *   7. `FAILED` / `INTERRUPTED` status throws with the error message.
 *   8. Budget exhaustion throws a clear "did not complete" error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import knowledge_search, { __test_only__ } from "./knowledge_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchOnce,
  mockFetchSequence,
  requestFrom,
} from "./__test_helpers.js";

// Mock-response counts scale with the polling budget so changing
// `POLL_BUDGET_MS` doesn't silently make the budget-exhaustion test stop
// covering the budget exhaustion (would just run out of mocked GETs and
// throw a different error). +5 buffer covers the rounding + the
// budget-check-before-sleep edge.
const MAX_PENDING_POLLS =
  Math.ceil(__test_only__.POLL_BUDGET_MS / __test_only__.POLL_INTERVAL_MS) + 5;

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

// Handler input type includes the zod-defaulted fields (count, country_code,
// locale) because `.default(...)` makes them non-optional after parse. Tests
// call `handler` directly (bypassing zod), so we spread these defaults in.
const DEFAULTS = { count: 5, country_code: "US", locale: "en-US" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("knowledge_search fast-first-deep-fallback", () => {
  it("defaults to search_effort=fast on the initial call", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "abc", title: "Gold", description: "d", url: null, source: null },
          ],
        },
      }),
    ]);

    await knowledge_search.handler({ query: "gold price", ...DEFAULTS }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("fast");
  });

  it("does not retry when fast returns at least one card", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "abc", title: "Gold", description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "gold price", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("abc");
  });

  it("retries with search_effort=deep when fast returns zero cards", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "deep1", title: "Thailand Tourism", description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "thailand tourism gdp", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    const secondBody = await bodyOf(requestFrom(fetchMock.mock.calls[1]));
    expect(firstBody.search_effort).toBe("fast");
    expect(secondBody.search_effort).toBe("deep");
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("deep1");
  });

  it("returns the empty fast result (no retry) when caller forces search_effort=fast", async () => {
    // Explicit `fast` is a "don't burn credits on deep" signal — respect it
    // even on empty results.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
    ]);

    const out = await knowledge_search.handler(
      { query: "obscure", search_effort: "fast", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(0);
  });

  it("makes a single deep call when caller passes search_effort=deep", async () => {
    // Explicit `deep` skips the fast pre-call. Backend may still respond
    // synchronously (e.g. against test fixtures); the polling path is
    // covered by the async-task suite below.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "d", title: null, description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    await knowledge_search.handler(
      { query: "gold price", search_effort: "deep", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("deep");
  });
});

describe("knowledge_search async-task polling (TAKO-2686)", () => {
  // All tests in this suite use vi's fake timers because the polling loop
  // sleeps via `setTimeout(... POLL_INTERVAL_MS)` between status GETs.
  // Real timers would make every test wait seconds; fake timers let us
  // collapse the wall-clock cost while still exercising the loop.
  it("polls once and returns cards when status is COMPLETED on first GET", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        // POST response — async-task initiation.
        jsonResponse(202, { task_id: "task-1", status: "pending" }),
        // First GET to the status endpoint already terminal.
        jsonResponse(200, {
          task_id: "task-1",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "deep1",
                  title: "US GDP",
                  description: null,
                  url: null,
                  source: null,
                },
              ],
            },
          },
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "us gdp", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      // Drain any pending timers + microtasks (no actual sleep happens
      // because the first GET is already terminal).
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const postBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
      expect(postBody.search_effort).toBe("deep");

      const statusReq = requestFrom(fetchMock.mock.calls[1]);
      expect(statusReq.method).toBe("GET");
      // The polling endpoint should carry the task_id as a query param.
      const statusUrl = new URL(statusReq.url);
      expect(statusUrl.pathname).toBe("/api/v1/knowledge_search/async/status/");
      expect(statusUrl.searchParams.get("task_id")).toBe("task-1");

      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("deep1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls through PENDING and IN_PROGRESS until COMPLETED", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        jsonResponse(202, { task_id: "task-2", status: "pending" }),
        jsonResponse(200, { task_id: "task-2", status: "PENDING" }),
        jsonResponse(200, { task_id: "task-2", status: "IN_PROGRESS" }),
        jsonResponse(200, {
          task_id: "task-2",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "c-final",
                  title: null,
                  description: null,
                  url: null,
                  source: null,
                },
              ],
            },
          },
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "slow query", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      // runAllTimersAsync drains pending timers in order; each iteration's
      // setTimeout for the inter-poll sleep fires, the next GET runs, and
      // the next sleep is queued — until the COMPLETED response breaks
      // the loop.
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(4); // POST + 3 GETs
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("c-final");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats lowercase terminal status from GET as terminal (case normalization)", async () => {
    // Backend casing has historically drifted between the 202 POST
    // ("pending") and subsequent GETs ("PENDING" / "COMPLETED" / …).
    // The polling loop normalizes via toUpperCase() so a future
    // standardization on lowercase doesn't silently turn a terminal
    // response into an infinite loop until budget exhausts.
    vi.useFakeTimers();
    try {
      mockFetchSequence([
        jsonResponse(202, { task_id: "task-case", status: "pending" }),
        jsonResponse(200, {
          task_id: "task-case",
          status: "completed",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "lowercase-ok",
                  title: null,
                  description: null,
                  url: null,
                  source: null,
                },
              ],
            },
          },
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("lowercase-ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws with the error message when status is FAILED", async () => {
    vi.useFakeTimers();
    try {
      mockFetchSequence([
        jsonResponse(202, { task_id: "task-3", status: "pending" }),
        jsonResponse(200, {
          task_id: "task-3",
          status: "FAILED",
          error: "Orca pipeline blew up",
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      // Need to both run timers AND surface the rejection. Pattern: kick
      // off the promise, drain timers (which lets the FAILED branch
      // throw), then assert.
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/failed.*Orca pipeline blew up/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the status GET on a transient 5xx and recovers", async () => {
    // Transient transport blips against the status endpoint (Django
    // restart, LB hiccup) shouldn't kill a polling loop whose underlying
    // Celery task is still running. The first GET fails 503, the loop
    // sleeps one interval, and the second GET succeeds with cards.
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        jsonResponse(202, { task_id: "task-retry", status: "pending" }),
        jsonResponse(503, { detail: "Service Unavailable" }),
        jsonResponse(200, {
          task_id: "task-retry",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "after-retry",
                  title: null,
                  description: null,
                  url: null,
                  source: null,
                },
              ],
            },
          },
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(3); // POST + 503 + 200
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("after-retry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the error when transient failures exceed the retry budget", async () => {
    // MAX_TRANSIENT_RETRIES = 2, so after the 2nd retry is consumed the
    // 3rd consecutive failure must throw the underlying DjangoHttpError
    // instead of swallowing it indefinitely.
    vi.useFakeTimers();
    try {
      mockFetchSequence([
        jsonResponse(202, { task_id: "task-flap", status: "pending" }),
        jsonResponse(503, { detail: "blip 1" }),
        jsonResponse(503, { detail: "blip 2" }),
        jsonResponse(503, { detail: "blip 3" }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/Django returned 503/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry the status GET on a 404 (terminal task-not-found)", async () => {
    // 404 means the task is gone — retrying won't bring it back. Surface
    // the DjangoNotFoundError immediately instead of burning the retry
    // budget on a hopeless cause.
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        jsonResponse(202, { task_id: "task-404", status: "pending" }),
        new Response("", { status: 404 }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/404/);
      expect(fetchMock).toHaveBeenCalledTimes(2); // POST + single 404, no retry
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the budget is exhausted before the task terminates", async () => {
    vi.useFakeTimers();
    try {
      // POST + `MAX_PENDING_POLLS` IN_PROGRESS responses — that's
      // `ceil(POLL_BUDGET_MS / POLL_INTERVAL_MS) + 5`, enough to outlast
      // the budget regardless of how those constants are tuned.
      const responses: Response[] = [
        jsonResponse(202, { task_id: "task-4", status: "pending" }),
      ];
      for (let i = 0; i < MAX_PENDING_POLLS; i++) {
        responses.push(
          jsonResponse(200, { task_id: "task-4", status: "IN_PROGRESS" }),
        );
      }
      mockFetchSequence(responses);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/did not complete within/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accumulates progress events across polls and surfaces them in the timeout error", async () => {
    vi.useFakeTimers();
    try {
      // Status responses with growing event_log entries. The backend's
      // `since_index` filter means each subsequent response only includes
      // events newer than what we've already seen — we mimic that by
      // returning incrementally-different `events[]` slices.
      const responses: Response[] = [
        jsonResponse(202, { task_id: "task-progress", status: "pending" }),
      ];
      // Poll 1 → IN_PROGRESS with one PLANNING event.
      responses.push(
        jsonResponse(200, {
          task_id: "task-progress",
          status: "IN_PROGRESS",
          events: [{ id: 0, data: { event_type: "PLANNING" } }],
        }),
      );
      // Poll 2 → IN_PROGRESS, one new QUERYING event.
      responses.push(
        jsonResponse(200, {
          task_id: "task-progress",
          status: "IN_PROGRESS",
          events: [{ id: 1, data: { event_type: "QUERYING" } }],
        }),
      );
      // Subsequent polls keep returning IN_PROGRESS with no new events
      // (we already have them via since_index) until budget exhausted.
      for (let i = 0; i < MAX_PENDING_POLLS; i++) {
        responses.push(
          jsonResponse(200, {
            task_id: "task-progress",
            status: "IN_PROGRESS",
            events: [],
          }),
        );
      }
      mockFetchSequence(responses);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      // Error message should mention 2 events and the most recent type
      // (QUERYING) — proves both accumulation and the latest-event pick.
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/2 progress events.*last: QUERYING/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates 404 from the status endpoint as a typed Django error", async () => {
    vi.useFakeTimers();
    try {
      mockFetchSequence([
        jsonResponse(202, { task_id: "task-5", status: "pending" }),
        // Status endpoint says the task doesn't exist (e.g. Django GC'd
        // it). djangoGet maps 404 to DjangoNotFoundError.
        new Response("", { status: 404 }),
      ]);

      const promise = knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        CTX,
      );
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/404/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-escalation falls through to async polling when fast returns empty", async () => {
    // Mirrors the omitted-search_effort path: fast first, then deep. The
    // deep call now hits the async branch and polls.
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        // 1: fast POST (sync, empty)
        jsonResponse(200, { outputs: { knowledge_cards: [] } }),
        // 2: deep POST (async-task initiation)
        jsonResponse(202, { task_id: "task-6", status: "pending" }),
        // 3: deep status GET (immediately COMPLETED with cards)
        jsonResponse(200, {
          task_id: "task-6",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "auto-deep",
                  title: null,
                  description: null,
                  url: null,
                  source: null,
                },
              ],
            },
          },
        }),
      ]);

      const promise = knowledge_search.handler(
        { query: "obscure thing", ...DEFAULTS },
        CTX,
      );
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const fastBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
      const deepBody = await bodyOf(requestFrom(fetchMock.mock.calls[1]));
      expect(fastBody.search_effort).toBe("fast");
      expect(deepBody.search_effort).toBe("deep");
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("auto-deep");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Minimal valid PNG bytes for `parsePngDimensions` — signature + IHDR
// length prefix + IHDR type + width (900) + height (720). Just enough
// bytes to pass the byteLength >= 24 + signature checks and parse
// dimensions. Real Tako chart PNGs are 50-300 KB; we don't need
// realism here, just a header that the parser accepts.
const MINIMAL_VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length = 13
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x03, 0x84, // width = 900
  0x00, 0x00, 0x02, 0xd0, // height = 720
]);

function pngResponse(bytes: Uint8Array, contentType = "image/png"): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

// Output shape with the auto-chain fields populated, used as input to
// extraMeta / extraContentBlocks tests. Mirrors what the handler
// produces when results[0].card_id exists.
function autoChainOutput(): {
  results: Array<{
    card_id: string | null;
    title: string | null;
    description: string | null;
    url: string | null;
    source: string | null;
  }>;
  count: number;
  pub_id: string;
  embed_url: string;
  image_url: string;
  dark_mode: boolean;
  width: number;
  height: number;
} {
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
    image_url: "https://staging.trytako.com/api/v1/image/top-1/?dark_mode=true",
    dark_mode: true,
    width: 900,
    height: 720,
  };
}

describe("knowledge_search auto-chain top-result chart fields", () => {
  // Handler-side: when the top card has a card_id, the handler lifts
  // pub_id / embed_url / image_url / dark_mode / width / height to the
  // output root so the chart widget can read them with the same key
  // paths it uses for `open_chart_ui`. This is what makes the auto-chain
  // observable to the host's widget bundle without a second tool call.

  it("lifts top card's pub_id, embed_url, image_url, and chart defaults to the output root when top card has card_id", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "aapl-price",
              title: "AAPL Stock Price",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "AAPL stock price", ...DEFAULTS },
      CTX,
    );

    expect(out.pub_id).toBe("aapl-price");
    expect(out.embed_url).toBe(
      "https://staging.trytako.com/embed/aapl-price/?theme=dark",
    );
    expect(out.image_url).toBe(
      "https://staging.trytako.com/api/v1/image/aapl-price/?dark_mode=true",
    );
    // Defaults match `open_chart_ui` so a follow-up explicit render
    // produces a visually identical chart.
    expect(out.dark_mode).toBe(true);
    expect(out.width).toBe(900);
    expect(out.height).toBe(720);
  });

  it("uses the FIRST card with a card_id when multiple are returned (top-only auto-render)", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "first",
              title: "First",
              description: null,
              url: null,
              source: null,
            },
            {
              card_id: "second",
              title: "Second",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "anything", ...DEFAULTS },
      CTX,
    );

    expect(out.pub_id).toBe("first");
    expect(out.embed_url).toContain("/embed/first/");
    expect(out.results).toHaveLength(2);
  });

  it("omits chart fields when no card has a card_id", async () => {
    // Edge case: knowledge_cards came back but every card_id is null
    // (rare metadata-only result). No chart to render — output stays
    // text-only.
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

    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
    expect(out.results).toHaveLength(1);
  });

  it("omits chart fields when results are empty", async () => {
    // Caller forced `fast` and got nothing — no top card, no auto-render.
    // (Implicit fast→deep escalation is covered elsewhere; here we just
    // verify the no-results branch.)
    mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
    ]);

    const out = await knowledge_search.handler(
      { query: "obscure", search_effort: "fast", ...DEFAULTS },
      CTX,
    );

    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.results).toEqual([]);
  });
});

describe("knowledge_search extraMeta", () => {
  // `extraMeta` ships the top chart's PNG as a `data:` URI on `_meta`
  // (kept off the LLM's context window) along with the source PNG's
  // natural pixel dimensions. The widget reads these for the
  // image-baked render path on hosts whose CSP rejects cross-origin
  // imgs (claude.ai). All failure modes degrade silently to undefined
  // so the tool call still resolves — the widget falls through to its
  // existing `image_url` path.

  it("inlines the PNG as a data:image URI and parses its natural dimensions when image_url is present", async () => {
    mockFetchOnce(pngResponse(MINIMAL_VALID_PNG));

    const meta = await knowledge_search.extraMeta!(autoChainOutput(), CTX);

    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      image_natural_width: 900,
      image_natural_height: 720,
    });
    expect((meta as { image_data_url: string }).image_data_url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("returns undefined when the output has no image_url (no top card to render)", async () => {
    // No top card → handler omits image_url → extraMeta has nothing
    // to fetch. Must NOT call fetch — a stray fetch with `undefined`
    // URL would throw.
    const meta = await knowledge_search.extraMeta!(
      {
        results: [],
        count: 0,
      } as unknown as Parameters<typeof knowledge_search.extraMeta>[0],
      CTX,
    );

    expect(meta).toBeUndefined();
  });

  it("returns undefined when the PNG endpoint fails (silent degradation, no exception)", async () => {
    mockFetchOnce(new Response("not found", { status: 404 }));

    const meta = await knowledge_search.extraMeta!(autoChainOutput(), CTX);

    expect(meta).toBeUndefined();
  });
});

describe("knowledge_search extraContentBlocks", () => {
  // `extraContentBlocks` runs only when the widget is suppressed (the
  // skip-when-ui-set rule in mcp.ts). On those hosts we emit the chart
  // as a native MCP image block so the user still sees it inline
  // without a click-to-load gate.

  it("returns one image content block with the top chart's PNG when image_url is present", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFetchOnce(pngResponse(png));

    const blocks = await knowledge_search.extraContentBlocks!(
      autoChainOutput(),
      CTX,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("returns [] when the output has no image_url (no top card to render)", async () => {
    const blocks = await knowledge_search.extraContentBlocks!(
      {
        results: [],
        count: 0,
      } as unknown as Parameters<
        typeof knowledge_search.extraContentBlocks
      >[0],
      CTX,
    );

    expect(blocks).toEqual([]);
  });

  it("returns [] when the PNG endpoint fails (silent degradation)", async () => {
    mockFetchOnce(new Response("not found", { status: 404 }));

    const blocks = await knowledge_search.extraContentBlocks!(
      autoChainOutput(),
      CTX,
    );

    expect(blocks).toEqual([]);
  });
});

describe("knowledge_search appUiResource", () => {
  // `knowledge_search` shares the chart widget bundle with
  // `open_chart_ui` — same URI, same HTML. mcp.ts dedupes the
  // duplicate registration so the SDK doesn't throw `Resource ... is
  // already registered`. The dynamic resolver differs: knowledge_search
  // reads the pub_id from the handler's *output* (results[0].card_id)
  // because its input is a query, not a pub_id.

  it("registers the same widget URI as open_chart_ui (so both tools share one bundle)", () => {
    const ui = knowledge_search.appUiResource!(ENV);
    expect(ui.uri).toBe("ui://tako/embed/chart");
    expect(ui.name).toBe("open_chart_ui_widget");
    // CSP allow-list pinned to env's web base, same as open_chart_ui.
    expect(ui.frameDomains).toEqual(["https://staging.trytako.com"]);
  });

  it("dynamic.resolveUriFromInput reads pub_id from output.pub_id (not input)", () => {
    const ui = knowledge_search.appUiResource!(ENV);
    const uri = ui.dynamic!.resolveUriFromInput(
      { query: "anything", count: 5, country_code: "US", locale: "en-US" },
      autoChainOutput(),
    );
    expect(uri).toBe("ui://tako/embed/chart/top-1");
  });

  it("dynamic.resolveUriFromInput falls back to the static URI when output has no pub_id", () => {
    // Called pre-handler-result (e.g. test-time validation, or a tool
    // call that produced no top card) — must not throw, must return a
    // URI that resolves to a registered resource.
    const ui = knowledge_search.appUiResource!(ENV);
    const uri = ui.dynamic!.resolveUriFromInput(
      { query: "anything", count: 5, country_code: "US", locale: "en-US" },
      undefined,
    );
    expect(uri).toBe("ui://tako/embed/chart");
  });

  it("dynamic.resolveUriFromInput URL-encodes the pub_id", () => {
    const ui = knowledge_search.appUiResource!(ENV);
    const uri = ui.dynamic!.resolveUriFromInput(
      { query: "anything", count: 5, country_code: "US", locale: "en-US" },
      { ...autoChainOutput(), pub_id: "weird/id with space" },
    );
    expect(uri).toBe(
      "ui://tako/embed/chart/weird%2Fid%20with%20space",
    );
  });
});
