import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  looseArray,
  looseArrayField,
  unwrapLooseArray,
} from "./_loose_array.js";
import { TOOL_REGISTRY } from "./_registry.js";

/** Every coercion emits a `console.warn`; keep the suite output clean. */
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const enumArray = z
  .array(z.enum(["data", "web", "tako"]))
  .min(1)
  .default(["data", "web"]);

/** The `sources` configuration: closed enum, so comma-splitting is safe. */
const sources = looseArray(enumArray, {
  field: "test.sources",
  commaSeparated: true,
});

/** The `urls` / `node_ids` configuration: opaque strings, no opt-ins. */
const opaque = looseArray(z.array(z.string().min(1)).min(1), {
  field: "test.opaque",
});

describe("looseArray: always-on forms", () => {
  it("passes a real array straight through", () => {
    expect(sources.parse(["data"])).toEqual(["data"]);
    expect(sources.parse(["data", "web"])).toEqual(["data", "web"]);
  });

  it("keeps the wrapped schema's default for a missing value", () => {
    expect(sources.parse(undefined)).toEqual(["data", "web"]);
  });

  // The observed OpenBB Copilot failure: the client serialized the array it
  // meant to send into a JSON string.
  it("parses a JSON-encoded array string", () => {
    expect(sources.parse('["data","web"]')).toEqual(["data", "web"]);
    expect(sources.parse('[ "web" ]')).toEqual(["web"]);
    expect(opaque.parse('["a","b"]')).toEqual(["a", "b"]);
  });

  it("wraps a single bare value", () => {
    expect(sources.parse("data")).toEqual(["data"]);
    expect(sources.parse("  web  ")).toEqual(["web"]);
    expect(opaque.parse("just-one")).toEqual(["just-one"]);
  });

  it("still rejects values the wrapped schema rejects", () => {
    expect(() => sources.parse("bing")).toThrow();
    expect(() => sources.parse('["bing"]')).toThrow();
    expect(() => sources.parse("")).toThrow();
    expect(() => sources.parse([])).toThrow();
    expect(() => sources.parse(7)).toThrow();
  });

  it("leaves a string that is not a reshapeable array alone", () => {
    expect(() => sources.parse("[not json")).toThrow();
  });

  it("logs the field and the form that fired", () => {
    const warn = vi.spyOn(console, "warn");
    sources.parse('["data","web"]');
    expect(warn).toHaveBeenCalledWith(
      "[mcp] input coerced field=test.sources from=json-array items=2",
    );
    warn.mockClear();
    sources.parse("data,web");
    expect(warn).toHaveBeenCalledWith(
      "[mcp] input coerced field=test.sources from=comma-list items=2",
    );
    warn.mockClear();
    // A value that needs no reshaping must not log — the signal exists to
    // measure how often hosts send the broken shape.
    sources.parse(["data"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("looseArray: commaSeparated (closed-enum item domains only)", () => {
  it("splits when enabled", () => {
    expect(sources.parse("data,web")).toEqual(["data", "web"]);
    expect(sources.parse("data, web")).toEqual(["data", "web"]);
    expect(sources.parse("data,,web,")).toEqual(["data", "web"]);
  });

  /**
   * The regression this option exists to prevent. `tako_contents.urls` takes a
   * bare `z.string()` with no url format check, so an unconditional split
   * turned ONE wikipedia url into two strings that both validate, and the
   * handler fans out one independently BILLED subrequest per entry — the model
   * would have received a different city's page with no error anywhere.
   */
  it("keeps a comma-bearing url intact when disabled", () => {
    const url = "https://en.wikipedia.org/wiki/Washington,_D.C.";
    expect(opaque.parse(url)).toEqual([url]);
  });

  it("never splits JSON-shaped input, even when enabled", () => {
    // Splitting `{"data":{},"web":{}}` on commas would report two bogus
    // per-item errors instead of the one that names the real mistake.
    const result = z.object({ sources }).safeParse({
      sources: '{"data":{},"web":{}}',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe("invalid_type");
    expect(result.error?.issues[0]?.path).toEqual(["sources"]);
    expect(result.error?.issues[0]?.message).toContain("expected array");
  });
});

describe("looseArray: jsonObjectAsItem (object item domains only)", () => {
  const objects = looseArray(z.array(z.object({ id: z.string() })).min(1), {
    field: "test.objects",
    jsonObjectAsItem: true,
  });

  it("wraps a single JSON object when enabled", () => {
    expect(objects.parse('{"id":"a"}')).toEqual([{ id: "a" }]);
    expect(objects.parse('[{"id":"a"},{"id":"b"}]')).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });

  it("passes a JSON object through untouched when disabled", () => {
    // Not `[{...}]` — on a primitive item domain that can never validate, and
    // it replaces "expected array, received string" (which names the mistake)
    // with a per-item error about element 0 of an array the caller never sent.
    const result = z.object({ opaque }).safeParse({ opaque: '{"a":1}' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["opaque"]);
    expect(result.error?.issues[0]?.message).toContain("expected array");
  });
});

/**
 * Coverage guard over the REAL registry.
 *
 * Wrapping is per-field and therefore forgettable: a new tool (or field) that
 * publishes an array without `looseArray` brings the -32602 back for exactly
 * the hosts this exists for.
 *
 * SCOPE, stated so the assertions are not read as more than they are: this
 * walks TOP-LEVEL input properties only. Arrays nested inside an object item
 * are not wrapped and are not checked here — `tako_visualize` has five
 * (`components[].config.datasets`, `.columns`, `.rows`, `.items`, and
 * `datasets[].data`). That is deliberate: in the observed failure the whole
 * `components` array arrives as one JSON string, and parsing it yields
 * correctly typed nested values. A host that stringifies ONLY a nested field
 * is not a shape we have seen.
 */
describe("registry guard: top-level array inputs", () => {
  type Published = {
    type?: unknown;
    anyOf?: Array<{ type?: unknown }>;
    oneOf?: Array<{ type?: unknown }>;
  };

  /**
   * Array-typed top-level fields, from the PUBLISHED schema (the same
   * `z.toJSONSchema(…, { io: "input" })` the MCP SDK publishes — no zod
   * internals). `anyOf`/`oneOf` branches count: a `.nullable()` array
   * publishes `{anyOf:[{type:"array"},{type:"null"}]}` with NO top-level
   * `type`, so a `type === "array"` test alone would skip it in silence.
   */
  const arrayFields = (tool: (typeof TOOL_REGISTRY)[number]): string[] => {
    const published = z.toJSONSchema(z.object(tool.inputSchema.shape), {
      io: "input",
    }) as { properties?: Record<string, Published> };
    const isArray = (schema: Published): boolean =>
      schema.type === "array" ||
      (schema.anyOf ?? schema.oneOf ?? []).some((b) => b.type === "array");
    return Object.entries(published.properties ?? {})
      .filter(([, schema]) => isArray(schema))
      .map(([name]) => name);
  };

  const found = TOOL_REGISTRY.flatMap((tool) =>
    arrayFields(tool).map((field) => ({ tool, field })),
  );

  /**
   * Fail closed. Without this the block registers zero `it()`s if `arrayFields`
   * ever returns nothing (a moved `$ref`, a changed `type` spelling), and the
   * suite stays green with the coverage claim void.
   *
   * Bump this deliberately: a new array input means wrapping it in
   * `looseArray` and raising the count in the same commit.
   */
  it("finds all 7 known array-typed input fields", () => {
    expect(found.map((f) => `${f.tool.name}.${f.field}`).sort()).toEqual([
      "tako_agent.sources",
      "tako_answer.node_ids",
      "tako_answer.sources",
      "tako_contents.urls",
      "tako_search.node_ids",
      "tako_search.sources",
      "tako_visualize.components",
    ]);
  });

  for (const { tool, field } of found) {
    describe(`${tool.name}.${field}`, () => {
      const schema = (tool.inputSchema.shape as Record<string, unknown>)[field];

      it("is wrapped in looseArray", () => {
        expect(
          unwrapLooseArray(schema),
          `${field} is an array input but is not wrapped in looseArray()`,
        ).toBeDefined();
      });

      // A stale label would send the wrong field name to Workers Logs, which is
      // the only post-deploy signal this PR leaves behind.
      it("carries a label matching its property key", () => {
        const label = looseArrayField(schema);
        expect(label).toBeDefined();
        expect(label?.split(".").slice(-1)[0]).toBe(field);
        const declaringTool = label?.split(".")[0];
        expect(TOOL_REGISTRY.map((t) => t.name)).toContain(declaringTool);
      });

      /**
       * The published contract is untouched by the wrap. Asserted against the
       * SHIPPED field's own inner schema (not a schema rebuilt in the test), in
       * both `io` modes because `gen-registry.ts` uses the other one — this is
       * the canary for a zod bump changing how `$ZodPreprocess` derives
       * `optin`/`optout`, which is what would move `required` on the
       * `.optional()` fields (`node_ids`, `urls`).
       */
      for (const io of ["input", "output"] as const) {
        it(`publishes the same JSON Schema as the unwrapped array (io: ${io})`, () => {
          const inner = unwrapLooseArray(schema);
          expect(inner).toBeDefined();
          const wrapped = z.toJSONSchema(z.object({ [field]: schema as z.ZodType }), { io });
          const bare = z.toJSONSchema(z.object({ [field]: inner as z.ZodType }), { io });
          expect(wrapped).toEqual(bare);
        });
      }

      // Not "produces no type complaint": a per-item failure at
      // ["<field>", 0] would slip past that and leave a broken coercion green.
      it("accepts a JSON-encoded array of valid items", () => {
        const result = z
          .object(tool.inputSchema.shape)
          .safeParse({ ...REQUIRED_SIBLINGS[tool.name], [field]: VALID_JSON_TEXT[`${tool.name}.${field}`] });
        expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      });
    });
  }
});

/**
 * The other required inputs each tool needs before a `safeParse` can succeed,
 * so the guard's parse assertion measures the coerced field and nothing else.
 */
const REQUIRED_SIBLINGS: Record<string, Record<string, unknown>> = {
  tako_answer: { query: "q" },
  tako_search: { query: "q" },
  tako_agent: { query: "q" },
  tako_contents: {},
  tako_visualize: {},
};

/** A valid JSON-text payload per wrapped field. */
const VALID_COMPONENT = {
  component_type: "header",
  config: { title: "Monthly Revenue" },
};
const VALID_JSON_TEXT: Record<string, string> = {
  "tako_answer.sources": '["data","web"]',
  "tako_answer.node_ids": '["node-1"]',
  "tako_search.sources": '["data","web"]',
  "tako_search.node_ids": '["node-1"]',
  "tako_agent.sources": '["data","web"]',
  "tako_contents.urls": '["https://trytako.com/charts/c1"]',
  "tako_visualize.components": JSON.stringify([VALID_COMPONENT]),
};

/**
 * Per-option behaviour on the SHIPPED fields, not on schemas rebuilt here. The
 * generic guard above proves each field is wrapped; these prove each is wrapped
 * with the RIGHT options, which is where the billed-fanout bug lived.
 */
describe("shipped fields carry the right opt-ins", () => {
  const shape = (name: string) =>
    z.object(TOOL_REGISTRY.find((t) => t.name === name)!.inputSchema.shape);

  it("tako_contents.urls keeps a comma-bearing url as ONE url", () => {
    const url = "https://en.wikipedia.org/wiki/Washington,_D.C.";
    const result = shape("tako_contents").safeParse({ urls: url });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    // Two entries here means two independently BILLED subrequests for pages the
    // caller never asked for, and nothing downstream can detect it.
    expect((result.data as { urls: string[] }).urls).toEqual([url]);
  });

  it("tako_search.node_ids keeps a comma-bearing id as ONE id", () => {
    const result = shape("tako_search").safeParse({
      query: "q",
      node_ids: "weird,id",
    });
    expect(result.success).toBe(true);
    expect((result.data as { node_ids: string[] }).node_ids).toEqual([
      "weird,id",
    ]);
  });

  it("tako_answer.sources DOES split a comma list (closed enum)", () => {
    const result = shape("tako_answer").safeParse({
      query: "q",
      sources: "data,web",
    });
    expect(result.success).toBe(true);
    expect((result.data as { sources: string[] }).sources).toEqual([
      "data",
      "web",
    ]);
  });

  it("tako_answer.sources reports the plain type error for an object payload", () => {
    const result = shape("tako_answer").safeParse({
      query: "q",
      sources: '{"data":{},"web":{}}',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(["sources"]);
    expect(result.error?.issues[0]?.message).toContain("expected array");
  });
});

/**
 * `components` is the only wrapped field whose coercion has to reshape into a
 * 20-member discriminated union, and the only user of `jsonObjectAsItem`, so
 * both of its real forms get an explicit end-to-end parse rather than riding on
 * the generic guard.
 */
describe("tako_visualize.components coercion produces a usable value", () => {
  const visualize = TOOL_REGISTRY.find((t) => t.name === "tako_visualize");
  const parse = (components: unknown) =>
    z.object(visualize!.inputSchema.shape).safeParse({ components });

  it("accepts the components array as JSON text", () => {
    const result = parse(JSON.stringify([VALID_COMPONENT]));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect((result.data as { components: unknown[] }).components).toHaveLength(1);
  });

  it("accepts a single component object as JSON text", () => {
    const result = parse(JSON.stringify(VALID_COMPONENT));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect((result.data as { components: unknown[] }).components).toHaveLength(1);
  });

  it("still rejects a coerced array whose items are not components", () => {
    const result = parse('["x"]');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe("components");
  });
});
