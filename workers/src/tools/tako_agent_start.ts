/**
 * `tako_agent_start` — kick off a Tako Answer Agent run asynchronously and
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
 * tool handles the full dispatch+poll in one call. See `_surface.ts`'s
 * `CHATGPT_ONLY_TOOL_NAMES` set.
 *
 * Wire path: POSTs to `/api/v1/agent/answer/runs` with `effort: "medium"`
 * (Tako's Answer Agent). Backend responds immediately with
 * `{ run_id, status: "queued" }`.
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
  description: [
    "Start a Tako Answer Agent run; returns a `run_id` immediately (the agent runs ~30–90s server-side).",
    "",
    "Best for: open-ended questions that need figuring out — cohorts, ranking or filtering, multi-step reasoning. For a known value use `tako_search` / `tako_answer`.",
    "",
    "Workflow: tell the user it's starting, then call `tako_agent_wait` with the `run_id`; repeat until `status` is `completed` or `failed`.",
  ].join("\n"),
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Start Agent Run",
    // Read-only under the MCP reading: the run only computes an answer;
    // the queued-run record (`run_id`/`thread_id`) is server bookkeeping,
    // not a mutation of the user's environment. Credit debits never flip
    // the hint — every Tako tool, reads included, debits credits.
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  annotationsByClient: {
    // Apps review draws the write line at "creates a durable,
    // user-addressable resource" — enqueueing a server-side run reachable
    // later via `run_id` qualifies, so ChatGPT sees this as a
    // non-destructive write. See `annotationsByClient` in types.ts.
    chatgpt: { readOnlyHint: false, openWorldHint: false },
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
