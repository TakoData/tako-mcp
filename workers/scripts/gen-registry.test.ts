import { describe, it, expect } from "vitest";
import { z } from "zod";

import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import type { ToolModule } from "../src/tools/types.js";
import {
  diffRegistryParameters,
  assertAllToolsDescribed,
  assertChatgptSnapshot,
  assertChatgptSubmissionParity,
  assertLlmsFullCoverage,
  assertNoPhantomToolsInDocs,
  assertPinAdviceReachableInLlmsFull,
  assertPinFormInDocs,
  assertProseBudget,
  assertPublishedParametersUsable,
  declaredType,
  buildChatgptSnapshot,
  buildLobehubPlugin,
  buildToolsDoc,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
  INSTRUCTIONS_MAX_CHARS,
  LEGACY_PROSE_CEILINGS,
  LOBEHUB_TOOL_ALLOWLIST,
  MCP_TOOL_ALLOWLIST,
  PARAM_MAX_CHARS,
  TOOL_ENTRY_MAX_CHARS,
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
    // A `### tako_agent` section must not satisfy a longer name that starts
    // with it.
    const doc = "### tako_agent\nParameters:\n- `query`\n";
    expect(() =>
      assertLlmsFullCoverage([tool("tako_agent_deluxe", "query")], doc),
    ).toThrow(/tako_agent_deluxe.*never mentioned/);
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
        doc("Get figures via tako_search_advanced with the card's `nodes` ids pinned and strict: true."),
      ),
    ).toThrow(/every node id on the card/);
  });

  // The determiner used to be hardcoded to "the", which left the most likely
  // reword uncaught: the canonical strings this repo ships say "pin THAT card's
  // METRIC node id ALONE", so "that card's `nodes` ids" is the phrasing a future
  // edit drifts into — and `registry:check` passed on it. Two independent
  // narrownesses had to be fixed for this to fire: the determiner set here, and
  // `ADVISES_PINNING`'s stem, which could not span the backtick in "`nodes` ids".
  it("rejects the plural form under any determiner, not just `the`", () => {
    for (const phrasing of [
      "Get figures via tako_search_advanced with that card's `nodes` ids pinned.",
      "Get figures via tako_search_advanced with this card's `nodes` ids pinned.",
      "Get figures via tako_search_advanced with its `nodes` ids pinned.",
      "Get figures via tako_search_advanced with the cards' nodes ids pinned.",
    ]) {
      expect(() => assertPinFormInDocs(doc(phrasing)), phrasing).toThrow(
        /every node id on the card/,
      );
    }
  });

  // The flip side: the rule must not fire on prose that mentions ids without
  // pointing at a card's whole `nodes` array. `tako_search`'s description talks
  // about harvesting ids to feed the other tools, and the form we PRESCRIBE is a
  // singular metric node id.
  it("does not flag descriptive id prose or the prescribed singular form", () => {
    for (const phrasing of [
      "Use it for breadth and to harvest the node ids and urls it returns.",
      "Get figures via tako_search_advanced, pinning that card's METRIC node id ALONE with `strict: true`.",
    ]) {
      expect(() => assertPinFormInDocs(doc(phrasing)), phrasing).not.toThrow();
    }
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

  // The plural rule runs twice by design — once document-wide as a safety net
  // for whatever the sentence detector cannot see, once per sentence so the
  // offending text can be quoted. One bad sentence must still produce ONE
  // problem, or a real failure reads as two unrelated ones.
  it("reports one offending sentence once, not once per layer", () => {
    try {
      assertPinFormInDocs(doc("Get figures with the card's `nodes` ids pinned."));
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/every node id on the card/);
      expect(message.match(/every node id on the card/g)).toHaveLength(1);
    }
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
  // The fixtures name REAL chatgpt-surface tools: membership is a fixed name
  // set now (`CHATGPT_TOOL_NAMES`, spec D2), so a made-up name is simply off
  // the surface and would exercise none of the gates under test.
  const ON_SURFACE = "tako_search";
  const tool = (
    name: string,
    overrides?: { chatgpt?: { openWorldHint?: boolean; readOnlyHint?: boolean } },
  ) => ({
    name,
    annotations: {
      title: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    ...(overrides !== undefined ? { annotationsBySurface: overrides } : {}),
  });
  const submission = (
    tools: Record<string, { annotations?: Record<string, unknown> }>,
  ) => JSON.stringify({ tools });

  it("passes when the declared tools and hints match the runtime descriptors", () => {
    const tools = [tool(ON_SURFACE, { chatgpt: { openWorldHint: false } })];
    const declared = submission({
      [ON_SURFACE]: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    });
    expect(() => assertChatgptSubmissionParity(tools, declared)).not.toThrow();
  });

  it("throws when the top-level tools object is missing", () => {
    expect(() =>
      assertChatgptSubmissionParity([tool(ON_SURFACE)], "{}"),
    ).toThrow(/missing top-level "tools"/);
  });

  it("fails on a surface tool the submission does not declare", () => {
    expect(() =>
      assertChatgptSubmissionParity([tool(ON_SURFACE)], submission({})),
    ).toThrow(new RegExp(`missing tool "${ON_SURFACE}"`));
  });

  it("fails on a declared tool that is not on the chatgpt surface", () => {
    expect(() =>
      assertChatgptSubmissionParity(
        [],
        submission({ tako_ghost: { annotations: {} } }),
      ),
    ).toThrow(/extra tool "tako_ghost"/);
  });

  it("fails on a hint mismatch with a per-tool, per-hint message", () => {
    const t = tool(ON_SURFACE, { chatgpt: { openWorldHint: false } });
    const declared = submission({
      [ON_SURFACE]: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true, // runtime serves false for chatgpt
        },
      },
    });
    expect(() => assertChatgptSubmissionParity([t], declared)).toThrow(
      new RegExp(
        `tool "${ON_SURFACE}" openWorldHint: submission declares true, runtime serves false`,
      ),
    );
  });

  it("fails on a missing idempotentHint — OpenAI review requires all four hints explicit", () => {
    const declared = submission({
      [ON_SURFACE]: {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
    });
    expect(() =>
      assertChatgptSubmissionParity([tool(ON_SURFACE)], declared),
    ).toThrow(
      new RegExp(
        `tool "${ON_SURFACE}" idempotentHint: submission declares undefined, runtime serves true`,
      ),
    );
  });

  // NOTE: parity against the REAL registry + committed submission file is
  // asserted by `npm run registry:check` (CI), not here — this suite runs
  // in the Workers pool, which has no filesystem.
});

describe("assertChatgptSnapshot", () => {
  const search = {
    name: "tako_search",
    description: "Search.",
    inputSchema: z.object({ query: z.string() }),
  };
  const others = [
    { name: "tako_available_data", description: "a", inputSchema: z.object({ q: z.string() }) },
    { name: "tako_contents", description: "c", inputSchema: z.object({ urls: z.array(z.string()) }) },
    { name: "tako_visualize", description: "v", inputSchema: z.object({ components: z.array(z.any()) }) },
    { name: "tako_graph_related", description: "g", inputSchema: z.object({ node_id: z.string() }) },
  ];

  it("passes when the live descriptions and schemas match the snapshot", () => {
    const snapshot = buildChatgptSnapshot([search, ...others]);
    expect(() => assertChatgptSnapshot([search, ...others], snapshot)).not.toThrow();
  });

  it("fails when a reviewed tool's description changes", () => {
    const snapshot = buildChatgptSnapshot([search, ...others]);
    const edited = { ...search, description: "Search, now with more words." };
    expect(() => assertChatgptSnapshot([edited, ...others], snapshot)).toThrow(
      /tako_search.*description.*resubmit/is,
    );
  });

  it("fails when a reviewed tool's input schema changes", () => {
    const snapshot = buildChatgptSnapshot([search, ...others]);
    const edited = { ...search, inputSchema: z.object({ query: z.string(), count: z.number() }) };
    expect(() => assertChatgptSnapshot([edited, ...others], snapshot)).toThrow(/input_schema/);
  });

  it("ignores tools that are not on the chatgpt surface", () => {
    const snapshot = buildChatgptSnapshot([search, ...others]);
    const agent = { name: "tako_agent", description: "x", inputSchema: z.object({}) };
    expect(() => assertChatgptSnapshot([search, ...others, agent], snapshot)).not.toThrow();
  });
});

describe("buildToolsDoc", () => {
  const search = {
    name: "tako_search",
    description: "Search the graph.\n\nSecond paragraph.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language query."),
      count: z.number().int().min(1).max(20).optional().describe("Max results."),
    }),
    annotations: { title: "Tako: Search", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    annotationsBySurface: { chatgpt: { openWorldHint: false } },
    fixedInputs: [{ field: "sources.web.highlights", value: "true", note: "Highlights on." }],
    handler: async () => ({}),
  };
  const agent = {
    name: "tako_agent",
    description: "Run the agent.",
    inputSchema: z.object({ query: z.string() }),
    annotations: { title: "Tako: Answer Agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    fixedInputs: [],
    handler: async () => ({}),
  };
  const modules = [search, agent] as unknown as ToolModule[];
  const doc = buildToolsDoc({
    modules,
    registryTools: modules.map((m) => ({
      name: m.name,
      description: m.description,
      parameters: m.name === "tako_search"
        ? { query: { type: "string", description: "Natural-language query.", required: true }, count: { type: "integer", description: "Max results." } }
        : { query: { type: "string", required: true } },
      annotations: m.annotations,
    })),
    instructions: "INSTRUCTIONS TEXT",
    freeTierToolNames: new Set(["tako_search"]),
  });

  // No version in the banner, deliberately: release-please bumps
  // `registry/metadata.json` but does not track this doc, so an embedded
  // version would leave the committed file stale and fail `registry:check`
  // on release-please's own PR. `registry/server.json` and
  // `registry/lhm.plugin.json` carry the version because registries consume
  // them as published artifacts; a doc that regenerates from HEAD does not.
  it("opens with the generated-file banner and no version", () => {
    expect(doc.startsWith("<!-- GENERATED by workers/scripts/gen-registry.ts")).toBe(true);
    expect(doc).not.toMatch(/tako-mcp \d+\.\d+\.\d+/);
  });

  it("renders the description verbatim under the tool heading", () => {
    expect(doc).toContain("### tako_search");
    expect(doc).toContain("Search the graph.\n\nSecond paragraph.");
  });

  it("renders a parameter row per input with required and description", () => {
    expect(doc).toMatch(/\| `query` \| string \| yes \| .*Natural-language query\./);
    expect(doc).toMatch(/\| `count` \| integer \| no \| .*Max results\./);
  });

  it("renders per-surface annotations and the fixed inputs", () => {
    expect(doc).toContain("openWorldHint: true");   // generic
    expect(doc).toContain("openWorldHint: false");  // chatgpt override
    expect(doc).toContain("`sources.web.highlights` = `true`");
  });

  it("lists membership per surface and the tools= tokens", () => {
    expect(doc).toContain("## `/mcp`");
    expect(doc).toContain("## `/mcp/chatgpt`");
    expect(doc).toContain("`?tools=`");
    // Path-qualified: anonymous connections exist only on `/mcp`.
    expect(doc).toContain("Runs anonymously (on `/mcp`): yes"); // tako_search is free-tier
  });

  it("includes the instructions verbatim", () => {
    // One string for every tier — see `instructions.ts` for why there is
    // no anonymous variant to render.
    expect(doc).toContain("INSTRUCTIONS TEXT");
  });
});

