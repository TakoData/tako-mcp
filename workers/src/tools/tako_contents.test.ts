import { afterEach, describe, it, expect, vi } from "vitest";

// Preserve the real module (error classes — the handler's `instanceof
// DjangoHttpError` 403 branch needs the genuine class) and stub only the
// transport functions.
vi.mock("../django.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../django.js")>()),
  djangoPost: vi.fn(),
  djangoGet: vi.fn(),
}));

import { DjangoError, DjangoHttpError, DjangoNotFoundError, DjangoUnauthorizedError, djangoPost } from "../django.js";
import { djangoErrorToToolResult } from "../mcp.js";
import tool, { BATCH_CHAR_BUDGET, MAX_CONTENTS_URLS } from "./tako_contents.js";

const ctx = { token: "t", env: {} as never, surface: "generic" as const, sendProgress: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** A web-page wire item: no `content_format`, which is how the projection
 *  tells a page from a card. */
const page = (data: string, cost = 0.01) => ({
  contents: [{ content_format: null, data, cost, url: null, expires_at: null, source_url: "https://src" }],
  request_id: "r",
});

/** A Tako-card wire item. `json_compact` is the only serialization the tool
 *  requests now, so `dataset` is the only payload channel a card arrives in.
 *  `ref`/`sources`/`provenance` ride because the generated `TakoDataset`
 *  requires them — and they are exactly what the projection drops. */
const card = (over: Record<string, unknown> = {}) => ({
  contents: [
    {
      content_format: "json_compact",
      dataset: {
        columns: [
          { name: "Timestamp", type: "datetime", unit: null },
          { name: "Total Revenues (USD)", type: "number", unit: "USD" },
        ],
        rows: [["2026-03-31T00:00:00+00:00", 111184000000], ["2026-06-30T00:00:00+00:00", null]],
        total_rows: 46,
        truncated: true,
        ref: "https://tako.com/card/abc",
        sources: [{ name: "Fiscal.ai", index: "data" }],
        provenance: "query",
      },
      total_rows: 46,
      truncated: true,
      cost: 0.0056,
      source_url: "https://tako.com/card/abc",
      ...over,
    },
  ],
  request_id: "r-card",
});

describe("tako_contents input schema", () => {
  it("takes four parameters — urls, max_rows, max_chars, query", () => {
    // Down from seven. `mode` and `content_format` are server decisions now
    // (see `fixedInputs`): one delivery, one serialization, so neither is a
    // question the model should be answering. The deprecated single `url` went
    // with them.
    expect(Object.keys(tool.inputSchema.shape).sort()).toEqual([
      "max_chars",
      "max_rows",
      "query",
      "urls",
    ]);
  });

  it("requires urls — the schema owns the check the handler used to", () => {
    // `urls` could not be required while the deprecated single `url` might
    // carry the request instead, which is why a runtime "at least one URL"
    // guard lived in the handler. With `url` gone the schema rejects an empty
    // call, and a caller pinned to the old shape reads one validation error
    // naming `urls` and retries on the same turn.
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ url: "https://x" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ urls: ["https://x"] }).success).toBe(true);
  });

  it("rejects an empty url (local .min(1) guard; the spec has no minLength)", () => {
    expect(() => tool.inputSchema.parse({ urls: [""] })).toThrow();
  });

  it("caps the batch so one call cannot fan out unbounded", () => {
    const many = Array.from({ length: MAX_CONTENTS_URLS + 1 }, (_, i) => `https://u${i}`);
    expect(() => tool.inputSchema.parse({ urls: many })).toThrow();
    expect(() => tool.inputSchema.parse({ urls: [] })).toThrow();
  });

  it("exposes an optional max_rows in 1..2000", () => {
    const parsed = tool.inputSchema.parse({ urls: ["https://x"] }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("max_rows");
    expect(tool.inputSchema.parse({ urls: ["https://x"], max_rows: 2000 }).max_rows).toBe(2000);
    expect(() => tool.inputSchema.parse({ urls: ["https://x"], max_rows: 0 })).toThrow();
    expect(() => tool.inputSchema.parse({ urls: ["https://x"], max_rows: 2001 })).toThrow();
  });

  it("max_chars: accepts a caller override up to the 1M full-text ceiling, rejects out-of-range", () => {
    expect(tool.inputSchema.parse({ urls: ["https://x"], max_chars: 1_000_000 }).max_chars).toBe(1_000_000);
    expect(() => tool.inputSchema.parse({ urls: ["https://x"], max_chars: 0 })).toThrow();
    expect(() => tool.inputSchema.parse({ urls: ["https://x"], max_chars: 1_000_001 })).toThrow();
  });

  it("states the real max_rows default: the whole card, up to 2,000 rows", () => {
    const described = tool.inputSchema.shape.max_rows.description ?? "";
    expect(described).not.toMatch(/20-row default/i);
    expect(described).toMatch(/2,000/);
  });
});

