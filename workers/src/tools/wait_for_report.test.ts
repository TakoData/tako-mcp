/**
 * Tests for `wait_for_report` covering both wait modes:
 *
 *   - Polling fallback (no `celery_task_id`, or stream errors): the
 *     legacy loop locked by the original four properties — terminal
 *     short-circuit, transition through pending/running, `timed_out:
 *     true` on budget exhaustion, deadline-clamped sleep.
 *   - SSE streaming (when `celery_task_id` is present): tool opens
 *     `/api/v1/agent/stream/{task_id}/`, forwards each activity
 *     envelope as a `notifications/progress` via `ctx.sendProgress`,
 *     and re-fetches the report detail once the stream ends.
 *
 * Polling tests use `vi.useFakeTimers()` (the loop sleeps via
 * `setTimeout`); streaming tests use real timers and a streaming
 * `Response` with a `ReadableStream` body that yields SSE-formatted
 * frames. Mocking is URL-aware via `mockFetchByUrl` so a single test
 * can stub the detail endpoint and the stream endpoint together.
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
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

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
        pdf_url: "https://exports.tako.com/r/rep_done.pdf",
        pptx_url: "https://exports.tako.com/r/rep_done.pptx",
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

    // Export URLs flatten — but webpage_url stays at top level (it's a
    // view link, not an export).
    expect(out.export_urls?.pdf_url).toBe(
      "https://exports.tako.com/r/rep_done.pdf",
    );
    expect(out.export_urls?.pptx_url).toBe(
      "https://exports.tako.com/r/rep_done.pptx",
    );
    expect(out.export_urls?.webpage_url).toBeUndefined();
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

  describe("SSE streaming path (celery_task_id present)", () => {
    it("opens the stream, emits a progress notification per activity envelope, and finishes via the final detail fetch", async () => {
      // Real timers — the streaming consumer reads from a
      // ReadableStream; fake timers would freeze the iterator.
      const messages: string[] = [];
      const ctxWithProgress: ToolContext = {
        ...CTX,
        async sendProgress({ message }) {
          if (message !== undefined) messages.push(message);
        },
      };

      const fetchMock = mockFetchByUrl({
        // First fetch: report still running, exposes the streaming task id.
        "/api/v1/internal/reports/rep_stream/": [
          jsonResponse(200, {
            id: "rep_stream",
            status: "running",
            celery_task_id: "task-uuid-1",
          }),
          // Final fetch after stream_done: report now completed.
          jsonResponse(200, {
            id: "rep_stream",
            status: "completed",
            title: "Streamed report",
            result: { sections: [{ heading: "ok", text: "done" }] },
          }),
        ],
        "/api/v1/agent/stream/task-uuid-1/": [
          sseResponse([
            sseFrame({
              seq: 1,
              task_id: "task-uuid-1",
              category: "activity",
              block: { kind: "status", message: "Searching knowledge graph" },
            }),
            sseFrame({
              seq: 2,
              task_id: "task-uuid-1",
              category: "activity",
              block: {
                kind: "tool_call",
                id: "tc1",
                tool: "knowledge_search",
                status_message: "Looking up Tesla data",
              },
            }),
            // Content blocks are intentionally not surfaced as
            // progress lines — they're report body fragments, not
            // activity breadcrumbs.
            sseFrame({
              seq: 3,
              task_id: "task-uuid-1",
              category: "content",
              block: {
                kind: "text",
                generation_id: 1,
                id: "t1",
                delta: "Q1 earnings ...",
              },
            }),
            sseFrame({
              seq: 4,
              task_id: "task-uuid-1",
              category: "control",
              block: { kind: "stream_done" },
            }),
          ]),
        ],
      });

      const out = await wait_for_report.handler(
        { report_id: "rep_stream", max_wait_seconds: 50 },
        ctxWithProgress,
      );

      // Two activity envelopes → two progress notifications, in order.
      // The status_message wins over the default "Calling tool…" line.
      expect(messages).toEqual([
        "Searching knowledge graph",
        "Looking up Tesla data",
      ]);

      // Two report-detail fetches (initial + final) plus one stream open.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const urls = fetchMock.mock.calls.map((call) =>
        new URL(requestFrom(call).url).pathname,
      );
      expect(urls).toEqual([
        "/api/v1/internal/reports/rep_stream/",
        "/api/v1/agent/stream/task-uuid-1/",
        "/api/v1/internal/reports/rep_stream/",
      ]);

      expect(out.status).toBe("completed");
      expect(out.timed_out).toBe(false);
      expect(out.title).toBe("Streamed report");
    });

    it("falls back to polling when the stream endpoint returns 404 (e.g. task not yet registered)", async () => {
      // 404 on the stream is the most likely transient failure: an
      // analyze call whose AsyncTaskStatus row hasn't propagated yet.
      // The tool should swallow the SSE error and continue with the
      // poll loop so the user still gets a final answer.
      vi.useFakeTimers();
      const fetchMock = mockFetchByUrl({
        "/api/v1/internal/reports/rep_404/": [
          jsonResponse(200, {
            id: "rep_404",
            status: "running",
            celery_task_id: "task-missing",
          }),
          jsonResponse(200, { id: "rep_404", status: "running" }),
          jsonResponse(200, { id: "rep_404", status: "completed", title: "ok" }),
        ],
        "/api/v1/agent/stream/task-missing/": [
          new Response("not found", { status: 404 }),
        ],
      });

      const promise = wait_for_report.handler(
        { report_id: "rep_404", max_wait_seconds: 50 },
        CTX,
      );
      await vi.runAllTimersAsync();
      const out = await promise;

      // Initial detail + stream attempt + (poll path: at least one
      // sleep + one detail fetch + terminal detail fetch). Only the
      // exact terminal sequence matters.
      expect(out.status).toBe("completed");
      expect(out.timed_out).toBe(false);
      // Stream was attempted exactly once.
      const streamCalls = fetchMock.mock.calls.filter((call) =>
        new URL(requestFrom(call).url).pathname.startsWith(
          "/api/v1/agent/stream/",
        ),
      );
      expect(streamCalls).toHaveLength(1);
    });

    it("skips the stream entirely when celery_task_id is missing, going straight to polling", async () => {
      vi.useFakeTimers();
      const fetchMock = mockFetchByUrl({
        "/api/v1/internal/reports/rep_no_task/": [
          // No celery_task_id field on the running snapshot.
          jsonResponse(200, { id: "rep_no_task", status: "running" }),
          jsonResponse(200, { id: "rep_no_task", status: "completed" }),
        ],
      });

      const promise = wait_for_report.handler(
        { report_id: "rep_no_task", max_wait_seconds: 50 },
        CTX,
      );
      await vi.runAllTimersAsync();
      const out = await promise;

      // Stream endpoint never called.
      const streamCalls = fetchMock.mock.calls.filter((call) =>
        new URL(requestFrom(call).url).pathname.startsWith(
          "/api/v1/agent/stream/",
        ),
      );
      expect(streamCalls).toHaveLength(0);
      expect(out.status).toBe("completed");
      expect(out.timed_out).toBe(false);
    });

    it("propagates DjangoUnauthorizedError from the very first detail fetch (not silently swallowed)", async () => {
      // A bad token surfacing from the *initial* detail fetch must
      // throw. The fallback-to-polling logic only catches errors
      // from the stream itself — auth errors hitting the detail
      // endpoint are real failures and should reach the MCP error
      // mapper.
      mockFetchOnce(jsonResponse(401, { detail: "invalid token" }));

      const err = await wait_for_report
        .handler({ report_id: "rep_401", max_wait_seconds: 50 }, CTX)
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      // DjangoUnauthorizedError extends DjangoError extends Error;
      // exact class is checked by other tests.
      expect((err as Error).name).toBe("DjangoUnauthorizedError");
    });
  });
});

/* ----------- streaming test helpers ----------- */

/** Build the wire form of one SSE frame from a JSON envelope. */
function sseFrame(envelope: object): string {
  return `data: ${JSON.stringify(envelope)}\n\n`;
}

/** Build a streaming `Response` whose body emits the given chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Stub `fetch` so each path matches against a queue of pre-built
 * `Response`s. Different from `mockFetchSequence` in that the same
 * test can stub two distinct endpoints (detail vs. stream) and not
 * care about the exact interleaving order — each path's responses are
 * consumed FIFO independently.
 */
function mockFetchByUrl(
  routes: Record<string, Response[]>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queues: Record<string, Response[]> = {};
  for (const [path, responses] of Object.entries(routes)) {
    queues[path] = [...responses];
  }
  const fn = vi.fn<typeof fetch>(async (input) => {
    const url =
      input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input)).pathname;
    const queue = queues[url];
    if (queue === undefined) {
      throw new Error(`mockFetchByUrl: no route configured for ${url}`);
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`mockFetchByUrl: queue exhausted for ${url}`);
    }
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