// The guard's own corpus exercise is VACUOUS by construction: every
// pin-advising sentence in llms-full.txt today sits under
// `### tako_search_advanced`, which is pin-capable and therefore skipped, so `registry:check` has never demonstrated it fires. These
// two cases are the ones its doc comment describes, and they pin the part most
// likely to be silently wrong — the `split(/^### /m)` section attribution.
describe("assertPinAdviceReachableInLlmsFull", () => {
  const PIN_ADVICE =
    "Pin that card's METRIC node id ALONE with `strict: true` to get the figures.";
  const section = (tool: string) => `# Tako\n\n### ${tool}\n${PIN_ADVICE}\n`;
  const PIN_CAPABLE = new Set(["tako_search_advanced"]);

  it("throws when pin advice sits under a tool that accepts no node_ids", () => {
    expect(() =>
      assertPinAdviceReachableInLlmsFull(section("tako_available_data"), PIN_CAPABLE),
    ).toThrow(/tako_available_data.*accepts no/s);
  });

  it("accepts the same sentence under a pin-capable tool", () => {
    expect(() =>
      assertPinAdviceReachableInLlmsFull(section("tako_search_advanced"), PIN_CAPABLE),
    ).not.toThrow();
  });

  it("attributes to the ENCLOSING section, not the whole document", () => {
    // The failure mode the section split exists to prevent: advice under a
    // pin-capable heading must not be blamed on a later innocent section, and
    // advice under an innocent heading must not be excused by an earlier
    // pin-capable one.
    const doc = `# Tako\n\n### tako_search_advanced\n${PIN_ADVICE}\n\n### tako_contents\nNothing here.\n`;
    expect(() => assertPinAdviceReachableInLlmsFull(doc, PIN_CAPABLE)).not.toThrow();
    const flipped = `# Tako\n\n### tako_search_advanced\nNothing here.\n\n### tako_contents\n${PIN_ADVICE}\n`;
    expect(() => assertPinAdviceReachableInLlmsFull(flipped, PIN_CAPABLE)).toThrow(
      /tako_contents/,
    );
  });

  it("is inert when no tool accepts a pin, rather than flagging every section", () => {
    expect(() =>
      assertPinAdviceReachableInLlmsFull(section("tako_available_data"), new Set()),
    ).not.toThrow();
  });
});

