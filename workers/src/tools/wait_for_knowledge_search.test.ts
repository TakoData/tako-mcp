/**
 * Tests for `wait_for_knowledge_search`. Mirrors `wait_for_report.test.ts`.
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
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "chatgpt",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("wait_for_knowledge_search input schema", () => {
  it("rejects max_wait_seconds above the 50 s ceiling", () => {
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
  it("returns results on first-poll COMPLETED, with no widget fields on the output", async () => {
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
    // Tool deliberately ships no widget fields — chart rendering
    // happens via a separate `open_chart_ui` call.
    expect((out as Record<string, unknown>).pub_id).toBeUndefined();
    expect((out as Record<string, unknown>).embed_url).toBeUndefined();
    expect((out as Record<string, unknown>).image_url).toBeUndefined();

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/v1/knowledge_search/async/status/");
    expect(url.searchParams.get("task_id")).toBe("t-1");
    expect(req.headers.get("X-API-Key")).toBe("sk-test");
  });

  it("treats lowercase 'completed' as terminal", async () => {
    vi.useFakeTimers();
    mockFetchSequence([
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
    expect(err).toBeInstanceOf(DjangoNotFoundError);
  });
});

describe("wait_for_knowledge_search timed_out branch", () => {
  it("returns timed_out=true with status + events_summary on budget exhaustion", async () => {
    // max_wait_seconds=20, intervals 5,7,8(clamped from 9):
    //   t=0 fetch #1 IN_PROGRESS(PLANNING) → sleep 5
    //   t=5 fetch #2 IN_PROGRESS(QUERYING) → sleep 7
    //   t=12 fetch #3 IN_PROGRESS         → sleep 8 (clamped)
    //   t=20 fetch #4 IN_PROGRESS         → break
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

    const start = Date.now();
    const promise = wait_for_knowledge_search.handler(
      { task_id: "t-long", max_wait_seconds: 20 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    const elapsed = Date.now() - start;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out.timed_out).toBe(true);
    expect(out.status).toBe("IN_PROGRESS");
    expect(out.events_summary).toMatch(/2 progress events.*last: QUERYING/);
    expect(out.results).toEqual([]);
    expect(elapsed).toBe(20_000);
  });
});
