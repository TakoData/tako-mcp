/**
 * SSE consumer for Tako's agent progress stream.
 *
 * Counterpart to `django.ts` for the request/response side: that module
 * issues one HTTP call and returns the parsed JSON body; this one opens a
 * long-lived `text/event-stream` connection and yields parsed
 * `StreamEnvelope` objects as they arrive.
 *
 * Wire format (Django side: `app/backend/data/agent/streaming/http_view.py`
 * via `streaming_utils.build_sse`):
 *
 *     data: {"seq":1,"task_id":"...","category":"activity","block":{...}}
 *     <blank line>
 *     data: {"seq":2,...}
 *     <blank line>
 *
 * Each frame is one or more lines separated from the next by `\n\n`. We
 * only act on `data:` lines (any `event:` / `id:` / comment lines are
 * ignored — Django's stream view doesn't emit them today, but the SSE
 * spec allows them and a stricter parser would break on a future addition).
 *
 * Single connection per call. The caller owns reconnection: when the
 * generator returns or throws, re-invoke with `lastSeq` set to the last
 * successfully yielded `seq` and Django replays everything since then
 * from `AsyncTaskStatus.event_log`. Mirrors how `djangoGet` / `djangoPost`
 * make exactly one HTTP attempt and let the caller retry — keeps this
 * module's responsibility narrow and the failure modes greppable.
 *
 * Auth piggybacks on the global DRF auth chain in `app/config/settings/
 * base.py::REST_FRAMEWORK`: `BearerTokenAuthentication` reads the
 * `X-API-Key` header on every view, including this streaming view (it
 * declares `permission_classes = [AllowAny]` and does its own ownership
 * check, but does not override `authentication_classes`). So passing the
 * Tako API token via `X-API-Key` is enough — no Django change needed.
 */
import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "./django.js";
import type { Env } from "./env.js";

/**
 * Parsed SSE frame from the agent stream.
 *
 * `block` is intentionally loose (`{ kind: string } & Record<string,
 * unknown>`) rather than mirroring Django's discriminated union of
 * `ActivityBlock | ContentBlock | ControlBlock`. Consumers narrow on
 * `block.kind` when they care; the helper itself is just a transport
 * and shouldn't drift every time the backend adds a new block kind.
 */
export interface StreamEnvelope {
  seq: number;
  task_id: string;
  category: "activity" | "content" | "control";
  block: { kind: string } & Record<string, unknown>;
}

