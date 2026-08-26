import { describe, expect, it } from "vitest";
import {
  FREE_TIER_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  serverInstructionsForTier,
} from "./instructions.js";

describe("instructions module", () => {
  it("serves the authenticated text for authenticated and the anonymous text for free", () => {
    expect(serverInstructionsForTier("authenticated")).toBe(SERVER_INSTRUCTIONS);
    expect(serverInstructionsForTier("free")).toBe(FREE_TIER_SERVER_INSTRUCTIONS);
  });

  it("both variants share the opening paragraph", () => {
    const [opening = ""] = SERVER_INSTRUCTIONS.split("\n");
    expect(FREE_TIER_SERVER_INSTRUCTIONS.startsWith(opening)).toBe(true);
  });
});
