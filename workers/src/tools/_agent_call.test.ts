import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../django.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../django.js")>();
  return { ...actual, djangoGet: vi.fn(), djangoPost: vi.fn() };
});
vi.mock("./_agent_wait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_agent_wait.js")>();
  return { ...actual, waitForRun: vi.fn() };
});
import {
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoTimeoutError,
  djangoGet,
  djangoPost,
} from "../django.js";
import type { Env } from "../env.js";
import { AgentInputError } from "./_agent_product.js";
import { AGENT_CALL_WINDOW_MS, AgentWireDriftError, waitForRun } from "./_agent_wait.js";
import { runAgentCall } from "./_agent_call.js";
import { PNG_HEAD_FETCH_TIMEOUT_MS } from "./_chart_widget.js";
import type { ToolContext } from "./types.js";

const signal = new AbortController().signal;
const ctx: ToolContext = {
  token: "t",
  env: { DJANGO_BASE_URL: "https://trytako.com" } as Env,
  surface: "generic",
  caller: undefined,
  sendProgress: async () => {},
  signal,
};
const startBody = (): unknown => ({ query: "q" });
const CREATED_AT = "2026-10-22T12:00:00Z";

function httpError(status: number, body: string, method: "GET" | "POST" = "POST"): DjangoHttpError {
  return new DjangoHttpError({ path: "/api/v1/agent/answer/runs", method, status, body });
}