describe("tako_contents handler", () => {
  it("batches: N urls -> ONE call, N subrequests, results positionally aligned", async () => {
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      .mockResolvedValueOnce(page("page B"))
      .mockResolvedValueOnce(page("page C"));
    const out = await tool.handler({ urls: ["https://a", "https://b", "https://c"] }, ctx);
    expect(vi.mocked(djangoPost)).toHaveBeenCalledTimes(3);
    expect(out.results.map((r) => r.url)).toEqual(["https://a", "https://b", "https://c"]);
    expect(out.results.map((r) => r.text)).toEqual(["page A", "page B", "page C"]);
    // Each url is billed independently; the root reports the sum under the
    // same field name `tako_search` uses.
    expect(out.usage.total_cost_usd).toBeCloseTo(0.03);
  });

  it("one url failing does NOT discard the others; its entry carries the guidance", async () => {
    const gated = new DjangoHttpError({ path: "/api/v1/contents/", method: "POST", status: 403, body: "forbidden" });
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      .mockRejectedValueOnce(gated)
      .mockResolvedValueOnce(page("page C"));
    const out = await tool.handler({ urls: ["https://a", "https://gated", "https://c"] }, ctx);
    expect(out.results).toHaveLength(3);
    expect(out.results[0]?.text).toBe("page A");
    // Position preserved: the failure stays at index 1 rather than compacting
    // out and re-mapping every later index onto the wrong url.
    expect(out.results[1]?.url).toBe("https://gated");
    expect(out.results[1]?.text).toBeUndefined();
    expect(out.results[1]?.error).toMatch(/export gate refused this card/);
    expect(out.results[2]?.text).toBe("page C");
  });

  it("when EVERY url fails it throws, so a single-url 403 keeps its self-correcting envelope", async () => {
    vi.mocked(djangoPost).mockRejectedValue(new DjangoHttpError({ path: "/api/v1/contents/", method: "POST", status: 403, body: "forbidden" }));
    await expect(tool.handler({ urls: ["https://gated"] }, ctx)).rejects.toBeInstanceOf(DjangoHttpError);
  });

  // Review finding: `errorText` gated on `DjangoHttpError` specifically, but
  // DjangoNotFoundError/DjangoUnauthorizedError/DjangoBadRequestError/
  // DjangoTimeoutError/DjangoResponseParseError are SIBLING subclasses of the
  // base DjangoError, not subclasses of DjangoHttpError — so a partial-batch
  // 404 silently lost its modelGuidance (fell through to the bare
  // `reason.message`) and everything else leaked the internal request path
  // into model-visible text. Single-url calls never hit this: an unmatched
  // reason there re-throws whole into djangoErrorToToolResult instead of
  // being stringified by errorText.
  it("a 404 failing alongside other urls in a batch keeps its self-correcting modelGuidance (not the bare status)", async () => {
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      .mockRejectedValueOnce(
        new DjangoNotFoundError({
          path: "/api/v1/contents/", method: "POST", body: '{"detail":"no exportable data"}',
        }),
      );
    const out = await tool.handler({ urls: ["https://a", "https://missing"] }, ctx);
    expect(out.results[1]?.error).toContain("Nothing downloadable exists");
    expect(out.results[1]?.error).toContain("no exportable data");
    expect(out.results[1]?.error).not.toBe("Django returned 404 for POST /api/v1/contents/.");
  });

  it("a 401 failing alongside other urls in a batch does not leak the internal request path", async () => {
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      .mockRejectedValueOnce(
        new DjangoUnauthorizedError({ path: "/api/v1/contents/", method: "POST", body: "" }),
      );
    const out = await tool.handler({ urls: ["https://a", "https://unauthed"] }, ctx);
    expect(out.results[1]?.error).toContain("401");
    // AGENTS.md Safety Rules: error text must never expose internal URLs.
    expect(out.results[1]?.error).not.toContain("/api/v1/contents");
    expect(out.results[1]?.error).not.toContain("Django returned");
  });

  it("rounds the summed usage, so a batch total is not a float artifact", async () => {
    // This is the one Tako usage total that is COMPUTED rather than quoted:
    // search reads it off the backend, a contents batch adds up subrequests.
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("a", 0.1))
      .mockResolvedValueOnce(page("b", 0.2));
    const out = await tool.handler({ urls: ["https://a", "https://b"] }, ctx);
    expect(out.usage.total_cost_usd).toBe(0.3);
    expect(String(out.usage.total_cost_usd)).not.toContain("0.30000000000000004");
  });

  it("an unexpected throw inside a batch renders generically, never its own message", async () => {
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      // Not a transport failure and not one of our own aborts: a bug. Its
      // message is unreviewed text, and a batch entry is a model-visible
      // surface (AGENTS.md Safety Rules).
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'columns')"));
    const out = await tool.handler({ urls: ["https://a", "https://boom"] }, ctx);
    expect(out.results[0]?.text).toBe("page A");
    expect(out.results[1]?.error).toBe(
      "Fetch failed for this url. Retry once; if it persists, flag it to the Tako team.",
    );
    expect(out.results[1]?.error).not.toContain("columns");
    expect(out.results[1]?.error).not.toContain("TypeError");
  });

  it("keeps our own aborts verbatim — they are fetch outcomes, not bugs", async () => {
    vi.mocked(djangoPost)
      .mockResolvedValueOnce(page("page A"))
      .mockResolvedValueOnce({ contents: [], request_id: "r-empty" });
    const out = await tool.handler({ urls: ["https://a", "https://empty"] }, ctx);
    expect(out.results[1]?.error).toContain("no downloadable content");
  });

  it("serves a single url as a one-item batch", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("only"));
    const out = await tool.handler({ urls: ["https://only"] }, ctx);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.text).toBe("only");
    expect(out.results[0]?.url).toBe("https://only");
  });

  it("throws when the endpoint returns no content item", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ contents: [], request_id: "r5" });
    await expect(tool.handler({ urls: ["https://tako.com/card/x"] }, ctx)).rejects.toThrow(
      /no downloadable content/,
    );
  });
});

