import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, RateLimit } from "./env.js";
import {
  checkFreeTierRateLimit,
  FREE_TIER_BATCH_MESSAGE,
  FREE_TIER_LIMIT_MESSAGE,
  FREE_TIER_TOOL_NAMES,
  freeTierBatchResponse,
  freeTierLimitResponse,
  isMeteredJsonRpcBody,
  resolveFreeTierConfig,
} from "./freetier.js";
import worker from "./index.js";
import { mockFetchSequence, requestFrom } from "./tools/__test_helpers.js";

/** A fake limiter that records keys and returns a scripted success value. */
function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: { key: string }) {
      keys.push(key);
      return { success };
    },
  };
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const TOOLS_CALL_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "tako_answer", arguments: { query: "US GDP" } },
};

describe("FREE_TIER_TOOL_NAMES", () => {
  it("is exactly the three approved free tools", () => {
    expect([...FREE_TIER_TOOL_NAMES].sort()).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_search",
    ]);
  });
});

describe("resolveFreeTierConfig", () => {
  const limiter = fakeLimiter(true);

  it("returns the config when both bindings are present", () => {
    const env = {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "free-key",
      FREE_TIER_RATE_LIMITER: limiter,
    } as Env;
    expect(resolveFreeTierConfig(env)).toEqual({
      apiKey: "free-key",
      limiter,
    });
  });

  it("returns null when the API key is missing or empty (fail-closed)", () => {
    expect(
      resolveFreeTierConfig({
        DJANGO_BASE_URL: "http://localhost:8000",
        FREE_TIER_RATE_LIMITER: limiter,
      } as Env),
    ).toBeNull();
    expect(
      resolveFreeTierConfig({
        DJANGO_BASE_URL: "http://localhost:8000",
        FREE_TIER_API_KEY: "",
        FREE_TIER_RATE_LIMITER: limiter,
      } as Env),
    ).toBeNull();
  });

  it("returns null when the limiter binding is missing (fail-closed)", () => {
    expect(
      resolveFreeTierConfig({
        DJANGO_BASE_URL: "http://localhost:8000",
        FREE_TIER_API_KEY: "free-key",
      } as Env),
    ).toBeNull();
  });
});

describe("isMeteredJsonRpcBody", () => {
  it("meters tools/call", () => {
    expect(isMeteredJsonRpcBody(TOOLS_CALL_BODY)).toBe(true);
  });

  it("does not meter the handshake and listing methods", () => {
    for (const method of [
      "initialize",
      "tools/list",
      "prompts/list",
      "resources/list",
      "notifications/initialized",
      "ping",
    ]) {
      expect(isMeteredJsonRpcBody({ jsonrpc: "2.0", id: 1, method })).toBe(false);
    }
  });

  it("does not meter non-object garbage", () => {
    expect(isMeteredJsonRpcBody(null)).toBe(false);
    expect(isMeteredJsonRpcBody("tools/call")).toBe(false);
    expect(isMeteredJsonRpcBody(42)).toBe(false);
  });
});

