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
import { AgentResult as AgentResultContract, AgentRun as AgentRunContract, AgentRunRequest } from "../generated/schemas.js";
import { webResultSchema } from "./_search_results.js";
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
  "Run Tako's deep research agent for questions that require *figuring something out* rather than retrieving a known value — resolving a cohort (\"which companies match…\"), ranking or filtering a set by criteria, multi-step aggregation or transformation, and multi-hop reasoning across many entities that a single search/answer can't satisfy. Returns a synthesized `answer` plus supporting Tako chart `cards`. Use `tako_search` / `tako_answer` for a specific, known thing (a value, a time series, a direct comparison of two named entities); reach for the agent when the question's *shape* needs reasoning over multiple retrievals. **Uses both Tako's connected data and the live web by default — pass `sources` to narrow to one (`[\"data\"]` or `[\"web\"]`).** (Runs server-side, typically ~30–90s.)";

export const inputSchema = z.object({
  query: z.string().min(1).describe("The deep/analytical question for the agent to work through."),
  sources: z
    .array(z.enum(["data", "web", "tako"]))
    .min(1)
    .default(["data", "web"])
    .describe(
      'Which source(s) the agent may use. Defaults to both Tako data and the web (["data","web"]); pass ["data"] for connected data only, or ["web"] for open-web search only. ("tako" is accepted as a legacy synonym for "data".)',
    ),
  thread_id: z
    .uuid()
    .optional()
    .describe(
      "Optional thread ID (a UUID from a prior agent run's `thread_id`) to continue that conversation as a follow-up. Omit to start a new thread.",
    ),
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
  // Surfaced so the caller can pass it back as `thread_id` to ask a follow-up
  // in the same conversation.
  thread_id: z.string().nullable().optional(),
  // Mirrors the backend AgentRunStatus StrEnum exactly (api/ga/v1/agent/types.py)
  // — kept in lockstep on purpose. A new backend status must be added here too,
  // or the poll will reject the run as an "unexpected shape".
  status: z.enum(["queued", "running", "completed", "failed"]),
  timed_out: z.boolean().default(false),
  result: z
    .object({
      answer: z.string().nullable().optional(),
      cards: z.array(takoCardSchema).default([]),
      // Web sources backing the answer, carrying the 1-based citation_number
      // that the answer's [N] markers map to. Dropping these loses all web
      // citations, so they are captured here.
      web_results: z.array(webResultSchema).default([]),
      request_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
type AgentRunWire = {
  run_id?: string;
  thread_id?: string | null;
  status?: string;
  timed_out?: boolean;
  result?: unknown;
  error?: unknown;
};

type AgentInput = z.infer<typeof inputSchema>;

/**
 * Reshape the flat MCP input into the backend's AgentRunRequest body.
 * Exported for the contract-guard test.
 *
 * The MCP flat `sources` array maps to the backend's `source_indexes` field
 * (a rename). The legacy `"tako"` synonym is folded onto the canonical `"data"`
 * here so the body matches the generated enum (["data","web"]). The `satisfies`
 * annotation is the build-time guard: if the backend request contract changes
 * (new required field, renamed key, changed enum), this line fails to compile.
 *
 * Parity note: the generated AgentRunRequest has `source_indexes` as optional
 * (the backend defaults to ["data","web"] when absent), but we always send it
 * explicitly to keep the MCP behaviour predictable regardless of backend
 * defaults.
 */
export function buildAgentBody(input: AgentInput): z.input<typeof AgentRunRequest> {
  const body: z.input<typeof AgentRunRequest> = {
    query: input.query,
    source_indexes: input.sources.map((s) => (s === "tako" ? "data" : s)),
    effort: "medium",
  };
  if (input.thread_id !== undefined) body.thread_id = input.thread_id;
  return body satisfies z.input<typeof AgentRunRequest>; // ← build-time guard: backend request drift breaks here
}

/** Dispatch a deep agent run. Returns the run_id. */
export async function dispatchAgentRun(
  ctx: ToolContext,
  query: string,
  sources: Array<"data" | "web" | "tako">,
  threadId?: string,
): Promise<string> {
  // AgentRunRequest (api/ga/v1/agent/types.py) takes a flat `source_indexes`
  // list (defaults to ["tako","web"] server-side, mirrored by the schema
  // default here). `effort` only accepts "medium" today (AgentEffortLevel) —
  // the sole supported public level; add others here as the backend gains them.
  // `thread_id`, when provided, continues a prior run's conversation.
  const body = buildAgentBody({ query, sources, thread_id: threadId });
  const data = await djangoPost<AgentRunWire>(
    ctx.env,
    ctx.token,
    "/api/v1/agent/runs",
    body,
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
    // Wire-contract guard: validate the raw GET response against the generated
    // AgentRun contract before mapping into the normalised MCP output shape.
    //
    // Parity decision (Path 2): the generated AgentRun requires `created_at`
    // and `object` fields that the poll wire may omit for in-flight runs, and
    // it lacks the MCP-synthetic `timed_out` field the split tools depend on.
    // The hand-authored `agentRunSchema` therefore remains the tool's advertised
    // output shape. We use the generated contract as a structural guard that
    // catches backend drift — renamed/missing fields that would otherwise be
    // silently swallowed by the `wire.field ?? fallback` mapping below.
    //
    // Guard scope:
    //   • run_id / status  — always required; absence → drift error.
    //   • result           — when status is "completed", the field MUST be
    //                        present (not renamed away) and, if non-null, MUST
    //                        structurally match AgentResult from the generated
    //                        contract. For in-flight (queued/running) runs,
    //                        result is legitimately absent; no check is applied.
    //   • created_at / object / timed_out — tolerated as absent (metadata
    //                        fields the poll wire may omit; timed_out is MCP-
    //                        synthetic and does not appear in the backend schema).
    const lifecycleGuard = AgentRunContract.pick({ run_id: true, status: true }).safeParse(wire);
    if (!lifecycleGuard.success) {
      throw new Error(
        `Agent run wire drifted from the backend contract: ${lifecycleGuard.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`,
      );
    }
    // Terminal-state result guard: a completed run must carry a `result` field.
    // If the backend renames `result` → `output` (or similar), `wire.result`
    // becomes undefined here and the mapping below would silently return null —
    // masking the drift entirely. We catch that case explicitly.
    if (wire.status === "completed") {
      if (wire.result === undefined) {
        throw new Error(
          "Agent run wire drifted from the backend contract: completed run is missing the `result` field.",
        );
      }
      if (wire.result !== null) {
        const resultGuard = AgentResultContract.safeParse(wire.result);
        if (!resultGuard.success) {
          throw new Error(
            `Agent run wire drifted from the backend contract: result shape mismatch — ${resultGuard.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`,
          );
        }
      }
    }
    const parsed = agentRunSchema.safeParse({
      run_id: wire.run_id ?? runId,
      thread_id: wire.thread_id ?? null,
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
    const runId = await dispatchAgentRun(ctx, input.query, input.sources, input.thread_id);
    return pollAgentRun(ctx, runId, { budgetMs: AGENT_POLL_BUDGET_MS, onTimeout: "throw" });
  },
} satisfies ToolModule<typeof inputSchema, AgentRun>;

export default takoAgent;