describe("tako_contents wire body", () => {
  it("always sends inline + json_compact, because the backend defaults to neither", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    await tool.handler({ urls: ["https://example.com/a"] }, ctx);
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect(call[2]).toBe("/api/v1/contents/");
    expect(call[3]).toEqual({
      url: "https://example.com/a",
      mode: "inline",
      content_format: "json_compact",
      max_chars: 100_000,
    });
  });

  it("card_json is unreachable: the tool names its own serialization", async () => {
    // The old input surface excluded `card_json` from an enum because its
    // payload arrives under `card_data`, which the output had no channel for.
    // With `content_format` off the input entirely there is no enum to police
    // — the tool sends one value and a caller cannot ask for another.
    expect(Object.keys(tool.inputSchema.shape)).not.toContain("content_format");
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    await tool.handler({ urls: ["https://x"] }, ctx);
    expect((vi.mocked(djangoPost).mock.calls[0]![3] as { content_format?: string }).content_format).toBe(
      "json_compact",
    );
  });

  it("passes max_rows through when provided", async () => {
    vi.mocked(djangoPost).mockResolvedValue(card());
    await tool.handler(tool.inputSchema.parse({ urls: ["https://tako.com/card/abc"], max_rows: 1000 }), ctx);
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).toEqual({
      url: "https://tako.com/card/abc",
      mode: "inline",
      content_format: "json_compact",
      max_rows: 1000,
      max_chars: 100_000,
    });
  });

  it("applies the 100k inline default for web text onto the wire", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    // The schema deliberately has NO default — `fetchOne` decides, because only
    // it knows the batch size.
    const parsed = tool.inputSchema.parse({ urls: ["https://example.com/a"] });
    expect(parsed.max_chars).toBeUndefined();
    await tool.handler(parsed, ctx);
    expect((vi.mocked(djangoPost).mock.calls[0]![3] as { max_chars?: number }).max_chars).toBe(100_000);
  });

  // Review finding: with no batch-wide budget, a 10-url default batch (each
  // defaulting to 100k chars) reconstructed the exact ~250k-token blowup the
  // single-url 100k default exists to prevent — spread across urls
  // instead of concentrated in one. BATCH_CHAR_BUDGET splits the DEFAULT
  // evenly across the batch instead. Derives expectations off the imported
  // constant rather than hardcoding its current value, so tuning
  // BATCH_CHAR_BUDGET (see its doc comment — it's a starting guess, not a
  // measured number) doesn't also require hunting down stale test numbers.
  it("splits the default max_chars across a batch that drives it below the single-url 100k default", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    const batchSize = Math.ceil(BATCH_CHAR_BUDGET / 100_000) + 1;
    const expectedPerUrl = Math.floor(BATCH_CHAR_BUDGET / batchSize);
    expect(expectedPerUrl).toBeLessThan(100_000); // sanity: this batch size DOES trigger the split
    const urls = Array.from({ length: batchSize }, (_, i) => `https://u${i}`);
    await tool.handler({ urls }, ctx);
    for (const call of vi.mocked(djangoPost).mock.calls) {
      expect((call[3] as { max_chars?: number }).max_chars).toBe(expectedPerUrl);
    }
  });

  it("a 2-url batch is unaffected when BATCH_CHAR_BUDGET / 2 is still >= the single-url 100k default", async () => {
    // True for any BATCH_CHAR_BUDGET >= 200_000, which the ⚠️ judgment-call
    // doc comment on the constant commits to staying at or above.
    expect(Math.floor(BATCH_CHAR_BUDGET / 2)).toBeGreaterThanOrEqual(100_000);
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    await tool.handler({ urls: ["https://a", "https://b"] }, ctx);
    for (const call of vi.mocked(djangoPost).mock.calls) {
      expect((call[3] as { max_chars?: number }).max_chars).toBe(100_000);
    }
  });

  it("an EXPLICIT max_chars is never split by batch size — the caller's deliberate choice rides as-is", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("x"));
    await tool.handler(
      { urls: ["https://a", "https://b", "https://c", "https://d"], max_chars: 300_000 },
      ctx,
    );
    for (const call of vi.mocked(djangoPost).mock.calls) {
      expect((call[3] as { max_chars?: number }).max_chars).toBe(300_000);
    }
  });

  it("query: pins max_chars to the 1M ceiling so passages scan the full text", async () => {
    vi.mocked(djangoPost).mockResolvedValue(page("RevPAR was here"));
    // Even an explicit cap is overridden — a capped scan would turn a late
    // match into a false deterministic miss.
    await tool.handler(
      tool.inputSchema.parse({ urls: ["https://example.com/a"], query: "RevPAR", max_chars: 5000 }),
      ctx,
    );
    expect((vi.mocked(djangoPost).mock.calls[0]![3] as { max_chars?: number }).max_chars).toBe(1_000_000);
  });

  it("logs when the derived batch cap actually cuts a page (observability for tuning BATCH_CHAR_BUDGET)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batchSize = Math.ceil(BATCH_CHAR_BUDGET / 100_000) + 1;
    const perUrlCap = Math.floor(BATCH_CHAR_BUDGET / batchSize);
    // A page exactly at the derived cap — the same "length >= maxChars" signal
    // the projection uses to derive `truncated` for web text.
    vi.mocked(djangoPost).mockResolvedValue(page("x".repeat(perUrlCap)));
    const urls = Array.from({ length: batchSize }, (_, i) => `https://u${i}`);
    await tool.handler({ urls }, ctx);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("batch max_chars cap bit"));
    warnSpy.mockRestore();
  });

  it("does NOT log the cap-bit warning when the caller set max_chars explicitly", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batchSize = Math.ceil(BATCH_CHAR_BUDGET / 100_000) + 1;
    vi.mocked(djangoPost).mockResolvedValue(page("x".repeat(5000)));
    const urls = Array.from({ length: batchSize }, (_, i) => `https://u${i}`);
    await tool.handler({ urls, max_chars: 5000 }, ctx);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("batch max_chars cap bit"));
    warnSpy.mockRestore();
  });
});

