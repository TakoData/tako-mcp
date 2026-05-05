/**
 * Tests for `wait_for_report`'s polling loop.
 *
 * Locks four properties:
 *   1. Returns immediately on terminal status (no extra sleep / GET).
 *   2. Polls through pending/running until it sees a terminal status.
 *   3. Returns `timed_out: true` with the latest snapshot when the
 *      `max_wait_seconds` budget elapses without a terminal status.
 *   4. The last sleep is clamped to the remaining budget — the loop
 *      doesn't overshoot the deadline.
 *
 * Uses `vi.useFakeTimers()` because the loop sleeps via `setTimeout`.
 * Same pattern as `knowledge_search.test.ts` — `runAllTimersAsync`
 * drains pending timers (advancing the mocked clock as it does) until
 * the handler stops scheduling new ones, which is exactly what we want
 * to exercise both the terminal-status and budget-exhausted exits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DjangoHttpError } from "../django.js";
import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import wait_for_report from "./wait_for_report.js";
import {
  jsonResponse,
  mockFetchOnce,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "claude",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("wait_for_report", () => {
  it("returns immediately on completed status with no sleep", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        title: "Q1 Tesla earnings",
        result: { sections: [{ heading: "summary", text: "..." }] },
      }),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_done", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("completed");
    expect(out.timed_out).toBe(false);
    expect(out.report_id).toBe("rep_done");
    expect(out.result).toEqual({
      sections: [{ heading: "summary", text: "..." }],
    });

    // webpage_url is constructed from PUBLIC_BASE_URL (or DJANGO_BASE_URL
    // fallback in tests) — Django's response value is ignored. The
    // ?from=library param is the canonical Library deep-link the web
    // app reads for source attribution.
    expect(out.webpage_url).toBe(
      "https://trytako.com/reports/rep_done?from=library",
    );

    // Hits the right endpoint with the bearer token.
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe(
      "/api/v1/internal/reports/rep_done/",
    );
    expect(req.headers.get("X-API-Key")).toBe("sk-test");
  });

  it("constructs webpage_url from PUBLIC_BASE_URL when set (overrides DJANGO_BASE_URL)", async () => {
    // Production wiring: web origin (tako.com) and API origin (trytako.com)
    // diverge. The report link must land on the web origin so the user's
    // browser actually renders the report page.
    vi.useFakeTimers();
    mockFetchSequence([
      jsonResponse(200, { id: "rep_pub", status: "completed" }),
    ]);

    const ctxWithPublicBase: ToolContext = {
      token: "sk-test",
      env: {
        DJANGO_BASE_URL: "https://trytako.com",
        PUBLIC_BASE_URL: "https://tako.com",
      },
      sendProgress: noopSendProgress,
      client: "claude",
    };

    const promise = wait_for_report.handler(
      { report_id: "rep_pub", max_wait_seconds: 50 },
      ctxWithPublicBase,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(out.webpage_url).toBe(
      "https://tako.com/reports/rep_pub?from=library",
    );
  });

  it("returns immediately on failed status without polling further", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_bad",
        status: "failed",
        error_message: "Celery worker crashed",
      }),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_bad", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("failed");
    expect(out.timed_out).toBe(false);
    expect(out.error_message).toBe("Celery worker crashed");
  });

  it("treats uppercase terminal status as terminal (case normalization)", async () => {
    // Defensive: the report endpoint historically returns lowercase, but
    // future backend changes shouldn't silently turn a terminal response
    // into an infinite loop. Mirrors the same normalization knowledge_search
    // applies for its async-task status field.
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { id: "rep_caps", status: "COMPLETED" }),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_caps", max_wait_seconds: 50 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.timed_out).toBe(false);
  });

  it("polls through pending/running until it sees completed", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { id: "rep_slow", status: "pending" }),
      jsonResponse(200, { id: "rep_slow", status: "running" }),
      jsonResponse(200, { id: "rep_slow", status: "running" }),
      jsonResponse(200, {
        id: "rep_slow",
        status: "completed",
        title: "Slow report",
        result: { sections: [] },
      }),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_slow", max_wait_seconds: 50 },
      CTX,
    );
    // Each iteration's setTimeout fires, the next GET runs, and the
    // next sleep is queued — until the COMPLETED response breaks the
    // loop and runAllTimersAsync drains.
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out.status).toBe("completed");
    expect(out.timed_out).toBe(false);
    expect(out.title).toBe("Slow report");
  });

  it("returns timed_out=true with the latest snapshot when the budget elapses", async () => {
    // Use a small budget so the test stays narrow but still exercises
    // the deadline-clamp logic (the last sleep should be clamped to
    // the remaining budget rather than the next backoff interval).
    //
    // With max_wait_seconds=20 and intervals 5,7,8(clamped from 9):
    //   t=0 fetch #1 (pending) → sleep 5s
    //   t=5 fetch #2 (running) → sleep 7s
    //   t=12 fetch #3 (running) → sleep 8s (clamped: remaining=8 < 9)
    //   t=20 fetch #4 (running) → remaining=0 → break, return timed_out
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { id: "rep_long", status: "pending", title: "Cooking" }),
      jsonResponse(200, { id: "rep_long", status: "running", title: "Cooking" }),
      jsonResponse(200, { id: "rep_long", status: "running", title: "Cooking" }),
      jsonResponse(200, {
        id: "rep_long",
        status: "running",
        title: "Cooking",
        runtime_seconds: 18,
      }),
    ]);

    const startMs = Date.now();
    const promise = wait_for_report.handler(
      { report_id: "rep_long", max_wait_seconds: 20 },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    const elapsed = Date.now() - startMs;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out.timed_out).toBe(true);
    // Latest snapshot fields propagate so the model can show the user
    // partial progress info even though no terminal status was hit.
    expect(out.status).toBe("running");
    expect(out.title).toBe("Cooking");
    expect(out.runtime_seconds).toBe(18);
    // Deadline clamp: total elapsed must be exactly the budget. If we
    // were sleeping past the deadline the elapsed time would be
    // 5+7+9 = 21s instead of 5+7+8 = 20s.
    expect(elapsed).toBe(20_000);
  });

  it("propagates DjangoHttpError from a failing poll", async () => {
    // The detail endpoint going 500 mid-wait should fail loud — the
    // user's report_id may have been deleted, the backend may be down,
    // either way an empty `timed_out: true` response would be
    // misleading. Surface the Django error so the MCP adapter
    // (`djangoErrorToToolResult`) returns a structured isError.
    mockFetchOnce(jsonResponse(500, { detail: "Internal Server Error" }));

    const err = await wait_for_report
      .handler(
        { report_id: "rep_500", max_wait_seconds: 50 },
        CTX,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(DjangoHttpError);
    expect((err as DjangoHttpError).status).toBe(500);
  });

  it("rejects max_wait_seconds above the ceiling at the schema boundary", async () => {
    // Zod's `.max(MAX_WAIT_CEILING_S)` is what guarantees the loop
    // never schedules a wait that would outlast the MCP client's
    // tool-call timeout. Verify the schema rejects oversize values
    // before any handler runs.
    const parse = wait_for_report.inputSchema.safeParse({
      report_id: "rep_x",
      max_wait_seconds: 120,
    });
    expect(parse.success).toBe(false);
  });

  it("defaults max_wait_seconds to the ceiling when omitted", async () => {
    // The model can call wait_for_report({ report_id }) without any
    // tuning and get the maximum-safe wait. Schema parse confirms.
    const parse = wait_for_report.inputSchema.safeParse({
      report_id: "rep_x",
    });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.max_wait_seconds).toBe(50);
    }
  });
});
