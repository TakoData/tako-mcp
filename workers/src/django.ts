/**
 * Typed HTTP client for the Tako Django backend.
 *
 * Every MCP tool handler eventually hits Django via this module. The
 * client injects the user's Bearer token as `X-API-Key` (Django's
 * expected header — see `src/tako_mcp/server.py::_get_auth_header`
 * in the legacy Python implementation) and `Content-Type: application/json`
 * on bodied requests.
 *
 * Timeouts default to 30 s (matching the legacy Python default) but
 * are overridable per call — some endpoints legitimately take longer
 * (e.g. insights at 90 s in the legacy code).
 *
 * Error classification is intentionally coarse: we split on the HTTP
 * status codes Phase 2 tool wiring cares about (400 / 401 / 404 /
 * timeout) and lump everything else into `DjangoHttpError`. Retries
 * are explicitly out of scope for this ticket.
 */

import type { Env } from "./env";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Upper bound on how much of an error-response body we read into memory.
 *
 * A hostile or misconfigured upstream could otherwise return an
 * arbitrarily large body and force us to allocate it all — and Phase 2
 * will log these bodies, so an unbounded read would also flood Workers
 * logs. 8 KiB is plenty for Django's DRF validation errors (typically
 * a few hundred bytes of JSON).
 */
const ERROR_BODY_MAX_BYTES = 8192;
const ERROR_BODY_TRUNCATED_SUFFIX = "...[truncated]";

type HttpMethod = "GET" | "POST";

export interface DjangoRequestOptions {
  /** Serialized into a `?a=1&b=two` query string via URLSearchParams. */
  query?: Record<string, string | number | boolean>;
  /** Abort threshold in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

export type DjangoGetOptions = DjangoRequestOptions;

export interface DjangoPostOptions {
  timeoutMs?: number;
}

/**
 * Base class for all Django transport errors. Carrying `path` and
 * `method` on every error makes Phase 2 tool-level logging trivial —
 * a handler can log `err.method err.path` without inspecting the
 * original request.
 */
export abstract class DjangoError extends Error {
  readonly path: string;
  readonly method: HttpMethod;
  /** HTTP status, or `undefined` for transport errors (e.g. timeout). */
  readonly status: number | undefined;

  constructor(
    message: string,
    opts: { path: string; method: HttpMethod; status?: number },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.path = opts.path;
    this.method = opts.method;
    this.status = opts.status;
  }
}

export class DjangoNotFoundError extends DjangoError {
  constructor(opts: { path: string; method: HttpMethod }) {
    super(`Django returned 404 for ${opts.method} ${opts.path}`, {
      ...opts,
      status: 404,
    });
  }
}

export class DjangoBadRequestError extends DjangoError {
  /** Response body as a string — useful for surfacing validation errors. */
  readonly body: string;

  constructor(opts: { path: string; method: HttpMethod; body: string }) {
    super(
      `Django returned 400 for ${opts.method} ${opts.path}: ${opts.body}`,
      { path: opts.path, method: opts.method, status: 400 },
    );
    this.body = opts.body;
  }
}

export class DjangoUnauthorizedError extends DjangoError {
  constructor(opts: { path: string; method: HttpMethod }) {
    super(`Django returned 401 for ${opts.method} ${opts.path}`, {
      ...opts,
      status: 401,
    });
  }
}

export class DjangoTimeoutError extends DjangoError {
  readonly timeoutMs: number;

  constructor(opts: { path: string; method: HttpMethod; timeoutMs: number }) {
    super(
      `Django ${opts.method} ${opts.path} timed out after ${opts.timeoutMs}ms`,
      { path: opts.path, method: opts.method },
    );
    this.timeoutMs = opts.timeoutMs;
  }
}

/** Catch-all for non-2xx responses that don't fit one of the specific cases. */
export class DjangoHttpError extends DjangoError {
  readonly body: string;

