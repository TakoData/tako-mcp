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
