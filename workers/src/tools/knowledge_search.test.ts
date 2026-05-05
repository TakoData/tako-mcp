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

import { DjangoHttpError, DjangoNotFoundError } from "../django.js";
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
  client: "claude",
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

  it("translates Tako's 404 (no-results) on fast into an empty result and auto-escalates to deep", async () => {
    // Tako's `/api/v1/knowledge_search` returns HTTP 404 with
    // `RelevantResultsNotFoundError` when fast finds 0 cards (see
    // `app/backend/knowledge/api/ga/v1/knowledge_search/views.py`
    // ~line 607). The Worker's `runSearch` catches that
    // `DjangoNotFoundError` and returns an empty
    // `SyncSearchResponse` so the auto-escalation logic — which
    // keys on `cards.length === 0` — fires the same way it does
    // for a 200-with-empty-cards response. Without the
    // translation, the throw would escape the handler and surface
    // as a fatal `not_found` error, suppressing both this server-
    // side escalation AND the LLM-side
    // `start_deep_knowledge_search` directive on ChatGPT.
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchSequence([
        // 1: fast POST → 404 (Tako's "0 cards matched" signal)
        jsonResponse(404, {
          detail: "No relevant knowledge cards found",
          error_message: "No relevant knowledge cards found",
        }),
        // 2: deep POST → 202 async-task initiation
        jsonResponse(202, { task_id: "task-404-then-deep", status: "pending" }),
        // 3: status GET → COMPLETED with one card
        jsonResponse(200, {
          task_id: "task-404-then-deep",
          status: "COMPLETED",
          result: {
            outputs: {
              knowledge_cards: [
                {
                  card_id: "deep-after-404",
                  title: "Daily caloric supply per capita",
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
        { query: "daily caloric supply india china us", ...DEFAULTS },
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
      expect(out.results[0]?.card_id).toBe("deep-after-404");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty result on Tako 404 when caller forces fast (no auto-escalation, no throw)", async () => {
    // When the caller passes `search_effort: "fast"` explicitly,
    // auto-escalation is suppressed regardless of whether fast
    // returns 0 cards via 200 or 404. Either way the response
    // shape must be a clean empty result — never a thrown
    // `DjangoNotFoundError` — so ChatGPT's
    // `start_deep_knowledge_search` directive (keyed on 0 cards or
    // errors) has an unambiguous signal to trigger on.
    const fetchMock = mockFetchSequence([
      jsonResponse(404, { detail: "No relevant knowledge cards found" }),
    ]);

    const out = await knowledge_search.handler(
      {
        query: "obscure query with no matches",
        ...DEFAULTS,
        search_effort: "fast",
      },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(0);
    expect(out.results).toEqual([]);
  });

  it("throws an actionable redirect error when fast empty AND client is chatgpt", async () => {
    // Server-side auto-escalation is disabled on ChatGPT (the
    // single-tool deep path can't survive its 60 s host timeout).
    // Empirically, the model treats a clean `count: 0` reply as a
    // valid "no results" answer and falls back to training
    // knowledge instead of calling `start_deep_knowledge_search`
    // per the description directive. Throwing here surfaces the
    // empty case as an actionable tool error the model is much
    // less able to ignore. Same UA-based gate (`ctx.client ===
    // "chatgpt"`); Claude.ai's auto-escalation handles its empty
    // case server-side and never reaches this branch.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
    ]);
    const ctx: ToolContext = { ...CTX, client: "chatgpt" };

    await expect(
      knowledge_search.handler(
        { query: "thailand tourism gdp", ...DEFAULTS },
        ctx,
      ),
    ).rejects.toThrow(/start_deep_knowledge_search/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the same redirect when ChatGPT empty came via Tako 404", async () => {
    // The 404→empty translation in `runSearch` interacts with the
    // ChatGPT empty-result throw: a 404 from Tako should still
    // produce the actionable error on ChatGPT (not bubble as a
    // raw `DjangoNotFoundError`, which is the failure mode the
    // 404 translation was added to fix in the first place).
    const fetchMock = mockFetchSequence([
      jsonResponse(404, { detail: "No relevant knowledge cards found" }),
    ]);
    const ctx: ToolContext = { ...CTX, client: "chatgpt" };

    await expect(
      knowledge_search.handler(
        { query: "obscure metric with no coverage", ...DEFAULTS },
        ctx,
      ),
    ).rejects.toThrow(/start_deep_knowledge_search/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on explicit search_effort=deep when client is chatgpt", async () => {
    // Pointing the agent at `start_deep_knowledge_search` (registered
    // only on those clients) is more useful than letting the call
    // sit on a hopeless poll loop until the host times out.
    const ctx: ToolContext = { ...CTX, client: "chatgpt" };
    await expect(
      knowledge_search.handler(
        { query: "x", search_effort: "deep", ...DEFAULTS },
        ctx,
      ),
    ).rejects.toThrow(/start_deep_knowledge_search/);
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

  it("surfaces the underlying DjangoHttpError after exceeding the transient retry budget (3 consecutive 503s)", async () => {
    // `MAX_TRANSIENT_RETRIES` = 2, so the 3rd consecutive 503 must
    // surface the typed error instead of being swallowed indefinitely.
    // Locks `pollDeep`'s retry budget independently from the
    // `wait_for_knowledge_search` tool (which has its own polling
    // loop with different backoff).
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
      const err = await Promise.all([
        promise.catch((e) => e),
        vi.runAllTimersAsync(),
      ]).then(([e]) => e);

      expect(err).toBeInstanceOf(DjangoHttpError);
      expect((err as DjangoHttpError).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry the status GET on a 404 (terminal task-not-found)", async () => {
    // 404 means the task is gone — retrying won't bring it back.
    // Surface immediately as a `DjangoNotFoundError` rather than
    // burning the transient retry budget on a hopeless cause.
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
      const err = await Promise.all([
        promise.catch((e) => e),
        vi.runAllTimersAsync(),
      ]).then(([e]) => e);

      expect(err).toBeInstanceOf(DjangoNotFoundError);
      // Exactly the POST + the single 404 GET — no retry on the GET.
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
