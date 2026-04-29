/**
 * `knowledge_search` — semantic search over Tako's curated chart knowledge base.
 *
 * Ports `knowledge_search` from `src/tako_mcp/server.py:85` (Python legacy).
 * Posts to `/api/v1/knowledge_search`, flattens `outputs.knowledge_cards[]` into
 * a `results[]` shape, and adds `open_ui_tool` / `open_ui_args` hints so an LLM
 * can chain into `open_chart_ui` without re-deriving the card id.
 *
 * `search_effort` is optional; omitted → run `fast` first, escalate to `deep`
 * only if `fast` returns zero cards. Deep against staging/prod returns a
 * `202 {task_id, status: "pending"}` and the Orca/orchestrator pipeline runs
 * asynchronously — the cards land on `result.outputs.knowledge_cards[]` of
 * `GET /api/v1/knowledge_search/async/status/?task_id=<id>` once the task
 * reaches `COMPLETED`.
 *
 * This tool implements client-side polling for that async path (TAKO-2686):
 *   - Detects the `{task_id, status: "pending"}` response shape on POST.
 *   - Polls the status endpoint every `POLL_INTERVAL_MS` for up to
 *     `POLL_BUDGET_MS`, exiting on the first terminal state.
 *   - On `COMPLETED` → extracts cards and returns them like the sync path.
 *   - On `FAILED` / `INTERRUPTED` → throws with Django's `error` field.
 *   - On budget exhausted → throws so the MCP client can narrate the
 *     "deep search still running" outcome instead of returning a misleading
 *     empty list.
 *
 * The legacy Python MCP had this gap (always returned `[]` for explicit deep);
 * this port closes it.
 */
import { z } from "zod";

import {
  DjangoHttpError,
  DjangoTimeoutError,
  djangoGet,
  djangoPost,
} from "../django.js";
import type { ToolContext, ToolModule } from "./types.js";

// Polling budget — exposed as module-level constants so vitest can fake the
// surrounding timers. Three constraints intersect here:
//
//   1. Tako's `orchestrator_deep_config.py` (timeout=300.0) is the upper
//      bound on how long a deep search can possibly take.
//   2. Cloudflare Workers caps **subrequests per invocation** at 50 on
//      the default tier (1000 on Paid). One or two POSTs (auto-escalation
//      from fast → deep is two) plus N status GETs must stay under that
//      ceiling, or the runtime kills the Worker mid-flight with "Too many
//      subrequests by single Worker invocation".
//   3. The MCP **client's** per-tool timeout. The MCP TS SDK's
//      `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60_000 and applies unless the
//      caller passes `options.timeout` (and/or `resetTimeoutOnProgress:
//      true` paired with server-sent progress notifications, which we do
//      not emit yet). Clients on defaults will abort at ~60s; clients
//      that override (or use HTTP transports without their own ceiling)
//      get the full Worker budget. The tool `description` warns callers
//      to bump their timeout for deep searches.
//
// Sizing math: `2 + ceil(POLL_BUDGET_MS / POLL_INTERVAL_MS) +
// MAX_TRANSIENT_RETRIES ≤ 50` (worst case is fast POST → deep POST →
// status GETs + a small retry budget for transient blips). With 10s
// polls, a 290s budget, and 2 retries that's `2 + 29 + 2 = 33
// subrequests` — under the cap with ~17 slots of headroom. The 10s
// interval is fine because explicit `search_effort: "deep"` is inherently
// long-running (Orca pipeline routinely runs 60-300s); a 10s detection
// delta on completion is irrelevant against that wait.
const POLL_INTERVAL_MS = 10_000;
const POLL_BUDGET_MS = 290_000;
const STATUS_REQUEST_TIMEOUT_MS = 10_000;
// Transient transport blips against the status endpoint (Django restart
// mid-deploy, LB hiccup, network reset) shouldn't kill a polling loop
// whose underlying Celery task is still running and would have completed
// on the next poll. We swallow up to this many transient failures across
// the whole loop, count each one against the subrequest budget, and let
// the (N+1)th surface as before so a sustained outage still fails loud.
const MAX_TRANSIENT_RETRIES = 2;

