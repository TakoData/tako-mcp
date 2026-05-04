/**
 * Tests for `wait_for_knowledge_search`.
 *
 * Mirrors `wait_for_report.test.ts`; locks the same five properties
 * plus the knowledge-search-specific ones (auto-chain widget fields
 * on COMPLETED, FAILED / INTERRUPTED throws, transient-5xx retry).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DjangoNotFoundError } from "../django.js";
import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import wait_for_knowledge_search from "./wait_for_knowledge_search.js";
import {
  jsonResponse,
  mockFetchOnce,
  mockFetchSequence,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("wait_for_knowledge_search input schema", () => {
  it("rejects max_wait_seconds above the 50s ceiling", () => {
    const parsed = wait_for_knowledge_search.inputSchema.safeParse({
      task_id: "t",
      max_wait_seconds: 120,
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults max_wait_seconds to the ceiling", () => {
    const parsed = wait_for_knowledge_search.inputSchema.safeParse({
      task_id: "t",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.max_wait_seconds).toBe(50);
  });
});

describe("wait_for_knowledge_search COMPLETED branch", () => {
  it("returns results + auto-chain widget fields on first-poll COMPLETED", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        task_id: "t-1",
        status: "COMPLETED",
        result: {
          outputs: {
            knowledge_cards: [
              {
                card_id: "card-1",
                title: "Inflation",
                description: null,
                url: null,
                source: null,
              },
            ],
          },
        },
      }),
    ]);

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-1", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.timed_out).toBe(false);
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("card-1");
    expect(out.pub_id).toBe("card-1");
    expect(out.embed_url).toContain("/embed/card-1/");
    expect(out.image_url).toContain("/api/v1/image/card-1/");
    expect(out.dark_mode).toBe(true);

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/v1/knowledge_search/async/status/");
    expect(url.searchParams.get("task_id")).toBe("t-1");
    expect(req.headers.get("X-API-Key")).toBe("sk-test");
  });

  it("treats lowercase 'completed' as terminal", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        task_id: "t-case",
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

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-case", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.timed_out).toBe(false);
    expect(out.count).toBe(1);
  });

  it("polls through PENDING / IN_PROGRESS until COMPLETED", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { task_id: "t-2", status: "PENDING" }),
      jsonResponse(200, { task_id: "t-2", status: "IN_PROGRESS" }),
      jsonResponse(200, {
        task_id: "t-2",
        status: "COMPLETED",
        result: {
          outputs: {
            knowledge_cards: [
              {
                card_id: "fin",
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

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-2", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.timed_out).toBe(false);
    expect(out.count).toBe(1);
  });
});

describe("wait_for_knowledge_search FAILED / INTERRUPTED branch", () => {
  it("throws with error + progress summary on FAILED", async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      jsonResponse(200, {
        task_id: "t-fail",
        status: "FAILED",
        error: "Orca pipeline blew up",
        events: [{ id: 0, data: { event_type: "PLANNING" } }],
      }),
    ]);

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-fail", max_wait_seconds: 50 },
      CTX,
    );
    await expect(
      Promise.all([promise, vi.runAllTimersAsync()]),
    ).rejects.toThrow(/failed.*Orca pipeline blew up/i);
  });

  it("throws on INTERRUPTED", async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      jsonResponse(200, { task_id: "t-int", status: "INTERRUPTED" }),
    ]);

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-int", max_wait_seconds: 50 },
      CTX,
    );
    await expect(
      Promise.all([promise, vi.runAllTimersAsync()]),
    ).rejects.toThrow(/interrupted/i);
  });
});

describe("wait_for_knowledge_search transient-failure handling", () => {
  it("retries 503 within the budget and recovers", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(503, { detail: "blip" }),
      jsonResponse(200, {
        task_id: "t-retry",
        status: "COMPLETED",
        result: {
          outputs: {
            knowledge_cards: [
              {
                card_id: "ok",
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

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-retry", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.timed_out).toBe(false);
    expect(out.count).toBe(1);
  });

  it("propagates 404 (no retry — terminal task-not-found)", async () => {
    mockFetchOnce(new Response("", { status: 404 }));

    const err = await wait_for_knowledge_search
      .handler({ task_id: "t-404", max_wait_seconds: 50 }, CTX)
      .catch((e) => e);

    // Django's 404 maps to its own typed subclass (DjangoNotFoundError);
    // 5xx + everything-else maps to DjangoHttpError. The point of the
    // test is that 404 is NOT swallowed by the transient-retry path.
    expect(err).toBeInstanceOf(DjangoNotFoundError);
  });

  it("surfaces error after exceeding the transient retry budget (3 consecutive 503s)", async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      jsonResponse(503, { detail: "1" }),
      jsonResponse(503, { detail: "2" }),
      jsonResponse(503, { detail: "3" }),
    ]);

    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-flap", max_wait_seconds: 50 },
      CTX,
    );
    await expect(
      Promise.all([promise, vi.runAllTimersAsync()]),
    ).rejects.toThrow(/Django returned 503/);
  });
});

describe("wait_for_knowledge_search timed_out branch", () => {
  it("returns timed_out=true with status + events_summary on budget exhaustion", async () => {
    // With max_wait_seconds=20 and intervals 5,7,8(clamped from 9):
    //   t=0  fetch #1 IN_PROGRESS (with PLANNING event) → sleep 5s
    //   t=5  fetch #2 IN_PROGRESS (QUERYING event)      → sleep 7s
    //   t=12 fetch #3 IN_PROGRESS                        → sleep 8s (clamped)
    //   t=20 fetch #4 IN_PROGRESS                        → remaining=0 → break
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        task_id: "t-long",
        status: "IN_PROGRESS",
        events: [{ id: 0, data: { event_type: "PLANNING" } }],
      }),
      jsonResponse(200, {
        task_id: "t-long",
        status: "IN_PROGRESS",
        events: [{ id: 1, data: { event_type: "QUERYING" } }],
      }),
      jsonResponse(200, { task_id: "t-long", status: "IN_PROGRESS" }),
      jsonResponse(200, { task_id: "t-long", status: "IN_PROGRESS" }),
    ]);

    const startMs = Date.now();
    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-long", max_wait_seconds: 20 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    const elapsed = Date.now() - startMs;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out.timed_out).toBe(true);
    expect(out.status).toBe("IN_PROGRESS");
    expect(out.events_summary).toMatch(/2 progress events.*last: QUERYING/);
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
    // Deadline clamp: total elapsed must be the budget exactly.
    expect(elapsed).toBe(20_000);
  });
});
