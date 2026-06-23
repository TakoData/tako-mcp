/**
 * `tako_agent` — run Tako's deep data-pipeline agent (transformations,
 * aggregations, multi-hop reasoning). Wraps the Agent API:
 *   POST /api/v1/agent/runs            (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/runs/{run_id}   (poll until completed|failed)
 * Runs ~30-90s, so we poll and emit notifications/progress each iteration to
 * keep the per-call timeout fresh (clients with resetTimeoutOnProgress). For
 * ChatGPT (no progress support) a split tako_agent_start/tako_agent_wait pair
 * is registered instead (see mcp.ts).
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { djangoGet, djangoPost } from "../django.js";
import type { ToolContext, ToolModule } from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_TRANSIENT_ERRORS = 2;
export const AGENT_POLL_BUDGET_MS = 295_000;
// ChatGPT split (tako_agent_wait) per-call cap. Kept at 40 (not 50) so the
// worst case — a poll-GET that hangs the full AGENT_POLL_REQUEST_TIMEOUT_MS
// right at the deadline — still returns in ~40+15 = 55s, under ChatGPT's
// ~60s tool-call ceiling that the split exists to stay below.
export const AGENT_WAIT_CEILING_S = 40;
const AGENT_POLL_REQUEST_TIMEOUT_MS = 15_000;

const DESCRIPTION =
  "Run Tako's deep research agent for complex, multi-step data questions — transformations, aggregations, comparisons across many entities, and multi-hop reasoning that a single search/answer can't satisfy. Runs up to ~90s; returns a synthesized `answer` plus supporting Tako chart `cards`. Use `tako_search`/`tako_answer` for simple lookups; reach for this only when the question genuinely needs reasoning over multiple retrievals.";

export const inputSchema = z.object({
  query: z.string().min(1).describe("The deep/analytical question for the agent to work through."),
});

const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
  })
  .loose();

export const agentRunSchema = z.object({
  run_id: z.string(),
  // Mirrors the backend AgentRunStatus StrEnum exactly (api/ga/v1/agent/types.py)
  // — kept in lockstep on purpose. A new backend status must be added here too,
  // or the poll will reject the run as an "unexpected shape".
  status: z.enum(["queued", "running", "completed", "failed"]),
  timed_out: z.boolean().default(false),
  result: z
    .object({
      answer: z.string().nullable().optional(),
      cards: z.array(takoCardSchema).default([]),
      request_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
type AgentRunWire = {
  run_id?: string;
  status?: string;
  timed_out?: boolean;
  result?: unknown;
  error?: unknown;
};

/** Dispatch a deep agent run. Returns the run_id. */
export async function dispatchAgentRun(ctx: ToolContext, query: string): Promise<string> {
  const data = await djangoPost<AgentRunWire>(
    ctx.env,
    ctx.token,
    "/api/v1/agent/runs",
    { query, effort: "deep" },
    { timeoutMs: 30_000 },
  );
  if (!data.run_id) {
    throw new Error("Tako agent dispatch returned no run_id.");
  }
  return data.run_id;
}

/** Poll an agent run to a terminal state, emitting progress each iteration. */
export async function pollAgentRun(
  ctx: ToolContext,
  runId: string,
  opts: { budgetMs: number; onTimeout: "throw" | "return" },
): Promise<AgentRun> {
  const deadline = Date.now() + opts.budgetMs;
  let transient = 0;
  let pollCount = 0;
  let lastRun: AgentRun | undefined;

  while (true) {
    let wire: AgentRunWire;
    try {
      wire = await djangoGet<AgentRunWire>(ctx.env, ctx.token, `/api/v1/agent/runs/${runId}`, {
        timeoutMs: AGENT_POLL_REQUEST_TIMEOUT_MS,
      });
      transient = 0;
    } catch (err) {
      // Tolerate a couple of transient transport blips while the run continues.
      if (++transient > MAX_TRANSIENT_ERRORS) throw err;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const parsed = agentRunSchema.safeParse({
      run_id: wire.run_id ?? runId,
      status: wire.status ?? "running",
      timed_out: false,
      result: wire.result ?? null,
      error: wire.error ?? null,
    });
    if (!parsed.success) {
      throw new Error("Tako agent run endpoint returned an unexpected shape.");
    }
    lastRun = parsed.data;
    pollCount += 1; // MCP requires progress to strictly increase per token.
    await ctx.sendProgress(pollCount, { message: `Agent running… (${parsed.data.status})` });
    if (parsed.data.status === "completed" || parsed.data.status === "failed") {
      return { ...parsed.data, timed_out: false };
    }
    // Budget check: stop before the next poll would land past the deadline.
    // Worst case the loop still overruns budgetMs by up to
    // POLL_INTERVAL_MS + the per-GET request timeout (one in-flight GET that
    // started just under the deadline) — acceptable, and well under the MCP
    // client's tool-call ceiling.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      if (opts.onTimeout === "throw") {
        throw new Error(
          `Agent run ${runId} did not complete within ${Math.round(opts.budgetMs / 1000)}s.`,
        );
      }
      // onTimeout === "return": lastRun is always set here — the deadline
      // check only runs after a successful GET above assigned it.
      return { ...lastRun!, timed_out: true };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const takoAgent = {
  name: "tako_agent",
  description: DESCRIPTION,
  inputSchema,
  outputSchema: agentRunSchema,
  annotations: {
    title: "Tako: Deep Agent",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx): Promise<AgentRun> {
    const runId = await dispatchAgentRun(ctx, input.query);
    return pollAgentRun(ctx, runId, { budgetMs: AGENT_POLL_BUDGET_MS, onTimeout: "throw" });
  },
} satisfies ToolModule<typeof inputSchema, AgentRun>;

export default takoAgent;