export interface DjangoStreamOptions {
  /**
   * Resume from a known sequence number. Django replays everything in
   * `AsyncTaskStatus.event_log` with `seq > lastSeq` before tailing the
   * live pub/sub channel, so chained calls don't lose envelopes.
   * Defaults to 0 (full stream from the start).
   */
  lastSeq?: number;
  /**
   * Caller-provided abort signal. The helper stops yielding and tears
   * down the underlying fetch when this fires. The whole point of
   * streaming is "stay open until done", so there's no internal wall-
   * clock cap — bound the call from the caller side instead (see
   * `wait_for_report.ts` for the budget-clamp pattern).
   */
  signal?: AbortSignal;
  /**
   * Bound on how long we'll wait for the *initial* HTTP response (status
   * + headers). Once headers arrive, the stream itself can run as long
   * as `signal` allows. Defaults to 30 s — same as `djangoGet`'s
   * default. Connect-only because applying it to the body read would
   * defeat the purpose of streaming.
   */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Open `GET /api/v1/agent/stream/{taskId}/?last_seq=N` and yield each
 * parsed envelope until the connection ends.
 *
 * Returns naturally on:
 *   - a `kind: "stream_done"` control envelope (the Django view's
 *     normal terminator), which is yielded BEFORE the generator returns
 *     so consumers can react to it;
 *   - the response body closing (defensive — Django should always send
 *     `stream_done`, but a connection drop mid-stream shouldn't hang).
 *
 * Throws on:
 *   - 4xx/5xx response codes — same `DjangoError` subclasses as
 *     `djangoGet` so existing error-handling at the tool boundary
 *     (`djangoErrorToToolResult`) works unchanged;
 *   - `AbortSignal` firing during the connect phase (raised as
 *     `DjangoTimeoutError`);
 *   - malformed envelope JSON in a frame: skipped silently rather than
 *     thrown — losing one envelope is preferable to dropping the rest
 *     of the stream when Django introduces a new block kind.
 */
export async function* streamAgent(
  env: Env,
  token: string,
  taskId: string,
  opts: DjangoStreamOptions = {},
): AsyncGenerator<StreamEnvelope, void, void> {
  const path = `/api/v1/agent/stream/${encodeURIComponent(taskId)}/`;
  const url = buildStreamUrl(env, path, opts.lastSeq);

  const headers = new Headers({
    "X-API-Key": token,
    // Include `*/*` alongside `text/event-stream` so DRF's content
    // negotiation passes — Django's streaming view doesn't declare a
    // `text/event-stream` renderer, and a strict `Accept:
    // text/event-stream` triggers HTTP 406 before the view runs. The
    // `*/*` fallback matches DRF's default renderer, lets the view
    // execute, and the view's `StreamingHttpResponse` then bypasses
    // the renderer pipeline regardless.
    Accept: "text/event-stream, */*",
  });

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const signal = combineSignals(opts.signal, AbortSignal.timeout(connectTimeoutMs));

  // Wrap as a `Request` first (mirrors `django.ts`'s convention) so
  // tests can inspect outgoing calls with `requestFrom(...)` regardless
  // of whether the caller is the request/response client or this
  // streaming client.
  const request = new Request(url, { method: "GET", headers });
  let response: Response;
  try {
    response = await fetch(request, { signal });
  } catch (err) {
    if (isAbortError(err)) {
      throw new DjangoTimeoutError({
        path,
        method: "GET",
        timeoutMs: connectTimeoutMs,
      });
    }
    throw err;
  }

  if (!response.ok) {
    throw mapHttpError(response, path);
  }

  if (response.body === null) {
    // 2xx with no body would be a contract violation (the SSE view
    // always streams). Surface it the same way `djangoGet` surfaces an
    // unparseable success body.
    throw new DjangoResponseParseError({
      path,
      method: "GET",
      status: response.status,
      cause: new Error("response body is null"),
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";

  // ReadableStream is async-iterable in the Workers runtime. Reading
  // chunk-by-chunk lets us yield envelopes as they arrive rather than
  // waiting for the body to close.
  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const envelope = parseFrame(frame);
      if (envelope !== null) {
        yield envelope;
        if (
          envelope.category === "control" &&
          envelope.block.kind === "stream_done"
        ) {
          return;
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  // Trailing partial frame (no closing `\n\n`) is dropped. Django's
  // `build_sse` always appends one, so this only happens on an abrupt
  // connection close — in which case the partial almost certainly isn't
  // valid JSON anyway.
}

/**
 * Parse a single SSE frame (the text between two `\n\n` separators) and
 * return its embedded envelope, or `null` for non-data frames (heartbeat
 * comments, malformed JSON, etc.).
 *
 * SSE allows a frame's `data` field to span multiple lines (each prefixed
 * with `data:`); we join them with `\n` per spec. Django's writer never
 * splits a JSON envelope across lines today, but the parser handles it
 * anyway — cheaper than relying on that assumption.
 */
function parseFrame(frame: string): StreamEnvelope | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    // Per the SSE spec, leading-colon lines are comments — Django
    // doesn't emit them, but other intermediaries (proxies, keep-alive
    // injectors) might. Skip silently.
    if (rawLine.startsWith(":")) continue;
    if (rawLine.startsWith("data: ")) {
      dataLines.push(rawLine.slice(6));
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5));
    }
    // `event:`, `id:`, `retry:`, blank-line padding, etc. are all
    // ignored — we only care about envelope payloads.
  }
  if (dataLines.length === 0) return null;
  const json = dataLines.join("\n");
  if (json.length === 0) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isStreamEnvelope(parsed)) return null;
    return parsed;
  } catch {
    // One bad frame shouldn't kill the whole stream — caller can detect
    // gaps via missing `seq` values if it cares. Logging here would
    // produce one warning per bad frame across a long-running stream,
    // which is too noisy for what's effectively a backend regression.
    return null;
  }
}

/**
 * Structural validation for parsed envelopes. Loose on purpose — we
 * verify the fields we read on (`seq`, `task_id`, `category`, `block`,
 * `block.kind`) and let the rest pass through. A stricter check would
 * have to track every Django block kind, which defeats the point of
 * keeping the wire format additive.
 */
function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Number.isFinite(v.seq) || v.seq < 0) {
    return false;
  }
  if (typeof v.task_id !== "string" || v.task_id.length === 0) return false;
  if (
    v.category !== "activity" &&
    v.category !== "content" &&
    v.category !== "control"
  ) {
    return false;
  }
  if (typeof v.block !== "object" || v.block === null) return false;
  const block = v.block as Record<string, unknown>;
  if (typeof block.kind !== "string" || block.kind.length === 0) return false;
  return true;
}

function buildStreamUrl(env: Env, path: string, lastSeq: number | undefined): string {
  const base = env.DJANGO_BASE_URL;
  if (base === undefined || base === "") {
    throw new Error(
      "DJANGO_BASE_URL is not configured (empty or undefined binding)",
    );
  }
  if (base.endsWith("/")) {
    throw new Error(
      `DJANGO_BASE_URL must not end with a trailing slash (got \`${base}\`)`,
    );
  }
  let url = `${base}${path}`;
  if (lastSeq !== undefined && lastSeq > 0) {
    url += `?last_seq=${lastSeq}`;
  }
  return url;
}

function mapHttpError(response: Response, path: string): DjangoError {
  switch (response.status) {
    case 401:
      return new DjangoUnauthorizedError({ path, method: "GET" });
    case 404:
      return new DjangoNotFoundError({ path, method: "GET" });
    case 400:
      // Read body synchronously-ish; the caller awaits the throw via the
      // generator's iteration, so this is fine.
      return new DjangoBadRequestError({
        path,
        method: "GET",
        body: "", // Body read deferred — see note below.
      });
    default:
      return new DjangoHttpError({
        path,
        method: "GET",
        status: response.status,
        body: "",
      });
  }
  // Note: we don't `await response.text()` here because that would
  // require this to be async, which would in turn force the caller to
  // `await` before iterating. Django returns `{"error": "..."}` JSON on
  // these paths; for now the empty body is acceptable because the error
  // class + status code carry enough signal for the MCP adapter. If a
  // future debugging session needs the body, switch this to async and
  // make the caller `for await` from the start.
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return false;
}

/**
 * Combine an optional caller-provided signal with the connect timeout
 * signal. Either firing aborts the fetch.
 *
 * `AbortSignal.any` is available in modern Workers runtimes (it lands
 * with the WHATWG fetch baseline that Cloudflare ships). Falling back
 * to a manual controller for the case where it isn't — defensive, but
 * cheap.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (caller === undefined) return internal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any).any as
    | ((signals: AbortSignal[]) => AbortSignal)
    | undefined;
  if (typeof anyFn === "function") {
    return anyFn([caller, internal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  caller.addEventListener("abort", onAbort, { once: true });
  internal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