async function startError(
  product: "answer" | "company",
  err: Error,
  input: { query: string; thread_id?: string } = { query: "q" },
): Promise<Error & { modelGuidance?: string }> {
  vi.mocked(djangoPost).mockRejectedValue(err);
  return (await runAgentCall(ctx, product, input, startBody).catch((e: unknown) => e)) as Error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function resolveAfter<T>(delayMs: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

describe("runAgentCall", () => {
  it("rejects a call with both query and run_id", async () => {
    const err = await runAgentCall(
      ctx,
      "answer",
      { query: "q", run_id: "answer_run_r1" },
      startBody,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentInputError);
    expect((err as Error).message).toContain("exactly one of `query`");
    expect(djangoPost).not.toHaveBeenCalled();
    expect(djangoGet).not.toHaveBeenCalled();
  });

  it("rejects a call with neither query nor run_id", async () => {
    const err = await runAgentCall(ctx, "answer", {}, startBody).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentInputError);
    expect(djangoPost).not.toHaveBeenCalled();
  });

  it("starts a run and returns the prefixed run_id", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      run_id: "r1",
      thread_id: "t1",
      created_at: CREATED_AT,
    });
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running", progress: "Searching" });

    const out = await runAgentCall(ctx, "company", { query: "q" }, startBody);

    expect(out.status).toBe("running");
    expect(out.run_id).toBe("company_run_r1");
    expect(out.thread_id).toBeUndefined();
    expect(out.message).toContain("Searching");
    expect(vi.mocked(djangoPost).mock.calls[0]?.[2]).toBe("/api/v1/agent/company/runs");
    expect(vi.mocked(djangoPost).mock.calls[0]?.[3]).toEqual({ query: "q" });
    expect(waitForRun).toHaveBeenCalledWith(
      ctx,
      "company",
      "r1",
      expect.objectContaining({
        windowMs: AGENT_CALL_WINDOW_MS,
        createdAtMs: Date.parse(CREATED_AT),
        signal,
      }),
    );
  });

  it("counts the start request against the call window", async () => {
    vi.mocked(djangoPost).mockImplementation(() =>
      resolveAfter(20_000, { run_id: "r1", thread_id: "t1", created_at: CREATED_AT }),
    );
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running" });

    const pending = runAgentCall(ctx, "answer", { query: "q" }, startBody);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(vi.mocked(djangoPost).mock.calls[0]?.[4]?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(vi.mocked(waitForRun).mock.calls[0]?.[3]?.windowMs).toBe(AGENT_CALL_WINDOW_MS - 20_000);
  });

  it("counts the resume request against the call window", async () => {
    vi.mocked(djangoGet).mockImplementation(() =>
      resolveAfter(12_000, { run_id: "r1", status: "running", created_at: CREATED_AT }),
    );
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running" });

    const pending = runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(vi.mocked(djangoGet).mock.calls[0]?.[3]?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(vi.mocked(waitForRun).mock.calls[0]?.[3]?.windowMs).toBe(AGENT_CALL_WINDOW_MS - 12_000);
  });

  it("leaves the chart dimension read inside the call window on the chatgpt surface", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1", created_at: CREATED_AT });
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running" });

    await runAgentCall({ ...ctx, surface: "chatgpt" }, "answer", { query: "q" }, startBody);

    expect(vi.mocked(waitForRun).mock.calls[0]?.[3]?.windowMs).toBe(
      AGENT_CALL_WINDOW_MS - PNG_HEAD_FETCH_TIMEOUT_MS,
    );
  });

  it("falls back to the current time when created_at is missing", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1" });
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running" });
    const before = Date.now();

    await runAgentCall(ctx, "answer", { query: "q" }, startBody);

    const opts = vi.mocked(waitForRun).mock.calls[0]?.[3];
    expect(opts?.createdAtMs).toBeGreaterThanOrEqual(before);
  });

  it("returns the finished run when the wait ends terminal", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1", created_at: CREATED_AT });
    vi.mocked(waitForRun).mockResolvedValue({
      kind: "terminal",
      run: {
        run_id: "r1",
        thread_id: "t1",
        status: "completed",
        result: { answer: "42", cards: [], citations: [] },
      },
    });

    const out = await runAgentCall(ctx, "answer", { query: "q" }, startBody);

    expect(out.status).toBe("completed");
    expect(out.answer).toBe("42");
    expect(out.run_id).toBe("answer_run_r1");
  });

  it.each([
    ["answer", new Set(["tako_agent", "tako_search"]), true],
    ["answer", new Set(["tako_agent"]), false],
    ["company", new Set(["tako_company_agent", "tako_search"]), false],
  ] as const)(
    "names tako_search in %s refusal guidance only when it can serve the lookup (%#)",
    async (product, registeredTools, namesSearch) => {
      vi.mocked(djangoGet).mockResolvedValue({
        run_id: "r1",
        status: "completed",
        created_at: CREATED_AT,
        result: { answer: null, cards: [], citations: [], refusal_code: "rejected_input_classifier" },
      });

      const out = await runAgentCall(
        { ...ctx, registeredTools },
        product,
        { run_id: `${product}_run_r1` },
        startBody,
      );

      expect(out.guidance).toContain("rejected_input_classifier");
      expect(out.guidance?.includes("`tako_search`")).toBe(namesSearch);
    },
  );

  it("resumes a finished run without opening a stream", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "r1",
      thread_id: "t1",
      status: "completed",
      created_at: CREATED_AT,
      result: { answer: "done", cards: [], citations: [] },
    });

    const out = await runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody);

    expect(out.status).toBe("completed");
    expect(out.answer).toBe("done");
    expect(out.run_id).toBe("answer_run_r1");
    expect(waitForRun).not.toHaveBeenCalled();
    expect(djangoPost).not.toHaveBeenCalled();
    expect(vi.mocked(djangoGet).mock.calls[0]?.[2]).toBe("/api/v1/agent/answer/runs/r1");
  });

  it("resumes a live run by waiting on it", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "r1",
      thread_id: "t1",
      status: "running",
      created_at: CREATED_AT,
    });
    vi.mocked(waitForRun).mockResolvedValue({ kind: "running" });

    const out = await runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody);

    expect(out.status).toBe("running");
    expect(out.thread_id).toBeUndefined();
    expect(waitForRun).toHaveBeenCalledWith(
      ctx,
      "answer",
      "r1",
      expect.objectContaining({ createdAtMs: Date.parse(CREATED_AT), signal }),
    );
  });

  it("rejects a run_id with the other product's prefix", async () => {
    const err = await runAgentCall(ctx, "answer", { run_id: "company_run_r1" }, startBody).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AgentInputError);
    expect(djangoGet).not.toHaveBeenCalled();
  });

  it("maps a resume 404 to the run-not-found guidance", async () => {
    vi.mocked(djangoGet).mockRejectedValue(
      new DjangoNotFoundError({ path: "/api/v1/agent/company/runs/r1", method: "GET" }),
    );

    const err = (await runAgentCall(ctx, "company", { run_id: "company_run_r1" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoNotFoundError;

    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect(err.modelGuidance).toBe(
      "No run with that `run_id` for this account. Start a new run with `query`.",
    );
  });

  it("maps a resume 403 to the run-not-found guidance", async () => {
    const forbidden = httpError(403, "", "GET");
    vi.mocked(djangoGet).mockRejectedValue(forbidden);

    const err = (await runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;

    expect(err).toBe(forbidden);
    expect(err.modelGuidance).toBe(
      "No run with that `run_id` for this account. Start a new run with `query`.",
    );
  });

  it("maps a 403 thrown by the resume wait to the run-not-found guidance", async () => {
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "r1", status: "running" });
    vi.mocked(waitForRun).mockRejectedValue(httpError(403, "", "GET"));

    const err = (await runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;

    expect(err.modelGuidance).toContain("No run with that `run_id`");
  });

  it("maps a start 404 with thread_id to thread-not-found, not unavailable", async () => {
    const err = await startError(
      "company",
      new DjangoNotFoundError({ path: "/api/v1/agent/company/runs", method: "POST" }),
      { query: "q", thread_id: "t1" },
    );

    expect(err.modelGuidance).toBe(
      "Thread not found. Omit `thread_id` to start a new conversation.",
    );
  });

  it("maps a start 404 without thread_id on the company product to unavailable", async () => {
    const err = await startError(
      "company",
      new DjangoNotFoundError({ path: "/api/v1/agent/company/runs", method: "POST" }),
    );

    expect(err.modelGuidance).toBe("The company agent isn't available for this account.");
  });

  it("leaves a start 404 without thread_id on the answer product unchanged", async () => {
    const err = await startError(
      "answer",
      new DjangoNotFoundError({ path: "/api/v1/agent/answer/runs", method: "POST" }),
    );

    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect(err.modelGuidance).toBeUndefined();
  });

  it.each([
    new DjangoTimeoutError({ path: "/api/v1/agent/answer/runs", method: "POST", timeoutMs: 30_000 }),
    httpError(408, ""),
    httpError(502, ""),
    httpError(503, ""),
    httpError(504, ""),
  ])("asks before retrying a start that may have created a run (%#)", async (original) => {
    const err = await startError("answer", original);

    expect(err).toBe(original);
    expect(err.modelGuidance).toBe(
      "Tako didn't confirm that the run started, but it may have. Calling again with `query` can start and bill a second run, so ask the user before you retry.",
    );
  });

  it("leaves a start 429 to the shared retry guidance", async () => {
    const err = await startError("answer", httpError(429, ""));

    expect(err.modelGuidance).toBeUndefined();
  });

  it("maps a busy-thread 409 conflict to resume guidance", async () => {
    const err = await startError(
      "answer",
      httpError(409, JSON.stringify({ code: "conflict", message: "busy" })),
      { query: "q", thread_id: "t1" },
    );

    expect(err.modelGuidance).toBe(
      "A run is still going on this thread. Call this tool again with that run's `run_id` to keep waiting. If you don't have it, omit `thread_id` to start a new conversation.",
    );
  });

  it("keeps the run_id in the guidance when the wait throws a DjangoError", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1", created_at: CREATED_AT });
    const original = httpError(403, "", "GET");
    vi.mocked(waitForRun).mockRejectedValue(original);

    const err = (await runAgentCall(ctx, "answer", { query: "q" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;

    expect(err).toBe(original);
    expect(err.modelGuidance).toBe(
      "Run `answer_run_r1` started, but waiting on it failed. Call this tool again with run_id=`answer_run_r1`; don't start a new run.",
    );
  });

  it("keeps the run_id in the message when the wait throws a plain Error", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1", created_at: CREATED_AT });
    const original = new Error("unexpected shape");
    vi.mocked(waitForRun).mockRejectedValue(original);

    const err = (await runAgentCall(ctx, "answer", { query: "q" }, startBody).catch(
      (e: unknown) => e,
    )) as Error;

    expect(err.message).toContain("answer_run_r1");
    expect(err.message).toContain("don't start a new run");
    expect(err.cause).toBe(original);
  });

  it("doesn't tell the model to resume a run whose result fails its contract", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "r1", thread_id: "t1", created_at: CREATED_AT });
    const drift = new AgentWireDriftError("answer");
    vi.mocked(waitForRun).mockRejectedValue(drift);

    const err = await runAgentCall(ctx, "answer", { query: "q" }, startBody).catch((e: unknown) => e);

    expect(err).toBe(drift);
    expect((err as Error).message).not.toContain("Call this tool again");
  });

  it("tells the model a resume of a drifted finished run returns the same error", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "r1",
      thread_id: "t1",
      status: "completed",
      created_at: CREATED_AT,
      result: { answer: 42, cards: [], citations: [] },
    });

    const err = await runAgentCall(ctx, "answer", { run_id: "answer_run_r1" }, startBody).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AgentWireDriftError);
    expect((err as Error).message).toBe(
      "Tako returned a `tako_agent` run that this tool can't read. Calling again with the same `run_id` returns this error again, so tell the user the run's result isn't available.",
    );
  });

  it("maps effort_mismatch to the brief's copy", async () => {
    const err = await startError(
      "company",
      httpError(409, JSON.stringify({ code: "effort_mismatch", message: "x" })),
    );

    expect(err.modelGuidance).toBe(
      "This thread's effort is fixed. Omit `effort` to keep the thread's tier, or omit `thread_id` to start a new thread at a different effort.",
    );
  });

  it("maps source_indexes_mismatch on both products", async () => {
    for (const product of ["answer", "company"] as const) {
      const err = await startError(
        product,
        httpError(409, JSON.stringify({ code: "source_indexes_mismatch", message: "x" })),
      );

      expect(err.modelGuidance).toBe(
        "This thread's sources are fixed. Omit `sources` to keep them, or omit `thread_id` to start a new thread.",
      );
    }
  });

  it("maps thread_product_mismatch to the other tool's name when the connection registered it", async () => {
    const body = JSON.stringify({ code: "thread_product_mismatch", message: "x" });
    const registered = { ...ctx, registeredTools: new Set(["tako_agent", "tako_company_agent"]) };

    vi.mocked(djangoPost).mockRejectedValue(httpError(409, body));
    const fromAnswer = (await runAgentCall(registered, "answer", { query: "q" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;
    vi.mocked(djangoPost).mockRejectedValue(httpError(409, body));
    const fromCompany = (await runAgentCall(registered, "company", { query: "q" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;

    expect(fromAnswer.modelGuidance).toBe(
      "This thread belongs to `tako_company_agent`. Use that tool, or omit `thread_id`.",
    );
    expect(fromCompany.modelGuidance).toBe(
      "This thread belongs to `tako_agent`. Use that tool, or omit `thread_id`.",
    );
  });

  it("doesn't name the other agent tool when the connection didn't register it", async () => {
    const body = JSON.stringify({ code: "thread_product_mismatch", message: "x" });
    const answerOnly = { ...ctx, registeredTools: new Set(["tako_search", "tako_agent"]) };
    vi.mocked(djangoPost).mockRejectedValue(httpError(409, body));

    const err = (await runAgentCall(answerOnly, "answer", { query: "q" }, startBody).catch(
      (e: unknown) => e,
    )) as DjangoHttpError;
    const unknownRegistry = await startError("company", httpError(409, body));

    for (const guidance of [err.modelGuidance, unknownRegistry.modelGuidance]) {
      expect(guidance).toBe(
        "This thread belongs to a different agent. Omit `thread_id` to start a new conversation.",
      );
    }
  });

  it("leaves a 409 with an unparseable or unknown body unchanged", async () => {
    for (const body of ["<html>", "[]", "null", JSON.stringify({ code: "other" })]) {
      const original = httpError(409, body);

      const err = await startError("answer", original);

      expect(err).toBe(original);
      expect(err.modelGuidance).toBeUndefined();
    }
  });
});