// Django's task status discriminator. `PENDING` and `IN_PROGRESS` are the
// non-terminal states we keep polling through; the rest exit the loop.
// Source: `tako/app/backend/monolith/models.py:2719` (AsyncTaskStatusChoices).
// Compared against `.toUpperCase()` of the response status so that any
// future casing drift between POST ("pending") and GET ("PENDING") doesn't
// silently turn a terminal response into an infinite loop.
const COMPLETED_STATE = "COMPLETED";
const FAILURE_STATES = new Set(["FAILED", "INTERRUPTED"]);

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
    .default(5)
    .describe("Maximum number of matching cards to return (1–20)."),
  search_effort: z
    .enum(["fast", "medium", "deep", "auto"])
    .optional()
    .describe(
      "Search depth: `fast` (lexical), `medium` / `auto` (balanced), `deep` (Orca research pipeline, async, higher credit cost). Omit to let the tool run `fast` first and escalate to `deep` only if `fast` returns zero cards. Deep mode runs asynchronously on Tako's side — the tool polls until the task completes or the per-call budget is exhausted.",
    ),
  country_code: z
    .string()
    .default("US")
    .describe("ISO country code for localized results."),
  locale: z
    .string()
    .default("en-US")
    .describe("Locale for results."),
});

const visualizationSchema = z.object({
  card_id: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  source: z.string().nullable(),
  open_ui_tool: z.string().optional(),
  open_ui_args: z.object({ pub_id: z.string() }).optional(),
});

const outputSchema = z.object({
  results: z.array(visualizationSchema),
  count: z.number().int().nonnegative(),
});

type KnowledgeCard = {
  card_id?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
};

type SyncSearchResponse = {
  outputs?: {
    knowledge_cards?: KnowledgeCard[];
  };
};

type AsyncTaskInitiation = {
  task_id: string;
  status: string;
  message?: string;
};

type AsyncTaskEvent = {
  id: number;
  data?: {
    event_type?: string;
    [key: string]: unknown;
  };
};

type AsyncTaskStatus = {
  task_id: string;
  status: string;
  result?: {
    outputs?: {
      knowledge_cards?: KnowledgeCard[];
    };
  };
  error?: string;
  // Append-only progress event log emitted by `run_knowledge_agent_search`
  // (Tako's Celery task). Non-NOOP events surface here as the pipeline
  // works through planning / querying / aggregating steps; the final RESULT
  // event is consumed into `result` rather than appearing here. We use
  // these to build informative timeout / failure messages — the LLM gets
  // "task is at step PLANNING after 30s" instead of just "did not
  // complete in time."
  events?: AsyncTaskEvent[];
};

type SearchResponse = SyncSearchResponse | AsyncTaskInitiation;

function isAsyncTaskInitiation(
  data: SearchResponse,
): data is AsyncTaskInitiation {
  // `task_id` is the unambiguous async-mode marker — sync responses live
  // under `outputs.knowledge_cards`. Checking `task_id` alone keeps the
  // guard tolerant of `status` casing differences ("pending" vs "PENDING")
  // that we've seen between the initial 202 and subsequent polls.
  return (
    typeof data === "object" &&
    data !== null &&
    "task_id" in data &&
    typeof (data as AsyncTaskInitiation).task_id === "string"
  );
}

/**
 * Summarize a status response's progress for use in error messages. Picks
 * the most recent event with a `data.event_type` and returns a short
 * "<count> events; last: <type>" string. Falls back gracefully when the
 * backend doesn't include events (older deploys / non-deep tasks).
 */
function summarizeProgress(events: AsyncTaskEvent[] | undefined): string {
  const list = events ?? [];
  if (list.length === 0) return "no progress events emitted";
  // Walk from the tail to find the most recent typed event without
  // allocating a reversed copy. (Array.findLast is ES2023; tsconfig
  // targets earlier so we hand-roll the reverse scan.)
  let lastEventType = "untyped";
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]?.data?.event_type;
    if (typeof t === "string") {
      lastEventType = t;
      break;
    }
  }
  return `${list.length} progress event${list.length === 1 ? "" : "s"}; last: ${lastEventType}`;
}

