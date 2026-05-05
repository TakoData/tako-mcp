/**
 * `start_deep_knowledge_search` — kick off the deep (Orca) knowledge
 * search asynchronously and return a `task_id` immediately.
 *
 * Registered ONLY on clients that don't honor MCP
 * `notifications/progress` for tool-call timeout extension (currently:
 * ChatGPT). On those clients the single-tool `knowledge_search` deep
 * path can't survive the host's per-call timeout (typically 60 s),
 * so we fall back to the pattern Tako already uses for reports:
 * a non-blocking kickoff plus a separate `wait_for_knowledge_search`
 * status-check tool that the agent can chain in a loop.
 *
 * On Claude.ai (which sends a `progressToken` and resets timeouts on
 * progress events), this tool is NOT registered — the existing
 * `knowledge_search` auto-escalation path handles deep in a single
 * tool call. See `mcp.ts`'s `CHATGPT_ONLY_TOOL_NAMES` set.
 *
 * Wire path: this tool POSTs to `/api/v1/knowledge_search` with
 * `search_effort: "deep"`. The backend responds 202 with
 * `{ task_id, status: "pending" }`. We surface that as-is.
 *
 * No `appUiResource` / `extraMeta` / `extraContentBlocks`. The kickoff
 * response carries no chart, and ChatGPT's host reserves a min-height
 * widget container for any tool that ships `appUiResource` — which
 * would put a persistent empty box in the chat for every kickoff.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import {
  type SearchPostResponse,
  isAsyncTaskInitiation,
} from "./_async_search_shape.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query (e.g. "US GDP growth", "Intel vs Nvidia revenue").',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of matching cards the deep task should return (1-20)."),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z.string().default("en-US").describe("Locale for results."),
});

const outputSchema = z.object({
  task_id: z.string(),
  status: z.literal("pending"),
  message: z.string(),
});

type Output = z.infer<typeof outputSchema>;

const KICKOFF_MESSAGE =
  "Deep search running. Deep (Orca) knowledge searches usually take 1-3 minutes. Call `wait_for_knowledge_search` with this `task_id` when you want to check the status; loop until it returns `timed_out: false`. When it completes with results, call `open_chart_ui` with `results[0].card_id` to render the top chart inline.";

const start_deep_knowledge_search = {
  name: "start_deep_knowledge_search",
  description:
    'Kick off a thorough (deep / Orca research pipeline) knowledge search and return immediately with a `task_id`. **Use this whenever `knowledge_search` returns 0 cards OR errors out — auto-escalate by default, do not wait for the user to ask for "deep" or "research-grade" before retrying.** Also use when the user explicitly asks for a deep / thorough / research-grade result. The deep task runs server-side for 1-5 minutes; this tool returns in <1s with the task handle. **Workflow:** (1) tell the user the deep search is running and that it can take a few minutes; (2) when the user wants an update OR you want to deliver the final answer, call `wait_for_knowledge_search` with this `task_id`; (3) on COMPLETED, call `open_chart_ui` with `results[0].card_id` to render the chart inline, then narrate the data.',
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Start Deep Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const body = {
      inputs: { text: input.query, count: input.count },
      source_indexes: ["tako"],
      search_effort: "deep" as const,
      country_code: input.country_code,
      locale: input.locale,
    };
    // Deep returns 202 in <1s — the polling happens later in
    // `wait_for_knowledge_search`. Short timeout here is enough.
    const response = await djangoPost<SearchPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/knowledge_search",
      body,
      { timeoutMs: 15_000 },
    );

    if (!isAsyncTaskInitiation(response)) {
      // Defensive: backend served deep sync (rare / fixture path).
      // Surface a synthetic task-id-shaped error rather than a
      // results envelope, since this tool's contract is "always
      // return a task_id". The agent can fall back to plain
      // `knowledge_search` for sync results.
      throw new Error(
        "Tako backend returned synchronous results for an explicit deep search; expected a task_id. Use `knowledge_search` (search_effort: 'fast') if you need sync results.",
      );
    }

    return {
      task_id: response.task_id,
      status: "pending",
      message: KICKOFF_MESSAGE,
    };
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default start_deep_knowledge_search;
