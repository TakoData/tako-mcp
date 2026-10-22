import { z } from "zod";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoUnauthorizedError,
  djangoGet,
  djangoOpenStream,
} from "../django.js";
import { AGENT_TOOL_NAME, type AgentProduct, runsPath } from "./_agent_product.js";
import { type AgentRun, agentRunSchema } from "./_agent_run.js";
import { logWireGuardFailure } from "./_log.js";
import { nonEmpty, type Usage, usageSchema } from "./_search_results.js";
import type { ToolContext } from "./types.js";

/** How long one agent tool call waits on a run before it returns `running`. */
export const AGENT_CALL_WINDOW_MS = 45_000;
/** The shortest gap between two progress notifications. */
export const PROGRESS_MIN_INTERVAL_MS = 1_000;
/** The silence after which the wait sends a heartbeat notification. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_ERRORS = 2;
const LINE_BREAK = /\r\n|\r|\n/;

const streamEnvelopeSchema = z.looseObject({
  seq: z.number().optional(),
  run_id: z.string(),
  thread_id: z.string().nullable().optional(),
  block: z.looseObject({ kind: z.string() }),
});

/** One event from a run's stream: the backend's envelope around one block. */
export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

/** What a wait ends with: the finished run, or a run still in progress. */
export type WaitOutcome =
  | { kind: "terminal"; run: AgentRun }
  | { kind: "running"; threadId?: string; progress?: string };

type RunWire = {
  run_id?: string | undefined;
  thread_id?: string | null | undefined;
  status?: string | undefined;
  result?: unknown;
  error?: unknown;
  usage?: unknown;
};

/**
 * Parse server-sent event framing into run envelopes.
 *
 * Joins the `data:` lines of each event, ignores other fields and comments,
 * and skips any event whose data isn't a JSON run envelope. An event the
 * stream ends before terminating is dropped. When `signal` aborts, the reader
 * cancels the stream and the generator ends.
 */
export async function* readSseEnvelopes(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEnvelope> {
  const reader = stream.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let lineBreak = LINE_BREAK.exec(buffer);
      while (lineBreak !== null) {
        const crMayStartCrlf = lineBreak[0] === "\r" && lineBreak.index === buffer.length - 1;
        if (crMayStartCrlf && !done) break;
        const line = buffer.slice(0, lineBreak.index);
        buffer = buffer.slice(lineBreak.index + lineBreak[0].length);
        if (line === "") {
          const envelope = parseEnvelope(dataLines);
          dataLines = [];
          if (envelope !== undefined) yield envelope;
        } else {
          const data = dataFieldValue(line);
          if (data !== undefined) dataLines.push(data);
        }
        lineBreak = LINE_BREAK.exec(buffer);
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

function dataFieldValue(line: string): string | undefined {
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  if (field !== "data") return undefined;
  if (colon === -1) return "";
  const value = line.slice(colon + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseEnvelope(dataLines: string[]): StreamEnvelope | undefined {
  if (dataLines.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return undefined;
  }
  const envelope = streamEnvelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data : undefined;
}

class ProgressRelay {
  private latest: string | undefined;
  private lastSentText: string | undefined;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly createdAtMs: number,
  ) {
    this.armHeartbeat();
  }

  get text(): string | undefined {
    return this.latest;
  }

  update(message: string): void {
    if (this.stopped) return;
    this.latest = message;
    if (this.trailingTimer !== undefined) return;
    const waitMs = this.lastSentAt + PROGRESS_MIN_INTERVAL_MS - Date.now();
    if (waitMs <= 0) {
      this.sendLatest();
      return;
    }
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = undefined;
      this.sendLatest();
    }, waitMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.trailingTimer);
    clearTimeout(this.heartbeatTimer);
  }

  private sendLatest(): void {
    if (this.latest === undefined || this.latest === this.lastSentText) return;
    this.lastSentText = this.latest;
    this.send(this.latest);
  }

  private elapsedS(): number {
    return Math.max(0, Math.floor((Date.now() - this.createdAtMs) / 1000));
  }

  private send(message: string): void {
    if (this.stopped) return;
    this.lastSentAt = Date.now();
    this.armHeartbeat();
    const elapsedS = this.elapsedS();
    Promise.resolve()
      .then(() => (this.stopped ? undefined : this.ctx.sendProgress(elapsedS, { message })))
      .catch((err: unknown) => {
        console.warn("[tako] agent progress notification failed:", err);
      });
  }

  private armHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.send(`Still working (${this.elapsedS()} s): ${this.latest ?? "starting"}`);
    }, HEARTBEAT_INTERVAL_MS);
  }
}

