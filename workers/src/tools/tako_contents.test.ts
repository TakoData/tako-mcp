import { afterEach, describe, it, expect, vi } from "vitest";

// Preserve the real module (error classes — the handler's `instanceof
// DjangoHttpError` 403 branch needs the genuine class) and stub only the
// transport functions.
vi.mock("../django.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../django.js")>()),
  djangoPost: vi.fn(),
  djangoGet: vi.fn(),
}));

import { DjangoError, DjangoHttpError, DjangoNotFoundError, djangoPost } from "../django.js";
import { djangoErrorToToolResult } from "../mcp.js";
import tool from "./tako_contents.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// --- A3: tests that validate the generated-contract schema wiring ---
it("exposes a mode parameter sourced from the generated contract", () => {
  const shape = tool.inputSchema.shape as Record<string, unknown>;
  expect(shape).toHaveProperty("url");
  expect(shape).toHaveProperty("mode");
});

it("defaults mode to inline (the documented MCP override of the contract default)", () => {
  const parsed = tool.inputSchema.parse({ url: "https://example.com" });
  expect(parsed.mode).toBe("inline");
});
// --- end A3 tests ---

describe("tako_contents input schema", () => {
  it("defaults mode to \"inline\"", () => {
    const parsed = tool.inputSchema.parse({ url: "https://tako.com/card/abc" });
    expect(parsed.mode).toBe("inline");
  });

  it("rejects an unknown mode", () => {
    expect(() => tool.inputSchema.parse({ url: "https://x", mode: "stream" })).toThrow();
  });

  it("rejects an empty url (local .min(1) guard; the spec has no minLength)", () => {
    expect(() => tool.inputSchema.parse({ url: "" })).toThrow();
  });

  it("exposes an optional max_rows", () => {
    const shape = tool.inputSchema.shape as Record<string, unknown>;
    expect(shape).toHaveProperty("max_rows");
    // Omitted → absent from parsed input (backend applies its 20-row default).
    const parsed = tool.inputSchema.parse({ url: "https://tako.com/card/abc" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("max_rows");
  });

  it("accepts a max_rows within 1..2000 and rejects out-of-range values", () => {
    expect(tool.inputSchema.parse({ url: "https://x", max_rows: 500 }).max_rows).toBe(500);
    expect(tool.inputSchema.parse({ url: "https://x", max_rows: 2000 }).max_rows).toBe(2000);
    expect(() => tool.inputSchema.parse({ url: "https://x", max_rows: 0 })).toThrow();
    expect(() => tool.inputSchema.parse({ url: "https://x", max_rows: 2001 })).toThrow();
  });

  it("exposes content_format (enum) defaulting to csv", () => {
    const shape = tool.inputSchema.shape as Record<string, unknown>;
    expect(shape).toHaveProperty("content_format");
    expect(tool.inputSchema.parse({ url: "https://tako.com/card/abc" }).content_format).toBe("csv");
    expect(
      tool.inputSchema.parse({ url: "https://x", content_format: "json_records" }).content_format,
    ).toBe("json_records");
    expect(() => tool.inputSchema.parse({ url: "https://x", content_format: "xml" })).toThrow();
  });
});

describe("tako_contents handler", () => {
  it("inline mode (default): returns CSV data inline with total_rows/truncated, null download_url", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "csv",
          data: "name,value\nA,1\nB,2",
          total_rows: 1500,
          truncated: true,
          cost: 0,
          source_url: "https://tako.com/card/abc",
          url: null,
          expires_at: null,
        },
      ],
      request_id: "r1",
    });
    const out = await tool.handler(
      { url: "https://tako.com/card/abc", mode: "inline", content_format: "csv" },
      ctx,
    );
    expect(tool.name).toBe("tako_contents");
    expect(out.format).toBe("csv");
    expect(out.data).toBe("name,value\nA,1\nB,2");
    expect(out.total_rows).toBe(1500);
    expect(out.truncated).toBe(true);
    expect(out.download_url).toBeNull();
    expect(out.expires_at).toBeNull();
    expect(out.cost).toBe(0); // card CSV is free
  });

  it("inline mode: returns web-page text and surfaces its cost", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: null,
          data: "hello world",
          total_rows: null,
          truncated: false,
          cost: 1,
          source_url: "https://example.com/a",
          url: null,
          expires_at: null,
        },
      ],
      request_id: "r2",
    });
    const out = await tool.handler(
      { url: "https://example.com/a", mode: "inline", content_format: "csv" },
      ctx,
    );
    expect(out.format).toBe("text");
    expect(out.data).toBe("hello world");
    expect(out.download_url).toBeNull();
    expect(out.cost).toBe(1); // web text is metered
  });

  it("url mode: returns the presigned download_url + expiry, null inline data", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "csv",
          url: "https://signed/csv",
          expires_at: "2026-06-26T00:00:00Z",
          cost: 0,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r3",
    });
    const out = await tool.handler(
      { url: "https://tako.com/card/abc", mode: "url", content_format: "csv" },
      ctx,
    );
    expect(out.download_url).toBe("https://signed/csv");
    expect(out.expires_at).toBe("2026-06-26T00:00:00Z");
    expect(out.data).toBeNull();
    expect(out.total_rows).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("passes url + mode through to POST /api/v1/contents/", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "x", cost: 0, source_url: "https://example.com/a" }],
      request_id: "r4",
    });
    await tool.handler(
      { url: "https://example.com/a", mode: "url", content_format: "csv" },
      ctx,
    );
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect(call[2]).toBe("/api/v1/contents/");
    expect(call[3]).toEqual({ url: "https://example.com/a", mode: "url", content_format: "csv" });
  });

  it("passes max_rows through to the POST body when provided", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "csv",
          data: "name,value\nA,1",
          total_rows: 300,
          truncated: true,
          cost: 0.001,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r6",
    });
    const parsed = tool.inputSchema.parse({ url: "https://tako.com/card/abc", max_rows: 1000 });
    await tool.handler(parsed, ctx);
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect(call[3]).toEqual({
      url: "https://tako.com/card/abc",
      mode: "inline",
      max_rows: 1000,
      content_format: "csv",
    });
  });

  it("json_records: maps records (data/dataset null) and passes content_format through", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "json_records",
          records: [
            { name: "A", value: 1 },
            { name: "B", value: 2 },
          ],
          total_rows: 2,
          truncated: false,
          cost: 0.001,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r7",
    });
    const parsed = tool.inputSchema.parse({
      url: "https://tako.com/card/abc",
      content_format: "json_records",
    });
    const out = await tool.handler(parsed, ctx);
    expect(out.format).toBe("json_records");
    expect(out.records).toEqual([
      { name: "A", value: 1 },
      { name: "B", value: 2 },
    ]);
    expect(out.data).toBeNull();
    expect(out.dataset).toBeNull();
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect((call[3] as { content_format?: string }).content_format).toBe("json_records");
  });

  it("json_compact: maps dataset (data/records null)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "json_compact",
          dataset: {
            columns: [
              { name: "name", type: "string" },
              { name: "value", type: "number" },
            ],
            rows: [
              ["A", 1],
              ["B", 2],
            ],
            total_rows: 2,
            truncated: false,
            ref: "ds_1",
            sources: [{ name: "Tako", index: "data" }],
            provenance: "query",
          },
          total_rows: 2,
          truncated: false,
          cost: 0.001,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r8",
    });
    const parsed = tool.inputSchema.parse({
      url: "https://tako.com/card/abc",
      content_format: "json_compact",
    });
    const out = await tool.handler(parsed, ctx);
    expect(out.format).toBe("json_compact");
    expect(out.dataset?.rows).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
    expect(out.data).toBeNull();
    expect(out.records).toBeNull();
  });

  it("throws when the endpoint returns no content item", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ contents: [], request_id: "r5" });
    await expect(
      tool.handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx),
    ).rejects.toThrow(/no downloadable content/);
  });

  it("maps the export-safe gate's 403 (unexportable card) to a DjangoError whose modelGuidance carries the backend detail", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/",
        method: "POST",
        status: 403,
        body: '{"detail":"card is not exportable"}',
      }),
    );
    const err = await tool
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    // Re-thrown as the ORIGINAL DjangoError (so registerTool still emits the
    // _meta["tako/error"] envelope), with the self-correcting text on
    // `modelGuidance` (used verbatim as the model-visible message).
    expect(err).toBeInstanceOf(DjangoHttpError);
    expect((err as DjangoHttpError).modelGuidance).toMatch(/403.*card is not exportable.*`content` attribute/s);
  });

  it("omits an unstructured 403 body (edge/WAF HTML) from the model-visible guidance", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/",
        method: "POST",
        status: 403,
        body: "<!DOCTYPE html><html><body>Access denied</body></html>",
      }),
    );
    const err = await tool
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DjangoHttpError);
    expect((err as DjangoHttpError).modelGuidance).toMatch(/refused this export \(403\)/);
    expect((err as DjangoHttpError).modelGuidance).not.toMatch(/DOCTYPE|<html>/);
  });

  it("maps a 404 (no exportable data / does not exist) to a DjangoError with self-correcting modelGuidance", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoNotFoundError({
        path: "/api/v1/contents/",
        method: "POST",
        body: '{"detail":"no exportable data"}',
      }),
    );
    const err = await tool
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DjangoNotFoundError);
    expect((err as DjangoNotFoundError).modelGuidance).toMatch(/404.*no exportable data.*`content` attribute/s);
  });

  it("preserves the _meta[\"tako/error\"] envelope for contents 403 (re-thrown DjangoError, guidance not double-spliced)", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/",
        method: "POST",
        status: 403,
        body: '{"detail":"card is not exportable"}',
      }),
    );
    const err = (await tool
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx)
      .catch((e: unknown) => e)) as DjangoError;
    // Mirror registerTool: a DjangoError maps to a structured tool result that
    // keeps the full envelope AND shows the verbatim guidance (detail spliced
    // exactly once, by the handler — not again here).
    const result = djangoErrorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result._meta["tako/error"]).toMatchObject({
      status: 403,
      body: '{"detail":"card is not exportable"}',
    });
    expect(result.content[0]?.text).toMatch(/refused this export \(403: card is not exportable\)/);
  });

  it("passes non-403 Django errors through untouched", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/",
        method: "POST",
        status: 500,
        body: "",
      }),
    );
    await expect(
      tool.handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv" }, ctx),
    ).rejects.toThrow(/returned 500/);
  });
});