describe("diffRegistryParameters", () => {
  const committed = {
    tools: [
      { name: "tako_search_advanced", parameters: { query: {}, data: {} } },
      { name: "tako_search", parameters: { query: {} } },
    ],
  };
  const generated = [
    { name: "tako_search_advanced", parameters: { query: {}, data: {}, web: {} } },
    { name: "tako_search", parameters: {} },
    { name: "tako_new", parameters: { q: {} } },
  ];

  it("names added and removed parameters per tool, and new tools", () => {
    expect(diffRegistryParameters(committed, generated)).toEqual([
      "tako_new: new tool (q)",
      "tako_search: -query",
      "tako_search_advanced: +web",
    ]);
  });

  it("is empty when nothing moved", () => {
    expect(diffRegistryParameters(committed, committed.tools)).toEqual([]);
  });

  it("reports a tool that disappeared", () => {
    expect(diffRegistryParameters(committed, [committed.tools[0]!])).toEqual([
      "tako_search: tool removed",
    ]);
  });

  it("treats an absent committed registry as all-new rather than throwing", () => {
    // First run in a fresh checkout: server.json may not exist yet.
    expect(diffRegistryParameters({}, generated)).toEqual([
      "tako_new: new tool (q)",
      "tako_search: new tool ()",
      "tako_search_advanced: new tool (data, query, web)",
    ]);
  });
});

