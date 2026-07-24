/**
 * Guards the advertised tool annotations. `openWorldHint` follows the MCP
 * spec's meaning — true when a tool interacts with an open/unpredictable set
 * of external entities (web search and the live data graph), false for a
 * closed domain (rendering caller-supplied data). Every tool must declare all
 * three hints explicitly (the type makes openWorldHint required); these tests
 * pin the load-bearing values and the explicitness guarantee.
 */
import { describe, expect, it } from "vitest";

import takoSearch from "./tako_search.js";
import takoAnswer from "./tako_answer.js";
import takoContents from "./tako_contents.js";
import takoAvailableData from "./tako_available_data.js";
import takoVisualize from "./tako_visualize.js";

describe("tool annotations — openWorldHint", () => {
  it("web-search-style retrieval tools are open-world (true)", () => {
    for (const tool of [takoSearch, takoAnswer, takoContents, takoAvailableData]) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.openWorldHint).toBe(true);
    }
  });

  it("tako_visualize is closed-world (false) — renders caller-supplied data", () => {
    expect(takoVisualize.annotations.readOnlyHint).toBe(false);
    expect(takoVisualize.annotations.destructiveHint).toBe(false);
    expect(takoVisualize.annotations.openWorldHint).toBe(false);
  });

  it("every tool declares all three hints explicitly", () => {
    for (const tool of [
      takoSearch,
      takoAnswer,
      takoContents,
      takoAvailableData,
      takoVisualize,
    ]) {
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
    }
  });
});