describe("checkFreeTierRateLimit", () => {
  it("counts a tools/call against the CF-Connecting-IP key and allows under-limit", async () => {
    const limiter = fakeLimiter(true);
    const req = mcpRequest(TOOLS_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" });
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("allowed");
    expect(limiter.keys).toEqual(["203.0.113.7"]);
  });

  it("returns limited when the bucket is exhausted", async () => {
    const limiter = fakeLimiter(false);
    const req = mcpRequest(TOOLS_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" });
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("limited");
  });

  it("never calls the limiter for unmetered methods", async () => {
    const limiter = fakeLimiter(false); // would report limited if consulted
    const req = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("allowed");
    expect(limiter.keys).toEqual([]);
  });

  it("falls back to the shared 'unknown' key without CF-Connecting-IP", async () => {
    const limiter = fakeLimiter(true);
    await checkFreeTierRateLimit(mcpRequest(TOOLS_CALL_BODY), limiter);
    expect(limiter.keys).toEqual(["unknown"]);
  });

  it("does not consume the request body (the transport still needs it)", async () => {
    const limiter = fakeLimiter(true);
    const req = mcpRequest(TOOLS_CALL_BODY);
    await checkFreeTierRateLimit(req, limiter);
    // The original body must remain readable after the peek.
    await expect(req.json()).resolves.toMatchObject({ method: "tools/call" });
  });

  it("allows (does not meter) an unparseable body — the SDK will reject it anyway", async () => {
    const limiter = fakeLimiter(false);
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("allowed");
    expect(limiter.keys).toEqual([]);
  });

  it("rejects a batch array as 'batch' without calling the limiter, even when it contains a tools/call", async () => {
    const limiter = fakeLimiter(true); // would allow if (wrongly) consulted
    const req = mcpRequest([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, TOOLS_CALL_BODY]);
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("batch");
    expect(limiter.keys).toEqual([]);
  });

  it("rejects a batch array as 'batch' without calling the limiter, even without a tools/call", async () => {
    const limiter = fakeLimiter(true);
    const req = mcpRequest([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("batch");
    expect(limiter.keys).toEqual([]);
  });

  it("fails open and logs when the limiter binding throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter: RateLimit = {
      async limit() {
        throw new Error("limiter unavailable");
      },
    };
    const req = mcpRequest(TOOLS_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" });
    await expect(checkFreeTierRateLimit(req, limiter)).resolves.toBe("allowed");
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("[free-tier]");
    errSpy.mockRestore();
  });
});

describe("freeTierLimitResponse", () => {
  it("is a 429 JSON-RPC error with the upsell message and Retry-After", async () => {
    const res = freeTierLimitResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe(FREE_TIER_LIMIT_MESSAGE);
    expect(body.error.data.kind).toBe("rate_limited");
    expect(body.error.message).toContain("https://trytako.com/account/");
  });
});

describe("freeTierBatchResponse", () => {
  it("is a 400 JSON-RPC error with the verbatim batch message", async () => {
    const res = freeTierBatchResponse();
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.data.kind).toBe("batch_not_supported");
    expect(body.error.message).toBe(FREE_TIER_BATCH_MESSAGE);
    expect(body.error.message).toBe(
      "Batch requests are not supported on the free tier. Send one " +
        "JSON-RPC request per POST, or get a free API key at " +
        "https://trytako.com/account/ for full access.",
    );
  });
});

describe("free tier end-to-end (worker.fetch with stub env)", () => {
  const JSON_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  function freeEnv(limiter: RateLimit): Env {
    return {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "free-tier-secret-key",
      FREE_TIER_RATE_LIMITER: limiter,
    } as Env;
  }

  function post(
    body: unknown,
    headers: Record<string, string> = {},
  ): Request {
    return new Request("https://example.com/mcp", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
    });
  }

  const INITIALIZE_BODY = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
  const TOOLS_LIST_BODY = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("anonymous initialize succeeds without metering", async () => {
    const limiter = fakeLimiter(false); // would 429 if (wrongly) consulted
    const res = await worker.fetch(post(INITIALIZE_BODY), freeEnv(limiter));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe("tako-mcp");
    expect(limiter.keys).toEqual([]);
  });

  it("anonymous tools/list shows exactly the three free tools, unmetered", async () => {
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(post(TOOLS_LIST_BODY), freeEnv(limiter));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_search",
    ]);
    expect(limiter.keys).toEqual([]);
  });

  it("anonymous tools/call forwards FREE_TIER_API_KEY to Django and meters the IP", async () => {
    const limiter = fakeLimiter(true);
    // tako_answer POSTs /api/v1/answer/ once; the handler's response
    // handling is irrelevant here — the assertion is the outgoing header.
    const fetchMock = mockFetchSequence([
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const res = await worker.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "tako_answer", arguments: { query: "US GDP" } },
        },
        { "cf-connecting-ip": "203.0.113.7" },
      ),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    expect(limiter.keys).toEqual(["203.0.113.7"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const outbound = requestFrom(fetchMock.mock.calls[0]!);
    expect(outbound.headers.get("x-api-key")).toBe("free-tier-secret-key");
  });

  it("an over-limit anonymous tools/call gets the 429 upsell", async () => {
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "tako_answer", arguments: { query: "US GDP" } },
        },
        { "cf-connecting-ip": "203.0.113.7" },
      ),
      freeEnv(limiter),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(FREE_TIER_LIMIT_MESSAGE);
  });

  it("an anonymous batch request gets a 400, never hits the limiter or Django", async () => {
    const limiter = fakeLimiter(true); // would allow if (wrongly) consulted
    const fetchMock = mockFetchSequence([]);
    const res = await worker.fetch(
      post([
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "tako_answer", arguments: { query: "US GDP" } },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "tako_search", arguments: { query: "US CPI" } },
        },
      ]),
      freeEnv(limiter),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(FREE_TIER_BATCH_MESSAGE);
    expect(limiter.keys).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed Authorization header still 401s even with the free tier configured", async () => {
    const limiter = fakeLimiter(true);
    const res = await worker.fetch(
      post(INITIALIZE_BODY, { authorization: "NotBearer xyz" }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { data: { kind: string } } };
    expect(body.error.data.kind).toBe("malformed");
    expect(limiter.keys).toEqual([]);
  });

  it("without FREE_TIER_API_KEY, anonymous requests 401 exactly as before (fail-closed)", async () => {
    const env = {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_RATE_LIMITER: fakeLimiter(true),
    } as Env;
    const res = await worker.fetch(post(INITIALIZE_BODY), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await res.json()) as { error: { data: { kind: string } } };
    expect(body.error.data.kind).toBe("missing");
  });

  it("authenticated requests bypass the limiter and keep the full toolset", async () => {
    const limiter = fakeLimiter(false); // would 429 / restrict if consulted
    const res = await worker.fetch(
      post(TOOLS_LIST_BODY, { authorization: "Bearer real-user-token" }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_contents",
      "tako_search",
    ]);
    expect(limiter.keys).toEqual([]);
  });

  it("a limiter runtime failure fails open — the anonymous call still succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter: RateLimit = {
      async limit() {
        throw new Error("limiter unavailable");
      },
    };
    mockFetchSequence([
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const res = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "tako_answer", arguments: { query: "US GDP" } },
      }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
  });
});
