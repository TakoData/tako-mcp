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
 * Wire path: POSTs to `/api/v1/agent/runs` with `effort: "medium"`.
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
    "Kick off a Tako deep research agent run and return immediately with a `run_id`. Use this for questions that require *figuring something out* rather than retrieving a known value — cohort resolution, ranking or filtering a set by criteria, multi-step aggregation, and multi-hop reasoning across many entities (use `tako_search` / `tako_answer` for a specific, known thing). **Uses both Tako and the live web by default — pass `sources` to narrow to one.** The agent runs server-side (typically ~30–90s); this tool returns in <1s with the run handle. **Workflow:** (1) tell the user the agent run is starting; (2) call `tako_agent_wait` with the `run_id` to poll for results, chaining calls until `status` is `completed` or `failed`.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Start Agent Run",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx): Promise<Output> {
    const runId = await dispatchAgentRun(ctx, input.query, input.sources, input.thread_id);
    return {
      run_id: runId,
      status: "queued",
      message: KICKOFF_MESSAGE,
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_agent_start;