  constructor(opts: {
    path: string;
    method: HttpMethod;
    status: number;
    body: string;
  }) {
    super(
      `Django returned ${opts.status} for ${opts.method} ${opts.path}: ${opts.body}`,
      { path: opts.path, method: opts.method, status: opts.status },
    );
    this.body = opts.body;
  }
}

/* ------------------------------------------------------------------ */
/* Public helpers                                                     */
/* ------------------------------------------------------------------ */

export async function djangoGet<T>(
  env: Env,
  token: string,
  path: string,
  opts: DjangoGetOptions = {},
): Promise<T> {
  const url = buildUrl(env, path, opts.query);
  const headers = new Headers({
    "X-API-Key": token,
  });
  return executeRequest<T>(
    new Request(url, { method: "GET", headers }),
    { path, method: "GET", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}

export async function djangoPost<T>(
  env: Env,
  token: string,
  path: string,
  body: unknown,
  opts: DjangoPostOptions = {},
): Promise<T> {
  const url = buildUrl(env, path);
  const headers = new Headers({
    "X-API-Key": token,
    "Content-Type": "application/json",
  });
  return executeRequest<T>(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { path, method: "POST", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function buildUrl(
  env: Env,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  // Validate the base URL up-front. An empty / missing binding would
  // otherwise produce a URL like `/api/v1/x` (which is not a legal
  // absolute URL for `new Request(...)`) and a trailing slash would
  // produce `//api/v1/x` (wrong origin interpretation). We fail loud
  // here rather than silently forwarding broken requests to Django.
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
  // `path` is expected to start with `/api/v1/...`. We require the
  // leading slash so concatenation produces a well-formed URL (the
  // alternative would be silent corruption like
  // `https://trytako.comapi/v1/x`).
  if (!path.startsWith("/")) {
    throw new Error(
      `django path must start with \`/\` (got \`${path}\`)`,
    );
  }
  let url = `${base}${path}`;
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs.length > 0) {
      url += `?${qs}`;
    }
  }
  return url;
}

async function executeRequest<T>(
  request: Request,
  ctx: { path: string; method: HttpMethod; timeoutMs: number },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(request, {
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new DjangoTimeoutError({
        path: ctx.path,
        method: ctx.method,
        timeoutMs: ctx.timeoutMs,
      });
    }
    throw err;
  }

  if (response.ok) {
    return (await response.json()) as T;
  }

  // Only read the body for error types that actually surface it —
  // `DjangoNotFoundError` and `DjangoUnauthorizedError` don't expose
  // the body, so reading it would be wasted work.
  switch (response.status) {
    case 401:
      throw new DjangoUnauthorizedError({
        path: ctx.path,
        method: ctx.method,
      });
    case 404:
      throw new DjangoNotFoundError({
        path: ctx.path,
        method: ctx.method,
      });
    case 400:
      throw new DjangoBadRequestError({
        path: ctx.path,
        method: ctx.method,
        body: await safeReadText(response),
      });
    default:
      throw new DjangoHttpError({
        path: ctx.path,
        method: ctx.method,
        status: response.status,
        body: await safeReadText(response),
      });
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return false;
}

async function safeReadText(response: Response): Promise<string> {
  // Cap the body read at `ERROR_BODY_MAX_BYTES`. A hostile or
  // misconfigured upstream could otherwise return an arbitrarily large
  // body and force us to allocate it all (and Phase 2 logs these). If
  // the body exceeds the cap, we append `...[truncated]` so callers /
  // logs can tell the signal from the noise. We call `response.text()`
  // and slice the string rather than streaming bytes — JS strings are
  // UTF-16 code units so the cap is approximate, not exact, but it's
  // bounded and cheap.
  try {
    const text = await response.text();
    if (text.length <= ERROR_BODY_MAX_BYTES) {
      return text;
    }
    return text.slice(0, ERROR_BODY_MAX_BYTES) + ERROR_BODY_TRUNCATED_SUFFIX;
  } catch {
    return "";
  }
}
