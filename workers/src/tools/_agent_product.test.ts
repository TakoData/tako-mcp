import { describe, expect, it } from "vitest";

import {
  AgentInputError,
  runIdInputSchema,
  runsPath,
  toBackendRunId,
  toPublicRunId,
} from "./_agent_product.js";

describe("agent product table", () => {
  it("round-trips a backend id through the product prefix", () => {
    expect(toPublicRunId("company", "abc-123")).toBe("company_run_abc-123");
    expect(toBackendRunId("company", "company_run_abc-123")).toBe("abc-123");
  });

  it("rejects the other product's run_id and names the right tool", () => {
    const r = runIdInputSchema("answer").safeParse("company_run_abc");
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain("tako_company_agent");
  });

  it("toBackendRunId throws AgentInputError on a wrong prefix", () => {
    expect(() => toBackendRunId("answer", "company_run_x")).toThrow(
      AgentInputError,
    );
  });

  it("names the tool's prefix and the other tool in the wrong-prefix message", () => {
    const answer = runIdInputSchema("answer").safeParse("company_run_abc");
    const company = runIdInputSchema("company").safeParse("answer_run_abc");

    expect(answer.error!.issues.map((issue) => issue.message)).toEqual([
      "`tako_agent` takes a run_id that starts with `answer_run_`. A `company_run_` id belongs to `tako_company_agent`; call that tool instead.",
    ]);
    expect(company.error!.issues.map((issue) => issue.message)).toEqual([
      "`tako_company_agent` takes a run_id that starts with `company_run_`. A `answer_run_` id belongs to `tako_agent`; call that tool instead.",
    ]);
  });

  it("accepts a run_id this tool returned", () => {
    const publicRunId = toPublicRunId("answer", "3f2a9c1e-7b4d-4e8a-9c2f-1d0e5b6a7c8d");

    expect(runIdInputSchema("answer").safeParse(publicRunId).success).toBe(true);
    expect(toBackendRunId("answer", publicRunId)).toBe("3f2a9c1e-7b4d-4e8a-9c2f-1d0e5b6a7c8d");
  });

  it.each(["answer_run_", "answer_run_../x", "answer_run_../../company/runs/abc", "answer_run_abc?x=1"])(
    "rejects the malformed run_id %s in the schema and before any request",
    (runId) => {
      const parsed = runIdInputSchema("answer").safeParse(runId);

      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues[0]!.message).toContain("unchanged");
      expect(() => toBackendRunId("answer", runId)).toThrow(AgentInputError);
    },
  );

  it("builds the per-product runs path", () => {
    expect(runsPath("answer")).toBe("/api/v1/agent/answer/runs");
    expect(runsPath("company")).toBe("/api/v1/agent/company/runs");
  });
});
