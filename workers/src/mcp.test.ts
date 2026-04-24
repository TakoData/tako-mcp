import { describe, expect, it } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
} from "./django.js";
import { djangoErrorToToolResult } from "./mcp.js";

describe("djangoErrorToToolResult", () => {
  it("maps DjangoUnauthorizedError to kind=unauthorized with status 401", () => {
    const err = new DjangoUnauthorizedError({
      path: "/api/v1/knowledge_search",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      kind: "unauthorized",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 401,
    });
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
  });

  it("maps DjangoTimeoutError with no status and includes timeoutMs", () => {
    const err = new DjangoTimeoutError({
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    const result = djangoErrorToToolResult(err);
    expect(result.structuredContent).toEqual({
      kind: "timeout",
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    // No `status` — timeouts have no HTTP status by construction.
    expect(result.structuredContent).not.toHaveProperty("status");
  });

  it("maps DjangoNotFoundError to kind=not_found with status 404", () => {
    const err = new DjangoNotFoundError({
      path: "/api/v1/charts/missing",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result.structuredContent).toEqual({
      kind: "not_found",
      path: "/api/v1/charts/missing",
      method: "GET",
      status: 404,
    });
  });

  it("maps DjangoBadRequestError and surfaces the response body in both structured and text content", () => {
    const err = new DjangoBadRequestError({
      path: "/api/v1/create_chart",
      method: "POST",
      body: '{"series":["this field is required"]}',
    });
    const result = djangoErrorToToolResult(err);
    expect(result.structuredContent).toEqual({
      kind: "bad_request",
      path: "/api/v1/create_chart",
      method: "POST",
      status: 400,
      body: '{"series":["this field is required"]}',
    });
    // 400s are the only subtype whose body is spliced into `content[0].text`:
    // DRF validation errors carry the guidance the LLM needs to retry, and
    // not every MCP client surfaces `structuredContent` to the model.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: {"series":["this field is required"]}`,
    });
  });

  it("maps DjangoResponseParseError to kind=response_parse with the 2xx status", () => {
    const err = new DjangoResponseParseError({
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 200,
      cause: new Error("unexpected token"),
    });
    const result = djangoErrorToToolResult(err);
    expect(result.structuredContent).toEqual({
      kind: "response_parse",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 200,
    });
  });

  it("maps DjangoHttpError (catch-all) and surfaces the response body", () => {
    const err = new DjangoHttpError({
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    const result = djangoErrorToToolResult(err);
    expect(result.structuredContent).toEqual({
      kind: "http",
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    // 5xx body stays in `structuredContent` only — not spliced into the
    // text content. Non-400 errors don't carry LLM-actionable retry
    // guidance and a noisy upstream body would flood the text channel.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result.content[0]?.text).not.toContain("service unavailable");
  });
});
