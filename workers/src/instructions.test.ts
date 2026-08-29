import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, serverInstructionsFor } from "./instructions.js";
import { TIER_CLAIM } from "./tools/__test_helpers.js";

describe("instructions module", () => {
  it("serves one string with no tier parameter", () => {
    // The host loads `instructions` once at `initialize`; a per-tier variant
    // outlives a mid-conversation sign-in. The signature is the guard.
    expect(serverInstructionsFor.length).toBe(0);
    expect(serverInstructionsFor()).toBe(SERVER_INSTRUCTIONS);
    expect(serverInstructionsFor(null)).toBe(SERVER_INSTRUCTIONS);
  });

  it("carries no tier-specific claim", () => {
    // What runs anonymously is answered at dispatch (`authRequiredToolResult`),
    // never in text the host caches in the system prompt.
    expect(SERVER_INSTRUCTIONS).not.toMatch(TIER_CLAIM);
  });
});
