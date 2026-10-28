import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, serverInstructionsFor } from "./instructions.js";
import { TIER_CLAIM } from "./tools/__test_helpers.js";
import { GENERIC_DEFAULT_TOOL_NAMES } from "./tools/_surface.js";

describe("instructions module", () => {
  it("serves one string with no tier parameter", () => {
    // The host loads `instructions` once at `initialize`; a per-tier variant
    // outlives a mid-conversation sign-in.
    //
    // This arity check is a TRIPWIRE, not the guard. `Function.length` stops
    // counting at the first defaulted parameter, so it catches only a second
    // REQUIRED one — `(registered, tier = "authenticated")`, a defaulted
    // options bag, or a tier read off module state all still report 1.
    // What actually holds the invariant is the single call site
    // (`mcp.ts:236`) passing only a resolved toolset, and the two
    // same-instructions-per-tier assertions in `freetier.test.ts` and
    // `mcp.test.ts`, which compare the served strings rather than a number.
    expect(serverInstructionsFor.length).toBe(1);
  });

  it("carries no tier-specific claim", () => {
    // What runs anonymously is answered at dispatch (`authRequiredToolResult`),
    // never in text the host caches in the system prompt.
    expect(SERVER_INSTRUCTIONS).not.toMatch(TIER_CLAIM);
  });
});

describe("instructions on a connection that pins sources", () => {
  it("keeps the default string when no pin applies", () => {
    expect(serverInstructionsFor(GENERIC_DEFAULT_TOOL_NAMES)).toBe(SERVER_INSTRUCTIONS);
  });

  it("states a data pin and drops every web promise", () => {
    const text = serverInstructionsFor(GENERIC_DEFAULT_TOOL_NAMES, { sources: ["data"] });
    expect(text).toMatch(/^Tako searches a proprietary knowledge graph of live structured data\. /);
    expect(text).toContain(
      "On this connection, searches and agent runs use Tako data only and return no web results.",
    );
    expect(text).not.toContain("Default sources");
    expect(text).not.toContain("searches the web");
    expect(text).not.toContain("web links");
  });

  it("states a web pin", () => {
    const text = serverInstructionsFor(GENERIC_DEFAULT_TOOL_NAMES, { sources: ["web"] });
    expect(text).toContain(
      "On this connection, searches and agent runs use the web only and return no Tako data cards.",
    );
    expect(text).not.toContain("Default sources");
    expect(text).not.toContain("`tako_search` finds cards");
    expect(text).toMatch(/^Tako searches the web\. /);
    expect(text).not.toContain("knowledge graph");
    expect(text).not.toContain("Coverage includes");
  });

  it("states a data,web pin", () => {
    const text = serverInstructionsFor(GENERIC_DEFAULT_TOOL_NAMES, { sources: ["data", "web"] });
    expect(text).toContain(
      "On this connection, searches and agent runs always use both Tako data and the web, so one call answers a question that mixes a figure with context.",
    );
    expect(text).not.toContain("Default sources");
  });
});
