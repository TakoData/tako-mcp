import { z } from "zod";

import {
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoTimeoutError,
  djangoPost,
} from "../django.js";
import {
  AGENT_TOOL_NAME,
  AgentInputError,
  type AgentProduct,
  otherToolName,
  runsPath,
  toBackendRunId,
  toPublicRunId,
} from "./_agent_product.js";
import {
  type AgentRunOutput,
  type AgentRunWireLike,
  agentRunCharts,
  projectAgentRun,
  projectRunningRun,
} from "./_agent_run.js";
import {
  AGENT_CALL_WINDOW_MS,
  AgentWireDriftError,
  elapsedS,
  isTerminal,
  parseRun,
  readRun,
  type RunWire,
  type WaitOutcome,
  waitForRun,
} from "./_agent_wait.js";
import { buildChartExtraMeta, PNG_HEAD_FETCH_TIMEOUT_MS } from "./_chart_widget.js";
import { nonEmpty, withTopChartDims } from "./_search_results.js";
import type { FixedInput, ToolContext } from "./types.js";

/** The inputs both agent tools share: start a run with `query`, or resume one with `run_id`. */
export type AgentCallInput = {
  query?: string | undefined;
  run_id?: string | undefined;
  thread_id?: string | undefined;
};

const AGENT_CALL_WINDOW_SENTENCE = `A call returns within ${AGENT_CALL_WINDOW_MS / 1000} s. If \`status\` is \`running\`, call again with \`run_id\`; don't start a new run.`;

/** The description sentence that keeps each card's Tako page link in the model's reply. */
export const AGENT_CARD_LINK_SENTENCE = "In your reply, link each card's `url`; the full list or chart lives on that page.";

/** The description line both agent tools end with. */
export const AGENT_DESCRIPTION_LAST_LINE = `${AGENT_CALL_WINDOW_SENTENCE} ${AGENT_CARD_LINK_SENTENCE}`;

/** The `query` input both agent tools take. */
export const agentQueryInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The question to research, in natural language. Ask one question per call; the agent plans its own sub-steps. Send `query` or `run_id`, not both.",
  );

/** The `thread_id` input both agent tools take. */
export const agentThreadIdInput = z
  .uuid()
  .optional()
  .describe(
    "A `thread_id` from an earlier run. Pass it back to ask a follow-up in that conversation; omit it to start a new one.",
  );

/** The Worker-side call window, as both agent tools publish it. */
export const AGENT_CALL_WINDOW_FIXED_INPUT: FixedInput = {
  field: "call window",
  value: `${AGENT_CALL_WINDOW_MS / 1000} s`,
  note: "A call returns within the window; resume a running run with run_id.",
  scope: "worker",
};

const LOOKUP_TOOL = "tako_search";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_MARGIN_MS = 1_000;

const UNCONFIRMED_START_STATUS = new Set([408, 502, 503, 504]);

const UNCONFIRMED_START_GUIDANCE =
  "Tako didn't confirm that the run started, but it may have. Calling again with `query` can start and bill a second run, so ask the user before you retry.";

const RUN_NOT_FOUND_GUIDANCE =
  "No run with that `run_id` for this account. Start a new run with `query`.";

