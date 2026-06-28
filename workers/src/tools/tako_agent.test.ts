import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../django.js", () => ({ djangoPost: vi.fn(), djangoGet: vi.fn() }));
import { djangoPost, djangoGet } from "../django.js";
import tool, { AGENT_POLL_BUDGET_MS, AGENT_WAIT_CEILING_S, buildAgentBody, pollAgentRun } from "./tako_agent.js";
import { AgentRunRequest } from "../generated/schemas.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("tako_agent", () => {
  it("dispatches a deep run, polls to completion, emits progress, returns the result", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_1", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_1", status: "running" })
      .mockResolvedValueOnce({ run_id: "run_1", status: "completed", result: { answer: "42", cards: [] } });

    const handlerPromise = tool.handler({ query: "analyze X", sources: ["data", "web"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    expect(tool.name).toBe("tako_agent");
    expect(vi.mocked(djangoPost).mock.calls[0]![2]).toBe("/api/v1/agent/runs");
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).toMatchObject({
      query: "analyze X",
      effort: "medium",
      source_indexes: ["data", "web"],
    });
    expect(ctx.sendProgress).toHaveBeenCalled();
    expect(out.status).toBe("completed");
    expect(out.timed_out).toBe(false);
    expect(out.result?.answer).toBe("42");
  });

  it("surfaces a failed run with its error", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_2", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_2", status: "failed", error: { code: "x", message: "boom" } });

    const handlerPromise = tool.handler({ query: "q", sources: ["tako"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    expect(out.status).toBe("failed");
    expect(out.timed_out).toBe(false);
    expect(out.error?.message).toBe("boom");
  });

  it("throws when the run never completes before AGENT_POLL_BUDGET_MS (Claude path)", async () => {
    vi.useFakeTimers();
    // Always return "running" — never completes
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_3", status: "running" });

    const pollPromise = pollAgentRun(ctx, "run_3", {
      budgetMs: AGENT_POLL_BUDGET_MS,
      onTimeout: "throw",
    });
    // Advance past the budget
    await vi.advanceTimersByTimeAsync(AGENT_POLL_BUDGET_MS + 10_000);
    await expect(pollPromise).rejects.toThrow(/did not complete within/);
  });

  it("returns timed_out:true with non-terminal status on wait-path deadline elapse", async () => {
    vi.useFakeTimers();
    // Always return "running"
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_4", status: "running" });

    const budgetMs = AGENT_WAIT_CEILING_S * 1000;
    const pollPromise = pollAgentRun(ctx, "run_4", {
      budgetMs,
      onTimeout: "return",
    });
    await vi.advanceTimersByTimeAsync(budgetMs + 10_000);
    const result = await pollPromise;

    expect(result.timed_out).toBe(true);
    expect(result.status).toBe("running");
  });
});

describe("tako_agent input schema", () => {
  it("defaults sources to both data and web (matches the backend default)", () => {
    const parsed = tool.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toEqual(["data", "web"]);
  });

  it("accepts web, data, and the legacy tako synonym", () => {
    expect(tool.inputSchema.parse({ query: "q", sources: ["web"] }).sources).toEqual(["web"]);
    expect(tool.inputSchema.parse({ query: "q", sources: ["data", "web"] }).sources).toEqual([
      "data",
      "web",
    ]);
    // "tako" is still accepted on input (folded onto "data" at the reshape).
    expect(tool.inputSchema.parse({ query: "q", sources: ["tako"] }).sources).toEqual(["tako"]);
  });

  it("rejects an empty sources array", () => {
    expect(() => tool.inputSchema.parse({ query: "q", sources: [] })).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => tool.inputSchema.parse({ query: "q", sources: ["bing"] })).toThrow();
  });
});

describe("tako_agent contract guards", () => {
  it("agent default sources mirror the backend (data+web)", () => {
    const parsed = tool.inputSchema.parse({ query: "compare cohorts" });
    expect(parsed.sources).toEqual(["data", "web"]);
  });

  it("folds the legacy \"tako\" synonym onto \"data\" in source_indexes", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x", sources: ["tako"] }));
    expect(body.source_indexes).toEqual(["data"]);
  });

  it("reshapes into a contract-valid agent request", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x" }));
    expect(() => AgentRunRequest.parse(body)).not.toThrow();
  });
});

describe("tako_agent wire-drift guard", () => {
  it("throws a contract-drift error when a completed run has no `result` field (e.g. backend renamed result→output)", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_drift", status: "queued" });
    // Simulate backend renaming `result` → `output`: `result` is absent on wire
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "run_drift",
      status: "completed",
      output: { answer: "42", cards: [] }, // wrong key — backend drift
    } as never);

    const handlerPromise = tool.handler({ query: "drift test", sources: ["tako"] }, ctx);
    await vi.runAllTimersAsync();
    await expect(handlerPromise).rejects.toThrow(/drifted from the backend contract.*result/);
  });

  it("throws a contract-drift error when run_id is missing from the wire", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_norun_id", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({
      status: "running",
      // run_id absent
    } as never);

    const handlerPromise = tool.handler({ query: "no run_id", sources: ["tako"] }, ctx);
    await vi.runAllTimersAsync();
    await expect(handlerPromise).rejects.toThrow(/drifted from the backend contract/);
  });

  it("tolerates in-flight (running) runs that lack a result field — no false-positive", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_inflight", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_inflight", status: "running" }) // no result — in-flight
      .mockResolvedValueOnce({ run_id: "run_inflight", status: "running" }) // still no result
      .mockResolvedValueOnce({ run_id: "run_inflight", status: "completed", result: { answer: "done", cards: [] } });

    const handlerPromise = tool.handler({ query: "in-flight test", sources: ["tako"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;
    expect(out.status).toBe("completed");
    expect(out.result?.answer).toBe("done");
  });

  it("tolerates queued runs that lack a result field — no false-positive", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_queued_inf", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_queued_inf", status: "queued" }) // no result, no created_at — bare queued response
      .mockResolvedValueOnce({ run_id: "run_queued_inf", status: "completed", result: null }); // completed with null result is fine

    const handlerPromise = tool.handler({ query: "queued test", sources: ["tako"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;
    expect(out.status).toBe("completed");
    expect(out.result).toBeNull();
  });
});
