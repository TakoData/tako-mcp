import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("GET /health returns 200", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
  });

  it("unknown route returns 404", async () => {
    const res = await SELF.fetch("https://example.com/does-not-exist");
    expect(res.status).toBe(404);
  });
});
