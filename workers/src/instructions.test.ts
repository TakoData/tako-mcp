import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, serverInstructionsFor } from "./instructions.js";
import { TIER_CLAIM } from "./tools/__test_helpers.js";

describe("instructions module", () => {
  it("serves one string with no tier parameter", () => {
    // The host loads `instructions` once at `initialize`; a per-tier variant
    // outlives a mid-conversation sign-in.
    //
    // This arity check is a TRIPWIRE, not the guard. `Function.length` stops
    // counting at the first defaulted parameter, so it catches only a
    // REQUIRED leading one — `(registered = null, tier = "authenticated")`,
    // an options bag, or a tier read off module state all still report 0.
    // What actually holds the invariant is the single call site
    // (`mcp.ts:236`) passing only a resolved toolset, and the two
    // same-instructions-per-tier assertions in `freetier.test.ts` and
    // `mcp.test.ts`, which compare the served strings rather than a number.
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
