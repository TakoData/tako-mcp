/**
 * `tako_agent_wait` — poll a Tako agent run to completion and return the
 * result. Companion to `tako_agent_start`.
 *
 * Registered ONLY on clients that don't honor MCP
 * `notifications/progress` for tool-call timeout extension (currently:
 * ChatGPT). See `_surface.ts`'s `CHATGPT_ONLY_TOOL_NAMES` set and
 * `tako_agent_start` for the full rationale.
 *
 * Internally calls `pollAgentRun`, which polls
 * `GET /api/v1/agent/answer/runs/{run_id}` (Tako's Answer Agent) with a 5 s
 * interval until the run reaches `completed` or `failed`, or until
 * `max_wait_seconds` elapses. If `timed_out` is true, call again with the same
 * `run_id` to continue polling — agent runs are typically 30–90 s.
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import {
  agentRunSlimOutputShape,
  renderAgentRunMarkdown,
  slimAgentRunStructured,
  type AgentRunLike,
} from "./_render_markdown.js";
import { AGENT_WAIT_CEILING_S, type AgentRun, pollAgentRun } from "./tako_agent.js";
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
  description: [
    "Poll an agent run from `tako_agent_start`. Blocks until `status` is `completed` or `failed`, or until `max_wait_seconds` (default " +
      AGENT_WAIT_CEILING_S +
      "s).",
    "",
    "If `timed_out` is true, call this tool again with the same `run_id` — don't reply to the user mid-poll. Cap the chain at ~12 calls (~10 min), then tell the user it's taking long and offer to retry.",
    "",
    "On `completed`: the result holds the synthesized `answer` and `cards`.",
  ].join("\n"),
  inputSchema,
  // Advertised schema = the slim lifecycle shape; the result rides as
  // rendered markdown (renderText below). Mirrors tako_agent.
  outputSchema: agentRunSlimOutputShape,
  annotations: {
    title: "Tako: Wait for Agent Run",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Polling an existing run creates nothing — read-only on both
    // readings; only `openWorldHint` diverges (Apps review reads it as
    // "publishes/mutates public state"). See `annotationsBySurface` in
    // types.ts.
    chatgpt: { openWorldHint: false },
  },
  async handler(input, ctx): Promise<AgentRun> {
    return pollAgentRun(ctx, input.run_id, {
      budgetMs: input.max_wait_seconds * 1000,
      onTimeout: "return",
    });
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAgentRunMarkdown(output as unknown as AgentRunLike);
  },
  slimStructured(output) {
    return slimAgentRunStructured(output as unknown as AgentRunLike);
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof agentRunSlimOutputShape>>;

export default tako_agent_wait;
