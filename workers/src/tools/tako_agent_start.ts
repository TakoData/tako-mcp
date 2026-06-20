/**
 * `tako_agent_start` — kick off a Tako deep agent run asynchronously and
 * return a `run_id` immediately.
 *
 * Registered ONLY on clients that don't honor MCP
 * `notifications/progress` for tool-call timeout extension (currently:
 * ChatGPT). On those clients the single-tool `tako_agent` path can't
 * survive the host's per-call timeout (~60 s), so we fall back to a
 * non-blocking kickoff plus a separate `tako_agent_wait` poll tool.
 *
 * On Claude.ai (which sends a `progressToken` and resets timeouts on
 * progress events), this tool is NOT registered — the single `tako_agent`
 * tool handles the full dispatch+poll in one call. See `mcp.ts`'s
 * `CHATGPT_ONLY_TOOL_NAMES` set.
 *
 * Wire path: POSTs to `/api/v1/agent/runs` with `effort: "deep"`.
 * Backend responds immediately with `{ run_id, status: "queued" }`.
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { dispatchAgentRun, inputSchema } from "./tako_agent.js";
import type { ToolModule } from "./types.js";

const outputSchema = z.object({
  run_id: z.string(),
  status: z.literal("queued"),
  message: z.string(),
});

type Output = z.infer<typeof outputSchema>;

const KICKOFF_MESSAGE =
  "Agent run dispatched. Agent runs typically take 30–90 seconds. Call `tako_agent_wait` with this `run_id` to check the status; loop until `status` is `completed` or `failed`.";

const tako_agent_start = {
  name: "tako_agent_start",
  description:
    "Kick off a Tako deep agent run and return immediately with a `run_id`. Use this for complex, multi-step data questions requiring transformations, aggregations, and multi-hop reasoning. The agent runs server-side for 30–90 s; this tool returns in <1 s with the run handle. **Workflow:** (1) tell the user the agent run is starting; (2) call `tako_agent_wait` with the `run_id` to poll for results, chaining calls until `status` is `completed` or `failed`.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Start Agent Run",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const runId = await dispatchAgentRun(ctx, input.query);
    return {
      run_id: runId,
      status: "queued",
      message: KICKOFF_MESSAGE,
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_agent_start;
