/**
 * `tako_agent_wait` — poll a Tako agent run to completion and return the
 * result. Companion to `tako_agent_start`.
 *
 * Registered ONLY on clients that don't honor MCP
 * `notifications/progress` for tool-call timeout extension (currently:
 * ChatGPT). See `mcp.ts`'s `CHATGPT_ONLY_TOOL_NAMES` set and
 * `tako_agent_start` for the full rationale.
 *
 * Internally calls `pollAgentRun`, which polls `GET /api/v1/agent/runs/{run_id}`
 * with a 5 s interval until the run reaches `completed` or `failed`.
 * Agent runs are typically 30–90 s, so expect to chain several calls of
 * this tool (~12 calls maximum ≈ 10 minutes) before a terminal status.
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { type AgentRun, pollAgentRun } from "./tako_agent.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe("Run ID returned from `tako_agent_start`."),
});

const tako_agent_wait = {
  name: "tako_agent_wait",
  description:
    "Use this AFTER `tako_agent_start` returns a `run_id`. Polls the agent run until it reaches `completed` or `failed`. **On `completed`, the result contains a synthesized `answer` and supporting `cards`.** If the run hasn't finished, call this tool again with the same `run_id` — agent runs typically take 30–90 s. **CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes); after that, tell the user the agent is taking longer than usual.**",
  inputSchema,
  annotations: {
    title: "Tako: Wait for Agent Run",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<AgentRun> {
    return pollAgentRun(ctx, input.run_id);
  },
} satisfies ToolModule<typeof inputSchema, AgentRun>;

export default tako_agent_wait;
