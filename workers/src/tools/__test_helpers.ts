/**
 * Shared vitest helpers for tool tests.
 *
 * Every tool handler reaches Django via `fetch`; every tool test therefore
 * wants the same two affordances — stub `fetch` with a scripted sequence of
 * `Response`s, and inspect the outgoing `Request`s after the fact.
 *
 * Kept as a plain `.ts` module (not `.test.ts`) so vitest does NOT pick it
 * up as a suite of its own. The leading `__` mirrors the convention used
 * for pytest / jest fixture modules and keeps it visually separate from
 * the real tools at the top of `ls`.
 */
import { vi } from "vitest";

/** Stub `fetch` to return a single pre-built `Response` on every call. */
export function mockFetchOnce(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => response),
  );
}

/**
 * Stub `fetch` with an FIFO queue of `Response`s. The returned mock is
 * what the test uses to assert call count and recover `.mock.calls`.
 * Exhausting the queue throws — a loud failure beats silently hanging
 * the test when the handler makes more calls than expected.
 */
export function mockFetchSequence(
  responses: Response[],
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queue = [...responses];
  const fn = vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("mockFetchSequence: no more responses queued");
    }
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Build a JSON `Response` with the given status and body. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Recover the `Request` passed to a recorded `fetch` call. `djangoPost`
 * / `djangoGet` always pass a `Request` object as the first arg, so the
 * signature is stable; this helper just unpacks and narrows the type.
 */
export function requestFrom(
  call: Parameters<typeof fetch> | undefined,
): Request {
  if (call === undefined) {
    throw new Error("expected a recorded fetch call, got undefined");
  }
  const [input] = call;
  if (!(input instanceof Request)) {
    throw new Error("expected fetch to be called with a Request");
  }
  return input;
}

/** Read a request's body as a JSON object (most POSTs in this codebase). */
export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>;
}
