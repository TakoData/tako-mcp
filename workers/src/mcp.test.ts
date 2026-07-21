import { describe, expect, it } from "vitest";

import {
  DjangoBadRequestError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
  extractErrorDetail,
} from "./django.js";
import { djangoErrorToToolResult } from "./mcp.js";

describe("djangoErrorToToolResult", () => {
  // Read tools (tako_search/tako_answer/tako_contents) declare an
  // `outputSchema`. Spec-compliant MCP clients validate ANY
  // `structuredContent` present on a result against that schema — even when
  // `isError: true` — so attaching the error discriminant as
  // `structuredContent` made every Django error get rejected with a generic
  // `-32602` (masking the real failure). The machine-readable detail now
  // rides on `_meta["tako/error"]`, which clients forward but do NOT validate.
  it("omits structuredContent so clients validating against outputSchema don't reject the error", () => {
    const err = new DjangoHttpError({
      path: "/api/v3/search/",
      method: "POST",
      status: 503,
      body: "service unavailable",
    });
    const result = djangoErrorToToolResult(err);
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("maps DjangoUnauthorizedError to kind=unauthorized with status 401", () => {
    const err = new DjangoUnauthorizedError({
      path: "/api/v1/knowledge_search",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result._meta["tako/error"]).toEqual({
      kind: "unauthorized",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 401,
    });
    // No body captured → text stays body-free and `_meta` carries no `body`.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result._meta["tako/error"]).not.toHaveProperty("body");
  });

  it("surfaces a 401 auth-failure body in both _meta and text content", () => {
    const detail = "Invalid token.";
    const body = JSON.stringify({ detail });
    const err = new DjangoUnauthorizedError({
      path: "/api/v3/search/",
      method: "POST",
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "unauthorized",
      path: "/api/v3/search/",
      method: "POST",
      status: 401,
      body,
    });
    // 401 is a 4xx client error → the lifted reason reaches the model text.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
  });

  it("maps DjangoTimeoutError with no status and includes timeoutMs", () => {
    const err = new DjangoTimeoutError({
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "timeout",
      path: "/api/v1/insights",
      method: "POST",
      timeoutMs: 90_000,
    });
    // No `status` — timeouts have no HTTP status by construction.
    expect(result._meta["tako/error"]).not.toHaveProperty("status");
  });

  it("maps DjangoNotFoundError to kind=not_found with status 404", () => {
    const err = new DjangoNotFoundError({
      path: "/api/v1/charts/missing",
      method: "GET",
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "not_found",
      path: "/api/v1/charts/missing",
      method: "GET",
      status: 404,
    });
    // No body on this construction → nothing spliced, no `body` key.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result._meta["tako/error"]).not.toHaveProperty("body");
  });

  it("surfaces a 404 not-found body in both _meta and text content", () => {
    const detail = "No card found for that URL.";
    const body = JSON.stringify({ detail });
    const err = new DjangoNotFoundError({
      path: "/api/v1/contents/",
      method: "POST",
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "not_found",
      path: "/api/v1/contents/",
      method: "POST",
      status: 404,
      body,
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
  });

  it("maps DjangoBadRequestError and surfaces the response body in both _meta and text content", () => {
    const err = new DjangoBadRequestError({
      path: "/api/v3/search/",
      method: "POST",
      body: '{"query":["this field is required"]}',
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "bad_request",
      path: "/api/v3/search/",
      method: "POST",
      status: 400,
      body: '{"query":["this field is required"]}',
    });
    // A field-keyed DRF validation map is flattened to readable text (which
    // field failed) rather than spliced as raw JSON — the guidance the LLM
    // needs to retry, and not every MCP client surfaces structured detail.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: query: this field is required`,
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
    expect(result._meta["tako/error"]).toEqual({
      kind: "response_parse",
      path: "/api/v1/knowledge_search",
      method: "GET",
      status: 200,
    });
  });

  it("maps DjangoHttpError (catch-all) and surfaces the response body in _meta", () => {
    const err = new DjangoHttpError({
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toEqual({
      kind: "http",
      path: "/api/v1/whatever",
      method: "GET",
      status: 503,
      body: "service unavailable",
    });
    // 5xx SERVER-error body stays in `_meta` only — not spliced into the text
    // content. It carries no LLM-actionable detail and a noisy upstream body
    // (often an HTML error page) would flood the text channel.
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result.content[0]?.text).not.toContain("service unavailable");
  });

  it("splices a 403 (protected-source) body into the text content, not just _meta", () => {
    // Regression: a 403 from /api/v1/contents on a protected source used to
    // surface only the opaque "Django returned 403 for POST ..." message,
    // burying the actionable reason in `_meta` where most clients never read
    // it. 4xx CLIENT-error bodies are now spliced into the model-visible text.
    const detail = "Data export is not available for this card (protected source).";
    const body = JSON.stringify({ detail });
    const err = new DjangoHttpError({
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    const result = djangoErrorToToolResult(err);
    // `_meta` keeps the full raw JSON envelope untouched.
    expect(result._meta["tako/error"]).toEqual({
      kind: "http",
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    // The model-visible text carries the lifted `detail` message, not the
    // raw `{"detail": …}` JSON envelope.
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${err.message}: ${detail}`,
    });
    expect(result.content[0]?.text).toContain("protected source");
    expect(result.content[0]?.text).not.toContain('{"detail"');
  });

  it("does NOT splice a non-JSON 4xx body (e.g. a Cloudflare HTML block page)", () => {
    // A 4xx can carry a raw HTML edge/WAF page (403 block, 429 challenge).
    // It stays on `_meta` for debugging but must not flood the model text —
    // same failure mode the 5xx exclusion guards against, just on a 4xx.
    const body = "<!DOCTYPE html><html><body>Access denied (Error 1020)</body></html>";
    const err = new DjangoHttpError({
      path: "/api/v1/contents/",
      method: "POST",
      status: 403,
      body,
    });
    const result = djangoErrorToToolResult(err);
    expect(result._meta["tako/error"]).toMatchObject({ status: 403, body });
    expect(result.content[0]).toEqual({ type: "text", text: err.message });
    expect(result.content[0]?.text).not.toContain("DOCTYPE");
  });
});

describe("extractErrorDetail", () => {
  it("lifts DRF `detail`", () => {
    expect(extractErrorDetail('{"detail":"nope"}')).toBe("nope");
  });
  it("lifts `error`", () => {
    expect(extractErrorDetail('{"error":"boom"}')).toBe("boom");
  });
  it("lifts `message`", () => {
    expect(extractErrorDetail('{"message":"kaboom"}')).toBe("kaboom");
  });
  it("joins a nested list of detail strings", () => {
    expect(extractErrorDetail('{"detail":["a","b"]}')).toBe("a b");
  });
  it("flattens a field-keyed 400 validation map to readable text", () => {
    expect(extractErrorDetail('{"query":["this field is required"]}')).toBe(
      "query: this field is required",
    );
    expect(
      extractErrorDetail('{"query":["required"],"count":["must be an integer"]}'),
    ).toBe("query: required; count: must be an integer");
  });
  it("returns undefined for non-JSON text (e.g. an HTML edge page)", () => {
    expect(extractErrorDetail("service unavailable")).toBeUndefined();
    expect(extractErrorDetail("<html>Access denied</html>")).toBeUndefined();
  });
  it("returns undefined for a truncated (unparseable) JSON body", () => {
    expect(extractErrorDetail('{"detail":"long messag...[truncated]')).toBeUndefined();
  });
  it("returns undefined for a JSON object with no recognised message (bare discriminator)", () => {
    expect(
      extractErrorDetail('{"error_type":"RELEVANT_RESULTS_NOT_FOUND"}'),
    ).toBeUndefined();
  });
});
