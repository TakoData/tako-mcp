/**
 * Tests for `knowledge_search`.
 *
 * Single-tool flow with internal polling for the deep (Orca) path,
 * plus MCP `notifications/progress` emission so clients with
 * `resetTimeoutOnProgress: true` keep their per-tool-call timeout
 * fresh across the polling window.
 *
 * Locked properties:
 *   1. Default (no explicit `search_effort`) → call `fast` first.
 *   2. Empty `fast` result → escalate to `deep`; poll until completion.
 *   3. Non-empty `fast` result → no escalation.
 *   4. Explicit `search_effort: "fast"` → single call, no escalation.
 *   5. Explicit `search_effort: "deep"` → single POST + polling, no
 *      prior `fast`.
 *   6. Async-task POST response triggers polling against the status
 *      endpoint.
 *   7. `COMPLETED` status returns `result.outputs.knowledge_cards[]`.
 *   8. `FAILED` / `INTERRUPTED` status throws with the error message.
 *   9. Budget exhaustion throws a clear "did not complete" error.
 *  10. Schema rejects `medium` and `auto`.
 *  11. Default `count` is 10.
 *  12. Auto-chain widget fields populated when top card has `card_id`.
 *  13. Polling emits `notifications/progress` events with monotonic
 *      `progress` values when the request carries a `progressToken`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import knowledge_search, { __test_only__ } from "./knowledge_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const MAX_PENDING_POLLS =
  Math.ceil(__test_only__.POLL_BUDGET_MS / __test_only__.POLL_INTERVAL_MS) + 5;

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
};

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

describe("knowledge_search fast-first-deep-fallback", () => {
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

  it("does not escalate when fast returns at least one card", async () => {
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
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("abc");
  });

  it("retries with search_effort=deep when fast returns zero cards (auto-escalation)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        // 1: fast POST → empty
        jsonResponse(200, { outputs: { knowledge_cards: [] } }),
        // 2: deep POST → 202 async-task initiation
        jsonResponse(202, { task_id: "task-auto", status: "pending" }),
        // 3: status GET → COMPLETED with one card
        jsonResponse(200, {
          task_id: "task-auto",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "deep1",
                  title: "Thailand Tourism",
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
        { query: "thailand tourism gdp", ...DEFAULTS },
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
      expect(out.results[0]?.card_id).toBe("deep1");
    } finally {
      vi.useRealTimers();
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
    expect(out.count).toBe(0);
  });
});

describe("knowledge_search async-task polling", () => {
  it("polls once and returns cards when status is COMPLETED on first GET (explicit deep)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        jsonResponse(202, { task_id: "task-1", status: "pending" }),
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
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const postBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
      expect(postBody.search_effort).toBe("deep");

      const statusReq = requestFrom(fetchMock.mock.calls[1]);
      expect(statusReq.method).toBe("GET");
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
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("c-final");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats lowercase terminal status as terminal (case normalization)", async () => {
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
                  card_id: "lc",
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
      expect(out.results[0]?.card_id).toBe("lc");
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
      await expect(
        Promise.all([promise, vi.runAllTimersAsync()]),
      ).rejects.toThrow(/failed.*Orca pipeline blew up/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the status GET on a transient 5xx and recovers", async () => {
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

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(out.count).toBe(1);
      expect(out.results[0]?.card_id).toBe("after-retry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the budget is exhausted before the task terminates", async () => {
    vi.useFakeTimers();
    try {
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

  it("emits MCP progress notifications during polling with monotonically increasing progress values", async () => {
    // Lock the contract that's the whole point of going single-tool:
    // each poll iteration sends a `notifications/progress` event so
    // clients with `resetTimeoutOnProgress: true` keep their per-call
    // timeout alive across the deep-search wait.
    vi.useFakeTimers();
    try {
      const sendProgress = vi.fn<ToolContext["sendProgress"]>(async () => {});
      const ctx: ToolContext = { ...CTX, sendProgress };

      mockFetchSequence([
        jsonResponse(202, { task_id: "task-prog", status: "pending" }),
        jsonResponse(200, { task_id: "task-prog", status: "PENDING" }),
        jsonResponse(200, { task_id: "task-prog", status: "IN_PROGRESS" }),
        jsonResponse(200, {
          task_id: "task-prog",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "c-prog",
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
        ctx,
      );
      await vi.runAllTimersAsync();
      await promise;

      // Three polls (PENDING, IN_PROGRESS, COMPLETED) → three progress
      // events with progress=1, 2, 3.
      expect(sendProgress).toHaveBeenCalledTimes(3);
      const progressValues = sendProgress.mock.calls.map((c) => c[0]);
      expect(progressValues).toEqual([1, 2, 3]);
      // Each call must include a non-empty `message` so progress
      // shows something useful in clients that surface it.
      for (const call of sendProgress.mock.calls) {
        const opts = call[1];
        expect(typeof opts?.message).toBe("string");
        expect(opts?.message?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("knowledge_search auto-chain top-result chart fields", () => {
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

    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.image_url).toBeUndefined();
  });

  it("omits auto-chain widget fields when results are empty", async () => {
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
