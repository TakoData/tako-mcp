/**
 * `tako_company_agent` — run Tako's Company Agent: multi-step research over
 * the company registry and the web that returns a written, cited answer plus
 * any list cards it built. Wraps the Company Agent API:
 *   POST /api/v1/agent/company/runs           (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/company/runs/{run_id}  (read or stream a run)
 * A call waits up to 45 s (`AGENT_CALL_WINDOW_MS`) and returns the finished run,
 * or `status: "running"` with a `company_run_` `run_id`. Send that `run_id`
 * instead of `query` to keep waiting. The Worker never cancels a run.
 *
 * On the generic surface this is opt-in: name `company_agent` in `?tools=`.
 * The chatgpt surface always lists it (`CHATGPT_TOOL_NAMES` in
 * `_surface.ts`).
 */
import { z } from "zod";

import { CompanyAgentEffort, type CompanyAgentRunRequest } from "../generated/schemas.js";
import {
  AGENT_CALL_WINDOW_FIXED_INPUT,
  AGENT_DESCRIPTION_LAST_LINE,
  AGENT_EXPLICIT_ASK_SENTENCE,
  agentChartsMeta,
  agentQueryInput,
  agentThreadIdInput,
  runAgentCall,
} from "./_agent_call.js";
import { AgentInputError, runIdInputSchema } from "./_agent_product.js";
import { agentRunOutputShape, type AgentRunOutput } from "./_agent_run.js";
import { buildChartAppUiResourceFromOutputPubId } from "./_chart_widget.js";
import { looseArray } from "./_loose_array.js";
import { renderAgentRunMarkdown } from "./_render_markdown.js";
import { AGENT_SOURCES_THREAD_RULE } from "./_shared_prose.js";
import type { AppUiResource, ToolModule } from "./types.js";

const DESCRIPTION = [
  `Run Tako's Company Agent. It searches the company registry and the web over several steps, and returns a written \`answer\` with numbered citations plus any list \`cards\` it built. ${AGENT_EXPLICIT_ASK_SENTENCE}`,
  "",
  "Best for: finding which companies or people match registry facts, such as a screen by status, incorporation date, registered location, or industry; resolving named companies; finding a company's officers and directors. At `medium` and `high` effort it can also filter by financial metrics such as revenue or headcount. Without that ask, use `tako_search`, even for a list of companies or people.",
  "",
  AGENT_DESCRIPTION_LAST_LINE,
].join("\n");

const COMPANY_SOURCES_DESCRIBE = `Which sources to research: \`data\` for Tako's curated data, \`web\` for the open web. A new thread uses both. ${AGENT_SOURCES_THREAD_RULE}`;

export const inputSchema = z.object({
  query: agentQueryInput,
  run_id: runIdInputSchema("company").optional(),
  sources: looseArray(
    z.array(z.enum(["data", "web"])).min(1).optional().describe(COMPANY_SOURCES_DESCRIBE),
    { field: "tako_company_agent.sources", commaSeparated: true },
  ),
  thread_id: agentThreadIdInput,
  effort: CompanyAgentEffort.optional().describe(
    "Research depth. `medium` is the default. `high` is stronger and slower. `low` answers from the company registry and the web only, and can't filter or rank by financial metrics such as revenue or headcount. Effort is fixed for a thread.",
  ),
});

type CompanyAgentInput = z.infer<typeof inputSchema>;

type Output = z.infer<typeof agentRunOutputShape>;

/**
 * Reshape the flat MCP input into the backend's CompanyAgentRunRequest body.
 * Throws `AgentInputError` when `query` is unset. The body sends `effort` and
 * `source_indexes` only when the caller set them, so a follow-up inherits the
 * thread's pins, and leaves `locale`, `timezone`, and `output_settings` unset.
 */
export function buildCompanyAgentBody(
  input: CompanyAgentInput,
): z.input<typeof CompanyAgentRunRequest> {
  if (input.query === undefined) {
    throw new AgentInputError("Send `query` to start a run.");
  }
  const body: z.input<typeof CompanyAgentRunRequest> = { query: input.query, cards: true };
  if (input.thread_id !== undefined) body.thread_id = input.thread_id;
  if (input.effort !== undefined) body.effort = input.effort;
  if (input.sources !== undefined) body.source_indexes = [...input.sources];
  return body;
}

const takoCompanyAgent = {
  name: "tako_company_agent",
  description: DESCRIPTION,
  inputSchema,
  outputSchema: agentRunOutputShape,
  annotations: {
    title: "Tako: Company Agent",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  fixedInputs: [
    { field: "cards", value: "true", note: "The agent may build list cards." },
    AGENT_CALL_WINDOW_FIXED_INPUT,
  ],
  streamsProgress: true,
  async handler(input, ctx): Promise<AgentRunOutput> {
    return runAgentCall(ctx, "company", input, () => buildCompanyAgentBody(input));
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderAgentRunMarkdown(output as AgentRunOutput);
  },
  extraMeta(output, ctx) {
    return agentChartsMeta(output as AgentRunOutput, ctx);
  },
  appUiResource(env, requestOrigin): AppUiResource {
    return buildChartAppUiResourceFromOutputPubId(env, requestOrigin);
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoCompanyAgent;
