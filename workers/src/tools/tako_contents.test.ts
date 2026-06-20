import { describe, it, expect, vi } from "vitest";

vi.mock("../django.js", () => ({
  djangoPost: vi.fn(),
  djangoGet: vi.fn(),
}));

import { djangoPost } from "../django.js";
import tool from "./tako_contents.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

describe("tako_contents", () => {
  it("returns the presigned URL + metadata for a card CSV (no inline text)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ format: "csv", url: "https://signed/csv", expires_at: "2026-06-20T00:00:00Z", cost: 0, source_url: "https://tako.com/card/abc" }],
      request_id: "r1",
    });
    const out = await tool.handler({ url: "https://tako.com/card/abc" }, ctx);
    expect(tool.name).toBe("tako_contents");
    expect(out.format).toBe("csv");
    expect(out.download_url).toBe("https://signed/csv");
    expect(out.text).toBeNull();
  });

  it("inlines text for a web-text artifact", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ format: "text", url: "https://signed/txt", expires_at: "2026-06-20T00:00:00Z", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r2",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello world"));
    const out = await tool.handler({ url: "https://example.com/a" }, ctx);
    expect(out.format).toBe("text");
    expect(out.text).toBe("hello world");
    fetchSpy.mockRestore();
  });
});
