import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import { CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES } from "../src/tools/_surface.js";
import {
  assertAllToolsDescribed,
  assertChatgptSubmissionParity,
  assertLlmsFullCoverage,
  assertPinFormInDocs,
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

// The pin form measured to work is the METRIC node id ALONE with strict:true.
// `_pin_form.test.ts` guards it across tool and field descriptions; this guards
// the docs files it cannot reach, which is where the broken form survived a
// sweep whose commit message claimed "every surface".
describe("assertPinFormInDocs", () => {
  const doc = (text: string, requireStrict = true) => [
    { file: "d.txt", text, requireStrict },
  ];

  it("accepts advice that names the metric node alone with strict:true", () => {
    expect(() =>
      assertPinFormInDocs(
        doc("Pin that card's METRIC node id ALONE with `strict: true` to get the figures."),
      ),
    ).not.toThrow();
  });

  it("rejects a bare node_ids pin (the form that shipped in llms-full.txt)", () => {
    expect(() =>
      assertPinFormInDocs(doc("Ask here with its node_ids pinned to get the figures.")),
    ).toThrow(/without naming `strict: true`/);
  });

  it("rejects pinning every node id on the card", () => {
    expect(() =>
      assertPinFormInDocs(
        doc("Get figures via tako_answer with the card's `nodes` ids pinned and strict: true."),
      ),
    ).toThrow(/every node id on the card/);
  });

  // The token `strict` appearing anywhere used to satisfy the rule, so a
  // sentence advising the bare pin AND explaining that omitting strict does not
  // work passed it. Only an affirmative strict:true counts.
  it("is not satisfied by the word `strict` inside a negative clause", () => {
    expect(() =>
      assertPinFormInDocs(
        doc("Ask here with its node_ids pinned — omitting strict does not steer retrieval."),
      ),
    ).toThrow(/without naming `strict: true`/);
  });

  // README documents when to narrow `sources` and mentions pinning as a
  // PRECONDITION, not an instruction. No regex separates those, so the
  // strict-naming rule is opt-in per file.
  it("skips the strict rule where prose is not uniformly prescriptive", () => {
    const descriptive =
      'Narrow to `["data"]` only when you already know Tako has the metric (`tako_available_data` confirmed it, or you\'re pinning `node_ids`).';
    expect(() => assertPinFormInDocs(doc(descriptive, false))).not.toThrow();
    expect(() => assertPinFormInDocs(doc(descriptive, true))).toThrow();
  });

  // A parameter's own entry legitimately says "default false".
  it("does not flag parameter-definition lines", () => {
    expect(() =>
      assertPinFormInDocs(
        doc("- `node_ids` (array of strings, optional): Graph node ids to PIN into the data source."),
      ),
    ).not.toThrow();
  });

  it("reports the offending file and sentence", () => {
    expect(() =>
      assertPinFormInDocs([
        { file: "llms-full.txt", text: "Re-ask with node_ids pinned.", requireStrict: true },
      ]),
    ).toThrow(/llms-full\.txt/);
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

  // A REAL name, not a synthetic one. The function grew a second assertion —
  // the anonymous ChatGPT surface must EQUAL the declared tools — which reads
  // the real `CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES` constant, so a
  // synthetic `tako_x` can never satisfy it. This test kept the old fixture and
  // has been failing ever since, invisibly: `scripts/*.test.ts` matched no
  // vitest project until `vitest.scripts.config.ts` existed, so it never ran.
  //
  // Using every anonymous-discoverable name keeps the fixture honest if that
  // set changes: the parity assertion is EQUALITY in both directions, so a name
  // added there without appearing here fails this test rather than passing
  // vacuously.
  const ANON_NAMES = [...CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES];

  it("passes when the declared tools and hints match the runtime descriptors", () => {
    const tools = ANON_NAMES.map((n) => tool(n, { chatgpt: { openWorldHint: false } }));
    const declared = submission(
      Object.fromEntries(
        ANON_NAMES.map((n) => [
          n,
          {
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        ]),
      ),
    );
    expect(() => assertChatgptSubmissionParity(tools, declared)).not.toThrow();
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
