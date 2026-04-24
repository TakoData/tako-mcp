/**
 * Tests for `knowledge_search`'s fast-first-deep-fallback behavior.
 *
 * Observed on staging: `search_effort="deep"` frequently returns empty
 * `knowledge_cards` even for queries that `fast` answers in one hop. Deep
 * mode delegates to the Orca orchestrator via a redirect and the round-trip
 * is fragile from Workers; `fast` is lexical-only and reliable. The tool
 * therefore defaults to `fast` and only escalates to `deep` when `fast`
 * comes back empty.
 *
 * Locked properties:
 *   1. Default (no explicit `search_effort`) → call `fast` first.
 *   2. Empty `fast` result → retry with `deep`; return those results.
 *   3. Non-empty `fast` result → no retry.
 *   4. Explicit `deep` → single call with `deep` (no prior `fast`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import knowledge_search from "./knowledge_search.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

// Handler input type includes the zod-defaulted fields (count, country_code,
// locale) because `.default(...)` makes them non-optional after parse. Tests
// call `handler` directly (bypassing zod), so we spread these defaults in.
const DEFAULTS = { count: 5, country_code: "US", locale: "en-US" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetchSequence(
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

function requestFrom(call: Parameters<typeof fetch> | undefined): Request {
  if (call === undefined) {
    throw new Error("expected a recorded fetch call, got undefined");
  }
  const [input] = call;
  if (!(input instanceof Request)) {
    throw new Error("expected fetch to be called with a Request");
  }
  return input;
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>;
}

describe("knowledge_search fast-first-deep-fallback", () => {
  it("defaults to search_effort=fast on the initial call", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "abc", title: "Gold", description: "d", url: null, source: null },
          ],
        },
      }),
    ]);

    await knowledge_search.handler({ query: "gold price", ...DEFAULTS }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("fast");
  });

  it("does not retry when fast returns at least one card", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "abc", title: "Gold", description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "gold price", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("abc");
  });

  it("retries with search_effort=deep when fast returns zero cards", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "deep1", title: "Thailand Tourism", description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    const out = await knowledge_search.handler(
      { query: "thailand tourism gdp", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    const secondBody = await bodyOf(requestFrom(fetchMock.mock.calls[1]));
    expect(firstBody.search_effort).toBe("fast");
    expect(secondBody.search_effort).toBe("deep");
    expect(out.count).toBe(1);
    expect(out.results[0]?.card_id).toBe("deep1");
  });

  it("returns the empty fast result (no retry) when caller forces search_effort=fast", async () => {
    // Explicit `fast` is a "don't burn credits on deep" signal — respect it
    // even on empty results.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { outputs: { knowledge_cards: [] } }),
    ]);

    const out = await knowledge_search.handler(
      { query: "obscure", search_effort: "fast", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(0);
  });

  it("makes a single deep call when caller passes search_effort=deep", async () => {
    // Explicit `deep` skips the fast pre-call.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            { card_id: "d", title: null, description: null, url: null, source: null },
          ],
        },
      }),
    ]);

    await knowledge_search.handler(
      { query: "gold price", search_effort: "deep", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("deep");
  });
});
