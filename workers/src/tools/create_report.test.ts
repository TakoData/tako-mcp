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

function mockFetchSequence(responses: Response[]): ReturnType<typeof vi.fn<typeof fetch>> {
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestFrom(
  call: Parameters<typeof fetch> | undefined,
): Request {
  if (call === undefined) {
    throw new Error("expected a recorded fetch call, got undefined");
  }
  const [input] = call;
  // djangoPost/djangoGet always pass a Request object as the first arg.
  if (!(input instanceof Request)) {
    throw new Error("expected fetch to be called with a Request");
  }
  return input;
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
          // Pass explicit config so the tool skips the default-template
          // lookup and goes straight to create. Keeps this test focused
          // on create-error forwarding.
          config: { research_objective: "brief" },
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

  it("kicks off generation by POSTing to /analyze/ after create", async () => {
    // Observed prod bug: a plain POST /api/v1/internal/reports/ creates a
    // Draft record but never dispatches the Celery job. The backend
    // requires a follow-up POST /api/v1/internal/reports/{id}/analyze/
    // to transition the report to RUNNING and enqueue work. This test
    // locks the two-call contract.
    const fetchMock = mockFetchSequence([
      jsonResponse(201, {
        id: "rep_abc",
        status: "pending",
        title: "Quarterly AI market share",
        credit_cost: 25,
        estimated_runtime_seconds: 120,
      }),
      jsonResponse(202, {
        status: "running",
        celery_task_id: "task_xyz",
      }),
    ]);

    const out = await create_report.handler(
      {
        report_type: "agent_report",
        title: "Quarterly AI market share",
        research_objective: "Compare Claude/ChatGPT/Gemini",
        // Explicit config bypasses default-template lookup — this test
        // is about the create → analyze contract, not template resolution.
        config: { research_objective: "Compare Claude/ChatGPT/Gemini" },
      },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = requestFrom(fetchMock.mock.calls[0]);
    expect(first.method).toBe("POST");
    expect(new URL(first.url).pathname).toBe("/api/v1/internal/reports/");
    expect(first.headers.get("X-API-Key")).toBe("sk-test");

    const second = requestFrom(fetchMock.mock.calls[1]);
    expect(second.method).toBe("POST");
    expect(new URL(second.url).pathname).toBe(
      "/api/v1/internal/reports/rep_abc/analyze/",
    );
    expect(second.headers.get("X-API-Key")).toBe("sk-test");

    // Caller sees the post-analyze status so they know generation
    // actually started (not just that a draft was created).
    expect(out.report_id).toBe("rep_abc");
    expect(out.status).toBe("running");
  });

  it("auto-resolves default template when caller omits config", async () => {
    // Observed UX bug: `agent_report` is the only report type today and
    // its config requires `input_template` + `output_template` — shapes
    // the LLM can't guess. Without a default, every "write me a report
    // on X" call 400s. The Tako UI solves this by fetching the seeded
    // `is_default: true` template's detail (which carries the assembled
    // input/output XML in `config`), substituting user inputs into the
    // input XML, and POSTing the filled config alongside `template_source`.
    // The create serializer validates config against AgentReportConfig
    // which hard-requires both XML fields, so the MCP must mirror that
    // flow rather than relying on the backend to expand at create time.
    const fetchMock = mockFetchSequence([
      // 1. GET /api/v1/internal/reports/templates/ — list (no config).
      jsonResponse(200, [
        {
          id: "tmpl_other",
          is_default: false,
          report_type: "agent_report",
          name: "User-saved custom",
        },
        {
          id: "tmpl_default_agent",
          is_default: true,
          report_type: "agent_report",
          name: "Research Report",
        },
        {
          id: "tmpl_default_other",
          is_default: true,
          report_type: "other_type",
          name: "Other default",
        },
      ]),
      // 2. GET /api/v1/internal/reports/templates/tmpl_default_agent/ —
      //    detail carries config with assembled input/output XML.
      jsonResponse(200, {
        id: "tmpl_default_agent",
        is_default: true,
        report_type: "agent_report",
        name: "Research Report",
        config: {
          target_indexes: ["tako", "web"],
          input_template:
            '<research-objective required="true" label="Research Objective">default</research-objective>\n\n<audience-details required="false" label="Audience Details"/>',
          output_template:
            '<executive-summary required="true" label="Executive Summary">Lead with the most important finding.</executive-summary>',
        },
      }),
      // 3. POST /api/v1/internal/reports/ — create.
      jsonResponse(201, {
        id: "rep_xyz",
        status: "pending",
        title: "Iran conflict impact on oil",
      }),
      // 4. POST .../analyze/ — kick off generation.
      jsonResponse(202, {
        status: "running",
        celery_task_id: "task_qqq",
      }),
    ]);

    const out = await create_report.handler(
      {
        report_type: "agent_report",
        title: "Iran conflict impact on oil",
        research_objective: "How the Iran conflict is affecting oil prices",
      },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const listCall = requestFrom(fetchMock.mock.calls[0]);
    expect(listCall.method).toBe("GET");
    expect(new URL(listCall.url).pathname).toBe(
      "/api/v1/internal/reports/templates/",
    );
    expect(listCall.headers.get("X-API-Key")).toBe("sk-test");

    const detailCall = requestFrom(fetchMock.mock.calls[1]);
    expect(detailCall.method).toBe("GET");
    expect(new URL(detailCall.url).pathname).toBe(
      "/api/v1/internal/reports/templates/tmpl_default_agent/",
    );

    const createCall = requestFrom(fetchMock.mock.calls[2]);
    expect(createCall.method).toBe("POST");
    expect(new URL(createCall.url).pathname).toBe(
      "/api/v1/internal/reports/",
    );
    const createBody = (await createCall.json()) as Record<string, unknown>;
    expect(createBody.template_source).toBe("tmpl_default_agent");
    // Config must carry the filled XML — the backend's AgentReportConfig
    // pydantic model rejects missing input_template / output_template,
    // and <research-objective> content must be substituted with the
    // user's research_objective (mirrors the frontend's fillInputTemplate).
    const createConfig = createBody.config as Record<string, unknown>;
    expect(createConfig.target_indexes).toEqual(["tako", "web"]);
    expect(createConfig.output_template).toBe(
      '<executive-summary required="true" label="Executive Summary">Lead with the most important finding.</executive-summary>',
    );
    expect(createConfig.input_template).toBe(
      '<research-objective required="true" label="Research Objective">How the Iran conflict is affecting oil prices</research-objective>\n\n<audience-details required="false" label="Audience Details"/>',
    );
    expect(createConfig.research_objective).toBe(
      "How the Iran conflict is affecting oil prices",
    );
    expect(createConfig.audience_details).toBeNull();

    expect(out.report_id).toBe("rep_xyz");
    expect(out.status).toBe("running");
  });

  it("skips the template lookup when caller provides explicit config", async () => {
    // If the caller knows their config, don't burn a round-trip on a
    // lookup they'll ignore. Two fetches total: create + analyze.
    const fetchMock = mockFetchSequence([
      jsonResponse(201, { id: "rep_expl", status: "pending" }),
      jsonResponse(202, { status: "running", celery_task_id: "task_expl" }),
    ]);

    await create_report.handler(
      {
        report_type: "agent_report",
        title: "Explicit config report",
        research_objective: "objective",
        config: { input_template: "<xml/>", output_template: "<xml/>" },
      },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Neither of the two calls should be the templates-list GET.
    for (const call of fetchMock.mock.calls) {
      const req = requestFrom(call);
      expect(new URL(req.url).pathname).not.toBe(
        "/api/v1/internal/reports/templates/",
      );
    }

    // The create body must NOT have been rewritten — caller's config
    // passes through untouched.
    const createCall = requestFrom(fetchMock.mock.calls[0]);
    const createBody = (await createCall.json()) as Record<string, unknown>;
    expect(createBody.config).toEqual({
      input_template: "<xml/>",
      output_template: "<xml/>",
    });
    expect(createBody.template_source).toBeUndefined();
  });

  it("accepts paginated (DRF-style) template-list responses", async () => {
    // DRF default pagination wraps results in `{results: [...], count, ...}`.
    // The tool must handle both bare arrays and paginated shapes so we
    // don't silently fail to resolve a default when pagination is enabled.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: "tmpl_paged_default",
            is_default: true,
            report_type: "agent_report",
            name: "Research Report",
          },
        ],
      }),
      jsonResponse(200, {
        id: "tmpl_paged_default",
        is_default: true,
        report_type: "agent_report",
        config: {
          input_template: "<research-objective>x</research-objective>",
          output_template: "<executive-summary>y</executive-summary>",
        },
      }),
      jsonResponse(201, { id: "rep_paged", status: "pending" }),
      jsonResponse(202, { status: "running" }),
    ]);

    await create_report.handler(
      {
        report_type: "agent_report",
        title: "Paged",
        research_objective: "obj",
      },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const createCall = requestFrom(fetchMock.mock.calls[2]);
    const createBody = (await createCall.json()) as Record<string, unknown>;
    expect(createBody.template_source).toBe("tmpl_paged_default");
  });

  it("passes through to create when no matching default template exists", async () => {
    // If the list returns no is_default match, don't synthesize one —
    // let Django 400 so the caller sees the real error. This mirrors
    // the UI's behavior and avoids papering over a missing seed.
    const fetchMock = mockFetchSequence([
      jsonResponse(200, [
        {
          id: "tmpl_wrong_type",
          is_default: true,
          report_type: "something_else",
          name: "Wrong type",
        },
      ]),
      jsonResponse(400, {
        config: [
          "2 validation errors for AgentReportConfig input_template required, output_template required",
        ],
      }),
    ]);

    const err = await create_report
      .handler(
        {
          report_type: "agent_report",
          title: "No default",
          research_objective: "obj",
        },
        CTX,
      )
      .catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(DjangoBadRequestError);
    const createCall = requestFrom(fetchMock.mock.calls[1]);
    const createBody = (await createCall.json()) as Record<string, unknown>;
    // No template_source attached since none matched.
    expect(createBody.template_source).toBeUndefined();
    // But research_objective was still folded into config — harmless
    // when the backend rejects the call anyway.
    expect(createBody.config).toEqual({ research_objective: "obj" });
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
          // Explicit config → skip template lookup, go straight to create.
          config: { research_objective: "brief" },
        },
        CTX,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(DjangoHttpError);
    expect(err).not.toBeInstanceOf(DjangoBadRequestError);
    expect((err as DjangoHttpError).status).toBe(500);
  });
});
