import { afterEach, describe, expect, it, vi } from "vitest";

import wranglerRaw from "../wrangler.jsonc?raw";
import type { Env, RateLimit } from "./env.js";
import {
  checkFreeTierRateLimit,
  FREE_TIER_BATCH_MESSAGE,
  FREE_TIER_COMMERCE_UPSELL,
  FREE_TIER_CREDITS_MESSAGE,
  FREE_TIER_GLOBAL_LIMIT_MESSAGE,
  FREE_TIER_LIMIT_MESSAGE,
  FREE_TIER_TOO_LARGE_MESSAGE,
  FREE_TIER_TOOL_NAMES,
  type FreeTierConfig,
  freeTierBatchResponse,
  freeTierCreditsToolResult,
  freeTierGlobalLimitResponse,
  freeTierLimitResponse,
  freeTierRateLimitKey,
  freeTierTooLargeResponse,
  isMeteredJsonRpcBody,
  MAX_FREE_TIER_BODY_BYTES,
  resolveFreeTierConfig,
} from "./freetier.js";
import worker from "./index.js";
import { FREE_TIER_SERVER_INSTRUCTIONS } from "./mcp.js";
import { mockFetchSequence, requestFrom } from "./tools/__test_helpers.js";

/**
 * Every BASE string this module can put in front of a caller — and therefore
 * in front of a host's MODEL, since four of the five ship as tool-result
 * text. The two guard tests below hold for all of them together, so a new
 * base message added to `freetier.ts` is covered by adding one line here.
 *
 * Deliberately NOT in this list: `FREE_TIER_COMMERCE_UPSELL`, which exists
 * to violate the account-copy ban — on positively-identified Anthropic
 * clients only. Its own describe ("commerce-gated upsell") proves it is
 * absent by default from every producer and holds it to the hygiene rules
 * that are not commerce-specific; `docs/chatgpt-app-review.md` §1 records
 * the client gate for reviewers.
 */
const ALL_FREE_TIER_MESSAGES = [
  FREE_TIER_LIMIT_MESSAGE,
  FREE_TIER_GLOBAL_LIMIT_MESSAGE,
  FREE_TIER_BATCH_MESSAGE,
  FREE_TIER_CREDITS_MESSAGE,
  FREE_TIER_TOO_LARGE_MESSAGE,
];

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

/** A limiter whose `limit()` always throws — the fail-open path. */
function throwingLimiter(): RateLimit {
  return {
    async limit() {
      throw new Error("limiter unavailable");
    },
  };
}

/** Assemble a `FreeTierConfig` with sane defaults for unit tests. */
function makeConfig(overrides: Partial<FreeTierConfig> = {}): FreeTierConfig {
  return {
    apiKey: "free-key",
    limiter: fakeLimiter(true),
    globalLimiter: fakeLimiter(true),
    ...overrides,
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
  const globalLimiter = fakeLimiter(true);

  it("returns the config when all three bindings are present", () => {
    const env = {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "free-key",
      FREE_TIER_RATE_LIMITER: limiter,
      FREE_TIER_GLOBAL_RATE_LIMITER: globalLimiter,
    } as Env;
    expect(resolveFreeTierConfig(env)).toEqual({
      apiKey: "free-key",
      limiter,
      globalLimiter,
    });
  });

  it("trims the API key — a piped `wrangler secret put` adds a trailing newline", () => {
    const env = {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "  free-key\n",
      FREE_TIER_RATE_LIMITER: limiter,
      FREE_TIER_GLOBAL_RATE_LIMITER: globalLimiter,
    } as Env;
    expect(resolveFreeTierConfig(env)?.apiKey).toBe("free-key");
  });

  it("returns null when the API key is missing, empty, or whitespace-only (fail-closed)", () => {
    for (const key of [undefined, "", "  \n"]) {
      expect(
        resolveFreeTierConfig({
          DJANGO_BASE_URL: "http://localhost:8000",
          ...(key !== undefined ? { FREE_TIER_API_KEY: key } : {}),
          FREE_TIER_RATE_LIMITER: limiter,
          FREE_TIER_GLOBAL_RATE_LIMITER: globalLimiter,
        } as Env),
      ).toBeNull();
    }
  });

  it("returns null when the per-IP limiter binding is missing (fail-closed)", () => {
    expect(
      resolveFreeTierConfig({
        DJANGO_BASE_URL: "http://localhost:8000",
        FREE_TIER_API_KEY: "free-key",
        FREE_TIER_GLOBAL_RATE_LIMITER: globalLimiter,
      } as Env),
    ).toBeNull();
  });

  it("returns null when the global limiter binding is missing (fail-closed)", () => {
    expect(
      resolveFreeTierConfig({
        DJANGO_BASE_URL: "http://localhost:8000",
        FREE_TIER_API_KEY: "free-key",
        FREE_TIER_RATE_LIMITER: limiter,
      } as Env),
    ).toBeNull();
  });
});

