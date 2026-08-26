/**
 * `tako_agent` — run Tako's Answer Agent: opinionated, multi-step agentic
 * research that returns a synthesized, citation-backed prose answer plus
 * supporting chart cards. Wraps the Answer Agent API:
 *   POST /api/v1/agent/answer/runs           (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/answer/runs/{run_id}  (poll until completed|failed)
 * Runs ~30-90s, so we poll and emit notifications/progress each iteration to
 * keep the per-call timeout fresh (hosts with resetTimeoutOnProgress). This
 * is the only agent tool, and it is opt-in on the generic surface only: name
 * `agent` in `?tools=`. It is off the chatgpt surface (`CHATGPT_TOOL_NAMES`
 * in `_surface.ts`) because ChatGPT's Apps SDK sends no progressToken, so the
 * dispatch+poll path cannot survive its ~60s per-call ceiling.
 *
 * PRODUCT: the public agent split (TAKO-3371) has two products — the Answer
 * Agent (cited prose + cards; this tool) and the Retrieval Agent (structured
 * output / dataset slots). MCP exposes ONLY the Answer Agent: chat hosts want
 * a synthesized answer, and the Retrieval Agent's structured-output feature has
 * no chat-host consumer (it lives in the SDK). `effort: "medium"` already
 * routed to the Answer Agent (ORCHESTRATOR) on the retired generic
 * `/v1/agent/runs`, so pointing at `/v1/agent/answer/runs` is
 * behaviour-preserving.
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { djangoGet, djangoPost } from "../django.js";
import {
  AnswerAgentResult as AnswerAgentResultContract,
  AnswerAgentRun as AnswerAgentRunContract,
  AnswerAgentRunRequest,
} from "../generated/schemas.js";
import { withShareOptIn } from "./_chart_widget.js";
import { looseArray } from "./_loose_array.js";
import { logWireGuardFailure } from "./_log.js";
import {
  agentRunSlimOutputShape,
  renderAgentRunMarkdown,
  slimAgentRunStructured,
  type AgentRunLike,
} from "./_render_markdown.js";
import type { ToolContext, ToolModule } from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_TRANSIENT_ERRORS = 2;
export const AGENT_POLL_BUDGET_MS = 295_000;
// Per-call cap for a host with a ~60s tool-call ceiling. Kept at 40 (not 50)
// so the worst case — a poll-GET that hangs the full
// AGENT_POLL_REQUEST_TIMEOUT_MS right at the deadline — still returns in
// ~40+15 = 55s.
export const AGENT_WAIT_CEILING_S = 40;
const AGENT_POLL_REQUEST_TIMEOUT_MS = 15_000;

const DESCRIPTION = [
  "Run Tako's Answer Agent: multi-step research returning a synthesized, cited `answer` plus chart `cards`.",
  "",
  'Best for: questions whose shape needs figuring out — cohorts ("which companies match…"), ranking or filtering by criteria, multi-step aggregation, multi-hop reasoning. Also the fallback when `tako_search` returns nothing.',
  "",
  "Not for: a known value or a simple comparison — use `tako_search` (faster). This runs ~30–90s but is far more thorough.",
].join("\n");

export const inputSchema = z.object({
  query: z.string().min(1).describe("The deep/analytical question for the agent to work through."),
  // looseArray: hosts that stringify the array they meant to send (observed
  // from OpenBB Copilot) get it coerced instead of a -32602. `commaSeparated` is safe
  // here and ONLY here: the item domain is a closed enum, no member of which
  // contains a comma. See
  // _loose_array.ts.
  sources: looseArray(
    z
      .array(z.enum(["data", "web", "tako"]))
      .min(1)
      .default(["data", "web"])
      .describe(
        'Source(s) the agent may use. Default ["data","web"] (both) — keep BOTH enabled unless you have a confirmed reason to narrow. Narrow to ["data"] only once `tako_available_data` has confirmed Tako covers the data (web is the fallback when it lacks it). Narrow to ["web"] only for content a data graph cannot hold (news articles, page text, qualitative claims) — never because a metric merely feels web-native: website traffic, app usage, and similar digital metrics ARE in Tako\'s data graph. ("tako" is a legacy synonym for "data".)',
      ),
    // The label names the file the schema is declared in.
    { field: "tako_agent.sources", commaSeparated: true },
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

// One indexed source behind the answer. The answer's inline [n] markers join
// to a citation's `index`. Mirrors the generated AgentAnswerCitation — the
// unified top-level registry (Answer Agent, S1 §5.2) that replaced the generic
// agent's per-answer `web_results`. The required fields (`index`, `title`) match
// the contract non-null; the object stays `.loose()` so additive backend fields
// (source_index, content, …) pass through untouched.
const citationSchema = z
  .object({
    index: z.number().int(),
    title: z.string(),
    url: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    publish_date: z.string().nullable().optional(),
  })
  .loose();

// The answer's reasoning scaffolding (Answer Agent, AnswerAgentMetadata): term
// definitions, stated assumptions, and methodology notes behind the prose.
// Surfaced so chat hosts can show *why* the answer holds, not just the text.
// Leaves stay `.loose()` so additive backend fields pass through.
const definitionSchema = z
  .object({ term: z.string(), definition: z.string(), source_ref: z.number().int().nullable().optional() })
  .loose();
const assumptionSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    category: z.string().nullable().optional(),
    source_ref: z.number().int().nullable().optional(),
  })
  .loose();
const methodologyNoteSchema = z.object({ title: z.string(), description: z.string() }).loose();
const metadataSchema = z
  .object({
    definitions: z.array(definitionSchema).nullable().optional(),
    assumptions: z.array(assumptionSchema).nullable().optional(),
    methodology: z.array(methodologyNoteSchema).nullable().optional(),
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
      // The unified top-level citation registry (Answer Agent, S1 §5.2): the
      // indexed sources the answer's [n] markers join to. This replaced the
      // generic agent's `web_results` — dropping it loses all citations.
      citations: z.array(citationSchema).default([]),
      // Definitions / assumptions / methodology behind the answer
      // (AnswerAgentMetadata); a plain z.object would otherwise strip it.
      metadata: metadataSchema.nullable().optional(),
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
 * Reshape the flat MCP input into the backend's AnswerAgentRunRequest body.
 * Exported for the contract-guard test.
 *
 * The MCP flat `sources` array maps to the backend's `source_indexes` field
 * (a rename). The legacy `"tako"` synonym is folded onto the canonical `"data"`
 * here so the body matches the generated enum (["data","web"]). The `satisfies`
 * annotation is the build-time guard: if the backend request contract changes
 * (new required field, renamed key, changed enum), this line fails to compile.
 *
 * Parity note: the generated AnswerAgentRunRequest has `source_indexes` as
 * optional (the backend defaults to ["data","web"] when absent), but we always
 * send it explicitly to keep the MCP behaviour predictable regardless of
 * backend defaults. `effort` only accepts the literal "medium" on the Answer
 * Agent (AnswerAgentEffort) — the sole launched level.
 */
