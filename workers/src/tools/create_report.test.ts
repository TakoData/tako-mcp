/**
 * Tests for `create_report`'s error-forwarding contract.
 *
 * Contract: `create_report` does NOT catch or rewrap Django transport
 * errors. It lets `DjangoBadRequestError` propagate with the response
 * body intact on `.body`; the MCP adapter (`djangoErrorToToolResult`)
 * splices that body into the tool's text content so the LLM can read
 * Tako's DRF validation guidance and retry.
 *
 * This file locks two properties:
 *   1. On 400, the tool surfaces `DjangoBadRequestError` unchanged
 *      (so `err.body` is available to the adapter).
 *   2. On non-400, the tool surfaces the appropriate non-BadRequest
 *      `DjangoError` subtype (i.e. no catch-all swallowing).
 *
 * A future refactor that wraps Django errors inside `create_report` —
 * e.g. `throw new Error(err.body)` — would silently break the adapter's
 * splice logic and strip `structuredContent.body` from the result. Keep
 * this file narrow; the happy path is covered by `src/index.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
} from "../django.js";
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
  it("propagates DjangoBadRequestError with the response body intact on 400", async () => {
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

    // Tool must surface the raw DjangoBadRequestError — the MCP adapter
    // (`djangoErrorToToolResult`) handles the body splice at the MCP
    // boundary. Wrapping in `new Error(...)` here would drop the
    // `.body` / `.path` / `.method` metadata.
    expect(err).toBeInstanceOf(DjangoBadRequestError);
    const bad = err as DjangoBadRequestError;
    expect(bad.status).toBe(400);
    expect(bad.path).toBe("/api/v1/internal/reports/");
    expect(bad.method).toBe("POST");
    // Body must contain the DRF validation detail so the adapter can
    // splice it into the tool's text content.
    expect(bad.body).toContain("earnings_analysis");
    expect(bad.body).toContain("industry_overview");
    expect(bad.body).toContain("company_deep_dive");
  });

  it("propagates non-400 errors unchanged (no BadRequest special-casing)", async () => {
    // A 500 should surface as DjangoHttpError — NOT accidentally wrapped
    // or coerced into DjangoBadRequestError. Verifies the tool doesn't
    // contain a catch-all rewrite path.
    mockFetchOnce(jsonResponse(500, { detail: "Internal Server Error" }));

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

    expect(err).toBeInstanceOf(DjangoHttpError);
    expect(err).not.toBeInstanceOf(DjangoBadRequestError);
    expect((err as DjangoHttpError).status).toBe(500);
  });
});
