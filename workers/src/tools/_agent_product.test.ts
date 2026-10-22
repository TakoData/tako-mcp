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

  it("builds the per-product runs path", () => {
    expect(runsPath("answer")).toBe("/api/v1/agent/answer/runs");
    expect(runsPath("company")).toBe("/api/v1/agent/company/runs");
  });
});