describe("declaredType", () => {
  it("reads a plain type directly", () => {
    expect(declaredType({ type: "string" })).toBe("string");
  });

  it("reads THROUGH a nullable union, which is how the generated schemas emit every nullable field", () => {
    // `z.union([z.string(), z.null()])`. Reading `prop.type` published
    // `"type": "unknown"` for `timezone` on the registry card.
    expect(
      declaredType({ anyOf: [{ type: "string" }, { type: "null" }] }),
    ).toBe("string");
    expect(
      declaredType({ anyOf: [{ type: "integer" }, { type: "null" }] }),
    ).toBe("integer");
    expect(
      declaredType({ anyOf: [{ type: "object" }, { type: "null" }] }),
    ).toBe("object");
  });

  it("handles oneOf the same way", () => {
    expect(
      declaredType({ oneOf: [{ type: "number" }, { type: "null" }] }),
    ).toBe("number");
  });

  it("stays unknown when the union has more than one non-null branch", () => {
    // The registry format carries ONE type per parameter, so there is nowhere
    // to put the second. "unknown" is the honest answer, not a fallback.
    expect(
      declaredType({ anyOf: [{ type: "string" }, { type: "number" }] }),
    ).toBe("unknown");
  });

  it("stays unknown when nothing declares a type", () => {
    expect(declaredType({})).toBe("unknown");
    expect(declaredType({ anyOf: [{ type: "null" }] })).toBe("unknown");
  });
});

