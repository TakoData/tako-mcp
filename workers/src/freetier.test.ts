import { describe, expect, it, vi } from "vitest";

import type { Env, RateLimit } from "./env.js";
import {
  checkFreeTierRateLimit,
  FREE_TIER_LIMIT_MESSAGE,
  FREE_TIER_TOOL_NAMES,
  freeTierLimitResponse,
  isMeteredJsonRpcBody,
  resolveFreeTierConfig,
} from "./freetier.js";

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

  it("meters a batch iff it contains a tools/call", () => {
    expect(
      isMeteredJsonRpcBody([{ method: "tools/list" }, TOOLS_CALL_BODY]),
    ).toBe(true);
    expect(isMeteredJsonRpcBody([{ method: "tools/list" }])).toBe(false);
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