function isClientError(err: unknown): boolean {
  if (
    err instanceof DjangoNotFoundError ||
    err instanceof DjangoUnauthorizedError ||
    err instanceof DjangoBadRequestError
  ) {
    return true;
  }
  if (!(err instanceof DjangoHttpError) || err.status === undefined) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

function isTerminal(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

function parseRun(product: AgentProduct, backendRunId: string, wire: RunWire): AgentRun | undefined {
  const tool = AGENT_TOOL_NAME[product];
  let usage: Usage | null = null;
  if (wire.usage != null) {
    const usageGuard = usageSchema.safeParse(wire.usage);
    if (usageGuard.success) usage = usageGuard.data;
    else logWireGuardFailure(tool, "usage", usageGuard.error, wire);
  }
  const parsed = agentRunSchema.safeParse({
    run_id: wire.run_id ?? backendRunId,
    thread_id: wire.thread_id ?? null,
    status: wire.status ?? "running",
    result: wire.result ?? null,
    error: wire.error ?? null,
    usage,
  });
  if (!parsed.success) {
    logWireGuardFailure(tool, "wait-normalise", parsed.error, wire);
    return undefined;
  }
  return parsed.data;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Wait on a backend agent run for up to `opts.windowMs`.
 *
 * Reads the run's event stream and relays its status text through
 * `ctx.sendProgress`, at most once per `PROGRESS_MIN_INTERVAL_MS`, with a
 * heartbeat after `HEARTBEAT_INTERVAL_MS` of silence. Progress values are whole
 * seconds since `opts.createdAtMs`. Returns `terminal` once the stream's
 * `run_summary` arrives. If the stream breaks first, polls the run's JSON
 * resource every 5 s for the rest of the window. Returns `running` when the
 * window ends, when `opts.signal` aborts, or when the poll fails three times in
 * a row; it never cancels the run. Throws the `DjangoError` for any 4xx from the
 * backend except 408 and 429.
 */
export async function waitForRun(
  ctx: ToolContext,
  product: AgentProduct,
  backendRunId: string,
  opts: { windowMs: number; createdAtMs: number; signal?: AbortSignal },
): Promise<WaitOutcome> {
  const deadline = Date.now() + opts.windowMs;
  const callWindow = new AbortController();
  const windowTimer = setTimeout(() => callWindow.abort(), opts.windowMs);
  const progress = new ProgressRelay(ctx, opts.createdAtMs);
  const onClientAbort = (): void => {
    progress.stop();
    callWindow.abort();
  };
  if (opts.signal?.aborted) onClientAbort();
  else opts.signal?.addEventListener("abort", onClientAbort, { once: true });

  const seen: { threadId?: string } = {};
  const noteThread = (threadId: string | null | undefined): void => {
    const id = nonEmpty(threadId);
    if (id !== undefined) seen.threadId = id;
  };
  const path = `${runsPath(product)}/${backendRunId}`;

  const finish = (run: AgentRun): WaitOutcome => {
    console.log(`[tako] agent run terminal run_id=${backendRunId} status=${run.status}`);
    return { kind: "terminal", run };
  };

  try {
    const streamed = await readRunStream();
    if (streamed !== undefined) return finish(streamed);
    const polled = await pollRun();
    if (polled !== undefined) return finish(polled);
    const running: WaitOutcome = { kind: "running" };
    if (seen.threadId !== undefined) running.threadId = seen.threadId;
    if (progress.text !== undefined) running.progress = progress.text;
    return running;
  } finally {
    clearTimeout(windowTimer);
    opts.signal?.removeEventListener("abort", onClientAbort);
    progress.stop();
    callWindow.abort();
  }

  async function readRunStream(): Promise<AgentRun | undefined> {
    if (callWindow.signal.aborted) return undefined;
    let result: unknown = null;
    let sawResult = false;
    try {
      const stream = await djangoOpenStream(ctx.env, ctx.token, path, {
        caller: ctx.caller,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, opts.windowMs),
        signal: callWindow.signal,
      });
      for await (const envelope of readSseEnvelopes(stream, callWindow.signal)) {
        if (callWindow.signal.aborted) return undefined;
        noteThread(envelope.thread_id);
        const block = envelope.block;
        switch (block.kind) {
          case "status": {
            const message = nonEmpty(block.message);
            if (message !== undefined) progress.update(message);
            break;
          }
          case "tool_call": {
            const message = nonEmpty(block.status_message);
            if (message !== undefined && block.done === false) progress.update(message);
            break;
          }
          case "agent_result":
            result = block.data ?? null;
            sawResult = true;
            break;
          case "run_summary": {
            const status = typeof block.status === "string" ? block.status : undefined;
            if (!isTerminal(status) || (status === "completed" && !sawResult)) return undefined;
            return parseRun(product, backendRunId, {
              run_id: backendRunId,
              thread_id: seen.threadId ?? null,
              status,
              result,
              error: block.error,
              usage: block.usage,
            });
          }
          case "stream_reset":
            return undefined;
        }
      }
    } catch (err) {
      if (callWindow.signal.aborted) return undefined;
      if (isClientError(err)) throw err;
      console.warn(`[tako] agent stream broke run_id=${backendRunId}; polling instead:`, err);
    }
    return undefined;
  }

  async function pollRun(): Promise<AgentRun | undefined> {
    let transient = 0;
    while (!callWindow.signal.aborted) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return undefined;
      let wire: RunWire | undefined;
      try {
        wire = await abortable(
          djangoGet<RunWire>(ctx.env, ctx.token, path, {
            caller: ctx.caller,
            timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs),
          }),
          callWindow.signal,
        );
        transient = 0;
      } catch (err) {
        if (isClientError(err)) throw err;
        transient += 1;
        console.warn(
          `[tako] agent poll transient error run_id=${backendRunId} attempt=${transient}/${MAX_TRANSIENT_ERRORS}:`,
          err,
        );
        if (transient > MAX_TRANSIENT_ERRORS) return undefined;
      }
      if (callWindow.signal.aborted) return undefined;
      if (wire !== undefined) {
        noteThread(wire.thread_id);
        if (!agentRunSchema.shape.status.safeParse(wire.status).success) {
          logWireGuardFailure(AGENT_TOOL_NAME[product], "poll-status", undefined, wire);
          throw new Error(`The ${product} agent run endpoint returned an unexpected shape.`);
        }
        if (isTerminal(wire.status)) {
          const run = parseRun(product, backendRunId, wire);
          if (run === undefined) {
            throw new Error(`The ${product} agent run endpoint returned an unexpected shape.`);
          }
          return run;
        }
      }
      await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), callWindow.signal);
    }
    return undefined;
  }
}
