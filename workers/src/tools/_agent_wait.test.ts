import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../django.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../django.js")>();
  return { ...actual, djangoGet: vi.fn(), djangoPost: vi.fn() };
});
import { DjangoHttpError, DjangoNotFoundError, djangoGet, djangoPost } from "../django.js";
import type { Env } from "../env.js";
import { projectAgentRun } from "./_agent_run.js";
import {
  AGENT_CALL_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  PROGRESS_MIN_INTERVAL_MS,
  readSseEnvelopes,
  waitForRun,
  type StreamEnvelope,
} from "./_agent_wait.js";
import type { ToolContext } from "./types.js";

const RUN = "r1";
const encoder = new TextEncoder();

type Step = { atMs: number; text: string };

function frame(block: Record<string, unknown>, threadId: string | null = "t1"): string {
  return `data: ${JSON.stringify({ seq: 1, run_id: RUN, thread_id: threadId, category: "x", block })}\n\n`;
}

function status(message: string): string {
  return frame({ kind: "status", message });
}

type Scripted = { stream: ReadableStream<Uint8Array>; cancel: ReturnType<typeof vi.fn> };

function scriptedStream(steps: Step[], closeAtMs?: number): Scripted {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cancelled = false;
      cancel.mockImplementation(() => {
        cancelled = true;
      });
      const enqueue = (text: string): void => {
        if (!cancelled) controller.enqueue(encoder.encode(text));
      };
      for (const step of steps) {
        if (step.atMs === 0) enqueue(step.text);
        else setTimeout(() => enqueue(step.text), step.atMs);
      }
      if (closeAtMs === 0) controller.close();
      else if (closeAtMs !== undefined) setTimeout(() => controller.close(), closeAtMs);
    },
    cancel,
  });
  return { stream, cancel };
}

