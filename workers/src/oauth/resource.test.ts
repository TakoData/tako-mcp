import { describe, expect, it } from "vitest";
import { canonicalizeResource, isServerResource } from "./resource.js";

describe("isServerResource", () => {
  const origin = "https://mcp.tako.com";
  it("accepts the chatgpt path as an audience", () => {
    expect(isServerResource(`${origin}/mcp/chatgpt`, origin)).toBe(true);
  });
  it("still accepts the bare origin and /mcp", () => {
    expect(isServerResource(origin, origin)).toBe(true);
    expect(isServerResource(`${origin}/mcp`, origin)).toBe(true);
  });
  it("canonicalizes the chatgpt path with query/trailing slash", () => {
    expect(canonicalizeResource(`${origin}/mcp/chatgpt/?tools=agent`)).toBe(
      `${origin}/mcp/chatgpt`,
    );
  });
  it("still rejects other paths", () => {
    expect(isServerResource(`${origin}/mcp/oauth`, origin)).toBe(false);
  });
});
