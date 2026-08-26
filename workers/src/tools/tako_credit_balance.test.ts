/**
 * Handler tests for `tako_credit_balance`.
 *
 * The tool had no handler coverage at all until it joined the DEFAULT `/mcp`
 * listing: every reference in the suite was set membership, the closed-world
 * annotation carve-out, or the anonymous-refusal case in `mcp.test.ts`, which
 * asserts the handler never runs. Promotion is what made that expensive — the
 * `{ details: … }` wrap and the wire-guard rethrow now reach every connection.
 *
 * The rethrow is the branch that matters most: it is the only place a backend
 * contract breach becomes model-visible copy, and the whole point of the
 * hand-written sentence is that the model must not receive a raw Zod issue
 * dump.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoCreditBalance from "./tako_credit_balance.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, surface: "generic",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_credit_balance", () => {
  it("GETs /api/v1/credit_balance/ with the connection's token and no params", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { credit_balance: 42.5, formatted_credit_balance: "42.50" }),
    ]);
    await takoCreditBalance.handler({}, CTX);

    const request = requestFrom(fetchMock.mock.calls[0]);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/v1/credit_balance/");
    expect([...url.searchParams.keys()]).toEqual([]);
    // Django expects the token in `X-API-Key`, not `Authorization` (see django.ts).
    expect(request.headers.get("X-API-Key")).toBe("sk-test");
  });

  it("wraps the payload under `details`", async () => {
    mockFetchSequence([
      jsonResponse(200, { credit_balance: 42.5, formatted_credit_balance: "42.50" }),
    ]);
    const out = await takoCreditBalance.handler({}, CTX);
    expect(out).toEqual({
      details: { credit_balance: 42.5, formatted_credit_balance: "42.50" },
    });
  });

  it("passes unknown billing fields through to the model", async () => {
    // The schema is `.loose()` on purpose: billing may add subscription info,
    // usage aggregates or expiry without a tool re-ship, and those still reach
    // the model via `structuredContent`.
    mockFetchSequence([
      jsonResponse(200, {
        credit_balance: 7,
        subscription: { plan: "pro", renews_at: "2026-09-01" },
        usage_this_period: 118,
      }),
    ]);
    const out = await takoCreditBalance.handler({}, CTX);
    expect(out.details).toMatchObject({
      credit_balance: 7,
      subscription: { plan: "pro", renews_at: "2026-09-01" },
      usage_this_period: 118,
    });
  });

  it("accepts a response with no known fields at all", async () => {
    // Every declared field is optional, so an empty object is a valid — if
    // useless — response and must not throw.
    mockFetchSequence([jsonResponse(200, {})]);
    await expect(takoCreditBalance.handler({}, CTX)).resolves.toEqual({ details: {} });
  });

  it("throws a readable sentence when the payload is not a JSON object", async () => {
    mockFetchSequence([jsonResponse(200, [1, 2, 3])]);
    await expect(takoCreditBalance.handler({}, CTX)).rejects.toThrow(
      /returned an unexpected shape \(not a JSON object\)/,
    );
  });

  it("never leaks a Zod issue dump into the model-visible message", async () => {
    // The reason the hand-written sentence exists. A raw issue dump gives the
    // model no hint that this is a backend breach rather than its own bad call.
    mockFetchSequence([jsonResponse(200, "not-an-object")]);
    // Zod's own markers only — "expected"/"received" would match the
    // hand-written sentence's own word "unexpected".
    await expect(takoCreditBalance.handler({}, CTX)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringMatching(/invalid_type|ZodError|"code":|\[\s*\{/i),
      }) as Error,
    );
  });

  it("rejects a wrong-typed known field rather than passing it on", async () => {
    // `credit_balance` is declared as a number; the backend returns a plain
    // JSON number (Pydantic float), not a DRF string-coerced decimal. A string
    // here means the contract moved.
    mockFetchSequence([jsonResponse(200, { credit_balance: "42.50" })]);
    await expect(takoCreditBalance.handler({}, CTX)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
