/**
 * Tests for `export_report`.
 *
 * Locks four properties:
 *   1. URL construction — hits
 *      `/api/v1/internal/reports/{id}/export/{slug}/` with X-API-Key.
 *   2. Format → slug map — markdown→markdown, json→json, pdf→pdf,
 *      powerpoint→pptx.
 *   3. Text vs binary handling — md/json populate `content`; pdf/pptx
 *      populate `content_base64`. Each leaves the other null.
 *   4. Error pass-through — 404 surfaces the wait_for_report hint, 5xx
 *      includes status + body for triage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import export_report from "./export_report.js";
import { mockFetchOnce, requestFrom } from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Run a promise that's expected to reject and return the resulting
 * `Error`. `.catch((e) => e)` widens the inferred type to `T | unknown`,
 * which TS then complains about when we read `.message`. This helper
 * narrows once and keeps each test's assertion site clean.
 */
async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected rejection with Error, got: ${String(err)}`);
  }
  throw new Error("expected promise to reject, but it resolved");
}

/** Build a Response that mimics the Django export endpoint. */
function exportResponse(
  status: number,
  body: BodyInit,
  contentType: string,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("export_report", () => {
  it("hits the export endpoint with X-API-Key for the requested format", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      exportResponse(
        200,
        "# Report\n\nBody.",
        "text/markdown; charset=utf-8",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await export_report.handler(
      { report_id: "rep_abc", format: "markdown" },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://staging.trytako.com/api/v1/internal/reports/rep_abc/export/markdown/",
    );
    expect(req.headers.get("X-API-Key")).toBe("sk-test");
  });

  it("returns markdown content as decoded text", async () => {
    const md = "# Quarterly AI Report\n\n- Point one\n- Point two";
    mockFetchOnce(exportResponse(200, md, "text/markdown; charset=utf-8"));

    const out = await export_report.handler(
      { report_id: "rep_md", format: "markdown" },
      CTX,
    );

    expect(out).toEqual({
      report_id: "rep_md",
      format: "markdown",
      content_type: "text/markdown; charset=utf-8",
      byte_size: new TextEncoder().encode(md).byteLength,
      content: md,
      content_base64: null,
    });
  });

  it("returns json content as decoded text", async () => {
    const jsonBody = '{"title":"x","sections":[]}';
    mockFetchOnce(exportResponse(200, jsonBody, "application/json"));

    const out = await export_report.handler(
      { report_id: "rep_json", format: "json" },
      CTX,
    );

    expect(out.content).toBe(jsonBody);
    expect(out.content_base64).toBeNull();
    expect(out.content_type).toBe("application/json");
  });

  it("returns pdf content as base64 (text fields null)", async () => {
    // Use a fixed binary payload so the base64 expectation is
    // deterministic. PDF magic bytes (`%PDF-`) plus arbitrary tail.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await export_report.handler(
      { report_id: "rep_pdf", format: "pdf" },
      CTX,
    );

    expect(out.content).toBeNull();
    expect(out.content_base64).toBe(Buffer.from(bytes).toString("base64"));
    expect(out.byte_size).toBe(bytes.byteLength);
    expect(out.content_type).toBe("application/pdf");
  });

  it("uses pptx as the URL slug for powerpoint", async () => {
    // PowerPoint maps to a `.pptx` file, and the Django endpoint slug
    // mirrors the file extension. Lock the mapping so a casual rename
    // (`/export/powerpoint/`) doesn't slip in unnoticed.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK zip header
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await export_report.handler(
      { report_id: "rep_pp", format: "powerpoint" },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(new URL(req.url).pathname).toBe(
      "/api/v1/internal/reports/rep_pp/export/pptx/",
    );
  });

  it("URL-encodes the report id segment", async () => {
    // Defensive: report ids today are UUIDs, but the path interpolation
    // must not blow up if a future id ever contained reserved chars.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      exportResponse(200, "{}", "application/json"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await export_report.handler(
      { report_id: "rep with spaces", format: "json" },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toBe(
      "https://staging.trytako.com/api/v1/internal/reports/rep%20with%20spaces/export/json/",
    );
  });

  it("surfaces the wait_for_report hint on 404", async () => {
    // 404 on the export path is the natural "report not ready yet"
    // signal — backend doesn't render exports until completed. The
    // error must point the LLM at wait_for_report so it doesn't keep
    // retrying export_report on a still-running report.
    mockFetchOnce(
      new Response(JSON.stringify({ detail: "Not found." }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const err = await catchError(
      export_report.handler({ report_id: "rep_404", format: "pdf" }, CTX),
    );

    expect(err.message).toMatch(/404/);
    expect(err.message).toMatch(/wait_for_report/);
    expect(err.message).toMatch(/export\/pdf/);
  });

  it("includes status and body in non-2xx errors for triage", async () => {
    mockFetchOnce(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    const err = await catchError(
      export_report.handler({ report_id: "rep_500", format: "pdf" }, CTX),
    );

    expect(err.message).toMatch(/500/);
    expect(err.message).toMatch(/Internal Server Error/);
  });

  it("rejects exports above the size cap", async () => {
    // Build a payload larger than MAX_EXPORT_BYTES (4 MiB). Use a
    // single allocation rather than streaming because Workers fetch
    // mocks return the full body anyway.
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    mockFetchOnce(
      new Response(big, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    const err = await catchError(
      export_report.handler({ report_id: "rep_big", format: "pdf" }, CTX),
    );

    expect(err.message).toMatch(/exceeds/);
    expect(err.message).toMatch(/webpage_url/);
  });

  it("rejects empty / trailing-slash DJANGO_BASE_URL loudly", async () => {
    // Same invariants `django.ts` enforces — we duplicate them here
    // because this tool builds its URL by hand (the export endpoint
    // returns binary, so it can't go through the JSON-only djangoGet
    // helper).
    const badEnv: Env = { DJANGO_BASE_URL: "https://staging.trytako.com/" };
    const badCtx: ToolContext = { token: "sk-test", env: badEnv };

    const err = await catchError(
      export_report.handler({ report_id: "rep", format: "json" }, badCtx),
    );

    expect(err.message).toMatch(/trailing slash/);
  });
});