export function buildAgentBody(input: AgentInput): z.input<typeof AnswerAgentRunRequest> {
  const body: z.input<typeof AnswerAgentRunRequest> = {
    query: input.query,
    source_indexes: input.sources.map((s) => (s === "tako" ? "data" : s)),
    effort: "medium",
  };
  if (input.thread_id !== undefined) body.thread_id = input.thread_id;
  return body satisfies z.input<typeof AnswerAgentRunRequest>; // ← build-time guard: backend request drift breaks here
}

/** Dispatch an Answer Agent run. Returns the run_id. */
export async function dispatchAgentRun(
  ctx: ToolContext,
  query: string,
  sources: Array<"data" | "web" | "tako">,
  threadId?: string,
): Promise<string> {
  // AnswerAgentRunRequest takes a flat `source_indexes` list (defaults to
  // ["data","web"] server-side, mirrored by the schema default here). `effort`
  // only accepts the literal "medium" on the Answer Agent (AnswerAgentEffort).
  // `thread_id`, when provided, continues a prior run's conversation.
  const body = buildAgentBody({ query, sources, thread_id: threadId });
  const data = await djangoPost<AgentRunWire>(
    ctx.env,
    ctx.token,
    "/api/v1/agent/answer/runs",
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

  // Share opt-in on the passthrough card embed_urls, so the url an agent
  // quotes into its answer matches the one every other surface serves for
  // the same card — see withShareOptIn in _chart_widget.ts.
  const withSharedCards = (run: AgentRun): AgentRun =>
    run.result == null || run.result.cards.length === 0
      ? run
      : {
          ...run,
          result: {
            ...run.result,
            cards: run.result.cards.map((c) =>
              typeof c.embed_url === "string" && c.embed_url !== ""
                ? { ...c, embed_url: withShareOptIn(c.embed_url) }
                : c,
            ),
          },
        };

  while (true) {
    let wire: AgentRunWire;
    try {
      wire = await djangoGet<AgentRunWire>(ctx.env, ctx.token, `/api/v1/agent/answer/runs/${runId}`, {
        timeoutMs: AGENT_POLL_REQUEST_TIMEOUT_MS,
      });
      transient = 0;
    } catch (err) {
      // Tolerate a couple of transient transport blips while the run continues
      // — but leave a breadcrumb per blip: a backend degraded enough to fail
      // alternate polls is otherwise invisible until the final throw.
      transient += 1;
      console.warn(
        `[tako] agent poll transient error run_id=${runId} attempt=${transient}/${MAX_TRANSIENT_ERRORS}:`,
        err,
      );
      if (transient > MAX_TRANSIENT_ERRORS) throw err;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    // Wire-contract guard: validate the raw GET response against the generated
    // AnswerAgentRun contract before mapping into the normalised MCP output shape.
    //
    // Parity decision (Path 2): the generated AnswerAgentRun requires `created_at`
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
    //                        structurally match AnswerAgentResult from the
    //                        generated contract. For in-flight (queued/running)
    //                        runs, result is legitimately absent; no check runs.
    //   • created_at / object / timed_out — tolerated as absent (metadata
    //                        fields the poll wire may omit; timed_out is MCP-
    //                        synthetic and does not appear in the backend schema).
    const lifecycleGuard = AnswerAgentRunContract.pick({ run_id: true, status: true }).safeParse(wire);
    if (!lifecycleGuard.success) {
      logWireGuardFailure("tako_agent", "run-lifecycle", lifecycleGuard.error, wire);
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
        logWireGuardFailure("tako_agent", "completed-missing-result", undefined, wire);
        throw new Error(
          "Agent run wire drifted from the backend contract: completed run is missing the `result` field.",
        );
      }
      if (wire.result !== null) {
        const resultGuard = AnswerAgentResultContract.safeParse(wire.result);
        if (!resultGuard.success) {
          logWireGuardFailure("tako_agent", "completed-result", resultGuard.error, wire);
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
      logWireGuardFailure("tako_agent", "output-normalise", parsed.error, wire);
      throw new Error("Tako agent run endpoint returned an unexpected shape.");
    }
    lastRun = withSharedCards(parsed.data);
    pollCount += 1; // MCP requires progress to strictly increase per token.
    await ctx.sendProgress(pollCount, { message: `Agent running… (${parsed.data.status})` });
    if (parsed.data.status === "completed" || parsed.data.status === "failed") {
      return { ...lastRun, timed_out: false };
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
  // Advertised schema = the slim lifecycle shape; the answer, citations, and
  // reasoning notes reach the model as rendered markdown (renderText below).
  // agentRunSchema stays the internal shape the poll validates against.
  outputSchema: agentRunSlimOutputShape,
  annotations: {
    title: "Tako: Answer Agent",
    // WRITE under the shared rule in types.ts: the call creates a durable,
    // user-addressable resource — a queued run reachable later via
    // `run_id`/`thread_id`. Non-destructive: it only ever adds runs.
    readOnlyHint: false,
    destructiveHint: false,
    // idempotentHint false: each call dispatches a new agent run.
    idempotentHint: false,
    openWorldHint: true,
  },
  annotationsBySurface: {
    // Apps review reads `openWorldHint` as "publishes/mutates public or
    // third-party state", not MCP's domain-of-interaction, so the open-world
    // retrieval flag drops on the chatgpt surface.
    //
    // Production never reads this override: `CHATGPT_TOOL_NAMES` in
    // `_surface.ts` keeps this tool off the chatgpt surface entirely. Kept
    // anyway so the tool stays correct if it is ever added there, and because
    // `annotations_complete.test.ts` resolves every tool on both surfaces.
    // See `annotationsBySurface` in types.ts.
    chatgpt: { openWorldHint: false },
  },
  async handler(input, ctx): Promise<AgentRun> {
    const runId = await dispatchAgentRun(ctx, input.query, input.sources, input.thread_id);
    return pollAgentRun(ctx, runId, { budgetMs: AGENT_POLL_BUDGET_MS, onTimeout: "throw" });
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAgentRunMarkdown(output as unknown as AgentRunLike);
  },
  slimStructured(output) {
    return slimAgentRunStructured(output as unknown as AgentRunLike);
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof agentRunSlimOutputShape>>;

export default takoAgent;