function stubStream(scripted: Scripted): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(scripted.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeCtx(): ToolContext & { sendProgress: ReturnType<typeof vi.fn> } {
  return {
    token: "t",
    env: { DJANGO_BASE_URL: "https://trytako.com" } as Env,
    surface: "generic",
    caller: undefined,
    sendProgress: vi.fn(async () => {}),
  };
}

function progressMessages(ctx: { sendProgress: ReturnType<typeof vi.fn> }): string[] {
  return ctx.sendProgress.mock.calls.map((call) => (call[1] as { message: string }).message);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("waitForRun", () => {
  it("uses a 45 s window, a 1 s progress interval, and a 15 s heartbeat", () => {
    expect([AGENT_CALL_WINDOW_MS, PROGRESS_MIN_INTERVAL_MS, HEARTBEAT_INTERVAL_MS]).toEqual([
      45_000, 1_000, 15_000,
    ]);
  });

  it("returns terminal with the result as soon as run_summary arrives", async () => {
    const scripted = scriptedStream([
      { atMs: 0, text: status("Searching the company registry") },
      { atMs: 0, text: frame({ kind: "agent_result", id: "a1", data: { answer: "A", cards: [] } }) },
      {
        atMs: 0,
        text: frame({ kind: "run_summary", status: "completed", created_at: "x", error: null, usage: null }),
      },
    ]);
    const fetchMock = stubStream(scripted);
    const ctx = makeCtx();

    const outcome = await waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("A");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.thread_id).toBe("t1");
    expect((fetchMock.mock.calls[0]![0] as Request).url).toBe(
      "https://trytako.com/api/v1/agent/answer/runs/r1",
    );
    expect(djangoGet).not.toHaveBeenCalled();
    expect(scripted.cancel).toHaveBeenCalled();
  });

  it("carries a failed run's error and usage from run_summary", async () => {
    stubStream(
      scriptedStream([
        {
          atMs: 0,
          text: frame({
            kind: "run_summary",
            status: "failed",
            error: { code: "agent_error", message: "boom" },
            usage: { total_cost_usd: 0.5 },
          }),
        },
      ]),
    );

    const outcome = await waitForRun(makeCtx(), "company", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.error).toEqual({ code: "agent_error", message: "boom" });
    expect(outcome.run.usage?.total_cost_usd).toBe(0.5);
  });

  it("opens the company product's run path", async () => {
    const fetchMock = stubStream(
      scriptedStream([{ atMs: 0, text: frame({ kind: "run_summary", status: "failed" }) }]),
    );

    await waitForRun(makeCtx(), "company", RUN, { windowMs: AGENT_CALL_WINDOW_MS, createdAtMs: Date.now() });

    expect((fetchMock.mock.calls[0]![0] as Request).url).toBe(
      "https://trytako.com/api/v1/agent/company/runs/r1",
    );
  });

  it("relays status and tool_call status_message as throttled progress", async () => {
    stubStream(
      scriptedStream([
        { atMs: 0, text: status("Searching the company registry") },
        { atMs: 200, text: status("Building the list") },
      ]),
    );
    const ctx = makeCtx();
    const controller = new AbortController();
    const createdAtMs = Date.now() - 5_000;

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ctx.sendProgress).toHaveBeenCalledTimes(1);
    expect(ctx.sendProgress).toHaveBeenLastCalledWith(5, { message: "Searching the company registry" });

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.sendProgress).toHaveBeenCalledTimes(2);
    expect(ctx.sendProgress).toHaveBeenLastCalledWith(6, { message: "Building the list" });

    controller.abort();
    await pending;
  });

  it("relays only open tool calls with a status_message and ignores backend heartbeats", async () => {
    stubStream(
      scriptedStream([
        { atMs: 0, text: frame({ kind: "tool_call", id: "c1", tool: "x", status_message: "Reading filings", done: false }) },
        { atMs: 2_000, text: frame({ kind: "tool_call", id: "c1", tool: "x", status_message: "Finished filings", done: true }) },
        { atMs: 3_000, text: frame({ kind: "tool_call", id: "c2", tool: "x", status_message: null, done: false }) },
        { atMs: 4_000, text: frame({ kind: "heartbeat" }) },
        { atMs: 5_000, text: frame({ kind: "reasoning", text: "thinking" }) },
      ]),
    );
    const ctx = makeCtx();
    const controller = new AbortController();

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(progressMessages(ctx)).toEqual(["Reading filings"]);
    controller.abort();
    await pending;
  });

  it("sends a heartbeat after 15 s of silence", async () => {
    stubStream(scriptedStream([{ atMs: 0, text: status("Building the list") }]));
    const ctx = makeCtx();
    const controller = new AbortController();

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
    expect(ctx.sendProgress).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.sendProgress).toHaveBeenCalledTimes(2);
    const message = progressMessages(ctx)[1]!;
    expect(message).toMatch(/^Still working \(\d+ s\): /);
    expect(message).toBe("Still working (15 s): Building the list");

    controller.abort();
    await pending;
  });

  it("says starting in the heartbeat before any progress arrives", async () => {
    stubStream(scriptedStream([]));
    const ctx = makeCtx();
    const controller = new AbortController();

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now() - 30_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(progressMessages(ctx)).toEqual(["Still working (45 s): starting"]);
    controller.abort();
    await pending;
  });

  it("falls back to the JSON poll when the stream ends without run_summary", async () => {
    stubStream(scriptedStream([{ atMs: 0, text: status("Searching") }], 0));
    vi.mocked(djangoGet).mockResolvedValue({ status: "completed", result: { answer: "B" } });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await pending;

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("B");
    expect(projectAgentRun(outcome.run, "answer_run_1").answer).toBe("B");
    expect(vi.mocked(djangoGet).mock.calls[0]![2]).toBe("/api/v1/agent/answer/runs/r1");
  });

  it("keeps polling through the completion grace window when the poll still says running", async () => {
    stubStream(scriptedStream([], 0));
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: RUN, status: "running" })
      .mockResolvedValueOnce({ run_id: RUN, status: "completed", result: { answer: "C" } });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("C");
    expect(djangoGet).toHaveBeenCalledTimes(2);
  });

  it("falls back to the JSON poll when a completed run_summary arrives without an agent_result", async () => {
    stubStream(scriptedStream([{ atMs: 0, text: frame({ kind: "run_summary", status: "completed" }) }]));
    vi.mocked(djangoGet).mockResolvedValue({ status: "completed", result: { answer: "G" } });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await pending;

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(projectAgentRun(outcome.run, "answer_run_1").answer).toBe("G");
  });

  it("falls back to the JSON poll on a stream_reset", async () => {
    stubStream(scriptedStream([{ atMs: 0, text: frame({ kind: "stream_reset" }) }]));
    vi.mocked(djangoGet).mockResolvedValue({ status: "completed", result: { answer: "D" } });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await pending;

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("D");
  });

  it("falls back to the JSON poll when the stream errors", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(status("Searching")));
        setTimeout(() => controller.error(new Error("connection reset")), 100);
      },
    });
    stubStream({ stream, cancel: vi.fn() });
    vi.mocked(djangoGet).mockResolvedValue({ status: "completed", result: { answer: "E" } });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await pending;

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("E");
  });

  it("falls back to the JSON poll when the stream doesn't open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("bad gateway", { status: 502 })),
    );
    vi.mocked(djangoGet).mockResolvedValue({ status: "completed", result: { answer: "F" } });

    const outcome = await waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });

    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.run.result?.answer).toBe("F");
  });

  it("returns running instead of throwing when the fallback poll fails three times in a row", async () => {
    stubStream(scriptedStream([{ atMs: 0, text: status("Searching") }], 0));
    vi.mocked(djangoGet).mockRejectedValue(new Error("connection reset"));

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;

    expect(outcome).toEqual({ kind: "running", progress: "Searching", threadId: "t1" });
    expect(djangoGet).toHaveBeenCalledTimes(3);
  });

  it("throws DjangoNotFoundError when the poll finds no run", async () => {
    stubStream(scriptedStream([], 0));
    vi.mocked(djangoGet).mockRejectedValue(
      new DjangoNotFoundError({ path: "/api/v1/agent/answer/runs/r1", method: "GET" }),
    );

    const err = await waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DjangoNotFoundError);
  });

  it("throws DjangoNotFoundError when the run doesn't exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response('{"detail":"Not found."}', { status: 404 })),
    );

    const err = await waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect(djangoGet).not.toHaveBeenCalled();
  });

  it("throws a 403 from the poll instead of retrying it", async () => {
    stubStream(scriptedStream([], 0));
    vi.mocked(djangoGet).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/agent/answer/runs/r1",
        method: "GET",
        status: 403,
        body: "",
      }),
    );

    const err = await waitForRun(makeCtx(), "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DjangoHttpError);
    expect(djangoGet).toHaveBeenCalledTimes(1);
  });

  it("returns running with the last progress and thread_id when the window ends", async () => {
    const scripted = scriptedStream([{ atMs: 0, text: status("Building the list") }]);
    stubStream(scripted);
    const ctx = makeCtx();

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: 45_000,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    const outcome = await pending;

    expect(outcome).toEqual({ kind: "running", progress: "Building the list", threadId: "t1" });
    expect(djangoGet).not.toHaveBeenCalled();
    expect(scripted.cancel).toHaveBeenCalled();

    const sent = ctx.sendProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.sendProgress).toHaveBeenCalledTimes(sent);
  });

  it("returns running when the fallback poll still says running at the window's end", async () => {
    stubStream(scriptedStream([], 0));
    vi.mocked(djangoGet).mockResolvedValue({ run_id: RUN, status: "running", thread_id: "t9" });

    const pending = waitForRun(makeCtx(), "answer", RUN, {
      windowMs: 45_000,
      createdAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    const outcome = await pending;

    expect(outcome).toEqual({ kind: "running", threadId: "t9" });
    const polls = vi.mocked(djangoGet).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(djangoGet).toHaveBeenCalledTimes(polls);
  });

  it("stops on client abort and makes no further upstream request", async () => {
    const scripted = scriptedStream([
      { atMs: 0, text: status("Searching") },
      { atMs: 12_000, text: status("Too late") },
    ]);
    const fetchMock = stubStream(scripted);
    const ctx = makeCtx();
    const controller = new AbortController();

    const pending = waitForRun(ctx, "answer", RUN, {
      windowMs: AGENT_CALL_WINDOW_MS,
      createdAtMs: Date.now(),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ kind: "running", progress: "Searching", threadId: "t1" });
    expect(scripted.cancel).toHaveBeenCalled();
    const sent = ctx.sendProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(djangoPost).not.toHaveBeenCalled();
    expect(djangoGet).not.toHaveBeenCalled();
    expect(ctx.sendProgress).toHaveBeenCalledTimes(sent);
  });
});

