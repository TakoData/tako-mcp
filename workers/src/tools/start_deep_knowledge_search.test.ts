/**
 * Tests for `start_deep_knowledge_search`. Kicks off the async deep
 * pipeline and surfaces the backend's `task_id` immediately, no
 * polling, no widget. See the tool module for full rationale.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import start_deep_knowledge_search from "./start_deep_knowledge_search.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  // ChatGPT in practice — but the tool's behavior doesn't depend on
  // this; we set it for type-completeness.
  client: "chatgpt",
};

const DEFAULTS = { count: 10, country_code: "US", locale: "en-US" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("start_deep_knowledge_search", () => {
  it("POSTs to the search endpoint with search_effort=deep", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(202, { task_id: "task-1", status: "pending" }),
    ]);

    const out = await start_deep_knowledge_search.handler(
      { query: "us gdp", ...DEFAULTS },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.search_effort).toBe("deep");
    expect((body.inputs as { text: string; count: number }).text).toBe("us gdp");

    expect(out.task_id).toBe("task-1");
    expect(out.status).toBe("pending");
    expect(out.message).toMatch(/wait_for_knowledge_search/);
  });

  it("returns 'pending' regardless of the case the backend uses for status", async () => {
    mockFetchSequence([
      jsonResponse(202, { task_id: "task-case", status: "PENDING" }),
    ]);

    const out = await start_deep_knowledge_search.handler(
      { query: "x", ...DEFAULTS },
      CTX,
    );

    // Tool surface always returns lowercase 'pending' — the backend's
    // casing leaks via `isAsyncTaskInitiation` checking only `task_id`,
    // and we emit the literal "pending" from our schema.
    expect(out.status).toBe("pending");
    expect(out.task_id).toBe("task-case");
  });

  it("throws when the backend returns sync results instead of a task_id", async () => {
    // Defensive: tool's contract is "always return a task_id". If
    // the backend serves deep sync (rare / fixture path), tell the
    // agent to use the regular knowledge_search instead.
    mockFetchSequence([
      jsonResponse(200, {
        outputs: {
          knowledge_cards: [
            {
              card_id: "c1",
              title: "x",
              description: null,
              url: null,
              source: null,
            },
          ],
        },
      }),
    ]);

    await expect(
      start_deep_knowledge_search.handler({ query: "x", ...DEFAULTS }, CTX),
    ).rejects.toThrow(/synchronous results/i);
  });
});