describe("tako_contents projected output", () => {
  it("a card returns one `rows` object — no data/records/dataset/format", async () => {
    vi.mocked(djangoPost).mockResolvedValue(card());
    const out = await tool.handler({ urls: ["https://tako.com/card/abc"] }, ctx);
    const item = out.results[0]!;
    expect(item.rows).toEqual({
      columns: ["Timestamp", "Total Revenues (USD)"],
      rows: [["2026-03-31T00:00:00+00:00", 111184000000], ["2026-06-30T00:00:00+00:00", null]],
      total_rows: 46,
    });
    // The three payload channels and the field that said which one was live
    // are gone; so is every wire key the projection does not declare.
    for (const dropped of ["data", "records", "dataset", "format", "ref", "sources", "provenance", "download_url", "expires_at"]) {
      expect(item).not.toHaveProperty(dropped);
    }
    expect(item.truncated).toBe(true);
    // source_url echoes the requested url here, so it is omitted.
    expect(item).not.toHaveProperty("source_url");
  });

  it("keeps a missing cell as null, which is what CSV could not do", async () => {
    // The reason the tool asks for json_compact rather than the cheaper csv: a
    // sparse comparison card — every "X vs Y" card is one — serializes in CSV
    // as a trailing bare comma, the most misparsed construct in the format.
    vi.mocked(djangoPost).mockResolvedValue(card());
    const out = await tool.handler({ urls: ["https://tako.com/card/abc"] }, ctx);
    expect(out.results[0]?.rows?.rows[1]).toEqual(["2026-06-30T00:00:00+00:00", null]);
  });

  it("folds a unit into the column name only when the name lacks it", async () => {
    vi.mocked(djangoPost).mockResolvedValue(
      card({
        dataset: {
          columns: [
            { name: "Revenue (USD)", type: "number", unit: "USD" },
            { name: "Headcount", type: "number", unit: "people" },
            { name: "Ratio", type: "number", unit: null },
            // The regression case: `"Team Payroll".includes("m")` is true, so
            // a raw containment test drops the unit here and the model reads
            // an unlabeled number.
            { name: "Team Payroll", type: "number", unit: "m" },
          ],
          rows: [[1, 2, 3, 4]],
          total_rows: 1,
          truncated: false,
          ref: "r",
          sources: [],
          provenance: "query",
        },
      }),
    );
    const out = await tool.handler({ urls: ["https://tako.com/card/abc"] }, ctx);
    // Measured across 8 cards on prod: every non-null unit was already inside
    // the name, so `columns` is a bare string array. This rule is what keeps
    // that from being an assumption that can fail in silence — which is why
    // the test is `(unit)` and not raw containment.
    expect(out.results[0]?.rows?.columns).toEqual([
      "Revenue (USD)",
      "Headcount (people)",
      "Ratio",
      "Team Payroll (m)",
    ]);
  });

  // An item must carry exactly one payload or an error. Without these two,
  // a backend that renames `dataset` (or `data`) returns a BILLED item with no
  // payload, no error and no note, and nothing in the stack can see it: every
  // payload field on the generated `ContentItem` is `.optional()`, so
  // `ContentsResponse.safeParse` passes, and `ContentsWireItem` widens all of
  // them, so `tsc` passes too. The projection is the only guard there is.
  it("a card whose dataset did not materialize reports an error, not an empty item", async () => {
    vi.mocked(djangoPost).mockResolvedValue(card({ dataset: null }));
    const out = await tool.handler({ urls: ["https://tako.com/card/abc"] }, ctx);
    const item = out.results[0]!;
    expect(item.rows).toBeUndefined();
    expect(item.text).toBeUndefined();
    expect(item.error).toMatch(/no data/i);
  });

  it("a web page with no text reports an error, not an empty item", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: null, cost: 0.01, url: null, expires_at: null, source_url: "https://src" }],
      request_id: "r",
    });
    const out = await tool.handler({ urls: ["https://example.com/a"] }, ctx);
    const item = out.results[0]!;
    expect(item.text).toBeUndefined();
    expect(item.error).toMatch(/no data/i);
  });

  it("a web page returns `text`, and reports its cost", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "hello world", total_rows: null, truncated: false, cost: 1, source_url: "https://example.com/a", url: null, expires_at: null }],
      request_id: "r2",
    });
    const out = await tool.handler({ urls: ["https://example.com/a"] }, ctx);
    const item = out.results[0]!;
    expect(item.text).toBe("hello world");
    expect(item).not.toHaveProperty("rows");
    expect(item).not.toHaveProperty("truncated"); // complete → omitted, not false
    expect(item.cost).toBe(1);
    expect(out.usage.total_cost_usd).toBe(1);
  });

  it("names the redirect target only when the fetch landed off the requested url", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "x", cost: 0, source_url: "https://example.com/redirected" }],
      request_id: "r-redirect",
    });
    const out = await tool.handler({ urls: ["https://example.com/a"] }, ctx);
    expect(out.results[0]?.source_url).toBe("https://example.com/redirected");
  });

  it("derives truncated for web text cut at max_chars (backend never sets it on the web route)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "x".repeat(50), truncated: false, cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-derived-cut",
    });
    const out = await tool.handler(
      tool.inputSchema.parse({ urls: ["https://example.com/a"], max_chars: 50 }),
      ctx,
    );
    expect(out.results[0]?.truncated).toBe(true);
  });

  it("puts the payload FIRST and the chrome last, so a truncating host loses cost, not rows", async () => {
    vi.mocked(djangoPost).mockResolvedValue(card());
    const out = await tool.handler({ urls: ["https://tako.com/card/abc"] }, ctx);
    expect(Object.keys(out.results[0]!)).toEqual(["url", "rows", "truncated", "cost"]);
  });

  it("puts `note` BEFORE the payload it explains, in the order that actually ships", async () => {
    // A note-free item cannot see this: the handler re-parses, so the shipped
    // order is the SHAPE's and the projection's spread order proves nothing.
    // Both channels have to agree, and the text renderer prints the note first.
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "RevPAR reached $142.11 in Q3.", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-note",
    });
    const out = await tool.handler({ urls: ["https://example.com/a"], query: "RevPAR" }, ctx);
    expect(Object.keys(out.results[0]!)).toEqual(["url", "note", "text", "cost"]);
  });
});

