import {
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  djangoGet,
  djangoPost,
} from "../django.js";
import {
  AGENT_TOOL_NAME,
  AgentInputError,
  type AgentProduct,
  runsPath,
  toBackendRunId,
  toPublicRunId,
} from "./_agent_product.js";
import {
  type AgentRun,
  type AgentRunOutput,
  agentRunSchema,
  projectAgentRun,
  projectRunningRun,
} from "./_agent_run.js";
import { AGENT_CALL_WINDOW_MS, type WaitOutcome, waitForRun } from "./_agent_wait.js";
import { logWireGuardFailure } from "./_log.js";
import { nonEmpty, usageSchema } from "./_search_results.js";
import type { ToolContext } from "./types.js";

/** The inputs both agent tools share: start a run with `query`, or resume one with `run_id`. */
export type AgentCallInput = {
  query?: string | undefined;
  run_id?: string | undefined;
  thread_id?: string | undefined;
};

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_MARGIN_MS = 1_000;

const OTHER_TOOL: Record<AgentProduct, string> = {
  answer: AGENT_TOOL_NAME.company,
  company: AGENT_TOOL_NAME.answer,
};

const RUN_NOT_FOUND_GUIDANCE =
  "No run with that `run_id` for this account. Start a new run with `query`.";

type RunWire = {
  run_id?: string | undefined;
  thread_id?: string | null | undefined;
  status?: string | undefined;
  created_at?: string | undefined;
  result?: unknown;
  error?: unknown;
  usage?: unknown;
};

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
  const otherTool = OTHER_TOOL[product];
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
 * `registeredTools` holds it. Leaves every other error, and a 409 whose body
 * doesn't parse, unchanged. Returns `err`.
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
export function mapResumeError(err: DjangoError, _product: AgentProduct): DjangoError {
  if (err instanceof DjangoNotFoundError || err.status === 403) {
    err.modelGuidance = RUN_NOT_FOUND_GUIDANCE;
  }
  return err;
}

function waitFailedGuidance(publicRunId: string): string {
  return `Run \`${publicRunId}\` started, but waiting on it failed. Call this tool again with run_id=\`${publicRunId}\`; don't start a new run.`;
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

function elapsedS(createdAt: number): number {
  return Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
}

function parseTerminalRun(product: AgentProduct, backendRunId: string, wire: RunWire): AgentRun {
  const tool = AGENT_TOOL_NAME[product];
  const usageGuard = wire.usage == null ? undefined : usageSchema.safeParse(wire.usage);
  if (usageGuard !== undefined && !usageGuard.success) {
    logWireGuardFailure(tool, "usage", usageGuard.error, wire);
  }
  const parsed = agentRunSchema.safeParse({
    run_id: wire.run_id ?? backendRunId,
    thread_id: wire.thread_id ?? null,
    status: wire.status,
    result: wire.result ?? null,
    error: wire.error ?? null,
    usage: usageGuard?.success ? usageGuard.data : null,
  });
  if (!parsed.success) {
    logWireGuardFailure(tool, "resume-normalise", parsed.error, wire);
    throw new Error(`The ${product} agent run endpoint returned an unexpected shape.`);
  }
  return parsed.data;
}

function projectOutcome(
  product: AgentProduct,
  backendRunId: string,
  outcome: WaitOutcome,
  startedAtMs: number,
  knownThreadId: string | undefined,
): AgentRunOutput {
  const publicRunId = toPublicRunId(product, backendRunId);
  if (outcome.kind === "terminal") return projectAgentRun(outcome.run, publicRunId);
  const args: Parameters<typeof projectRunningRun>[0] = {
    toolName: AGENT_TOOL_NAME[product],
    publicRunId,
    elapsedS: elapsedS(startedAtMs),
  };
  const threadId = outcome.threadId ?? knownThreadId;
  if (threadId !== undefined) args.threadId = threadId;
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
    if (err instanceof DjangoNotFoundError || err instanceof DjangoHttpError) {
      mapStartError(err, product, input.thread_id !== undefined, ctx.registeredTools);
    }
    throw err;
  }
  const backendRunId = nonEmpty(started.run_id);
  if (backendRunId === undefined) {
    throw new Error(`The ${product} agent start returned no run_id.`);
  }
  const startedAtMs = createdAtMs(started.created_at);
  const threadId = nonEmpty(started.thread_id);
  try {
    const outcome = await waitForRun(ctx, product, backendRunId, {
      windowMs: remainingMs(deadline),
      createdAtMs: startedAtMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return projectOutcome(product, backendRunId, outcome, startedAtMs, threadId);
  } catch (err) {
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
    const wire = await djangoGet<RunWire>(
      ctx.env,
      ctx.token,
      `${runsPath(product)}/${backendRunId}`,
      { timeoutMs: requestTimeoutMs(deadline), caller: ctx.caller },
    );
    if (wire.status === "completed" || wire.status === "failed") {
      return projectAgentRun(parseTerminalRun(product, backendRunId, wire), publicRunId);
    }
    const startedAtMs = createdAtMs(wire.created_at);
    const outcome = await waitForRun(ctx, product, backendRunId, {
      windowMs: remainingMs(deadline),
      createdAtMs: startedAtMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return projectOutcome(product, backendRunId, outcome, startedAtMs, nonEmpty(wire.thread_id));
  } catch (err) {
    if (err instanceof DjangoNotFoundError || err instanceof DjangoHttpError) {
      mapResumeError(err, product);
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
  const deadline = Date.now() + AGENT_CALL_WINDOW_MS;
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
