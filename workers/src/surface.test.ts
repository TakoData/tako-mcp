import { describe, expect, it } from "vitest";
import { surfaceForPath } from "./surface.js";

describe("surfaceForPath", () => {
  it("maps /mcp to generic", () => {
    expect(surfaceForPath("/mcp")).toBe("generic");
  });
  it("maps /mcp/chatgpt to chatgpt", () => {
    expect(surfaceForPath("/mcp/chatgpt")).toBe("chatgpt");
  });
  it("returns null for unknown paths (incl. trailing slash)", () => {
    expect(surfaceForPath("/mcp/")).toBeNull();
    expect(surfaceForPath("/mcp/oauth")).toBeNull();
    expect(surfaceForPath("/")).toBeNull();
  });
});