describe("tako_contents query passages", () => {
  it("extracts matching passages from web text and STRIPS query from the wire body", async () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(400); // ~10.8k chars
    const body = `${filler}RevPAR reached $142.11 in Q3.${filler}`;
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: body, cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-passages",
    });
    const out = await tool.handler(
      tool.inputSchema.parse({ urls: ["https://example.com/a"], query: "RevPAR" }),
      ctx,
    );
    // Passages, not the full dump — `text` is PURE page text; the match summary
    // rides separately in `note`.
    expect(out.results[0]?.text).toContain("$142.11");
    expect(out.results[0]?.text).not.toContain("match(es)");
    expect(out.results[0]?.note).toContain("match(es)");
    expect((out.results[0]?.text as string).length).toBeLessThan(body.length / 2);
    expect(out.results[0]?.truncated).toBe(true);
    // `query` is an MCP-layer knob: the backend body must not carry it
    // (extra="forbid" would 400 the request).
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).not.toHaveProperty("query");
  });

  it("is ignored for a Tako card payload", async () => {
    vi.mocked(djangoPost).mockResolvedValue(card());
    const out = await tool.handler(
      tool.inputSchema.parse({ urls: ["https://tako.com/card/abc"], query: "RevPAR" }),
      ctx,
    );
    // Rows pass through untouched — no passage note injected onto a card.
    expect(out.results[0]?.rows?.rows).toHaveLength(2);
    expect(out.results[0]).not.toHaveProperty("note");
  });

  it("no match: a deterministic NOT FOUND notice instead of silence", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ content_format: null, data: "a page about something else entirely", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r-miss",
    });
    const out = await tool.handler(
      tool.inputSchema.parse({ urls: ["https://example.com/a"], query: "zebra unicorn" }),
      ctx,
    );
    expect(out.results[0]?.note).toContain("NOT FOUND");
    expect(out.results[0]?.text).toContain("a page about something else"); // head kept for orientation
  });
});

