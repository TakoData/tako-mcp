/**
 * Does what we SHIP in `structuredContent` conform to what we PUBLISH in
 * `outputSchema`?
 *
 * Every other test in this repo validates against the zod schemas as authored.
 * That is exactly the blind spot that shipped the `sources_glossary` bug for
 * three server versions: we declare the advertised shapes with `z.looseObject`,
 * so a `safeParse` accepts undeclared keys and every unit test passes — but
 * `registerTool` takes a `ZodRawShape` and the SDK rebuilds it as a STRICT
 * object, so what reaches a client says `additionalProperties: false`. Loose in
 * process, strict on the wire. `tako_answer` (since deleted) and `tako_search` emitted
 * `sources_glossary`, which no advertised schema declares, and the official
 * Python SDK raised
 *
 *   RuntimeError: Invalid structured content returned by tool tako_answer:
 *   Additional properties are not allowed ('sources_glossary' was unexpected)
 *
 * discarding the ENTIRE result — text block included — on a call already
 * billed. ~1 in 5 calls, concentrated on the tool the instructions route to
 * first.
 *
 * So this file deliberately does NOT use the authored zod schemas. It reads the
 * JSON Schema the server actually publishes over a real `tools/list`, and
 * validates with `CfWorkerJsonSchemaValidator` — the same validator the SDK
 * client uses. Anything less permissive than a real client cannot see this bug
 * class, which is the whole reason it survived manual testing.
 */
import { SELF } from "cloudflare:test";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { structuredContentFor } from "./mcp.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import { outputSchemaForSurface, publishedOutputJsonSchema } from "./tools/_surface.js";
import type { AnyToolModule } from "./tools/types.js";

const AUTH_HEADER = "Bearer conformance-test-token";

// Every tool, so the sweep covers the whole surface rather than the default
// subset. `?tools=` is an allowlist (spec D1), so name them all — DERIVED
// from the registry, because a hand-written list drops a new tool out of the
// sweep silently: nothing fails, the coverage just disappears.
const ALL_TOOLS_QUERY = `?tools=${TOOL_REGISTRY.map((t) => t.name)
  .sort()
  .join(",")}`;

interface PublishedSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
}

let published: Map<string, PublishedSchema>;

