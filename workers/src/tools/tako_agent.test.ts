import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../django.js", () => ({ djangoPost: vi.fn(), djangoGet: vi.fn() }));
import { djangoPost, djangoGet } from "../django.js";
import tool, { AGENT_POLL_BUDGET_MS, buildAgentBody, pollAgentRun } from "./tako_agent.js";
import { refusalGuidance } from "./_agent_run.js";
import { AnswerAgentRunRequest } from "../generated/schemas.js";

const ctx = { token: "t", env: {} as never, surface: "generic" as const, sendProgress: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("tako_agent", () => {
  it("dispatches a deep run, polls to completion, returns the projected result", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_1", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_1", status: "running" })
      .mockResolvedValueOnce({
        run_id: "run_1",
        status: "completed",
        result: {
          answer: "42",
          cards: [
            {
              card_id: "agentcard",
              title: "Agent card",
              embed_url: "https://trytako.com/embed/agentcard/",
            },
          ],
          citations: [{ index: 1, title: "Source", url: "https://example.com" }],
        },
      });

    const handlerPromise = tool.handler({ query: "analyze X", sources: ["data", "web"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    expect(tool.name).toBe("tako_agent");
    expect(vi.mocked(djangoPost).mock.calls[0]![2]).toBe("/api/v1/agent/answer/runs");
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).toMatchObject({
      query: "analyze X",
      effort: "medium",
      source_indexes: ["data", "web"],
    });
    // No progress notification: the transport discards request-scoped
    // notifications under `enableJsonResponse: true` (TAKO-4485), so the loop
    // must not claim a channel that drops it.
    expect(ctx.sendProgress).not.toHaveBeenCalled();
    expect(out.answer).toBe("42");
    // Passthrough cards pick up the share opt-in — see withShareOptIn.
    expect(out.cards[0]?.embed_url).toBe("https://trytako.com/embed/agentcard/?showShare=true");
    // The Answer Agent's unified citation registry flows through (replacing the
    // generic agent's web_results).
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.index).toBe(1);
    // The lifecycle fields the old advertised shape was made of are GONE from
    // the model-facing result: `run_id` and `status` have no model reader and
    // no poll tool (see _agent_run.ts).
    expect(out).not.toHaveProperty("run_id");
    expect(out).not.toHaveProperty("status");
    expect(out).not.toHaveProperty("timed_out");
  });

  it("surfaces the Answer Agent metadata (definitions/assumptions/methodology) instead of dropping it", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_meta", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "run_meta",
      status: "completed",
      result: {
        answer: "a",
        cards: [],
        citations: [],
        metadata: {
          definitions: [{ term: "GDP", definition: "gross domestic product" }],
          assumptions: [{ title: "nominal", description: "not inflation-adjusted" }],
          methodology: [{ title: "sources", description: "world bank" }],
        },
      },
    });

    const handlerPromise = tool.handler({ query: "q", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    // Flattened to the `{name: text}` maps both channels render.
    expect(out.definitions).toEqual({ GDP: "gross domestic product" });
    expect(out.assumptions).toEqual({ nominal: "not inflation-adjusted" });
    expect(out.methodology).toEqual({ sources: "world bank" });
  });

  it("carries refusal_code through the wire parse into the one guidance branch", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_refusal", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "run_refusal",
      status: "completed",
      result: { answer: null, cards: [], citations: [], refusal_code: "rejected_input_classifier" },
    });

    const handlerPromise = tool.handler({ query: "q", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    // The regression this pins: `result` is a strict z.object, so dropping
    // `refusal_code` from it strips the field before projectAgentRun sees it,
    // and a query Tako rejected reaches the model as a completed run with no
    // answer and no reason. The other refusal tests call projectAgentRun or
    // refusalGuidance directly, so neither crosses the parse where it broke.
    expect(out.guidance).toBe(refusalGuidance("rejected_input_classifier"));
    expect(out.answer).toBeUndefined();
  });

  it("surfaces a failed run with its error", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_2", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_2", status: "failed", error: { code: "x", message: "boom" } });

    const handlerPromise = tool.handler({ query: "q", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;

    // A failed run is signalled by `error` alone now — `status` was a field
    // whose only two reachable values `error` already distinguished.
    expect(out.error).toEqual({ code: "x", message: "boom" });
    expect(out.answer).toBeUndefined();
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

    // A literal, not a shared constant: the only caller of `onTimeout:
    // "return"` was the deleted tako_agent_wait, so no production budget
    // corresponds to this path any more.
    const budgetMs = 40_000;
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

  it("accepts web and data", () => {
    expect(tool.inputSchema.parse({ query: "q", sources: ["web"] }).sources).toEqual(["web"]);
    expect(tool.inputSchema.parse({ query: "q", sources: ["data", "web"] }).sources).toEqual([
      "data",
      "web",
    ]);
  });

  it('rejects the retired "tako" source alias', () => {
    expect(tool.inputSchema.safeParse({ query: "q", sources: ["tako"] }).success).toBe(false);
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

  it("passes the sources array straight through to source_indexes", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x", sources: ["data"] }));
    expect(body.source_indexes).toEqual(["data"]);
  });

  it("reshapes into a contract-valid answer-agent request", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x" }));
    expect(() => AnswerAgentRunRequest.parse(body)).not.toThrow();
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

    const handlerPromise = tool.handler({ query: "drift test", sources: ["data"] }, ctx);
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

    const handlerPromise = tool.handler({ query: "no run_id", sources: ["data"] }, ctx);
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

    const handlerPromise = tool.handler({ query: "in-flight test", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;
    expect(out.answer).toBe("done");
  });

  it("tolerates queued runs that lack a result field — no false-positive", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_queued_inf", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_queued_inf", status: "queued" }) // no result, no created_at — bare queued response
      .mockResolvedValueOnce({ run_id: "run_queued_inf", status: "completed", result: null }); // completed with null result is fine

    const handlerPromise = tool.handler({ query: "queued test", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    const out = await handlerPromise;
    // A completed run with a null result projects to an empty-but-valid
    // result rather than a null the renderer would have to special-case.
    expect(out.answer).toBeUndefined();
    expect(out.cards).toEqual([]);
    expect(out.citations).toEqual([]);
  });

  it("throws a contract-drift error when a completed run's citation is missing the required `title`", async () => {
    vi.useFakeTimers();
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_cite_drift", status: "queued" });
    // `title` is required non-null on the generated AgentAnswerCitation, so a
    // title-less citation is backend drift. The result-shape guard must reject
    // the run rather than silently drop the field (citationSchema mirrors this).
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "run_cite_drift",
      status: "completed",
      result: { answer: "x", cards: [], citations: [{ index: 1 }] }, // title missing
    } as never);

    const handlerPromise = tool.handler({ query: "citation drift", sources: ["data"] }, ctx);
    await vi.runAllTimersAsync();
    await expect(handlerPromise).rejects.toThrow(/drifted from the backend contract.*result shape mismatch/);
  });
});