/**
 * Classify whether a status-GET failure is likely transient (worth a
 * single retry) or terminal (caller should bail). Conservatively
 * whitelisted: only request-timeout aborts and Django-reported 5xx
 * count as transient. 404 (task gone), 401 (auth dead), 400 (bad
 * request), and parse errors are all surfaced immediately.
 */
function isTransientStatusError(err: unknown): boolean {
  if (err instanceof DjangoTimeoutError) return true;
  if (
    err instanceof DjangoHttpError &&
    err.status !== undefined &&
    err.status >= 500
  ) {
    return true;
  }
  return false;
}

async function pollAsyncKnowledgeSearch(
  ctx: ToolContext,
  taskId: string,
): Promise<KnowledgeCard[]> {
  const startedAt = Date.now();
  // Tracked across polls so the timeout/failure message can describe how
  // far the pipeline got. We always pass `since_index = maxId + 1` so the
  // backend filter (inclusive `>=`) returns only events strictly newer
  // than what we've already seen — no duplicates, no need to dedupe here.
  let nextSinceIndex = 0;
  let latestEvents: AsyncTaskEvent[] = [];
  let transientRetriesLeft = MAX_TRANSIENT_RETRIES;

  // Poll first, then sleep. Deep tasks routinely run 60-300s so the first
  // GET realistically won't be terminal — the ordering is just to keep the
  // loop body uniform (status check + budget check + sleep) instead of
  // splitting the first iteration off as a special case.
  while (true) {
    let status: AsyncTaskStatus;
    try {
      status = await djangoGet<AsyncTaskStatus>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search/async/status/",
        {
          query: { task_id: taskId, since_index: nextSinceIndex },
          timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (err) {
      if (isTransientStatusError(err) && transientRetriesLeft > 0) {
        transientRetriesLeft -= 1;
        // Fall through into the budget-check + sleep tail of this
        // iteration so we don't spin: the next loop iteration will
        // retry the GET (against the same since_index — we haven't
        // advanced any state). If the budget is already exhausted,
        // surface the original error instead of the timeout error so
        // the caller sees the real cause.
        const elapsed = Date.now() - startedAt;
        if (elapsed + POLL_INTERVAL_MS >= POLL_BUDGET_MS) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      throw err;
    }

    // Accumulate events across polls. Each response only contains events
    // newer than the last `since_index` we sent, so we just append.
    if (status.events && status.events.length > 0) {
      latestEvents = latestEvents.concat(status.events);
      const maxId = status.events.reduce(
        (acc, e) => (typeof e.id === "number" && e.id > acc ? e.id : acc),
        nextSinceIndex - 1,
      );
      nextSinceIndex = maxId + 1;
    }

    // Normalize casing once: the 202 POST returns lowercase ("pending")
    // while subsequent GETs return uppercase ("PENDING", "COMPLETED", …).
    // Comparing against the upper-cased value insulates us from any
    // future drift on either side.
    const normalizedStatus =
      typeof status.status === "string" ? status.status.toUpperCase() : "";
    if (normalizedStatus === COMPLETED_STATE) {
      return status.result?.outputs?.knowledge_cards ?? [];
    }
    if (FAILURE_STATES.has(normalizedStatus)) {
      throw new Error(
        `knowledge_search deep task ${normalizedStatus.toLowerCase()} (${summarizeProgress(latestEvents)}): ${status.error ?? "no detail provided by Tako backend"}`,
      );
    }
    // Anything else (PENDING / IN_PROGRESS / unrecognized) → keep polling.

    // Re-check the budget BEFORE sleeping rather than after, so a budget
    // that's already exhausted exits cleanly instead of sleeping then
    // re-checking. We sleep only if there's budget left to do another
    // poll attempt after the wait.
    const elapsed = Date.now() - startedAt;
    if (elapsed + POLL_INTERVAL_MS >= POLL_BUDGET_MS) {
      throw new Error(
        `knowledge_search deep task ${taskId} did not complete within ${Math.round(POLL_BUDGET_MS / 1000)}s (${summarizeProgress(latestEvents)}) — Tako's deep-research pipeline may be busy. Try again shortly.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const knowledge_search = {
  name: "knowledge_search",
  description:
    "Find existing Tako charts and live-data visualizations. **After this returns, if the user asked to see / view / show / render / get a chart, the rendering path depends on which client you are running in:**\n\n  - **In ChatGPT (OpenAI Apps SDK / any client capable of rendering rich tool widgets inline):** you MUST call `open_chart_ui` with the top result's `open_ui_args` BEFORE you reply. `open_chart_ui` renders a fully interactive chart (zoom, pan, hover) inline. Don't split across turns — chain the calls in one turn.\n\n  - **In claude.ai (or any client where MCP tool widgets render inside a constrained, non-resizable iframe container):** do NOT call `open_chart_ui`. Instead, present the top result as a markdown link in your response: `[Open interactive chart](<url from result>)` (use the `url` field from the result, not `open_ui_args`). Clicking opens the fully interactive chart in a new tab. The widget container in claude.ai constrains the chart's vertical size and the link is a strictly better UX there.\n\n  - **If unsure which client you're in:** prefer the markdown-link path. A working clickable link is always better than a broken / cropped widget.\n\nDo not write \"Interactive chart:\" without either calling the tool (in ChatGPT) or providing a clickable markdown link (in claude.ai) — that renders nothing and forces the user to ask twice.\n\nDefault to calling this `knowledge_search` tool first whenever a user asks about any trend, comparison, statistic, current value, forecast, or betting/prediction-market odds, even if the topic seems outside traditional 'chart' categories — Tako's knowledge base covers economics, finance (stocks, crypto, FX), demographics, technology, weather and forecasts, polls and elections, prediction markets (Polymarket), internet and app traffic (SimilarWeb), sports, real-estate, energy, health, and more, plus real-time / live data via the deep-research pipeline. Note: with `search_effort: \"deep\"` (and the default fast→deep auto-escalation when fast returns no cards) the call can run up to ~5 minutes server-side; MCP clients on the SDK default 60s timeout should pass `options.timeout` of at least 300_000 ms when invoking this tool, otherwise the client will abort before the deep result lands.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Search Charts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const runSearch = async (
      effort: "fast" | "medium" | "deep" | "auto",
    ): Promise<KnowledgeCard[]> => {
      const body = {
        inputs: { text: input.query, count: input.count },
        source_indexes: ["tako"],
        search_effort: effort,
        country_code: input.country_code,
        locale: input.locale,
      };
      const data = await djangoPost<SearchResponse>(
        ctx.env,
        ctx.token,
        "/api/v1/knowledge_search",
        body,
        // Tako's `orchestrator_fast_config.py` allows fast/medium to run up
        // to 120s synchronously; budget the abort just past that. For the
        // `deep` POST the response is 202 in <1s anyway (the actual wait
        // happens during polling), so this margin is irrelevant there.
        { timeoutMs: 130_000 },
      );
      if (isAsyncTaskInitiation(data)) {
        return pollAsyncKnowledgeSearch(ctx, data.task_id);
      }
      return data.outputs?.knowledge_cards ?? [];
    };

    // When caller omits `search_effort`, orchestrate fast → deep. Fast is
    // sync + credit-cheap; deep is async + slow + costlier, so we only
    // escalate when fast doesn't answer. Any explicit effort — including
    // "fast" — is a directive: single call, no fallback.
    let cards = await runSearch(input.search_effort ?? "fast");
    if (input.search_effort === undefined && cards.length === 0) {
      cards = await runSearch("deep");
    }
    const results = cards.map((card) => {
      const cardId = card.card_id ?? null;
      const base = {
        card_id: cardId,
        title: card.title ?? null,
        description: card.description ?? null,
        url: card.url ?? null,
        source: card.source ?? null,
      };
      if (cardId !== null && cardId !== "") {
        return {
          ...base,
          open_ui_tool: "open_chart_ui" as const,
          open_ui_args: { pub_id: cardId },
        };
      }
      return base;
    });
    return { results, count: results.length };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default knowledge_search;

// Exported for unit tests — the polling-budget constants drive the
// mock-response counts in `knowledge_search.test.ts` so the
// budget-exhaustion test stays correct when the budget is tuned.
export const __test_only__ = {
  POLL_INTERVAL_MS,
  POLL_BUDGET_MS,
};