beforeAll(async () => {
  const res = await SELF.fetch(`https://example.com/mcp${ALL_TOOLS_QUERY}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: AUTH_HEADER,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string; outputSchema?: PublishedSchema }> };
  };
  published = new Map(
    body.result.tools
      .filter((t) => t.outputSchema !== undefined)
      .map((t) => [t.name, t.outputSchema as PublishedSchema]),
  );
  expect(published.size).toBeGreaterThan(0);
});

const moduleFor = (name: string): AnyToolModule => {
  const entry = TOOL_REGISTRY.find((t) => t.name === name);
  if (entry === undefined) throw new Error(`no registry entry for ${name}`);
  return entry as unknown as AnyToolModule;
};

const validate = async (schema: PublishedSchema, value: unknown): Promise<string | null> => {
  // The validator's parameter type is the SDK's own JsonSchemaType; this is the
  // raw JSON the server published, so the cast is the boundary between "what
  // came off the wire" and "what the SDK types expect" — exactly the crossing
  // this file exists to test.
  const validator = new CfWorkerJsonSchemaValidator().getValidator(
    schema as Parameters<CfWorkerJsonSchemaValidator["getValidator"]>[0],
  );
  const result = await validator(value);
  return result.valid ? null : (result.errorMessage ?? "invalid");
};

/**
 * A minimal value satisfying one published property schema.
 *
 * The sweep below needs its synthetic output to actually CONFORM, or every tool
 * fails the required-key parse and diverts to the degradation path — which
 * narrows too, so the sweep would pass without ever exercising the success path
 * it exists to guard. (First draft of this file used `null` for every key and
 * did exactly that: it stayed green with the narrowing removed.) Reads the
 * PUBLISHED JSON Schema rather than the zod source, for the same reason the rest
 * of the file does.
 */
function dummyFor(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as {
    type?: string | string[];
    anyOf?: unknown[];
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    pattern?: string;
  };
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  // Nullable fields arrive as anyOf:[T, null] — null is the cheapest satisfying
  // value, so prefer it, else take the first branch.
  if (Array.isArray(s.anyOf)) {
    const nullable = s.anyOf.some(
      (b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "null",
    );
    return nullable ? null : dummyFor(s.anyOf[0]);
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "string":
      // Honour a pattern where one is declared (embed_url/image_url are http-only).
      return s.pattern !== undefined && s.pattern.includes("http") ? "https://example.com" : "x";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "null":
      return null;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) out[key] = dummyFor(s.properties?.[key]);
      return out;
    }
    default:
      return null;
  }
}

/**
 * Every property name in a JSON Schema that matches `banned`, at ANY depth,
 * reported as a dotted path.
 *
 * GENERIC on purpose, rather than a list of keywords to descend. That list was
 * wrong twice. First it was top-level only, which could not see a `request_id`
 * inside a nested object. Then it was `properties` + `items`, which still could
 * not see into `anyOf` — and `anyOf` is precisely how a nullable object reaches
 * the published schema: `usageAdvertisedSchema.nullable()` publishes as
 * `anyOf: [{properties: {…}}, {type: "null"}]`, a wrapper with no `properties`
 * and no `items` of its own. Seven such branches were live on the published
 * surface, including `usage` on both headline tools. Each time, the walk was
 * shallower than the rule it states and passed for a property of today's
 * schemas rather than of the check.
 *
 * So: walk the whole tree and treat every `properties` map found anywhere as
 * property names, whatever keyword nests it. That covers `anyOf` / `oneOf` /
 * `allOf`, `not`, `if` / `then` / `else`, `additionalProperties`,
 * `$defs`, `dependentSchemas` and anything a future serializer emits, without
 * this function needing to know their names.
 *
 * Two positions are handled specially because their keys are NOT property
 * names: `enum` / `const` hold data (an object in there may legitimately carry
 * a `properties` key), and `patternProperties` keys are regexes.
 */
function bannedKeysIn(schema: unknown, path: string, banned: RegExp): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((branch) => bannedKeysIn(branch, path, banned));
  }
  if (schema === null || typeof schema !== "object") return [];
  const found: string[] = [];
  for (const [keyword, value] of Object.entries(schema as Record<string, unknown>)) {
    // Instance data, not subschemas — never read as property names.
    if (keyword === "enum" || keyword === "const") continue;
    if (keyword === "properties") {
      for (const [name, child] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        const childPath = `${path}.${name}`;
        if (banned.test(name)) found.push(childPath);
        found.push(...bannedKeysIn(child, childPath, banned));
      }
      continue;
    }
    if (keyword === "patternProperties") {
      // Keys are regexes; descend into the subschemas without testing them.
      for (const child of Object.values((value ?? {}) as Record<string, unknown>)) {
        found.push(...bannedKeysIn(child, `${path}.*`, banned));
      }
      continue;
    }
    if (keyword === "items" || keyword === "prefixItems" || keyword === "contains") {
      found.push(...bannedKeysIn(value, `${path}[]`, banned));
      continue;
    }
    // Every other keyword: descend with the path unchanged, so a union branch
    // or a `$defs` entry does not invent a path segment.
    found.push(...bannedKeysIn(value, path, banned));
  }
  return found;
}

describe("published outputSchema conformance", () => {
  // The precondition that makes every other assertion here matter. If the SDK
  // ever stops republishing our loose shapes as strict, this flips and the
  // sweep below becomes theatre — better to be told than to keep asserting
  // against a constraint that no longer exists.
  it("the SDK publishes additionalProperties:false for our loose shapes", () => {
    const permissive = [...published.entries()].filter(
      ([, schema]) => schema.additionalProperties !== false,
    );
    expect(permissive.map(([name]) => name)).toEqual([]);
  });

  // The invariant, swept over every tool: whatever `structuredContentFor`
  // returns carries ONLY keys the published schema declares. Synthetic output
  // rather than per-tool fixtures on purpose — the property is about key sets,
  // so it holds for any input, and a fixture per tool would rot.
  it("never returns a key the published schema does not declare", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const offenders: string[] = [];
    const diverted: string[] = [];
    for (const [name, schema] of published) {
      const declared = new Set(Object.keys(schema.properties ?? {}));
      // Undeclared keys shaped like the ones that actually leaked, on top of a
      // conforming base so the SUCCESS path is what gets exercised.
      const output: Record<string, unknown> = {
        sources_glossary: { "S&P Global": "A source paragraph." },
        __never_declared__: true,
      };
      for (const key of declared) {
        output[key] = dummyFor(schema.properties?.[key]);
      }
      const before = errorSpy.mock.calls.length;
      const structured = structuredContentFor(moduleFor(name), output);
      // A log here means the synthetic output could not conform and the tool
      // took the degradation path — which narrows too, so the assertion would
      // pass without covering the success path. Surface it rather than let the
      // sweep quietly go hollow.
      if (errorSpy.mock.calls.length > before) diverted.push(name);
      for (const key of Object.keys(structured)) {
        if (!declared.has(key)) offenders.push(`${name}.${key}`);
      }
    }
    errorSpy.mockRestore();
    expect(offenders).toEqual([]);
    expect(diverted, "synthetic output failed to conform — sweep did not cover the success path").toEqual([]);
  });

  // Read off the REAL `tools/list`, so this covers every tool on the surface —
  // including one added later whose author never saw this rule.
  it("publishes no server-side debug identifier", () => {
    // OpenAI's app review calls out request ids, trace ids, session ids and
    // debug identifiers as things a tool response should not carry unless
    // strictly necessary. `tako_search` and `tako_answer` used to advertise
    // `request_id` (and echo it in their markdown footer); it is now
    // server-log-only — `logToolRequestId` in `tools/_log.ts`.
    //
    // Deliberately NOT banned: `run_id` and `thread_id` on the agent tools.
    // Those are strictly necessary — `run_id` is the only way to poll a run to
    // completion and `thread_id` the only way to continue a conversation, so a
    // caller cannot use the tool without them. The test is about identifiers
    // that exist for OUR debugging, not the caller's control flow.
    const banned = /^(request|trace|correlation|session|debug)_id$/;
    const offenders: string[] = [];
    for (const [name, schema] of published) {
      offenders.push(...bannedKeysIn(schema, name, banned));
    }
    expect(offenders).toEqual([]);
  });

  // A tool advertising an outputSchema MUST return structuredContent; the
  // official TS SDK throws on its absence exactly as it throws on a mismatch.
  it("never returns undefined for a tool that advertises an outputSchema", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [name] of published) {
      expect(structuredContentFor(moduleFor(name), { request_id: "r" }), name).not.toBeUndefined();
    }
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The regression itself, on realistic payloads.
// ---------------------------------------------------------------------------

const card = () => ({
  card_id: "c1",
  title: "NVIDIA Corporation Revenue",
  description: "$60.9B",
  exportable: true,
  nodes: [
    { id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" },
    { id: "mt::revenue::1", name: "Revenue", type: "metric" },
  ],
  sources: [{ source_name: "S&P Global", source_description: "A long source paragraph." }],
  content: {
    content_format: "dataset",
    dataset: { columns: [{ name: "date", type: "date" }], rows: [["2026-06-30"]] },
  },
});

// The nested cost breakdown is emitted while only `total_cost_usd` is
// advertised. That survives solely because `usageAdvertisedSchema` is `.loose()`
// (nested loose objects publish permissive additionalProperties, unlike the top
// level the SDK rebuilds strict), and `pickDeclared` is shallow — so it is worth
// a real assertion rather than an assumption.
const usage = () => ({
  total_cost_usd: 0.009,
  compute: { cost_usd: 0.008 },
  data: { cost_usd: 0.001, datasets: 1 },
});

describe("realistic payloads validate against the published schema", () => {
  const cases: Array<[string, () => Record<string, unknown>]> = [
    [
      // The answer payload now arrives on tako_search_advanced, via
      // include_answer. It carries the three answer-only fields, so this case
      // also checks they survive the published schema rather than being
      // stripped as unknown keys.
      "tako_search_advanced",
      () => ({
        answer: "Revenue was $60.9B [1].",
        cards: [card()],
        web_results: [],
        usage: usage(),
        request_id: "req-answer",
        structured_output: { revenue_usd_b: 60.9 },
        // The other two fields the fold added to the output shape. Checked here
        // because a field the published schema does not carry is STRIPPED, not
        // rejected — the same silent-drop failure the per-endpoint wire guard
        // exists to prevent, one layer out.
        structured_output_error: { code: "unfillable", message: "No evidence for revenue_usd_b." },
        related: [{ query: "Nvidia data center revenue", score: 0.9 }],
        // THE regression: attached whenever the cited cards carry source
        // paragraphs, which is why it fired on data-grounded answers only.
        sources_glossary: { "S&P Global": "A long source paragraph." },
      }),
    ],
    [
      "tako_search",
      () => ({
        cards: [card()],
        web_results: [],
        usage: { total_cost_usd: 0.007, compute: { cost_usd: 0.007 } },
        request_id: "req-search",
        pub_id: "p1",
        embed_url: "https://trytako.com/embed/p1",
        sources_glossary: { "S&P Global": "A long source paragraph." },
      }),
    ],
    [
      // The created card plus the widget fields the handler derives. The four
      // widget-only ones are declared on `/mcp/chatgpt` alone, so this case
      // also proves the generic narrowing DROPS them rather than shipping keys
      // the published schema does not carry.
      "tako_visualize",
      () => ({
        title: "Regional Sales",
        url: "https://trytako.com/card/p1/",
        embed_url: "https://trytako.com/embed/p1/?dark_mode=auto&showShare=true",
        image_url: "https://trytako.com/api/v1/image/p1/?dark_mode=true",
        pub_id: "p1",
        dark_mode: true,
        width: 900,
        height: 720,
      }),
    ],
    [
      "tako_available_data",
      // The PROJECTED shape (`projectMatch` / `projectCandidate`), which is
      // what the handler returns and what the schema advertises — there is no
      // second internal shape to keep in sync any more.
      () => ({
        found: true,
        verified: "coverage",
        guidance: "A verdict sentence. An action sentence.",
        matches: [
          {
            id: "ent::nvidia::1",
            name: "NVIDIA Corporation",
            type: "entity",
            // `subtype` and `label` are ONE field; `coverage.kind` is gone
            // because `type` derives it.
            kind: "Companies",
            aliases: ["NVDA"],
            coverage: {
              items: [{ name: "Revenue", id: "mt::revenue::1" }],
              total: 1,
              total_capped: false,
            },
          },
        ],
        candidates: [],
        // No node_ids / strict: no search tool takes a pin from this handle,
        // and the published schema is strict about additional properties, so a
        // stale pin here fails conformance rather than shipping silently.
        next_call: {
          tool: "tako_search",
          query: "NVIDIA Corporation Revenue",
        },
      }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`${name}: conforms, and drops sources_glossary`, async () => {
      const schema = published.get(name);
      expect(schema, `${name} publishes no outputSchema`).toBeDefined();
      const structured = structuredContentFor(moduleFor(name), build());
      expect(structured).not.toBeUndefined();
      expect(
        await validate(schema as PublishedSchema, structured),
        `${name} structuredContent does not conform to its own published schema`,
      ).toBeNull();
    });
  }

  // Belt and braces on the specific key, so a future refactor that reintroduces
  // it fails with an obvious message rather than a JSON Schema error string.
  it("sources_glossary never reaches structuredContent", () => {
    for (const [name, build] of cases) {
      expect(structuredContentFor(moduleFor(name), build()), name).not.toHaveProperty(
        "sources_glossary",
      );
    }
  });

  // The mirror of the test below, and the one that has teeth: the four
  // fold-added fields must be declared ONLY on the tool that can produce them.
  // `tako_search` hardcodes `endpoint: "search"` and takes no
  // `include_related`, so it can never return any of them — but it published
  // all four from #273 until review round two, because both tools imported one
  // shared shape. That cost 885 chars (20%) of its output schema and told the
  // model `tako_search` returns a synthesized `answer`. Conformance cannot see
  // this: every one of the four is optional, so a response that never carries
  // them validates against a schema that declares them.
  it("declares the four answer-endpoint fields on the advanced tool only", () => {
    const fold = ["answer", "structured_output", "structured_output_error", "related"];
    const advanced = publishedOutputJsonSchema(
      outputSchemaForSurface(moduleFor("tako_search_advanced"), "generic") as NonNullable<
        ReturnType<typeof outputSchemaForSurface>
      >,
    ) as { properties: Record<string, unknown> };
    for (const key of fold) expect(advanced.properties, key).toHaveProperty(key);
    // Both surfaces: the chatgpt variant is built by a separate spread, so it
    // can regain a field the generic one dropped.
    for (const surface of ["generic", "chatgpt"] as const) {
      const simple = publishedOutputJsonSchema(
        outputSchemaForSurface(moduleFor("tako_search"), surface) as NonNullable<
          ReturnType<typeof outputSchemaForSurface>
        >,
      ) as { properties: Record<string, unknown> };
      for (const key of fold) {
        expect(simple.properties, `tako_search/${surface} declares ${key}`).not.toHaveProperty(key);
      }
      // Not vacuous: the core fields it CAN produce are still there.
      expect(simple.properties, `tako_search/${surface}`).toHaveProperty("cards");
      expect(simple.properties, `tako_search/${surface}`).toHaveProperty("guidance");
    }
  });

  // tako_visualize's half of the same rule, and the departure from
  // tako_search that needs stating: there the six widget fields were the TOP
  // CARD's plumbing and every card carried its own `url`, so dropping all six
  // from `/mcp` cost the model nothing. Here the created card IS the result —
  // drop `embed_url` and `image_url` and a structured-only host (Claude Code,
  // Codex, VS Code) gets a title and no way to show or link what it published.
  // Only the four with no reader outside the widget leave.
  it("declares tako_visualize's widget-only fields on the chatgpt surface alone", () => {
    const widgetOnly = ["pub_id", "dark_mode", "width", "height"];
    const modelFacing = ["title", "url", "embed_url", "image_url"];
    const propsFor = (surface: "generic" | "chatgpt"): Record<string, unknown> =>
      (
        publishedOutputJsonSchema(
          outputSchemaForSurface(moduleFor("tako_visualize"), surface) as NonNullable<
            ReturnType<typeof outputSchemaForSurface>
          >,
        ) as { properties: Record<string, unknown> }
      ).properties;

    const generic = propsFor("generic");
    for (const key of widgetOnly) expect(generic, `generic declares ${key}`).not.toHaveProperty(key);
    for (const key of modelFacing) expect(generic, `generic drops ${key}`).toHaveProperty(key);

    const chatgpt = propsFor("chatgpt");
    for (const key of [...widgetOnly, ...modelFacing]) {
      expect(chatgpt, `chatgpt drops ${key}`).toHaveProperty(key);
    }
    // `description` is the caller's own input echoed back, dropped EVERYWHERE —
    // asserted on both surfaces, because the chatgpt shape is a separate
    // spread and can regain a field the generic one dropped (the same reason
    // the tako_search test above loops over both).
    for (const [surface, props] of [
      ["generic", generic],
      ["chatgpt", chatgpt],
    ] as const) {
      expect(props, `${surface} declares description`).not.toHaveProperty("description");
    }
  });

  // Conformance alone cannot see a STRIP: all four fold-added fields are
  // optional, so a payload that lost them still validates. Assert presence
  // separately, the same belt-and-braces shape as `sources_glossary` above.
  it("carries all four fold-added fields through to structuredContent", () => {
    const structured = structuredContentFor(moduleFor("tako_search_advanced"), {
      answer: "Revenue was $60.9B [1].",
      cards: [],
      web_results: [],
      usage: usage(),
      request_id: "r",
      structured_output: { revenue_usd_b: 60.9 },
      structured_output_error: { code: "unfillable", message: "No evidence." },
      related: [{ query: "Nvidia data center revenue", score: 0.9 }],
    });
    for (const key of ["answer", "structured_output", "structured_output_error", "related"]) {
      expect(structured, key).toHaveProperty(key);
    }
  });

  // The emitted breakdown must survive despite only `total_cost_usd` being
  // advertised — that is the point of keeping the nested schema loose.
  it("keeps the emitted usage breakdown that the advertised shape does not name", () => {
    const structured = structuredContentFor(moduleFor("tako_search_advanced"), {
      answer: "x",
      cards: [],
      web_results: [],
      usage: usage(),
      request_id: "r",
    });
    expect(structured.usage).toEqual(usage());
  });
});

describe("the debug-identifier sweep can actually see nested keys", () => {
  // Guards the sweep itself, not the schemas. The published schemas nest no
  // banned key today, so the recursive walk and the old top-level one are
  // indistinguishable against real input — this asserts the mechanism on a
  // shape the top-level walk provably missed.
  const banned = /^(request|trace|correlation|session|debug)_id$/;

  it("finds a request_id buried in a nested object", () => {
    const schema = {
      properties: {
        result: { properties: { request_id: { type: "string" } } },
      },
    };
    expect(bannedKeysIn(schema, "t", banned)).toEqual(["t.result.request_id"]);
  });

  it("finds one inside array items", () => {
    const schema = {
      properties: {
        cards: { type: "array", items: { properties: { trace_id: { type: "string" } } } },
      },
    };
    expect(bannedKeysIn(schema, "t", banned)).toEqual(["t.cards[].trace_id"]);
  });

  it("leaves legitimate control-flow identifiers alone at depth", () => {
    // `run_id` / `thread_id` are the caller's control flow, deliberately not
    // banned — the recursion must not start flagging them.
    const schema = {
      properties: {
        result: { properties: { run_id: {}, thread_id: {} } },
      },
    };
    expect(bannedKeysIn(schema, "t", banned)).toEqual([]);
  });
});

describe("the sweep sees into union branches, not just objects and arrays", () => {
  // The gap these exist for: `properties` + `items` descent could not enter an
  // `anyOf`, and `anyOf` is how every nullable object reaches the published
  // schema. Seven such branches were live when this was found. The earlier
  // mechanism tests all build plain {properties}/{items} shapes, so none of
  // them would have caught it — these deliberately wrap the nested object.
  const banned = /^(request|trace|correlation|session|debug)_id$/;

  it("finds a key inside a nullable object, the real published shape", () => {
    // Verbatim shape of `tako_search.usage` off a live tools/list, with the
    // banned key substituted for total_cost_usd.
    const schema = {
      properties: {
        usage: {
          anyOf: [
            {
              type: "object",
              properties: { request_id: { type: "string" } },
              required: ["request_id"],
              additionalProperties: {},
            },
            { type: "null" },
          ],
          description: "Cost-plus usage for this request (null when not metered).",
        },
      },
    };
    expect(bannedKeysIn(schema, "t", banned)).toEqual(["t.usage.request_id"]);
  });

  it("finds keys under oneOf and allOf too", () => {
    const oneOf = { properties: { a: { oneOf: [{ properties: { trace_id: {} } }] } } };
    const allOf = { properties: { b: { allOf: [{ properties: { session_id: {} } }] } } };
    expect(bannedKeysIn(oneOf, "t", banned)).toEqual(["t.a.trace_id"]);
    expect(bannedKeysIn(allOf, "t", banned)).toEqual(["t.b.session_id"]);
  });

  it("descends keywords it was never taught, via $defs", () => {
    // The point of the generic walk: coverage should not depend on this
    // function having heard of the keyword.
    const schema = { $defs: { Thing: { properties: { debug_id: {} } } } };
    expect(bannedKeysIn(schema, "t", banned)).toEqual(["t.debug_id"]);
  });

  it("does not mistake enum DATA for a schema", () => {
    // An enum value may legitimately be an object carrying a `properties` key.
    // Reading it as a subschema would invent an offender that does not exist.
    const schema = {
      properties: {
        mode: { enum: [{ properties: { request_id: "not a schema" } }] },
      },
    };
    expect(bannedKeysIn(schema, "t", banned)).toEqual([]);
  });
});

/**
 * `docs/TOOLS.md` renders each tool's output schema under a heading that
 * promises the bytes a client receives. It got that wrong in the one field
 * that already shipped a bug: the page rendered the `z.looseObject` directly,
 * giving `"additionalProperties": {}`, while `mcp.ts` hands the SDK `.shape`
 * and the SDK republishes it strict — `false`, which is why `_pick_declared.ts`
 * exists at all.
 *
 * `publishedOutputJsonSchema` is now the doc's single source, so this asserts
 * it against a REAL server on BOTH surfaces. Without this the helper is just a
 * second guess at what the SDK does, and the chatgpt surface — the one whose
 * widget reads `structuredContent`, and where a mistake costs a resubmission —
 * had no published-schema coverage of any kind.
 */
describe("docs/TOOLS.md renders the schema the wire actually carries", () => {
  const surfaces = [
    // `?tools=` is ignored on chatgpt (fixed listing), so only /mcp takes it.
    { surface: "generic" as const, path: `/mcp${ALL_TOOLS_QUERY}` },
    { surface: "chatgpt" as const, path: "/mcp/chatgpt" },
  ];

  for (const { surface, path } of surfaces) {
    it(`${surface}: every published output schema equals publishedOutputJsonSchema`, async () => {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: AUTH_HEADER,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { tools: Array<{ name: string; outputSchema?: unknown }> };
      };
      const withSchema = body.result.tools.filter((t) => t.outputSchema !== undefined);
      // Non-vacuity: a listing that published no output schema at all would
      // otherwise satisfy the loop below.
      expect(withSchema.length, `${surface} published no output schemas`).toBeGreaterThan(0);

      for (const tool of withSchema) {
        const declared = outputSchemaForSurface(moduleFor(tool.name), surface);
        expect(declared, `${tool.name} publishes a schema it does not declare`).toBeDefined();
        expect(
          tool.outputSchema,
          `${tool.name} on ${surface}: docs/TOOLS.md would render a schema the wire does not carry`,
        ).toEqual(publishedOutputJsonSchema(declared as NonNullable<typeof declared>));
      }
    });
  }
});
