/**
 * Tests for `streamAgent` — the SSE consumer that reads Django's agent
 * progress stream and yields parsed envelopes.
 *
 * Locks the contracts the upstream tools (`wait_for_report`) rely on:
 *   1. Each `data: {...}\n\n` frame yields one envelope.
 *   2. A `kind: "stream_done"` envelope is yielded AND ends iteration —
 *      consumers can both react to it and use it as the natural exit.
 *   3. Frame boundaries that happen mid-byte across two chunks reassemble
 *      cleanly (TextDecoder streaming + `\n\n` buffering).
 *   4. 4xx/5xx surface as the same `DjangoError` subclasses as `djangoGet`.
 *   5. The `lastSeq` option lands on the URL as `?last_seq=N`.
 *   6. `X-API-Key` carries the token (auth piggybacks on Django's global
 *      DRF auth chain).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DjangoNotFoundError,
  DjangoUnauthorizedError,
} from "./django.js";
import { streamAgent } from "./django_stream.js";
import type { Env } from "./env.js";

const ENV: Env = { DJANGO_BASE_URL: "https://trytako.com" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build the wire form of a single SSE frame from a JSON envelope. */
function frame(envelope: object): string {
  return `data: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Build a streaming `Response` whose body emits the given chunks in
 * order, then closes. Chunks may straddle SSE frame boundaries — that's
 * deliberate, since we want the parser tested under realistic chunking.
 */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("streamAgent", () => {
  it("yields envelopes from a multi-frame body and stops at stream_done", async () => {
    const body = [
      frame({
        seq: 1,
        task_id: "t",
        category: "activity",
        block: { kind: "status", message: "starting" },
      }),
      frame({
        seq: 2,
        task_id: "t",
        category: "activity",
        block: { kind: "tool_call", id: "tc1", tool: "knowledge_search" },
      }),
      frame({
        seq: 3,
        task_id: "t",
        category: "control",
        block: { kind: "stream_done" },
      }),
      // anything after stream_done is dropped — the generator returns.
      frame({
        seq: 4,
        task_id: "t",
        category: "activity",
        block: { kind: "status", message: "after" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(body)));

    const seen: number[] = [];
    for await (const env of streamAgent(ENV, "tok", "t")) {
      seen.push(env.seq);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("reassembles frames split mid-byte across chunks", async () => {
    // One full envelope, sliced ~halfway through. The parser must hold
    // the partial in its buffer until the rest arrives.
    const full = frame({
      seq: 1,
      task_id: "t",
      category: "activity",
      block: { kind: "status", message: "ok" },
    });
    const half = Math.floor(full.length / 2);
    const done = frame({
      seq: 2,
      task_id: "t",
      category: "control",
      block: { kind: "stream_done" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([full.slice(0, half), full.slice(half), done]),
      ),
    );

    const seen: number[] = [];
    for await (const env of streamAgent(ENV, "tok", "t")) {
      seen.push(env.seq);
    }
    expect(seen).toEqual([1, 2]);
  });

  it("treats the body ending without stream_done as a clean exit (no throw)", async () => {
    // Production Django always emits stream_done, but a connection drop
    // mid-stream shouldn't hang the consumer — body-end is enough to
    // exit. wait_for_report handles the missing-terminator case via its
    // own wall-clock budget anyway.
    const body = [
      frame({
        seq: 1,
        task_id: "t",
        category: "activity",
        block: { kind: "status", message: "interrupted" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(body)));

    const seen: number[] = [];
    for await (const env of streamAgent(ENV, "tok", "t")) {
      seen.push(env.seq);
    }
    expect(seen).toEqual([1]);
  });

  it("throws DjangoUnauthorizedError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauth", { status: 401 })),
    );

    const err = await consume(streamAgent(ENV, "tok", "t")).catch((e) => e);
    expect(err).toBeInstanceOf(DjangoUnauthorizedError);
  });

  it("throws DjangoNotFoundError on 404 (e.g. unknown task_id)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const err = await consume(streamAgent(ENV, "tok", "t")).catch((e) => e);
    expect(err).toBeInstanceOf(DjangoNotFoundError);
  });

  it("appends ?last_seq=N to the URL when lastSeq is provided", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      streamResponse([
        frame({
          seq: 6,
          task_id: "t",
          category: "control",
          block: { kind: "stream_done" },
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await consume(streamAgent(ENV, "tok", "t", { lastSeq: 5 }));

    const req = fetchSpy.mock.calls[0]![0] as Request;
    expect(req.url).toBe("https://trytako.com/api/v1/agent/stream/t/?last_seq=5");
  });

  it("omits ?last_seq when lastSeq is 0 or undefined", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      streamResponse([
        frame({
          seq: 0,
          task_id: "t",
          category: "control",
          block: { kind: "stream_done" },
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await consume(streamAgent(ENV, "tok", "t"));

    const req = fetchSpy.mock.calls[0]![0] as Request;
    expect(req.url).toBe("https://trytako.com/api/v1/agent/stream/t/");
  });

  it("sends X-API-Key header so Django's global auth chain identifies the user", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      streamResponse([
        frame({
          seq: 0,
          task_id: "t",
          category: "control",
          block: { kind: "stream_done" },
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await consume(streamAgent(ENV, "secret-token", "t"));

    const req = fetchSpy.mock.calls[0]![0] as Request;
    expect(req.headers.get("X-API-Key")).toBe("secret-token");
    expect(req.headers.get("Accept")).toBe("text/event-stream, */*");
  });

  it("URL-encodes task_id so unusual characters don't break path parsing", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      streamResponse([
        frame({
          seq: 0,
          task_id: "weird/id",
          category: "control",
          block: { kind: "stream_done" },
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await consume(streamAgent(ENV, "tok", "weird/id"));

    const req = fetchSpy.mock.calls[0]![0] as Request;
    expect(req.url).toBe(
      "https://trytako.com/api/v1/agent/stream/weird%2Fid/",
    );
  });

  it("skips frames whose JSON is malformed instead of aborting the stream", async () => {
    // A future Django regression that emits a malformed envelope
    // shouldn't kill the rest of the stream — losing one progress
    // breadcrumb is strictly better than the user seeing zero progress
    // for the rest of the report run.
    const body = [
      "data: {not valid json\n\n",
      frame({
        seq: 2,
        task_id: "t",
        category: "activity",
        block: { kind: "status", message: "ok" },
      }),
      frame({
        seq: 3,
        task_id: "t",
        category: "control",
        block: { kind: "stream_done" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(body)));

    const seen: number[] = [];
    for await (const env of streamAgent(ENV, "tok", "t")) {
      seen.push(env.seq);
    }
    expect(seen).toEqual([2, 3]);
  });

  it("ignores SSE comment lines (`:keep-alive`) without disrupting frame parsing", async () => {
    const body = [
      ":keep-alive\n\n",
      frame({
        seq: 1,
        task_id: "t",
        category: "activity",
        block: { kind: "status", message: "ok" },
      }),
      frame({
        seq: 2,
        task_id: "t",
        category: "control",
        block: { kind: "stream_done" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(body)));

    const seen: number[] = [];
    for await (const env of streamAgent(ENV, "tok", "t")) {
      seen.push(env.seq);
    }
    expect(seen).toEqual([1, 2]);
  });
});

/** Drain a stream into a list. Used by error-path tests where the order
 * doesn't matter — only that the generator throws (or doesn't). */
async function consume(
  stream: AsyncGenerator<unknown, void, void>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of stream) out.push(item);
  return out;
}
