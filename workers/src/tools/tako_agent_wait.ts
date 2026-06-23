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
 * with a 5 s interval until the run reaches `completed` or `failed`, or until
 * `max_wait_seconds` elapses. If `timed_out` is true, call again with the same
 * `run_id` to continue polling — agent runs are typically 30–90 s.
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { AGENT_WAIT_CEILING_S, agentRunSchema, type AgentRun, pollAgentRun } from "./tako_agent.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe("Run ID returned from `tako_agent_start`."),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .max(AGENT_WAIT_CEILING_S)
    .default(AGENT_WAIT_CEILING_S)
    .describe(
      `How long this single call may block waiting for a terminal status. Capped at ${AGENT_WAIT_CEILING_S} s so the call always returns before the MCP client's tool-call timeout fires. If the run isn't done yet (\`timed_out: true\`), call this tool again with the same run_id — agent runs typically take 30–90 s, expect to chain a few calls.`,
    ),
});

const tako_agent_wait = {
  name: "tako_agent_wait",
  description:
    `Use this AFTER \`tako_agent_start\` returns a \`run_id\`. Polls the agent run until it reaches \`completed\` or \`failed\`, or until \`max_wait_seconds\` (default ${AGENT_WAIT_CEILING_S} s) elapses. **If \`timed_out\` is true, IMMEDIATELY call tako_agent_wait again with the same run_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting); after that, tell the user the agent is taking longer than usual and offer to retry.** On \`completed\`, the result contains a synthesized \`answer\` and supporting \`cards\`.`,
  inputSchema,
  outputSchema: agentRunSchema,
  annotations: {
    title: "Tako: Wait for Agent Run",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx): Promise<AgentRun> {
    return pollAgentRun(ctx, input.run_id, {
      budgetMs: input.max_wait_seconds * 1000,
      onTimeout: "return",
    });
  },
} satisfies ToolModule<typeof inputSchema, AgentRun>;

export default tako_agent_wait;
