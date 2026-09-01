/**
 * `tako_agent` — run Tako's Answer Agent: opinionated, multi-step agentic
 * research that returns a synthesized, citation-backed prose answer plus
 * supporting chart cards. Wraps the Answer Agent API:
 *   POST /api/v1/agent/answer/runs           (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/answer/runs/{run_id}  (poll until completed|failed)
 * Runs ~30-90s, so the Worker polls the run to a terminal state INSIDE the one
 * tool call and returns the finished answer. The client sees nothing until then.
 *
 * THERE IS NO WORKING PROGRESS CHANNEL, so nothing here may claim one. The
 * loop used to call `ctx.sendProgress` per iteration "to keep the per-call
 * timeout fresh"; the transport runs `enableJsonResponse: true`
 * (`mcp.ts`), and `webStandardStreamableHttp.js` skips the SSE write for every
 * request-scoped notification in that mode — so no host has ever received one,
 * `resetTimeoutOnProgress` cannot fire anywhere, and the client's own tool
 * timeout is the real ceiling (60s in the MCP TS SDK's default). The call was
 * removed rather than left to imply otherwise. TAKO-4485 owns the fix (relay
 * the backend's SSE representation, or make the notification path real); until
 * it lands, a run slower than the client's timeout is lost work.
 *
 * This is the only agent tool, and it is opt-in on the generic surface only:
 * name `agent` in `?tools=`. It is off the chatgpt surface
 * (`CHATGPT_TOOL_NAMES` in `_surface.ts`); the reason on record was that
 * ChatGPT's Apps SDK sends no progressToken, which is not the binding
 * constraint — no surface gets progress — but its ~60s per-call ceiling
 * still rules out a 30-90s dispatch+poll call there.
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
import { agentRunOutputShape, projectAgentRun, type AgentRunOutput } from "./_agent_run.js";
import { looseArray } from "./_loose_array.js";
import { logWireGuardFailure } from "./_log.js";
import { renderAgentRunMarkdown } from "./_render_markdown.js";
import { type Usage, usageSchema } from "./_search_results.js";
import { SOURCES_DESCRIBE } from "./_shared_prose.js";
import type { ToolContext, ToolModule } from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_TRANSIENT_ERRORS = 2;
export const AGENT_POLL_BUDGET_MS = 295_000;
const AGENT_POLL_REQUEST_TIMEOUT_MS = 15_000;

const DESCRIPTION = [
  "Run Tako's Answer Agent on a question that needs research rather than a lookup. It plans, queries the data graph and the web over several steps, and returns a written `answer` with numbered citations plus the chart `cards` it built.",
  "",
  'Best for questions whose shape you\'d have to work out first: cohorts ("which companies match…"), ranking or screening by criteria, multi-step aggregation, multi-hop reasoning. Also the fallback when `tako_search` finds nothing.',
  "",
  // The 30-90s figure lives in the module docstring, not here: D2.2 keeps a
  // measurement out of a description, and the latency drives no routing choice
  // the `tako_search` alternative does not already make.
  "Not for a known value or a two-entity comparison — `tako_search` answers those in one round trip.",
].join("\n");

export const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The question to research, in natural language. Ask one question per call; the agent plans its own sub-steps.",
    ),
  // looseArray: hosts that stringify the array they meant to send (observed
  // from OpenBB Copilot) get it coerced instead of a -32602. `commaSeparated` is safe
  // here and ONLY here: the item domain is a closed enum, no member of which
  // contains a comma. See
  // _loose_array.ts.
  sources: looseArray(
    z
      .array(z.enum(["data", "web"]))
      .min(1)
      .default(["data", "web"])
      .describe(SOURCES_DESCRIBE),
    // The label names the file the schema is declared in.
    { field: "tako_agent.sources", commaSeparated: true },
  ),
  thread_id: z
    .uuid()
    .optional()
    .describe(
      "A `thread_id` from an earlier run. Pass it back to ask a follow-up in that conversation; omit it to start a new one.",
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
  // Metered cost of the run. Forwarded to the projected output as `usage` —
  // the one field a caller acts on, and absent from both channels until this
  // pass (agent runs over MCP are not yet metered for PAYG orgs, TAKO-3245,
  // so the wire figure can be present while nothing is charged).
  usage: usageSchema.nullable().optional(),
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
      // Set when Tako rejected the query BEFORE the agent ran; null on normal
      // runs. A strict `z.object` used to strip it, so a rejected run reached
      // the model as a completed run with no answer and no reason. It is now
      // the tool's one `guidance` branch (`refusalGuidance` in _agent_run.ts).
      // New codes are additive, so never switch on the value.
      refusal_code: z.string().nullable().optional(),
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
  usage?: unknown;
};

type AgentInput = z.infer<typeof inputSchema>;

// The advertised output, inferred from the schema the same way `tako_search`
// does it: the hand-written `AgentRunOutput` the projection returns is
// assignable to this, and declaring the module against the inferred type is
// what keeps `outputSchema` and the handler's return in one contract under
// `exactOptionalPropertyTypes`.
type Output = z.infer<typeof agentRunOutputShape>;

/**
 * Reshape the flat MCP input into the backend's AnswerAgentRunRequest body.
 * Exported for the contract-guard test.
 *
 * The MCP flat `sources` array maps to the backend's `source_indexes` field
 * (a rename); the two enums are now identical, so the list passes straight
 * through. The `satisfies` annotation is the build-time guard: if the backend
 * request contract changes (new required field, renamed key, changed enum),
 * this line fails to compile.
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
    source_indexes: [...input.sources],
    effort: "medium",
  };
  if (input.thread_id !== undefined) body.thread_id = input.thread_id;
  return body satisfies z.input<typeof AnswerAgentRunRequest>; // ← build-time guard: backend request drift breaks here
}

/** Dispatch an Answer Agent run. Returns the run_id. */
export async function dispatchAgentRun(
  ctx: ToolContext,
  query: string,
  sources: Array<"data" | "web">,
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

/** Poll an agent run to a terminal state. Emits no progress: the transport
 *  discards request-scoped notifications under `enableJsonResponse: true`
 *  (TAKO-4485), so a call here would be a claim the wire does not honor. */
export async function pollAgentRun(
  ctx: ToolContext,
  runId: string,
  opts: { budgetMs: number; onTimeout: "throw" | "return" },
): Promise<AgentRun> {
  const deadline = Date.now() + opts.budgetMs;
  let transient = 0;
  let lastRun: AgentRun | undefined;

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
    // Cost is telemetry, so a malformed usage payload must not cost a
    // completed run: the throw below fires AFTER status reached "completed",
    // discarding a 30-90s run that already billed. Soft-parse it here and
    // leave the same breadcrumb the guards above leave. `tako_search` never
    // parses usage at all (`_run_search.ts` passes `wire.usage ?? null`
    // straight through), so this keeps the strict field without its cost.
    let usage: Usage | null = null;
    if (wire.usage != null) {
      const usageGuard = usageSchema.safeParse(wire.usage);
      if (usageGuard.success) usage = usageGuard.data;
      else logWireGuardFailure("tako_agent", "usage", usageGuard.error, wire);
    }
    const parsed = agentRunSchema.safeParse({
      run_id: wire.run_id ?? runId,
      thread_id: wire.thread_id ?? null,
      status: wire.status ?? "running",
      timed_out: false,
      result: wire.result ?? null,
      error: wire.error ?? null,
      usage,
    });
    if (!parsed.success) {
      logWireGuardFailure("tako_agent", "output-normalise", parsed.error, wire);
      throw new Error("Tako agent run endpoint returned an unexpected shape.");
    }
    lastRun = parsed.data;
    if (parsed.data.status === "completed" || parsed.data.status === "failed") {
      // The ONLY place a successful run's id is recoverable. `run_id` reaches
      // neither channel (no model reader, no poll tool to spend it on), and
      // that is safe only while a support question — "this run was wrong" —
      // can still be answered. The transient-error log above fires on a FAILED
      // poll, so without this line a clean run leaves no trace anywhere.
      console.log(`[tako] agent run terminal run_id=${runId} status=${parsed.data.status}`);
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
  // Advertised schema = the PROJECTED shape, typed field by field
  // (`_agent_run.ts`). `agentRunSchema` stays the internal shape the poll
  // validates the wire against; `projectAgentRun` maps it to this one, so no
  // unknown backend key can reach the model and no field rides in one channel
  // only. One schema for both surfaces: this tool mounts no widget, so there
  // are no per-surface fields and no `outputSchemaBySurface`.
  outputSchema: agentRunOutputShape,
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
  fixedInputs: [
    { field: "effort", value: "\"medium\"", note: "The only Answer Agent effort level launched." },
    // `scope: "worker"` is what keeps this out of the request-inputs section —
    // `POLL_INTERVAL_MS` and `AGENT_POLL_BUDGET_MS` never reach the wire; they
    // drive the Worker's own poll loop. An earlier attempt relabelled the field
    // instead, which changed nothing: the generator emits that heading for every
    // non-empty `fixedInputs`, so the doc kept the false claim under a longer
    // name. Value derived, not restated, so retuning either constant regenerates
    // the doc rather than leaving it publishing a number the loop stopped using.
    {
      field: "poll interval / budget",
      value: `${POLL_INTERVAL_MS / 1000} s / ${AGENT_POLL_BUDGET_MS / 1000} s`,
      note: "The call polls the run until it completes or the budget ends.",
      scope: "worker",
    },
  ],
  // The handler's output IS the advertised shape, so there is no
  // `slimStructured` hook: `structuredContentFor` narrows to the declared keys
  // and both channels render the same object.
  async handler(input, ctx): Promise<AgentRunOutput> {
    const runId = await dispatchAgentRun(ctx, input.query, input.sources, input.thread_id);
    const run = await pollAgentRun(ctx, runId, {
      budgetMs: AGENT_POLL_BUDGET_MS,
      onTimeout: "throw",
    });
    return projectAgentRun(run);
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAgentRunMarkdown(output as AgentRunOutput);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAgent;
