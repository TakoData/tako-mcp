import { describe, expect, it } from "vitest";
import { surfaceForPath } from "./surface.js";

describe("surfaceForPath", () => {
  it("maps /mcp to generic", () => {
    expect(surfaceForPath("/mcp")).toBe("generic");
  });
  it("maps /mcp/chatgpt to chatgpt", () => {
    expect(surfaceForPath("/mcp/chatgpt")).toBe("chatgpt");
  });
  // A stray slash on a hand-pasted connector URL used to 404 with nothing to
  // diagnose. `canonicalizeResource` already ignores it when comparing token
  // audiences, so the two agree now.
  it("ignores a trailing slash", () => {
    expect(surfaceForPath("/mcp/")).toBe("generic");
    expect(surfaceForPath("/mcp/chatgpt/")).toBe("chatgpt");
    expect(surfaceForPath("/mcp///")).toBe("generic");
  });

  it("returns null for unknown paths", () => {
    expect(surfaceForPath("/mcp/oauth")).toBeNull();
    expect(surfaceForPath("/mcp/chatgpt/extra")).toBeNull();
    // The root must never resolve: stripping slashes turns "/" into "", which
    // is in no map entry.
    expect(surfaceForPath("/")).toBeNull();
    expect(surfaceForPath("")).toBeNull();
    expect(surfaceForPath("/health")).toBeNull();
  });
});