describe("assertPublishedParametersUsable", () => {
  const ok = {
    name: "tako_x",
    parameters: { query: { type: "string", description: "A query." } },
  };

  it("passes when every parameter has a type and a description", () => {
    expect(() => assertPublishedParametersUsable([ok])).not.toThrow();
  });

  it("names the parameter whose type is unknown", () => {
    // The five-parameter regression: `z.union([T, z.null()])` emits no
    // top-level `type`, so the card advertised `"type": "unknown"`.
    expect(() =>
      assertPublishedParametersUsable([
        { name: "tako_x", parameters: { p: { type: "unknown", description: "d" } } },
      ]),
    ).toThrow(/tako_x\.p has no usable type/);
  });

  it("names the parameter whose description is empty", () => {
    // `output_settings` shipped `"description": ""` because a hand-written
    // `.describe(x.description ?? "")` read the outer `.optional()` wrapper,
    // where the generated text does not live.
    expect(() =>
      assertPublishedParametersUsable([
        { name: "tako_x", parameters: { p: { type: "string", description: "" } } },
      ]),
    ).toThrow(/tako_x\.p has no description/);
    expect(() =>
      assertPublishedParametersUsable([
        { name: "tako_x", parameters: { p: { type: "string" } } },
      ]),
    ).toThrow(/tako_x\.p has no description/);
  });

  it("passes on the live tool surface", () => {
    const tools = TOOL_REGISTRY.map((tool) => ({
      name: tool.name,
      parameters: Object.fromEntries(
        Object.entries(
          (z.toJSONSchema(tool.inputSchema) as { properties?: Record<string, unknown> })
            .properties ?? {},
        ).map(([key, raw]) => {
          const prop = raw as { description?: string };
          const spec: { type: string; description?: string } = {
            type: declaredType(raw as Parameters<typeof declaredType>[0]),
          };
          if (prop.description !== undefined) spec.description = prop.description;
          return [key, spec];
        }),
      ),
    }));
    expect(() => assertPublishedParametersUsable(tools)).not.toThrow();
  });
});

