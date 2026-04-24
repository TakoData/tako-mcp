/**
 * Tests for `create_report`'s error-forwarding contract.
 *
 * Iter-1 of the self-review loop added a specific behavior: when Django
 * returns 400, the tool catches `DjangoBadRequestError` and re-throws an
 * `Error` whose message contains the response body. This is load-bearing
 * — the input-schema description promises LLMs can read the list of valid
 * `report_type` values from the thrown message and retry. A future
 * refactor that drops the `instanceof` branch (or swaps `Error` for a
 * subclass the SDK doesn't special-case) would silently break that
 * contract.
 *
 * Focuses ONLY on the splice path — the happy path is exercised by the
 * integration test in `src/index.test.ts` once we add per-tool Django
 * mocking. Keep this file narrow.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import create_report from "./create_report.js";

const ENV: Env = { DJANGO_BASE_URL: "https://trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetchOnce(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => response),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("create_report error forwarding", () => {
  it("splices the 400 response body into the thrown Error message", async () => {
    // Realistic DRF validation payload — what Django returns when the
    // `report_type` slug isn't in `get_all_report_types()`.
    const drfErrorBody = {
      report_type: [
        "Unknown report type 'nope'. Available: ['earnings_analysis', 'industry_overview', 'company_deep_dive'].",
      ],
    };
    mockFetchOnce(jsonResponse(400, drfErrorBody));

    const err = await create_report
      .handler(
        {
          report_type: "nope",
          title: "test",
          research_objective: "brief",
        },
        CTX,
      )
      .catch((e) => e);

    // Tool must surface a plain Error (the MCP SDK special-cases `McpError`
    // but propagates everything else via `error.message` as tool text).
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // Message should identify the tool + status up front so Workers Logs
    // stay greppable.
    expect(message).toMatch(/create_report/);
    expect(message).toMatch(/400/);
    // The body must be present so an LLM can read the list of valid
    // `report_type` values and retry — this is the whole point of the
    // catch-and-rethrow pattern.
    expect(message).toContain("earnings_analysis");
    expect(message).toContain("industry_overview");
    expect(message).toContain("company_deep_dive");
  });

  it("does not catch non-400 errors (those propagate unchanged)", async () => {
    // A 500 should NOT be swallowed into a tool-friendly message — it's a
    // genuine server error and the SDK/runtime should see it unchanged.
    // Verifies the catch branch is narrow (`instanceof DjangoBadRequestError`
    // only) and not a catch-all.
    mockFetchOnce(
      jsonResponse(500, { detail: "Internal Server Error" }),
    );

    const err = await create_report
      .handler(
        {
          report_type: "earnings_analysis",
          title: "test",
          research_objective: "brief",
        },
        CTX,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // Should be the generic DjangoHttpError message, NOT the spliced-body
    // "Tako rejected create_report" prefix reserved for 400s.
    expect((err as Error).message).not.toMatch(/Tako rejected/);
    expect((err as Error).message).toMatch(/500/);
  });
});
