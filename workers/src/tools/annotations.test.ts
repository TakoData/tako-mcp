/**
 * Guards the advertised tool annotations — specifically `openWorldHint`, which
 * distinguishes read-only retrieval tools (false: no effect observable outside
 * Tako) from the write/publish tool (true: creates a public card URL). These
 * values are read by MCP clients and tool scanners, so a silent flip is a
 * behavior change worth pinning.
 */
import { describe, expect, it } from "vitest";

import takoSearch from "./tako_search.js";
import takoAnswer from "./tako_answer.js";
import takoContents from "./tako_contents.js";
import takoAvailableData from "./tako_available_data.js";
import takoVisualize from "./tako_visualize.js";

describe("tool annotations — openWorldHint", () => {
  it("read-only retrieval tools declare openWorldHint: false", () => {
    for (const tool of [takoSearch, takoAnswer, takoContents, takoAvailableData]) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it("tako_visualize (write/publish) declares openWorldHint: true", () => {
    expect(takoVisualize.annotations.readOnlyHint).toBe(false);
    expect(takoVisualize.annotations.destructiveHint).toBe(false);
    expect(takoVisualize.annotations.openWorldHint).toBe(true);
  });
});