describe("readSseEnvelopes", () => {
  async function collect(chunks: string[]): Promise<StreamEnvelope[]> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const out: StreamEnvelope[] = [];
    for await (const envelope of readSseEnvelopes(stream)) out.push(envelope);
    return out;
  }

  it("parses multi-line data frames and skips non-JSON frames", async () => {
    const envelopes = await collect([
      ": keep-alive comment\n\n",
      "id: 1\n",
      'data: {"seq": 1, "run_id": "r1",\n',
      'data: "block": {"kind": "status", "message": "hi"}}\n\n',
      "data: not json\n\n",
      'data: {"seq": 2, "run_id": "r1", "block": {"kind": "heartbeat"}}\n\n',
    ]);

    expect(envelopes.map((e) => e.block.kind)).toEqual(["status", "heartbeat"]);
    expect(envelopes[0]!.block.message).toBe("hi");
  });

  it("handles CRLF line endings and frames split across chunks", async () => {
    const envelopes = await collect([
      'data: {"run_id": "r1", "thread_id": "t1", "blo',
      'ck": {"kind": "status", "message": "a"}}\r',
      "\n\r\n",
      'data:{"run_id": "r1", "block": {"kind": "text"}}\r\r',
    ]);

    expect(envelopes.map((e) => e.block.kind)).toEqual(["status", "text"]);
    expect(envelopes[0]!.thread_id).toBe("t1");
  });

  it("skips JSON frames that aren't run envelopes", async () => {
    const envelopes = await collect([
      'data: {"run_id": "r1"}\n\n',
      "data: [1, 2]\n\n",
      'data: {"run_id": "r1", "block": {"kind": "status", "message": "ok"}}\n\n',
    ]);

    expect(envelopes.map((e) => e.block.kind)).toEqual(["status"]);
  });

  it("drops an unterminated final frame", async () => {
    const envelopes = await collect(['data: {"run_id": "r1", "block": {"kind": "status"}}']);

    expect(envelopes).toEqual([]);
  });
});
