import { describe, it, expect, vi } from "vitest";

vi.mock("../django.js", () => ({ djangoPost: vi.fn(), djangoGet: vi.fn() }));
import { djangoPost, djangoGet } from "../django.js";
import tool from "./tako_agent.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

describe("tako_agent", () => {
  it("dispatches a deep run, polls to completion, emits progress, returns the result", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_1", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_1", status: "running" })
      .mockResolvedValueOnce({ run_id: "run_1", status: "completed", result: { answer: "42", cards: [] } });

    const out = await tool.handler({ query: "analyze X" }, ctx);

    expect(tool.name).toBe("tako_agent");
    expect(vi.mocked(djangoPost).mock.calls[0][2]).toBe("/api/v1/agent/runs");
    expect(vi.mocked(djangoPost).mock.calls[0][3]).toMatchObject({ query: "analyze X", effort: "deep" });
    expect(ctx.sendProgress).toHaveBeenCalled();
    expect(out.status).toBe("completed");
    expect(out.result?.answer).toBe("42");
  });

  it("surfaces a failed run with its error", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_2", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_2", status: "failed", error: { code: "x", message: "boom" } });
    const out = await tool.handler({ query: "q" }, ctx);
    expect(out.status).toBe("failed");
    expect(out.error?.message).toBe("boom");
  });
});
