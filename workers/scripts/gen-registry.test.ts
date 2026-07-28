import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import {
  assertAllToolsDescribed,
  assertChatgptSubmissionParity,
  assertLlmsFullCoverage,
  buildLobehubPlugin,
  LOBEHUB_TOOL_ALLOWLIST,
  MCP_TOOL_ALLOWLIST,
} from "./gen-registry.js";

describe("registry guards", () => {
  it("every registered tool has a non-empty description", () => {
    expect(() => assertAllToolsDescribed(TOOL_REGISTRY)).not.toThrow();
  });

  it("the allowlist covers exactly the registered tool names", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const name of MCP_TOOL_ALLOWLIST) expect(registered.has(name)).toBe(true);
    expect(registered.size).toBe(MCP_TOOL_ALLOWLIST.length);
  });

  it("the LobeHub allowlist is a subset of the registered tools", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const name of LOBEHUB_TOOL_ALLOWLIST) {
      expect(registered.has(name)).toBe(true);
    }
  });
});

describe("buildLobehubPlugin", () => {
  const modules = TOOL_REGISTRY.map((tool) => ({ file: `${tool.name}.ts`, tool }));
  const committed = {
    identifier: "takodata-tako-mcp",
    version: "0.0.1",
    tags: ["web-search"],
    tools: [{ name: "stale", description: "stale", inputSchema: {} }],
  };

  it("keeps static fields, overrides version, and emits the curated tools", () => {
    const plugin = buildLobehubPlugin(committed, "9.9.9", modules);
    expect(plugin.identifier).toBe("takodata-tako-mcp");
    expect(plugin.tags).toEqual(["web-search"]);
    expect(plugin.version).toBe("9.9.9");
    const tools = plugin.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((t) => t.name)).toEqual([...LOBEHUB_TOOL_ALLOWLIST]);
    // Full draft-7 schemas, not server.json's flat parameter map.
    for (const tool of tools) {
      expect(tool.inputSchema.$schema).toContain("draft-07");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("throws when an allowlisted tool has no module", () => {
    const withoutSearch = modules.filter((m) => m.tool.name !== "tako_search");
    expect(() => buildLobehubPlugin(committed, "9.9.9", withoutSearch)).toThrow(
      /tako_search/,
    );
  });
});

describe("assertLlmsFullCoverage", () => {
  const tool = (name: string, ...params: string[]) => ({
    name,
    parameters: Object.fromEntries(params.map((p) => [p, {}])),
  });

  it("passes when a sectioned tool documents all its params", () => {
    const doc = "### tako_x\nStuff.\n\nParameters:\n- `query` (string)\n- `limit` (int)\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x", "query", "limit")], doc),
    ).not.toThrow();
  });

  it("fails when a sectioned tool is missing a param", () => {
    const doc = "### tako_x\nParameters:\n- `query` (string)\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x", "query", "node_ids")], doc),
    ).toThrow(/### tako_x.*`node_ids`/);
  });

  it("accepts a prose-only mention (no section) without param checks", () => {
    const doc = "On ChatGPT this is the `tako_x_start` / `tako_x_wait` pair.\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_x_start", "query")], doc),
    ).not.toThrow();
  });

  it("fails when a tool is never mentioned at all", () => {
    expect(() => assertLlmsFullCoverage([tool("tako_ghost")], "# Tako\n")).toThrow(
      /tako_ghost.*never mentioned/,
    );
  });

  it("only matches whole `### name` headings, not prefixes", () => {
    // A `### tako_agent` section must not satisfy `tako_agent_start`.
    const doc = "### tako_agent\nParameters:\n- `query`\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_agent_start", "query")], doc),
    ).toThrow(/tako_agent_start.*never mentioned/);
  });
});

describe("assertChatgptSubmissionParity", () => {
  // Fixture tool on ChatGPT's default authenticated surface: not optional,
  // not chatgpt-only/excluded, not a free-tier name — so the only gates it
  // exercises are the ones under test here.
  const tool = (
    name: string,
    overrides?: { chatgpt?: { openWorldHint?: boolean; readOnlyHint?: boolean } },
  ) => ({
    name,
    annotations: {
      title: name,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    ...(overrides !== undefined ? { annotationsByClient: overrides } : {}),
  });
  const submission = (
    tools: Record<string, { annotations?: Record<string, unknown> }>,
  ) => JSON.stringify({ tools });

  it("passes when the declared tools and hints match the runtime descriptors", () => {
    const t = tool("tako_x", { chatgpt: { openWorldHint: false } });
    const declared = submission({
      tako_x: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    });
    expect(() => assertChatgptSubmissionParity([t], declared)).not.toThrow();
  });

  it("throws when the top-level tools object is missing", () => {
    expect(() => assertChatgptSubmissionParity([tool("tako_x")], "{}")).toThrow(
      /missing top-level "tools"/,
    );
  });

  it("fails on a surface tool the submission does not declare", () => {
    expect(() =>
      assertChatgptSubmissionParity([tool("tako_x")], submission({})),
    ).toThrow(/missing tool "tako_x"/);
  });

  it("fails on a declared tool that is not on ChatGPT's default surface", () => {
    expect(() =>
      assertChatgptSubmissionParity(
        [],
        submission({ tako_ghost: { annotations: {} } }),
      ),
    ).toThrow(/extra tool "tako_ghost"/);
  });

  it("fails on a hint mismatch with a per-tool, per-hint message", () => {
    const t = tool("tako_x", { chatgpt: { openWorldHint: false } });
    const declared = submission({
      tako_x: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true, // runtime serves false for chatgpt
        },
      },
    });
    expect(() => assertChatgptSubmissionParity([t], declared)).toThrow(
      /tool "tako_x" openWorldHint: submission declares true, runtime serves false/,
    );
  });

  it("fails when a free-tier surface tool is missing from the submission", () => {
    // `tako_search` is in FREE_TIER_TOOL_NAMES: anonymous connections must
    // never see a tool the submission does not declare.
    expect(() =>
      assertChatgptSubmissionParity([tool("tako_search")], submission({})),
    ).toThrow(/anonymous free-tier ChatGPT surface but not declared/);
  });

  // NOTE: parity against the REAL registry + committed submission file is
  // asserted by `npm run registry:check` (CI), not here — this suite runs
  // in the Workers pool, which has no filesystem.
});