describe("isMeteredJsonRpcBody", () => {
  it("meters a tools/call naming each free tool", () => {
    for (const name of FREE_TIER_TOOL_NAMES) {
      expect(
        isMeteredJsonRpcBody({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      ).toBe(true);
    }
  });

  it("does not meter a tools/call for a hidden tool (returns 'tool not found' without spend)", () => {
    for (const name of ["tako_agent", "get_credit_balance", "no_such_tool"]) {
      expect(
        isMeteredJsonRpcBody({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      ).toBe(false);
    }
  });

  it("does not meter a tools/call with missing or malformed params", () => {
    expect(
      isMeteredJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    ).toBe(false);
    expect(
      isMeteredJsonRpcBody({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: 42 },
      }),
    ).toBe(false);
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

describe("freeTierRateLimitKey", () => {
  it("uses the shared 'unknown' bucket when the header is absent", () => {
    expect(freeTierRateLimitKey(null)).toBe("unknown");
  });

  it("keys IPv4 addresses verbatim", () => {
    expect(freeTierRateLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 addresses by /64 prefix — one subscriber, one bucket", () => {
    expect(freeTierRateLimitKey("2001:db8:1:2:3:4:5:6")).toBe("v6:2001:db8:1:2");
    // `::` expansion: 2001:db8::1 is 2001:db8:0:0:0:0:0:1 → /64 = 2001:db8:0:0.
    expect(freeTierRateLimitKey("2001:db8::1")).toBe("v6:2001:db8:0:0");
    // Two hosts in the same /64 share a bucket…
    expect(freeTierRateLimitKey("2001:db8:1:2:aaaa::1")).toBe(
      freeTierRateLimitKey("2001:db8:1:2:bbbb::2"),
    );
    // …two different /64s do not.
    expect(freeTierRateLimitKey("2001:db8:1:2::1")).not.toBe(
      freeTierRateLimitKey("2001:db8:1:3::1"),
    );
  });
});

describe("checkFreeTierRateLimit", () => {
  it("hits the global ceiling for EVERY request, even unmetered methods", async () => {
    const config = makeConfig();
    const req = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "allowed",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect((config.globalLimiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "global",
    ]);
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("returns global_limited with the request id for a tools/call, before per-IP metering", async () => {
    const config = makeConfig({ globalLimiter: fakeLimiter(false) });
    const req = mcpRequest(TOOLS_CALL_BODY);
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "global_limited",
      requestId: TOOLS_CALL_BODY.id,
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("returns global_limited with a null id for non-tools/call methods", async () => {
    const config = makeConfig({ globalLimiter: fakeLimiter(false) });
    const req = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "global_limited",
      requestId: null,
    });
  });

  it("counts unparseable bodies against the per-colo ceiling (garbage floods still count)", async () => {
    const config = makeConfig();
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "allowed",
    });
    expect((config.globalLimiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "global",
    ]);
  });

  it("counts a free-tool tools/call against the CF-Connecting-IP key and allows under-limit", async () => {
    const config = makeConfig();
    const req = mcpRequest(TOOLS_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "allowed",
      body: TOOLS_CALL_BODY,
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "203.0.113.7",
    ]);
  });

  it("returns limited with the request id when the per-IP bucket is exhausted", async () => {
    const config = makeConfig({ limiter: fakeLimiter(false) });
    const req = mcpRequest(
      { ...TOOLS_CALL_BODY, id: "req-9" },
      { "cf-connecting-ip": "203.0.113.7" },
    );
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "limited",
      requestId: "req-9",
    });
  });

  it("degrades the request id to null when it is missing or malformed", async () => {
    const config = makeConfig({ limiter: fakeLimiter(false) });
    const { id: _dropped, ...noIdBody } = TOOLS_CALL_BODY;
    const req = mcpRequest(noIdBody);
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "limited",
      requestId: null,
    });
  });

  it("never consults the per-IP limiter for a hidden-tool tools/call (still counts globally)", async () => {
    const config = makeConfig({ limiter: fakeLimiter(false) }); // would report limited if consulted
    const req = mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tako_agent", arguments: {} },
    });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "allowed",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tako_agent", arguments: {} },
      },
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
    expect((config.globalLimiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "global",
    ]);
  });

  it("keys IPv6 clients by /64 prefix", async () => {
    const config = makeConfig();
    const req = mcpRequest(TOOLS_CALL_BODY, {
      "cf-connecting-ip": "2001:db8:1:2:3:4:5:6",
    });
    await checkFreeTierRateLimit(req, config);
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "v6:2001:db8:1:2",
    ]);
  });

  it("falls back to the shared 'unknown' key without CF-Connecting-IP", async () => {
    const config = makeConfig();
    await checkFreeTierRateLimit(mcpRequest(TOOLS_CALL_BODY), config);
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([
      "unknown",
    ]);
  });

  it("does not consume the request body (the transport still needs it)", async () => {
    const config = makeConfig();
    const req = mcpRequest(TOOLS_CALL_BODY);
    await checkFreeTierRateLimit(req, config);
    // The original body must remain readable after the peek.
    await expect(req.json()).resolves.toMatchObject({ method: "tools/call" });
  });

  it("allows (does not meter per-IP) an unparseable body — the SDK will reject it anyway", async () => {
    const config = makeConfig({ limiter: fakeLimiter(false) });
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "allowed",
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("rejects a batch array as 'batch' without per-IP metering, even when it contains a tools/call", async () => {
    const config = makeConfig();
    const req = mcpRequest([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      TOOLS_CALL_BODY,
    ]);
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "batch",
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("rejects a batch array as 'batch' even without a tools/call", async () => {
    const config = makeConfig();
    const req = mcpRequest([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "batch",
    });
  });

  it("rejects a declared Content-Length over the cap before reading the body", async () => {
    const config = makeConfig();
    const req = mcpRequest(TOOLS_CALL_BODY, {
      "content-length": String(MAX_FREE_TIER_BODY_BYTES + 1),
    });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "too_large",
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("rejects an actually-oversized body via the bounded read (Content-Length can lie)", async () => {
    const config = makeConfig();
    // A real body over the cap; the header (if any) is not what stops it.
    const bigQuery = "x".repeat(MAX_FREE_TIER_BODY_BYTES + 1024);
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...TOOLS_CALL_BODY,
        params: { name: "tako_answer", arguments: { query: bigQuery } },
      }),
    });
    await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
      kind: "too_large",
    });
    expect((config.limiter as ReturnType<typeof fakeLimiter>).keys).toEqual([]);
  });

  it("fails open and logs when the per-IP limiter binding throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = makeConfig({ limiter: throwingLimiter() });
      const req = mcpRequest(TOOLS_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" });
      await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
        kind: "allowed",
        body: TOOLS_CALL_BODY,
      });
      expect(errSpy).toHaveBeenCalledOnce();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("failing open");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("fails open and logs when the global limiter binding throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = makeConfig({ globalLimiter: throwingLimiter() });
      const req = mcpRequest(TOOLS_CALL_BODY);
      await expect(checkFreeTierRateLimit(req, config)).resolves.toEqual({
        kind: "allowed",
        body: TOOLS_CALL_BODY,
      });
      expect(errSpy).toHaveBeenCalledOnce();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("failing open");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("freeTierLimitResponse", () => {
  it("with a request id: HTTP 200 JSON-RPC RESULT carrying the limit message as a tool error", async () => {
    // Deliberately not a 429 — the SDK client throws on non-2xx POSTs at
    // the transport layer, so a 429 body never reaches the model. As a
    // tool result the host feeds the text straight to the model.
    const res = freeTierLimitResponse(4);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
        _meta: Record<string, unknown>;
      };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(4);
    expect(body.result.isError).toBe(true);
    expect(body.result.content).toEqual([
      { type: "text", text: FREE_TIER_LIMIT_MESSAGE },
    ]);
    // The failed-call discriminant every other error result carries. The
    // chart widget keys its labelled empty state on it — without this the
    // most common anonymous-ChatGPT failure left an unlabelled blank box.
    expect(body.result._meta).toEqual({
      "tako/error": { kind: "rate_limited" },
    });
  });

  it("without a request id: degrades to the legacy 429 with Retry-After", async () => {
    const res = freeTierLimitResponse(null);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = (await res.json()) as {
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe(FREE_TIER_LIMIT_MESSAGE);
    expect(body.error.data.kind).toBe("rate_limited");
  });
});

describe("freeTierGlobalLimitResponse", () => {
  it("with a tools/call id: HTTP 200 tool-error result the model can read", async () => {
    const res = freeTierGlobalLimitResponse("req-3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
        _meta: Record<string, unknown>;
      };
    };
    expect(body.id).toBe("req-3");
    expect(body.result.isError).toBe(true);
    expect(body.result.content).toEqual([
      { type: "text", text: FREE_TIER_GLOBAL_LIMIT_MESSAGE },
    ]);
    // Same discriminant as the per-IP bucket, kind mirroring the 429
    // branch's data.kind — distinct spellings on purpose (see the
    // function's comment on topology visibility).
    expect(body.result._meta).toEqual({
      "tako/error": { kind: "global_rate_limited" },
    });
  });

  it("without an id: a 429 JSON-RPC error with the capacity message and Retry-After", async () => {
    const res = freeTierGlobalLimitResponse(null);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = (await res.json()) as {
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe(FREE_TIER_GLOBAL_LIMIT_MESSAGE);
    // Distinct from the per-IP bucket's kind. Collapsing the two hid the
    // topology in `kind` while `message` still revealed it, so it broke a
    // client-visible contract for no gain. See `freeTierGlobalLimitResponse`.
    expect(body.error.data.kind).toBe("global_rate_limited");
  });
});

describe("freeTierTooLargeResponse", () => {
  it("is a 413 JSON-RPC error naming the byte cap", async () => {
    const res = freeTierTooLargeResponse();
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      id: null;
      error: { code: number; message: string; data: { kind: string } };
    };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.data.kind).toBe("payload_too_large");
    expect(body.error.message).toContain(String(MAX_FREE_TIER_BODY_BYTES));
    expect(body.error.message).toBe(FREE_TIER_TOO_LARGE_MESSAGE);
    expect(body.error.message).toBe(
      "Request body is too large for anonymous access. The limit is " +
        "131072 bytes.",
    );
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
      "Batch requests are not supported for anonymous access. Send one " +
        "JSON-RPC request per POST.",
    );
  });
});