describe("assertNoPhantomToolsInDocs", () => {
  const known = ["tako_search", "tako_search_advanced"];

  it("passes when every named tool is registered", () => {
    expect(() =>
      assertNoPhantomToolsInDocs(known, [
        { path: "llms.txt", text: "Use `tako_search`, then `tako_search_advanced`." },
      ]),
    ).not.toThrow();
  });

  it("fails on a tool that was deleted, which coverage cannot see", () => {
    // `assertLlmsFullCoverage` only asks whether every REGISTERED tool is
    // mentioned. `tako_answer` survived its own deletion in two llms-full.txt
    // lines with coverage green, because the tool that replaced it has a
    // section of its own.
    expect(() =>
      assertNoPhantomToolsInDocs(known, [
        { path: "llms-full.txt", text: "Opt-in: `tako_answer` (not recommended)." },
      ]),
    ).toThrow(/llms-full\.txt names `tako_answer`/);
  });

  it("names the file, and reports each phantom once", () => {
    let message = "";
    try {
      assertNoPhantomToolsInDocs(known, [
        { path: "llms.txt", text: "`tako_gone` and `tako_gone` again" },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("llms.txt names `tako_gone`");
    expect(message.match(/tako_gone/g)?.length).toBe(1);
  });

  it("ignores an unbackticked mention, which is prose rather than a claim", () => {
    expect(() =>
      assertNoPhantomToolsInDocs(known, [
        { path: "llms.txt", text: "tako_answer was removed in the fold." },
      ]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The prose-budget gate. It is the mechanism that holds the line across six
// fan-out PRs, so it needs tests that prove it FAILS — a gate nobody has seen
// reject anything is indistinguishable from a gate that always passes.
// ---------------------------------------------------------------------------

describe("assertProseBudget", () => {
  // A tool with no LEGACY_PROSE_CEILINGS row: the D1 caps apply outright.
  const migrated = (description: string) => [{ name: "tako_new", description }];
  const params = (descriptions: Record<string, string>) => [
    {
      name: "tako_new",
      parameters: Object.fromEntries(
        Object.entries(descriptions).map(([k, d]) => [k, { description: d }]),
      ),
    },
  ];
  const OK = "Does the thing.";

  it("passes a migrated tool inside every cap", () => {
    expect(() => assertProseBudget(migrated(OK), params({ query: "The query." }), "Short.")).not.toThrow();
  });

  it("fails a description over the char cap", () => {
    const long = "x".repeat(DESCRIPTION_MAX_CHARS + 1);
    expect(() => assertProseBudget(migrated(long), params({}), "Short.")).toThrow(
      /tako_new: description is \d+ chars/,
    );
  });

  it("fails a description over the line cap", () => {
    const tall = Array.from({ length: DESCRIPTION_MAX_LINES + 1 }, () => "a").join("\n");
    expect(() => assertProseBudget(migrated(tall), params({}), "Short.")).toThrow(
      /tako_new: description is \d+ lines/,
    );
  });

  it("fails a parameter description over the param cap, naming the parameter", () => {
    const long = "x".repeat(PARAM_MAX_CHARS + 1);
    expect(() => assertProseBudget(migrated(OK), params({ sources: long }), "Short.")).toThrow(
      /tako_new\.sources: parameter description is \d+ chars/,
    );
  });

  it("fails when description + every param description exceeds the entry cap", () => {
    // Each half is legal on its own; only the SUM is over, which is the case a
    // per-field cap cannot catch.
    const desc = "x".repeat(DESCRIPTION_MAX_CHARS);
    const each = "y".repeat(PARAM_MAX_CHARS);
    const many = Object.fromEntries(
      Array.from({ length: Math.ceil(TOOL_ENTRY_MAX_CHARS / PARAM_MAX_CHARS) }, (_, i) => [`p${i}`, each]),
    );
    expect(() => assertProseBudget(migrated(desc), params(many), "Short.")).toThrow(
      /tako_new: tool entry is \d+ chars/,
    );
  });

  it("fails instructions over their own cap", () => {
    const long = "x".repeat(INSTRUCTIONS_MAX_CHARS + 1);
    expect(() => assertProseBudget(migrated(OK), params({}), long)).toThrow(
      /instructions: \d+ chars/,
    );
  });

  // The ratchet. Both the row's NAME and its numbers are read from the map
  // rather than restated: re-baselining a row cannot make these lie, and the
  // fan-out PR that deletes a row does not have to come back and repoint these
  // tests. Naming one row here broke this file the first time a fan-out landed
  // — `tako_contents` was the hardcoded pick, and deleting its row (which is
  // exactly what a migration is supposed to do) failed three tests that have
  // nothing to do with that tool.
  const legacyNames = Object.keys(LEGACY_PROSE_CEILINGS).sort();
  // When the last row goes, every tool is migrated and the ratchet is dead
  // code — delete it and this block together rather than leaving assertions
  // that silently cover nothing.
  expect(legacyNames.length, "LEGACY_PROSE_CEILINGS is empty — delete the ratchet and these tests").toBeGreaterThan(0);
  const legacyName = legacyNames[0] as string;
  const ceiling = LEGACY_PROSE_CEILINGS[legacyName]!;

  it("passes a legacy tool sitting exactly at its ceiling", () => {
    const at = "x".repeat(ceiling.description);
    expect(() =>
      assertProseBudget([{ name: legacyName, description: at }], [{ name: legacyName, parameters: {} }], "Short."),
    ).not.toThrow();
  });

  it("fails a legacy tool one char over its ceiling", () => {
    const over = "x".repeat(ceiling.description + 1);
    expect(() =>
      assertProseBudget([{ name: legacyName, description: over }], [{ name: legacyName, parameters: {} }], "Short."),
    ).toThrow(/description grew to \d+ chars \(legacy ceiling/);
  });

  it("lets legacy prose SHRINK freely — the ratchet is one-directional", () => {
    expect(() =>
      assertProseBudget([{ name: legacyName, description: "Tiny." }], [{ name: legacyName, parameters: {} }], "Short."),
    ).not.toThrow();
  });

  it("exempts a legacy tool from the line cap the migrated caps impose", () => {
    // Legacy prose is multi-paragraph by construction. Deleting the row is what
    // turns the line cap on; until then a tall description must not fail.
    const tall = Array.from({ length: DESCRIPTION_MAX_LINES + 5 }, () => "a").join("\n");
    expect(tall.length).toBeLessThanOrEqual(ceiling.description);
    expect(() =>
      assertProseBudget([{ name: legacyName, description: tall }], [{ name: legacyName, parameters: {} }], "Short."),
    ).not.toThrow();
  });

  // assertProseBudget only ever READS a row through a live tool, so a row for a
  // deleted tool is unreachable and would sit here forever — and it is the row
  // a future author trusts when re-baselining. tako_credit_balance (#270) and
  // tako_answer (#273) were both deleted while this map's spec was being
  // written, so this is the repo's demonstrated failure mode, not a hypothetical.
  it("every LEGACY_PROSE_CEILINGS row names a tool that still exists", () => {
    const live = new Set(TOOL_REGISTRY.map((t) => (t as ToolModule).name));
    const stale = Object.keys(LEGACY_PROSE_CEILINGS).filter((n) => !live.has(n)).sort();
    expect(
      stale,
      "ratchet row(s) for deleted tool(s) — delete the row, it can never fire again",
    ).toEqual([]);
  });
});