describe("tako_contents error guidance", () => {
  it("maps the export-safe gate's 403 to modelGuidance carrying the backend detail", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/", method: "POST", status: 403, body: '{"detail":"card is not exportable"}',
      }),
    );
    const err = await tool
      .handler({ urls: ["https://tako.com/card/x"] }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    // Re-thrown as the ORIGINAL DjangoError (so registerTool still emits the
    // _meta["tako/error"] envelope), with the self-correcting text on
    // `modelGuidance` (used verbatim as the model-visible message).
    expect(err).toBeInstanceOf(DjangoHttpError);
    const guidance = (err as DjangoHttpError).modelGuidance ?? "";
    expect(guidance).toContain("card is not exportable");
    expect(guidance).toMatch(/Read the headline value/);
    // Two sentences: the verdict, then the one action. A branch that cannot
    // survive at two sentences dies (spec, guidance rules).
    expect(guidance.split(/(?<=\.)\s+/).filter((s) => s.length > 0)).toHaveLength(2);
  });

  it("omits an unstructured 403 body (edge/WAF HTML) from the model-visible guidance", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/", method: "POST", status: 403,
        body: "<!DOCTYPE html><html><body>Access denied</body></html>",
      }),
    );
    const err = await tool
      .handler({ urls: ["https://tako.com/card/x"] }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    const guidance = (err as DjangoHttpError).modelGuidance ?? "";
    expect(guidance).toMatch(/export gate refused this card,/);
    expect(guidance).not.toMatch(/DOCTYPE|<html>/);
  });

  it("maps a 404 to modelGuidance naming the one recovery", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoNotFoundError({
        path: "/api/v1/contents/", method: "POST", body: '{"detail":"no exportable data"}',
      }),
    );
    const err = await tool
      .handler({ urls: ["https://tako.com/card/x"] }, ctx)
      .then(() => {
        throw new Error("expected the handler to reject");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DjangoNotFoundError);
    const guidance = (err as DjangoNotFoundError).modelGuidance ?? "";
    expect(guidance).toContain("no exportable data");
    expect(guidance).toMatch(/exportable: true/);
    expect(guidance.split(/(?<=\.)\s+/).filter((s) => s.length > 0)).toHaveLength(2);
  });

  it("preserves the _meta[\"tako/error\"] envelope for contents 403 (guidance not double-spliced)", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({
        path: "/api/v1/contents/", method: "POST", status: 403, body: '{"detail":"card is not exportable"}',
      }),
    );
    const err = (await tool
      .handler({ urls: ["https://tako.com/card/x"] }, ctx)
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
    expect(result.content[0]?.text).toMatch(/refused this card \(card is not exportable\)/);
  });

  it("passes non-403 Django errors through untouched", async () => {
    vi.mocked(djangoPost).mockRejectedValue(
      new DjangoHttpError({ path: "/api/v1/contents/", method: "POST", status: 500, body: "" }),
    );
    await expect(tool.handler({ urls: ["https://tako.com/card/x"] }, ctx)).rejects.toThrow(/returned 500/);
  });
});