describe("wrangler.jsonc ↔ message drift", () => {
  // The binding CANNOT enforce a specific rate, so no user-facing string may
  // claim one. Measured on deployed staging against a 10-per-60s bucket: 20 of
  // 20 normal-paced requests were admitted, a cold burst admitted ~115
  // regardless of the configured limit, and one IP had 292 requests admitted in
  // ~16 s. The earlier version of this test asserted the advertised number
  // MATCHED the binding, which protected a false promise. It now asserts the
  // opposite, so a number cannot be reintroduced. See README.md "Measured
  // behaviour".
  function bindingLimits(name: string): number[] {
    const re = new RegExp(
      `"name":\\s*"${name}"[\\s\\S]*?"limit":\\s*(\\d+)`,
      "g",
    );
    return [...wranglerRaw.matchAll(re)].map((m) => Number(m[1]));
  }

  /**
   * Every `ratelimits` entry in the file, in document order.
   *
   * Deliberately NOT scoped to `FREE_TIER_*`. It was, and the effect was that
   * the login limiters added later (`LOGIN_RATE_LIMITER`,
   * `LOGIN_EMAIL_RATE_LIMITER`) were invisible to both the distinct-namespace
   * and the period-60 guards, and the suite stayed green either way. Every
   * `ratelimits` bucket has the same two invariants regardless of what it meters,
   * so the scan covers all of them and the NEXT limiter is covered on arrival.
   *
   * The one risk of widening is a false match on a `"period"` or
   * `"namespace_id"` key belonging to some unrelated future binding — which is
   * why this matches the whole entry SHAPE (name + namespace_id + simple), and
   * why `covers every ratelimits entry` below cross-checks the count against
   * the raw `namespace_id` occurrences so a missed entry fails loudly instead of
   * silently shrinking coverage.
   */
  function ratelimitEntries(): Array<{
    name: string;
    namespaceId: string;
    limit: number;
    period: number;
  }> {
    const re =
      /"name":\s*"([A-Z_]+)"\s*,\s*"namespace_id":\s*"([^"]+)"\s*,\s*"simple":\s*\{\s*"limit":\s*(\d+)\s*,\s*"period":\s*(\d+)\s*\}/g;
    return [...wranglerRaw.matchAll(re)].map((m) => ({
      name: m[1]!,
      namespaceId: m[2]!,
      limit: Number(m[3]),
      period: Number(m[4]),
    }));
  }

  it("per-IP binding limits agree across all 3 envs", () => {
    const limits = bindingLimits("FREE_TIER_RATE_LIMITER");
    expect(limits).toHaveLength(3);
    expect(new Set(limits).size).toBe(1);
  });

  it("global binding limits agree across all 3 envs", () => {
    const limits = bindingLimits("FREE_TIER_GLOBAL_RATE_LIMITER");
    expect(limits).toHaveLength(3);
    expect(new Set(limits).size).toBe(1);
  });

  it("covers every ratelimits entry — a bucket the scan misses is a bucket with no guards", () => {
    // The count is DERIVED from the file, not a literal, so adding a limiter
    // cannot leave it uncovered: `namespace_id` appears exactly once per
    // `ratelimits` entry, so if the shape-match below ever finds fewer entries
    // than there are ids, this fails instead of quietly checking less.
    const entries = ratelimitEntries();
    const rawIdCount = [...wranglerRaw.matchAll(/"namespace_id":/g)].length;
    expect(entries).toHaveLength(rawIdCount);
    // Sanity that the file still declares one block per env.
    expect([...wranglerRaw.matchAll(/"ratelimits":/g)]).toHaveLength(3);
    // Each declared binding must appear once per env, or an env is unprotected.
    const perName = new Map<string, number>();
    for (const e of entries) perName.set(e.name, (perName.get(e.name) ?? 0) + 1);
    for (const [name, count] of perName) {
      expect(count, `${name} is not declared in all 3 envs`).toBe(3);
    }
  });

  it("every bucket's period is 60 — a shorter period admits MORE traffic, not less (see README 'Measured behaviour')", () => {
    const entries = ratelimitEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.period, `${e.name} (${e.namespaceId})`).toBe(60);
    }
  });

  it("every namespace_id is distinct — reusing one merges two counters into one bucket", () => {
    // This is the assertion that makes "confirm the new namespace ids do not
    // collide" a CI check rather than a manual release step.
    const ids = ratelimitEntries().map((e) => e.namespaceId);
    expect(new Set(ids).size, `duplicate namespace_id in ${ids.join(",")}`).toBe(
      ids.length,
    );
  });

  it("each binding uses the same limit in every env", () => {
    // A limit that differs per env means staging is not testing production's
    // behaviour. Derived per name, so it covers the login buckets too.
    const byName = new Map<string, number[]>();
    for (const e of ratelimitEntries()) {
      byName.set(e.name, [...(byName.get(e.name) ?? []), e.limit]);
    }
    for (const [name, limits] of byName) {
      expect(new Set(limits).size, `${name} limits differ: ${limits.join(",")}`).toBe(1);
    }
  });

  it("no freetier error kind names the internal mechanism or the cause", async () => {
    // The `kind` fields are machine-readable and SHIP TO CALLERS. What they
    // must not do is name the internal mechanism, or restate the one thing
    // the prose deliberately withholds: that the shortage is SPENT CREDIT,
    // which would hand a prober a gauge for how depleted the account is.
    //
    // Limiter TOPOLOGY is deliberately NOT hidden. Hiding it here while the
    // two limit messages still describe different situations bought nothing
    // and broke a client-visible contract, so `global_rate_limited` stays
    // distinct from `rate_limited` and "global" is not banned below.
    //
    // SCOPE: this covers only the kinds THIS module emits. The anonymous path
    // also surfaces `djangoErrorKind` values from `mcp.ts`
    // (unauthorized / timeout / not_found / bad_request / response_parse /
    // http / unknown). None of those disclose anything today, so there is no
    // live gap, but they are not guarded here — and the raw upstream body
    // that `djangoErrorToToolResult` attaches alongside them is a separate,
    // larger disclosure surface tracked outside this test.
    const kinds: string[] = [];
    for (const res of [
      freeTierLimitResponse(null),
      freeTierGlobalLimitResponse(null),
      freeTierTooLargeResponse(),
      freeTierBatchResponse(),
    ]) {
      const body = (await res.json()) as {
        error: { data: { kind: string } };
      };
      kinds.push(body.error.data.kind);
    }
    const meta = freeTierCreditsToolResult()._meta["tako/error"] as {
      kind: string;
    };
    kinds.push(meta.kind);

    expect(kinds).toHaveLength(5);
    for (const kind of kinds) {
      // NOT banned, deliberately:
      //   "shared" — FREE_TIER_CREDITS_MESSAGE says the capacity is shared on
      //     purpose, so banning it from the kind would make the two disagree.
      //   "global" — see the topology note above.
      // Banned: the internal naming, and the cause of the shortage.
      expect(kind).not.toMatch(/free_tier|credit|billing|payment|exhaust|depleted|quota/i);
    }
  });

  it("no user-facing message advertises a rate, says free, or uses the old host", () => {
    // All five user-facing messages, including the 413 body-too-large
    // message: it ships to clients (see `freeTierTooLargeResponse`), so the
    // same prohibitions apply. No rate may be advertised (the byte cap is
    // exactly enforced, unlike the limiter buckets, so that number is fine;
    // the regex below only bans a requests-per-time figure).
    for (const message of ALL_FREE_TIER_MESSAGES) {
      expect(message).not.toMatch(
        /\d+\s*requests?\s*(\/|per)\s*(min|minute|sec|second)/i,
      );
      expect(message).not.toMatch(/\bfree\b/i);
      expect(message).not.toContain("trytako.com");
    }
  });

  it("no user-facing message promotes an account, a purchase, or an upgrade", () => {
    // These strings reach ChatGPT's MODEL as tool-result text (see
    // `freeTierLimitResponse` for why they are delivered as results rather
    // than 429s). OpenAI's commerce policy forbids promoting or selling
    // digital services, subscriptions, tokens, or credits through an app, so
    // an over-limit message may state capacity and retry advice and nothing
    // more. Four of these used to close with "get an API key at
    // https://tako.com/account/ …"; that is what this test exists to keep
    // out. Existing paid-account functionality is unaffected — only
    // advertising it from a tool response is.
    //
    // Note for anyone re-adding a link: the current API-key page is
    // https://tako.com/console/api-keys (the `/account/` path these
    // messages used was already stale). It belongs in the docs and on
    // tako.com, not in a tool result.
    for (const message of ALL_FREE_TIER_MESSAGES) {
      expect(message).not.toMatch(/https?:\/\//);
      expect(message).not.toMatch(
        /api key|account|sign ?up|upgrade|subscri|purchas|\bbuy\b|\bplan\b|pricing|\bcredits?\b|\$/i,
      );
    }
  });
});

