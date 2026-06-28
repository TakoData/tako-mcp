import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("../django.js", () => ({
  djangoPost: vi.fn(),
  djangoGet: vi.fn(),
}));

import { djangoPost } from "../django.js";
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
});

describe("tako_contents handler", () => {
  it("inline mode (default): returns CSV data inline with total_rows/truncated, null download_url", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          format: "csv",
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
    const out = await tool.handler({ url: "https://tako.com/card/abc", mode: "inline" }, ctx);
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
          format: "text",
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
    const out = await tool.handler({ url: "https://example.com/a", mode: "inline" }, ctx);
    expect(out.format).toBe("text");
    expect(out.data).toBe("hello world");
    expect(out.download_url).toBeNull();
    expect(out.cost).toBe(1); // web text is metered
  });

  it("url mode: returns the presigned download_url + expiry, null inline data", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [
        {
          format: "csv",
          url: "https://signed/csv",
          expires_at: "2026-06-26T00:00:00Z",
          cost: 0,
          source_url: "https://tako.com/card/abc",
        },
      ],
      request_id: "r3",
    });
    const out = await tool.handler({ url: "https://tako.com/card/abc", mode: "url" }, ctx);
    expect(out.download_url).toBe("https://signed/csv");
    expect(out.expires_at).toBe("2026-06-26T00:00:00Z");
    expect(out.data).toBeNull();
    expect(out.total_rows).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("passes url + mode through to POST /api/v1/contents/", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ format: "text", data: "x", cost: 0, source_url: "https://example.com/a" }],
      request_id: "r4",
    });
    await tool.handler({ url: "https://example.com/a", mode: "url" }, ctx);
    const call = vi.mocked(djangoPost).mock.calls[0]!;
    expect(call[2]).toBe("/api/v1/contents/");
    expect(call[3]).toEqual({ url: "https://example.com/a", mode: "url" });
  });

  it("throws when the endpoint returns no content item", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ contents: [], request_id: "r5" });
    await expect(tool.handler({ url: "https://tako.com/card/x", mode: "inline" }, ctx)).rejects.toThrow(
      /no downloadable content/,
    );
  });
});
