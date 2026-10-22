/**
 * `tako_agent` — run Tako's Answer Agent: opinionated, multi-step agentic
 * research that returns a synthesized, citation-backed prose answer plus
 * supporting chart cards. Wraps the Answer Agent API:
 *   POST /api/v1/agent/answer/runs           (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/answer/runs/{run_id}  (read or stream a run)
 * A call waits up to 45 s (`AGENT_CALL_WINDOW_MS`) over the backend's event
 * stream and returns the finished run, or `status: "running"` with a prefixed
 * `run_id`. Send that `run_id` instead of `query` to keep waiting. The Worker
 * never cancels a run.
 *
 * This is opt-in on the generic surface only: name `agent` in `?tools=`. It is
 * off the chatgpt surface (`CHATGPT_TOOL_NAMES` in `_surface.ts`).
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

import { AnswerAgentRunRequest } from "../generated/schemas.js";
import { runAgentCall } from "./_agent_call.js";
import { AgentInputError, runIdInputSchema } from "./_agent_product.js";
import { agentRunOutputShape, type AgentRunOutput } from "./_agent_run.js";
import { AGENT_CALL_WINDOW_MS } from "./_agent_wait.js";
import { looseArray } from "./_loose_array.js";
import { renderAgentRunMarkdown } from "./_render_markdown.js";
import { SOURCES_DESCRIBE } from "./_shared_prose.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Run Tako's Answer Agent on a question that needs research rather than a lookup. It plans, queries the data graph and the web over several steps, and returns a written `answer` with numbered citations plus the chart `cards` it built.",
  "",
  "Best for metric-driven research: ranking or screening by financial or economic metrics, multi-step aggregation, multi-hop reasoning. Also the fallback when `tako_search` finds nothing. Not for a known value or a two-entity comparison — `tako_search` answers those in one round trip. Not for questions about which companies or people match registry facts such as status, incorporation date, location, or industry.",
  "",
  "A call returns within 45 s. If `status` is `running`, call again with `run_id`; don't start a new run.",
].join("\n");

export const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The question to research, in natural language. Ask one question per call; the agent plans its own sub-steps. Send `query` or `run_id`, not both.",
    ),
  run_id: runIdInputSchema("answer").optional(),
  // looseArray: hosts that stringify the array they meant to send (observed
  // from OpenBB Copilot) get it coerced instead of a -32602. `commaSeparated` is safe
  // here and ONLY here: the item domain is a closed enum, no member of which
  // contains a comma. See
  // _loose_array.ts.
  sources: looseArray(
    z.array(z.enum(["data", "web"])).min(1).optional().describe(SOURCES_DESCRIBE),
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

type AgentInput = z.infer<typeof inputSchema>;

// The advertised output, inferred from the schema the same way `tako_search`
// does it: the hand-written `AgentRunOutput` the projection returns is
// assignable to this, and declaring the module against the inferred type is
// what keeps `outputSchema` and the handler's return in one contract under
// `exactOptionalPropertyTypes`.
type Output = z.infer<typeof agentRunOutputShape>;

/**
 * Reshape the flat MCP input into the backend's AnswerAgentRunRequest body.
 * Exported for the contract-guard test. Throws `AgentInputError` when `query` is unset.
 *
 * The MCP flat `sources` array maps to the backend's `source_indexes` field
 * (a rename); the two enums are now identical, so the list passes straight
 * through. The `satisfies` annotation is the build-time guard: if the backend
 * request contract changes (new required field, renamed key, changed enum),
 * this line fails to compile.
 *
 * The body sends `source_indexes` only when the caller set `sources`, so a
 * follow-up inherits the thread's sources; a new thread gets the backend's
 * default of data and web. `effort` only accepts the literal "medium" on the
 * Answer Agent (AnswerAgentEffort) — the sole launched level.
 */
export function buildAgentBody(input: AgentInput): z.input<typeof AnswerAgentRunRequest> {
  if (input.query === undefined) {
    throw new AgentInputError("Send `query` to start a run.");
  }
  const body: z.input<typeof AnswerAgentRunRequest> = {
    query: input.query,
    effort: "medium",
  };
  if (input.thread_id !== undefined) body.thread_id = input.thread_id;
  if (input.sources !== undefined) body.source_indexes = [...input.sources];
  return body satisfies z.input<typeof AnswerAgentRunRequest>; // ← build-time guard: backend request drift breaks here
}

const takoAgent = {
  name: "tako_agent",
  description: DESCRIPTION,
  inputSchema,
  // Advertised schema = the PROJECTED shape, typed field by field
  // (`_agent_run.ts`). `agentRunSchema` stays the internal shape the wait
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
    // idempotentHint false: a call without `run_id` dispatches a new agent run.
    idempotentHint: false,
    // Open-world on EVERY surface: the run searches the live public web, a
    // system outside Tako's first-party context, under MCP's reading and
    // under OpenAI's Apps review guideline alike. Off the chatgpt surface
    // today (`CHATGPT_TOOL_NAMES`); the annotation is per-tool regardless.
    // See `annotationsBySurface` in types.ts.
    openWorldHint: true,
  },
  fixedInputs: [
    { field: "effort", value: "\"medium\"", note: "The only Answer Agent effort level launched." },
    {
      field: "call window",
      value: `${AGENT_CALL_WINDOW_MS / 1000} s`,
      note: "A call returns within the window; resume a running run with run_id.",
      scope: "worker",
    },
  ],
  // The handler's output IS the advertised shape, so there is no
  // `slimStructured` hook: `structuredContentFor` narrows to the declared keys
  // and both channels render the same object.
  async handler(input, ctx): Promise<AgentRunOutput> {
    return runAgentCall(ctx, "answer", input, () => buildAgentBody(input));
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAgentRunMarkdown(output as AgentRunOutput);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAgent;