describe("commerce-gated upsell (FREE_TIER_COMMERCE_UPSELL)", () => {
  // The base messages above stay commerce-free because they reach ChatGPT's
  // model. On connections POSITIVELY identified as Anthropic clients
  // (`commerceCopyAllowedForUa` in mcp.ts — the same allowlist that gates
  // the authenticated 402 remedy), the anonymous limit moment is the one
  // place a caller can be told that an account lifts the limits — the same
  // conversion point Exa's keyless tier uses. The flag defaults to false,
  // so every producer fails closed.

  it("is absent from every producer by default (fails closed)", async () => {
    const limited = (await freeTierLimitResponse(1).json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(limited.result.content[0]?.text).toBe(FREE_TIER_LIMIT_MESSAGE);
    const global = (await freeTierGlobalLimitResponse(2).json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(global.result.content[0]?.text).toBe(
      FREE_TIER_GLOBAL_LIMIT_MESSAGE,
    );
    expect(freeTierCreditsToolResult().content[0]?.text).toBe(
      FREE_TIER_CREDITS_MESSAGE,
    );
  });

  it("is appended to all three limit/capacity surfaces when allowed, in both response shapes", async () => {
    const limited = (await freeTierLimitResponse(1, true).json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(limited.result.content[0]?.text).toBe(
      `${FREE_TIER_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
    const limited429 = (await freeTierLimitResponse(null, true).json()) as {
      error: { message: string };
    };
    expect(limited429.error.message).toBe(
      `${FREE_TIER_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
    const global = (await freeTierGlobalLimitResponse("x", true).json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(global.result.content[0]?.text).toBe(
      `${FREE_TIER_GLOBAL_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
    expect(freeTierCreditsToolResult(true).content[0]?.text).toBe(
      `${FREE_TIER_CREDITS_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
  });

  it("obeys the hygiene rules that are not commerce-specific", () => {
    // It exists to name the account path, so the commerce-word ban does not
    // apply — but the other message rules still do: no scheme URL (bare
    // domain only — deep links rot), no stale host, no rate figure, and no
    // "free" (the tier never names itself).
    expect(FREE_TIER_COMMERCE_UPSELL).not.toMatch(/https?:\/\//);
    expect(FREE_TIER_COMMERCE_UPSELL).not.toContain("trytako.com");
    expect(FREE_TIER_COMMERCE_UPSELL).not.toMatch(
      /\d+\s*requests?\s*(\/|per)\s*(min|minute|sec|second)/i,
    );
    expect(FREE_TIER_COMMERCE_UPSELL).not.toMatch(/\bfree\b/i);
  });
});

describe("free tier end-to-end (worker.fetch with stub env)", () => {
  const JSON_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  function freeEnv(
    limiter: RateLimit,
    globalLimiter: RateLimit = fakeLimiter(true),
  ): Env {
    return {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "free-tier-secret-key",
      FREE_TIER_RATE_LIMITER: limiter,
      FREE_TIER_GLOBAL_RATE_LIMITER: globalLimiter,
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
  const ANSWER_CALL_BODY = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "tako_answer", arguments: { query: "US GDP" } },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("anonymous initialize succeeds without per-IP metering (global counts it)", async () => {
    const limiter = fakeLimiter(false); // would limit if (wrongly) consulted
    const globalLimiter = fakeLimiter(true);
    const res = await worker.fetch(
      post(INITIALIZE_BODY),
      freeEnv(limiter, globalLimiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe("tako-mcp");
    expect(limiter.keys).toEqual([]);
    expect(globalLimiter.keys).toEqual(["global"]);
  });

  it("anonymous tools/list shows exactly the three free tools, unmetered per-IP", async () => {
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

  it("anonymous ChatGPT tools/list shows the five submitted tools with top-level securitySchemes", async () => {
    // The ChatGPT link-account flow requires the two auth-required
    // submitted tools to stay LISTED anonymously, and the Apps SDK reads
    // securitySchemes at the descriptor TOP LEVEL (injected by
    // withChatGptToolSecuritySchemes — the MCP SDK drops unknown fields).
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      post(TOOLS_LIST_BODY, { "user-agent": "ChatGPT/1.0" }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          securitySchemes?: Array<{ type: string; scopes?: string[] }>;
        }>;
      };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "tako_answer",
      "tako_available_data",
      "tako_contents",
      "tako_search",
      "tako_visualize",
    ]);
    const oauth2 = { type: "oauth2", scopes: ["mcp"] };
    const byName = new Map(
      body.result.tools.map((t) => [t.name, t.securitySchemes]),
    );
    for (const name of ["tako_search", "tako_answer", "tako_available_data"]) {
      expect(byName.get(name), name).toEqual([{ type: "noauth" }, oauth2]);
    }
    for (const name of ["tako_contents", "tako_visualize"]) {
      expect(byName.get(name), name).toEqual([oauth2]);
    }
    expect(limiter.keys).toEqual([]);
  });

  it("anonymous ChatGPT tools/call to tako_contents returns the challenge with the request origin, unmetered, no Django call", async () => {
    const limiter = fakeLimiter(false); // would limit if (wrongly) consulted
    const fetchMock = mockFetchSequence([]);
    const res = await worker.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "tako_contents",
            arguments: { url: "https://trytako.com/card/x" },
          },
        },
        { "user-agent": "ChatGPT/1.0" },
      ),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; _meta?: Record<string, unknown> };
    };
    expect(body.result.isError).toBe(true);
    const challenges = body.result._meta?.["mcp/www_authenticate"] as string[];
    expect(challenges).toHaveLength(1);
    // The origin threaded through createMcpServer's requestOrigin option
    // must match the actual request host, mirroring the HTTP 401 header.
    expect(challenges[0]).toContain(
      'resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    );
    // Over HTTP this is now answered by the PRE-DISPATCH gate
    // (`freeTierHiddenToolResponse` in `handleMcpRequest`) — the
    // `registerTool` dispatch gate behind it returns the same result and
    // stays directly exercised by the in-memory `callTool` tests in
    // mcp.test.ts (defense in depth, not dead code). Either way: no
    // Django call on the shared key, and non-free tool names never
    // consume the per-IP bucket.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.keys).toEqual([]);
  });

  it("anonymous tools/call forwards the TRIMMED FREE_TIER_API_KEY to Django and meters the IP", async () => {
    const limiter = fakeLimiter(true);
    // tako_answer POSTs /api/v1/answer/ once; the handler's response
    // handling is irrelevant here — the assertion is the outgoing header.
    const fetchMock = mockFetchSequence([
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const env = freeEnv(limiter);
    (env as { FREE_TIER_API_KEY?: string }).FREE_TIER_API_KEY =
      "free-tier-secret-key\n";
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(limiter.keys).toEqual(["203.0.113.7"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const outbound = requestFrom(fetchMock.mock.calls[0]!);
    expect(outbound.headers.get("x-api-key")).toBe("free-tier-secret-key");
  });

  it("an over-limit anonymous tools/call gets a 200 TOOL ERROR the model can read", async () => {
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, { "cf-connecting-ip": "203.0.113.7" }),
      freeEnv(limiter),
    );
    // Not a 429: the SDK client throws on non-2xx, so the message would
    // never reach the model. A JSON-RPC result with isError does.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(body.id).toBe(ANSWER_CALL_BODY.id);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(FREE_TIER_LIMIT_MESSAGE);
  });

  it("a non-tools/call request over the per-colo ceiling gets the capacity 429", async () => {
    const limiter = fakeLimiter(true);
    const res = await worker.fetch(
      post(TOOLS_LIST_BODY),
      freeEnv(limiter, fakeLimiter(false)),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(FREE_TIER_GLOBAL_LIMIT_MESSAGE);
    expect(limiter.keys).toEqual([]);
  });

  it("a tools/call over the per-colo ceiling gets a 200 TOOL ERROR the model can read", async () => {
    const limiter = fakeLimiter(true);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY),
      freeEnv(limiter, fakeLimiter(false)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.id).toBe(ANSWER_CALL_BODY.id);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(FREE_TIER_GLOBAL_LIMIT_MESSAGE);
    expect(limiter.keys).toEqual([]);
  });

  it("an oversized anonymous body gets a 413 without reaching Django", async () => {
    const fetchMock = mockFetchSequence([]);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, {
        "content-length": String(MAX_FREE_TIER_BODY_BYTES + 1),
      }),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an anonymous batch request gets a 400, never hits the per-IP limiter or Django", async () => {
    const limiter = fakeLimiter(true); // would allow if (wrongly) consulted
    const fetchMock = mockFetchSequence([]);
    const res = await worker.fetch(
      post([
        ANSWER_CALL_BODY,
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

  it("an anonymous call to a hidden tool answers sign-in guidance, burns no per-IP quota, never hits Django", async () => {
    const limiter = fakeLimiter(false); // would 429 the call if consulted
    const fetchMock = mockFetchSequence([]);
    const res = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "tako_contents", arguments: { urls: ["x"] } },
      }),
      freeEnv(limiter),
    );
    // Pre-dispatch gate (`freeTierHiddenToolResponse`): a tool that
    // authentication WOULD unlock answers the same auth-required result
    // the ChatGPT dispatch gate uses — NOT the SDK's bare "tool not
    // found", which reads as "this tool does not exist" when the truth is
    // "sign in and it works". Per-IP bucket untouched, nothing reaches
    // Django.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: {
        content: Array<{ text: string }>;
        isError: boolean;
        _meta: Record<string, { kind?: string }>;
      };
    };
    expect(body.id).toBe(8);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("requires a Tako account");
    expect(body.result._meta["tako/error"]?.kind).toBe("auth_required");
    expect(limiter.keys).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anonymous call to a gated tool on claude.ai names the Connect step", async () => {
    const res = await worker.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "tako_contents", arguments: { urls: ["https://x.com"] } },
        },
        { "user-agent": "Claude-User/1.0" },
      ),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0]?.text ?? "";
    expect(text).toContain("This tool requires a Tako account.");
    expect(text).toContain("Settings → Connectors");
    // The client sign-in step and the tool-specific agent fallback must
    // COMPOSE through the real gate (hint first) — the unit test alone
    // would not catch a call site dropping toolName when signInHint is set.
    expect(text).toContain("tako_answer");
    expect(text.indexOf("Settings → Connectors")).toBeLessThan(
      text.indexOf("tako_answer"),
    );
  });

  it("anonymous call to a gated tool on Claude Code names the API-key step", async () => {
    const res = await worker.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "tako_contents", arguments: { urls: ["https://x.com"] } },
        },
        { "user-agent": "claude-code/2.1.220 (sdk-cli)" },
      ),
      freeEnv(fakeLimiter(true)),
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const text = body.result.content[0]?.text ?? "";
    expect(text).toContain("Tako API key");
    expect(text).toContain("Claude Code");
    // Composition through the second (pre-dispatch) gate too — see the
    // claude.ai case above.
    expect(text).toContain("tako_answer");
  });

  it("anonymous gated-tool text on ChatGPT and unknown UAs carries no client sign-in step", async () => {
    for (const userAgent of ["ChatGPT/1.0", "python-httpx/0.27"]) {
      // `tako_contents`, not `tako_visualize`: `tako_visualize` is opt-in
      // (`OPTIONAL_TOOL_NAMES`) and default-on only for widget clients
      // (`WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES` — chatgpt/claude/codex), so
      // it is off the AUTHENTICATED surface for `python-httpx`'s "unknown"
      // client and the pre-dispatch gate never answers for it, regardless
      // of any sign-in hint — an unrelated surface gap, not something this
      // task's hint logic controls. `tako_contents` is unconditionally on
      // every client's authenticated surface, so it exercises the same
      // "byte-identical when the client is not positively identified"
      // path this test is actually about.
      const res = await worker.fetch(
        post(
          {
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: { name: "tako_contents", arguments: { urls: ["https://x.com"] } },
          },
          { "user-agent": userAgent },
        ),
        freeEnv(fakeLimiter(true)),
      );
      const body = (await res.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const text = body.result.content[0]?.text ?? "";
      // The guard this test exists for: the CLIENT-specific sign-in step
      // must not leak to clients that are not positively identified as
      // Anthropic hosts (an unknown UA could be OpenAI's review crawler).
      expect(text).toContain("This tool requires a Tako account.");
      expect(text).not.toContain("Settings → Connectors");
      expect(text).not.toContain("Claude Code");
      // The TOOL-specific agent fallback is NOT client-gated — it names
      // only free-tier tools and carries no commerce copy, so every
      // client's model gets the executable route to the data.
      expect(text).toContain("tako_answer");
    }
  });

  it("an anonymous call to a NONEXISTENT tool still gets the SDK's genuine tool-not-found", async () => {
    // The gate only answers for names the registry knows — claiming a
    // typo'd tool needs auth would send the caller on a pointless sign-in.
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "tako_nonexistent", arguments: {} },
      }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(JSON.stringify(body)).toMatch(/not found/i);
    expect(JSON.stringify(body)).not.toMatch(/requires a Tako account/i);
    expect(limiter.keys).toEqual([]);
  });

  it("an anonymous call to an opt-in tool NOT enabled on this connection gets tool-not-found, not sign-in", async () => {
    // `tako_agent` is `?tools=agent` opt-in: signing in on THIS URL (no
    // opt-in) would still be "tool not found", so promising auth would
    // just move the dead end one sign-in later. The gate checks the
    // AUTHENTICATED surface for the same client + opt-ins before
    // answering.
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "tako_agent", arguments: { query: "x" } },
      }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(JSON.stringify(body)).toMatch(/not found/i);
    expect(JSON.stringify(body)).not.toMatch(/requires a Tako account/i);
    expect(limiter.keys).toEqual([]);
  });

  it("an anonymous call to an opt-in tool that IS enabled via ?tools= gets sign-in guidance", async () => {
    // With `?tools=agent` on the connection URL, authentication alone
    // unlocks the tool — so here the sign-in promise is true.
    const limiter = fakeLimiter(false);
    const res = await worker.fetch(
      new Request("https://example.com/mcp?tools=agent", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "tako_agent", arguments: { query: "x" } },
        }),
      }),
      freeEnv(limiter),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("requires a Tako account");
    expect(limiter.keys).toEqual([]);
  });

  it("an anonymous initialize returns the free-tier instructions variant", async () => {
    // The tier-specific instructions must ride the real HTTP path, not
    // just `createMcpServer` (covered in mcp.test.ts) — this pins the
    // wiring in `handleMcpRequest`.
    const res = await worker.fetch(
      post(INITIALIZE_BODY),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { instructions?: string };
    };
    expect(body.result.instructions).toBe(FREE_TIER_SERVER_INSTRUCTIONS);
  });

  it("free-tier credit exhaustion (Django 402) surfaces as the capacity message, not a billing error", async () => {
    const limiter = fakeLimiter(true);
    mockFetchSequence([
      new Response(JSON.stringify({ error_type: "PAYMENT_REQUIRED" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const res = await worker.fetch(post(ANSWER_CALL_BODY), freeEnv(limiter));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(FREE_TIER_CREDITS_MESSAGE);
  });

  it("a 4xx body merely CONTAINING 'PAYMENT_REQUIRED' text is not mistaken for credit exhaustion", async () => {
    // Only status 402 signals credit exhaustion. A validation error that
    // echoes caller-supplied text must keep the real error message.
    const limiter = fakeLimiter(true);
    mockFetchSequence([
      new Response(
        JSON.stringify({ detail: "invalid query: PAYMENT_REQUIRED" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    ]);
    const res = await worker.fetch(post(ANSWER_CALL_BODY), freeEnv(limiter));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).not.toBe(FREE_TIER_CREDITS_MESSAGE);
  });

  // The two REAL 402 bodies the priced endpoints emit (verified against
  // subscriptions/decorators.py in the monorepo): monthly plan credits
  // (regrant each cycle; remedy = upgrade/wait) vs prepaid PAYG balance
  // (remedy = add credits).
  const SUBSCRIPTION_402 = () =>
    new Response(
      JSON.stringify({
        error: "insufficient_credits",
        message:
          "You don't have enough credits for this request (need 3, have 0). " +
          "Upgrade your plan for more credits.",
        upgrade_url: "/pricing",
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  const PAYG_402 = () =>
    new Response(
      JSON.stringify({
        error_type: "PAYMENT_REQUIRED",
        error_message:
          "Your API credit balance is exhausted. Add credits to continue.",
        balance_cents: 0,
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );

  it("authenticated credit exhaustion on a claude client splices Django's own remedy", async () => {
    // The free tier masks 402s as neutral "capacity" (the caller has no
    // account to top up); an authenticated caller OWNS the balance, so the
    // actionable answer names the cause and the backend's OWN remedy —
    // which differs by account type, so it is spliced from the 402 body
    // rather than hand-written. Before `paymentRequiredToolResult` this
    // fell through as the raw "Django returned 402 for POST …".
    mockFetchSequence([SUBSCRIPTION_402()]);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, {
        authorization: "Bearer real-user-token",
        "user-agent": "claude-mcp-client/1.0",
      }),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        content: Array<{ text: string }>;
        isError: boolean;
        _meta: Record<string, { kind?: string; status?: number }>;
      };
    };
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0]?.text ?? "";
    expect(text).not.toBe(FREE_TIER_CREDITS_MESSAGE);
    expect(text).toContain("out of credits");
    // A subscription 402 names the subscription remedy — not "add
    // credits", which a FREE/PRO subscriber cannot do.
    expect(text).toContain("Upgrade your plan for more credits.");
    expect(body.result._meta["tako/error"]?.kind).toBe("payment_required");
    expect(body.result._meta["tako/error"]?.status).toBe(402);
  });

  it("authenticated credit exhaustion on Claude Code (unknown McpClientKind) still gets the remedy", async () => {
    // Claude Code deliberately buckets as "unknown" for widget routing;
    // the commerce gate keys on the UA allowlist instead, so the flagship
    // raw-Bearer client is not stranded with OpenAI's crawlers.
    mockFetchSequence([PAYG_402()]);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, {
        authorization: "Bearer real-user-token",
        "user-agent": "claude-code/2.1.220 (sdk-cli)",
      }),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0]?.text ?? "";
    expect(text).toContain("out of credits");
    // A PAYG 402 names the PAYG remedy.
    expect(text).toContain("Add credits to continue.");
  });

  it("authenticated credit exhaustion on ChatGPT-family and UNRECOGNIZED clients carries no remedy copy", async () => {
    // OpenAI's commerce policy forbids promoting purchases through an
    // app, and Django's remedies name plan upgrades and credit purchases
    // — exactly that copy. Unrecognized UAs fail closed for the same
    // reason `annotationClientFamily` buckets unknown with chatgpt: an
    // OpenAI reviewer/crawler — or a ChatGPT UA `detectMcpClient` hasn't
    // learned yet (the desktop app's `codex-mcp-client` UA was exactly
    // that once) — lands there. The factual cause stays on every client.
    for (const userAgent of ["openai-mcp/1.0", "python-httpx/0.27"]) {
      mockFetchSequence([SUBSCRIPTION_402()]);
      const res = await worker.fetch(
        post(ANSWER_CALL_BODY, {
          authorization: "Bearer real-user-token",
          "user-agent": userAgent,
        }),
        freeEnv(fakeLimiter(true)),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(body.result.isError).toBe(true);
      const text = body.result.content[0]?.text ?? "";
      expect(text).toContain("out of credits");
      expect(text).not.toContain("tako.com");
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/upgrade|add credits/i);
    }
  });

  it("anonymous rate limit on a claude client carries the account upsell", async () => {
    // The one place an anonymous Anthropic-client caller can learn that an
    // account lifts the limits — the same conversion moment Exa's keyless
    // tier uses ("add your own API key to continue").
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, {
        "user-agent": "claude-code/2.1.220 (sdk-cli)",
        "cf-connecting-ip": "203.0.113.9",
      }),
      freeEnv(fakeLimiter(false)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(
      `${FREE_TIER_LIMIT_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
  });

  it("anonymous rate limit on ChatGPT-family and unrecognized clients stays neutral", async () => {
    // Same fail-closed rule as the authenticated 402 remedy: commerce copy
    // reaching ChatGPT's model violates OpenAI policy, and an unrecognized
    // UA could be an OpenAI reviewer or crawler.
    for (const userAgent of ["ChatGPT/1.0", "python-httpx/0.27"]) {
      const res = await worker.fetch(
        post(ANSWER_CALL_BODY, { "user-agent": userAgent }),
        freeEnv(fakeLimiter(false)),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(body.result.content[0]?.text).toBe(FREE_TIER_LIMIT_MESSAGE);
    }
  });

  it("anonymous shared-account 402 on a claude client keeps the neutral cause and adds the upsell", async () => {
    // The cause stays masked (an anonymous caller must not learn the shared
    // account's balance state), but an Anthropic-client caller does get told
    // that connecting an account is the way past shared capacity.
    mockFetchSequence([SUBSCRIPTION_402()]);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY, { "user-agent": "claude-mcp-client/1.0" }),
      freeEnv(fakeLimiter(true)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(
      `${FREE_TIER_CREDITS_MESSAGE} ${FREE_TIER_COMMERCE_UPSELL}`,
    );
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
      FREE_TIER_GLOBAL_RATE_LIMITER: fakeLimiter(true),
    } as Env;
    const res = await worker.fetch(post(INITIALIZE_BODY), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await res.json()) as { error: { data: { kind: string } } };
    expect(body.error.data.kind).toBe("missing");
  });

  it("without the global limiter binding, anonymous requests 401 (fail-closed)", async () => {
    const env = {
      DJANGO_BASE_URL: "http://localhost:8000",
      FREE_TIER_API_KEY: "free-tier-secret-key",
      FREE_TIER_RATE_LIMITER: fakeLimiter(true),
    } as Env;
    const res = await worker.fetch(post(INITIALIZE_BODY), env);
    expect(res.status).toBe(401);
  });

  it("authenticated requests bypass both limiters and keep the full toolset", async () => {
    const limiter = fakeLimiter(false); // would 429 / restrict if consulted
    const globalLimiter = fakeLimiter(false);
    const res = await worker.fetch(
      post(TOOLS_LIST_BODY, { authorization: "Bearer real-user-token" }),
      freeEnv(limiter, globalLimiter),
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
    expect(globalLimiter.keys).toEqual([]);
  });

  it("a limiter runtime failure fails open — the anonymous call still succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchSequence([
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const res = await worker.fetch(
      post(ANSWER_CALL_BODY),
      freeEnv(throwingLimiter(), throwingLimiter()),
    );
    expect(res.status).toBe(200);
  });
});
