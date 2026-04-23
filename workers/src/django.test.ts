import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
  djangoGet,
  djangoPost,
} from "./django";

const BASE_URL = "https://trytako.com";
const ENV: Env = { DJANGO_BASE_URL: BASE_URL };
const TOKEN = "sk-test-token";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function mockFetchOnce(response: Response): FetchMock {
  const mock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("djangoGet", () => {
  it("sends X-API-Key, hits BASE_URL+path, and parses JSON", async () => {
    const fetchMock = mockFetchOnce(jsonResponse(200, { hello: "world" }));

    const result = await djangoGet<{ hello: string }>(
      ENV,
      TOKEN,
      "/api/v1/knowledge_search",
    );

    expect(result).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toBe(`${BASE_URL}/api/v1/knowledge_search`);
    expect(req.method).toBe("GET");
    expect(req.headers.get("x-api-key")).toBe(TOKEN);
  });

  it("concatenates base URL + path without producing double slashes", async () => {
    mockFetchOnce(jsonResponse(200, {}));
    const envTrailing: Env = { DJANGO_BASE_URL: BASE_URL };
    await djangoGet(envTrailing, TOKEN, "/api/v1/x");
    const req = (globalThis.fetch as unknown as FetchMock).mock.calls[0]![0] as Request;
    // Exactly one slash between origin and `/api/v1/x`:
    expect(req.url).toBe(`${BASE_URL}/api/v1/x`);
    expect(req.url).not.toMatch(/trytako\.com\/\/api/);
  });

  it("serializes query params in URLSearchParams order and coerces numbers/booleans", async () => {
    mockFetchOnce(jsonResponse(200, {}));
    await djangoGet(ENV, TOKEN, "/api/v1/x", {
      query: { a: 1, b: "two", c: true },
    });
    const req = (globalThis.fetch as unknown as FetchMock).mock.calls[0]![0] as Request;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/v1/x");
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("b")).toBe("two");
    expect(url.searchParams.get("c")).toBe("true");
  });

  it("throws DjangoNotFoundError on 404", async () => {
    mockFetchOnce(new Response("nope", { status: 404 }));
    const err = await djangoGet(ENV, TOKEN, "/api/v1/missing").catch((e) => e);
    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect(err).toBeInstanceOf(DjangoError);
    expect((err as DjangoNotFoundError).status).toBe(404);
    expect((err as DjangoNotFoundError).path).toBe("/api/v1/missing");
    expect((err as DjangoNotFoundError).method).toBe("GET");
  });

  it("throws DjangoBadRequestError on 400 carrying the body", async () => {
    mockFetchOnce(new Response("bad field: foo", { status: 400 }));
    const err = await djangoGet(ENV, TOKEN, "/api/v1/x").catch((e) => e);
    expect(err).toBeInstanceOf(DjangoBadRequestError);
    expect((err as DjangoBadRequestError).status).toBe(400);
    expect((err as DjangoBadRequestError).body).toBe("bad field: foo");
  });

  it("throws DjangoUnauthorizedError on 401", async () => {
    mockFetchOnce(new Response("unauthorized", { status: 401 }));
    const err = await djangoGet(ENV, TOKEN, "/api/v1/x").catch((e) => e);
    expect(err).toBeInstanceOf(DjangoUnauthorizedError);
    expect((err as DjangoUnauthorizedError).status).toBe(401);
  });

  it("throws DjangoHttpError with status=500 for other non-2xx responses", async () => {
    mockFetchOnce(new Response("boom", { status: 500 }));
    const err = await djangoGet(ENV, TOKEN, "/api/v1/x").catch((e) => e);
    expect(err).toBeInstanceOf(DjangoHttpError);
    // Sanity: DjangoHttpError is the catch-all and must NOT be one of
    // the specific subclasses.
    expect(err).not.toBeInstanceOf(DjangoNotFoundError);
    expect(err).not.toBeInstanceOf(DjangoBadRequestError);
    expect(err).not.toBeInstanceOf(DjangoUnauthorizedError);
    expect((err as DjangoHttpError).status).toBe(500);
    expect((err as DjangoHttpError).body).toBe("boom");
  });

  it("throws DjangoTimeoutError when fetch is aborted", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw abortErr;
    }));
    const err = await djangoGet(ENV, TOKEN, "/api/v1/x", { timeoutMs: 50 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DjangoTimeoutError);
    expect((err as DjangoTimeoutError).path).toBe("/api/v1/x");
    expect((err as DjangoTimeoutError).method).toBe("GET");
  });
});

describe("djangoPost", () => {
  it("sends Content-Type: application/json with serialized body", async () => {
    const fetchMock = mockFetchOnce(jsonResponse(200, { ok: true }));

    const result = await djangoPost<{ ok: boolean }>(
      ENV,
      TOKEN,
      "/api/v1/create",
      { foo: "bar", n: 42 },
    );

    expect(result).toEqual({ ok: true });
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/api/v1/create`);
    expect(req.headers.get("content-type")).toMatch(/application\/json/);
    expect(req.headers.get("x-api-key")).toBe(TOKEN);
    const bodyText = await req.text();
    expect(JSON.parse(bodyText)).toEqual({ foo: "bar", n: 42 });
  });

  it("maps 404 → DjangoNotFoundError with method=POST", async () => {
    mockFetchOnce(new Response("nope", { status: 404 }));
    const err = await djangoPost(ENV, TOKEN, "/api/v1/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect((err as DjangoNotFoundError).method).toBe("POST");
  });
});
