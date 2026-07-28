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
  it("inline mode (default): returns CSV data inline with total_rows/truncated, no download_url", async () => {
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
      { url: "https://tako.com/card/abc", mode: "inline", content_format: "csv", max_chars: 100_000 },
      ctx,
    );
    expect(tool.name).toBe("tako_contents");
    expect(out.format).toBe("csv");
    expect(out.data).toBe("name,value\nA,1\nB,2");
    expect(out.total_rows).toBe(1500);
    expect(out.truncated).toBe(true);
    // Minimal envelope: url-mode fields are OMITTED inline, not null.
    expect(out).not.toHaveProperty("download_url");
    expect(out).not.toHaveProperty("expires_at");
    // source_url echoes the requested url here, so it is omitted too.
    expect(out).not.toHaveProperty("source_url");
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
      { url: "https://example.com/a", mode: "inline", content_format: "csv", max_chars: 100_000 },
      ctx,
    );
    // Web text carries no `format` — the envelope is essentially {data, cost}.
    expect(out).not.toHaveProperty("format");
    expect(out.data).toBe("hello world");
    expect(out).not.toHaveProperty("download_url");
    expect(out).not.toHaveProperty("truncated"); // complete → omitted, not false
    expect(out.cost).toBe(1); // web text is metered
  });

  it("query: extracts matching passages from web text and STRIPS query from the wire body", async () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(400); // ~10.8k chars
    const page = `${filler}RevPAR reached $142.11 in Q3.${filler}`;
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        { content_format: null, data: page, cost: 1, source_url: "https://example.com/a" },
      ],
      request_id: "r-passages",
    });
    const parsed = tool.inputSchema.parse({
      url: "https://example.com/a", mode: "inline", query: "RevPAR",
    });
    const out = await tool.handler(parsed, ctx);
    // Passages, not the full dump — data is PURE page text; the match summary
    // rides separately in `note`.
    expect(out.data).toContain("$142.11");
    expect(out.data).not.toContain("match(es)");
    expect(out.note).toContain("match(es)");
    expect((out.data as string).length).toBeLessThan(page.length / 2);
    expect(out.truncated).toBe(true);
    // `query` is an MCP-layer knob: the backend body must not carry it
    // (extra="forbid" would 400 the request).
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).not.toHaveProperty("query");
  });

  it("query: ignored for Tako card payloads (content_format csv)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          content_format: "csv",
          data: "name,value\nRevPAR,142.11\nADR,190.55",
          total_rows: 2,
          truncated: false,
          cost: 0.001,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r-card-q",
    });
    const parsed = tool.inputSchema.parse({
      url: "https://tako.com/card/abc", query: "RevPAR",
    });
    const out = await tool.handler(parsed, ctx);
    // CSV passes through untouched — no passage header injected into data.
    expect(out.data).toBe("name,value\nRevPAR,142.11\nADR,190.55");
  });

  it("query with no match: deterministic NOT FOUND notice instead of silence", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        { content_format: null, data: "a page about something else entirely", cost: 1, source_url: "https://example.com/a" },
      ],
      request_id: "r-miss",
    });
    const parsed = tool.inputSchema.parse({
      url: "https://example.com/a", query: "zebra unicorn",
    });
    const out = await tool.handler(parsed, ctx);
    expect(out.note).toContain("NOT FOUND");
    expect(out.data).toContain("a page about something else"); // head kept for orientation
  });

  it("url mode: returns the presigned download_url + expiry, no inline data", async () => {
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
      { url: "https://tako.com/card/abc", mode: "url", content_format: "csv", max_chars: 100_000 },
      ctx,
    );
    expect(out.download_url).toBe("https://signed/csv");
    expect(out.expires_at).toBe("2026-06-26T00:00:00Z");
    expect(out).not.toHaveProperty("data");
    expect(out).not.toHaveProperty("total_rows");
    expect(out).not.toHaveProperty("truncated");
  });

  it("passes url + mode through to POST /api/v1/contents/", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "x", cost: 0, source_url: "https://example.com/a" }],
      request_id: "r4",
    });
    await tool.handler(
      { url: "https://example.com/a", mode: "url", content_format: "csv", max_chars: 100_000 },
      ctx,
    );
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect(call[2]).toBe("/api/v1/contents/");
    expect(call[3]).toEqual({ url: "https://example.com/a", mode: "url", content_format: "csv", max_chars: 100_000 });
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
      max_chars: 100_000,
      content_format: "csv",
    });
  });

  it("caps web text via max_chars: the handler applies the 100k inline default onto the wire", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "x", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-chars",
    });
    // The schema deliberately has NO default — the handler decides per mode.
    const parsed = tool.inputSchema.parse({ url: "https://example.com/a" });
    expect(parsed.max_chars).toBeUndefined();
    await tool.handler(parsed, ctx);
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect((call[3] as { max_chars?: number }).max_chars).toBe(100_000);
  });

  it("url mode: omits max_chars from the wire unless the caller set one (full file, cache key preserved)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        { content_format: null, url: "https://signed/txt", expires_at: "2026-06-26T00:00:00Z", cost: 1, source_url: "https://example.com/a" },
      ],
      request_id: "r-url-nochars",
    });
    const parsed = tool.inputSchema.parse({ url: "https://example.com/a", mode: "url" });
    await tool.handler(parsed, ctx);
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).not.toHaveProperty("max_chars");
  });

  it("query: pins max_chars to the 1M ceiling so passages scan the full text", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "RevPAR was here", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-q-pin",
    });
    // Even an explicit cap is overridden — a capped scan would turn a late
    // match into a false deterministic miss.
    const parsed = tool.inputSchema.parse({
      url: "https://example.com/a", query: "RevPAR", max_chars: 5000,
    });
    await tool.handler(parsed, ctx);
    expect((vi.mocked(djangoPost).mock.calls[0]![3] as { max_chars?: number }).max_chars).toBe(1_000_000);
  });

  it("derives truncated for web text cut at max_chars (backend never sets it on the web route)", async () => {
    const page = "x".repeat(50);
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: page, truncated: false, cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-derived-cut",
    });
    const parsed = tool.inputSchema.parse({ url: "https://example.com/a", max_chars: 50 });
    const out = await tool.handler(parsed, ctx);
    expect(out.truncated).toBe(true);
    // Below the cap → complete → omitted (see the web-text test above).
  });

  it("max_chars: accepts a caller override up to the 1M full-text ceiling, rejects out-of-range", async () => {
    expect(tool.inputSchema.parse({ url: "https://x", max_chars: 1_000_000 }).max_chars).toBe(1_000_000);
    expect(tool.inputSchema.parse({ url: "https://x", max_chars: 5000 }).max_chars).toBe(5000);
    expect(() => tool.inputSchema.parse({ url: "https://x", max_chars: 0 })).toThrow();
    expect(() => tool.inputSchema.parse({ url: "https://x", max_chars: 1_000_001 })).toThrow();
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
    expect(out).not.toHaveProperty("data");
    expect(out).not.toHaveProperty("dataset");
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
    expect(out).not.toHaveProperty("data");
    expect(out).not.toHaveProperty("records");
  });

  it("throws when the endpoint returns no content item", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ contents: [], request_id: "r5" });
    await expect(
      tool.handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx),
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
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx)
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
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx)
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
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx)
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
      .handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx)
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
      tool.handler({ url: "https://tako.com/card/x", mode: "inline", content_format: "csv", max_chars: 100_000 }, ctx),
    ).rejects.toThrow(/returned 500/);
  });
});