function conflictCode(err: DjangoHttpError): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const code = (parsed as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function threadProductMismatchGuidance(
  product: AgentProduct,
  registeredTools: ReadonlySet<string> | undefined,
): string {
  const otherTool = otherToolName(product);
  if (registeredTools?.has(otherTool) !== true) {
    return "This thread belongs to a different agent. Omit `thread_id` to start a new conversation.";
  }
  return `This thread belongs to \`${otherTool}\`. Use that tool, or omit \`thread_id\`.`;
}

function conflictGuidance(
  code: string | undefined,
  product: AgentProduct,
  registeredTools: ReadonlySet<string> | undefined,
): string | undefined {
  switch (code) {
    case "conflict":
      return "A run is still going on this thread. Call this tool again with that run's `run_id` to keep waiting. If you don't have it, omit `thread_id` to start a new conversation.";
    case "effort_mismatch":
      return "This thread's effort is fixed. Omit `effort` to keep the thread's tier, or omit `thread_id` to start a new thread at a different effort.";
    case "source_indexes_mismatch":
      return "This thread's sources are fixed. Omit `sources` to keep them, or omit `thread_id` to start a new thread.";
    case "thread_product_mismatch":
      return threadProductMismatchGuidance(product, registeredTools);
    default:
      return undefined;
  }
}

/**
 * Set the model-facing guidance for an error from starting a run.
 *
 * Maps a 404 to thread-not-found when the request sent a `thread_id`, or to
 * "unavailable" for the company product when it didn't. Maps a 409 by its
 * `code`; a `thread_product_mismatch` names the other agent tool only when
 * `registeredTools` holds it. Maps a timeout, a 408, or a 502, 503, or 504,
 * after which the run may exist, to ask-before-retry. Leaves every other
 * error, and a 409 whose body doesn't parse, unchanged. Returns `err`.
 */
export function mapStartError(
  err: DjangoError,
  product: AgentProduct,
  sentThreadId: boolean,
  registeredTools?: ReadonlySet<string>,
): DjangoError {
  if (err instanceof DjangoNotFoundError) {
    if (sentThreadId) {
      err.modelGuidance = "Thread not found. Omit `thread_id` to start a new conversation.";
    } else if (product === "company") {
      err.modelGuidance = "The company agent isn't available for this account.";
    }
    return err;
  }
  if (
    err instanceof DjangoTimeoutError ||
    (err.status !== undefined && UNCONFIRMED_START_STATUS.has(err.status))
  ) {
    err.modelGuidance = UNCONFIRMED_START_GUIDANCE;
    return err;
  }
  if (err instanceof DjangoHttpError && err.status === 409) {
    const guidance = conflictGuidance(conflictCode(err), product, registeredTools);
    if (guidance !== undefined) err.modelGuidance = guidance;
  }
  return err;
}

/**
 * Set the model-facing guidance for an error from resuming a run.
 *
 * Maps a 404, or a 403 for a run that belongs to someone else, to
 * run-not-found. Leaves every other error unchanged. Returns `err`.
 */
export function mapResumeError(err: DjangoError): DjangoError {
  if (err instanceof DjangoNotFoundError || err.status === 403) {
    err.modelGuidance = RUN_NOT_FOUND_GUIDANCE;
  }
  return err;
}

function waitFailedGuidance(publicRunId: string): string {
  return `Run \`${publicRunId}\` started, but waiting on it failed. Call this tool again with run_id=\`${publicRunId}\`; don't start a new run.`;
}

function callDeadline(ctx: ToolContext): number {
  const chartMetaReserveMs = ctx.surface === "chatgpt" ? PNG_HEAD_FETCH_TIMEOUT_MS : 0;
  return Date.now() + AGENT_CALL_WINDOW_MS - chartMetaReserveMs;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function requestTimeoutMs(deadline: number): number {
  return Math.min(REQUEST_TIMEOUT_MS, Math.max(0, remainingMs(deadline) - REQUEST_MARGIN_MS));
}

function createdAtMs(createdAt: string | undefined): number {
  const parsed = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function refusalLookupTool(ctx: ToolContext, product: AgentProduct): string | undefined {
  return product === "answer" && ctx.registeredTools?.has(LOOKUP_TOOL) === true
    ? LOOKUP_TOOL
    : undefined;
}

function projectTerminalRun(
  ctx: ToolContext,
  product: AgentProduct,
  run: AgentRunWireLike,
  publicRunId: string,
): AgentRunOutput {
  return {
    ...projectAgentRun(run, publicRunId, refusalLookupTool(ctx, product)),
    charts: agentRunCharts(run, ctx.env),
  };
}

function projectOutcome(
  ctx: ToolContext,
  product: AgentProduct,
  backendRunId: string,
  outcome: WaitOutcome,
  startedAtMs: number,
): AgentRunOutput {
  const publicRunId = toPublicRunId(product, backendRunId);
  if (outcome.kind === "terminal") {
    return projectTerminalRun(ctx, product, outcome.run, publicRunId);
  }
  const args: Parameters<typeof projectRunningRun>[0] = {
    toolName: AGENT_TOOL_NAME[product],
    publicRunId,
    elapsedS: elapsedS(startedAtMs),
  };
  if (outcome.progress !== undefined) args.progress = outcome.progress;
  return projectRunningRun(args);
}

async function startRun(
  ctx: ToolContext,
  product: AgentProduct,
  input: AgentCallInput,
  startBody: () => unknown,
  deadline: number,
): Promise<AgentRunOutput> {
  let started: RunWire;
  try {
    started = await djangoPost<RunWire>(ctx.env, ctx.token, runsPath(product), startBody(), {
      timeoutMs: requestTimeoutMs(deadline),
      caller: ctx.caller,
    });
  } catch (err) {
    if (err instanceof DjangoError) {
      mapStartError(err, product, input.thread_id !== undefined, ctx.registeredTools);
    }
    throw err;
  }
  const backendRunId = nonEmpty(started.run_id);
  if (backendRunId === undefined) {
    throw new Error(`The ${product} agent start returned no run_id.`);
  }
  const startedAtMs = createdAtMs(started.created_at);
  try {
    const outcome = await waitForRun(ctx, product, backendRunId, {
      windowMs: remainingMs(deadline),
      createdAtMs: startedAtMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return projectOutcome(ctx, product, backendRunId, outcome, startedAtMs);
  } catch (err) {
    if (err instanceof AgentWireDriftError) throw err;
    const guidance = waitFailedGuidance(toPublicRunId(product, backendRunId));
    if (err instanceof DjangoError) {
      err.modelGuidance = guidance;
      throw err;
    }
    throw new Error(guidance, { cause: err });
  }
}

async function resumeRun(
  ctx: ToolContext,
  product: AgentProduct,
  publicRunId: string,
  deadline: number,
): Promise<AgentRunOutput> {
  const backendRunId = toBackendRunId(product, publicRunId);
  try {
    const wire = await readRun(ctx, product, backendRunId, requestTimeoutMs(deadline));
    if (isTerminal(wire.status)) {
      return projectTerminalRun(ctx, product, parseRun(product, backendRunId, wire), publicRunId);
    }
    const startedAtMs = createdAtMs(wire.created_at);
    const outcome = await waitForRun(ctx, product, backendRunId, {
      windowMs: remainingMs(deadline),
      createdAtMs: startedAtMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return projectOutcome(ctx, product, backendRunId, outcome, startedAtMs);
  } catch (err) {
    if (err instanceof DjangoNotFoundError || err instanceof DjangoHttpError) {
      mapResumeError(err);
    }
    throw err;
  }
}

/**
 * Start an agent run with `query`, or resume one with `run_id`, and return
 * within `AGENT_CALL_WINDOW_MS` of the call's start. The start or resume
 * request counts against that window.
 *
 * Returns the finished run, or a `running` result that carries the prefixed
 * `run_id` to resume with. Throws `AgentInputError` unless exactly one of
 * `query` and `run_id` is set. A resume of a run that already finished returns
 * it without opening a stream. Never cancels a run. Sets `modelGuidance` on the
 * `DjangoError`s it rethrows; see `mapStartError` and `mapResumeError`.
 */
export async function runAgentCall(
  ctx: ToolContext,
  product: AgentProduct,
  input: AgentCallInput,
  startBody: () => unknown,
): Promise<AgentRunOutput> {
  const deadline = callDeadline(ctx);
  const hasQuery = input.query !== undefined;
  const hasRunId = input.run_id !== undefined;
  if (hasQuery === hasRunId) {
    throw new AgentInputError(
      "Send exactly one of `query` (start a run) or `run_id` (keep waiting for a run).",
    );
  }
  if (input.run_id !== undefined) return resumeRun(ctx, product, input.run_id, deadline);
  return startRun(ctx, product, input, startBody, deadline);
}

/**
 * The `_meta` both agent tools ship where the chart widget is live: every
 * renderable card as `charts`, with PNG dimensions on the first one when the
 * ranged read succeeds. Returns `{ charts: [] }` for a finished run with no
 * renderable card, and `undefined` for a `running` result.
 */
export async function agentChartsMeta(
  output: AgentRunOutput,
  ctx: ToolContext,
): Promise<Record<string, unknown> | undefined> {
  if (output.status === "running") return undefined;
  const charts = output.charts ?? [];
  const top = charts[0];
  if (top === undefined) return { charts: [] };
  const topMeta = await buildChartExtraMeta(top.image_url, {
    bakeImage: ctx.surface !== "chatgpt",
    env: ctx.env,
    origin: ctx.origin,
    pubId: top.pub_id,
  });
  return { ...topMeta, charts: withTopChartDims(charts, top.pub_id, topMeta) };
}
