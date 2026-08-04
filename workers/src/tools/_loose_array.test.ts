import { describe, expect, it } from "vitest";
import { z } from "zod";

import { looseArray } from "./_loose_array.js";
import { TOOL_REGISTRY } from "./_registry.js";

const sources = looseArray(
  z.array(z.enum(["data", "web", "tako"])).min(1).default(["data", "web"]),
);

describe("looseArray", () => {
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
  });

  it("wraps a single bare value", () => {
    expect(sources.parse("data")).toEqual(["data"]);
    expect(sources.parse("  web  ")).toEqual(["web"]);
  });

  it("splits a comma-separated list", () => {
    expect(sources.parse("data,web")).toEqual(["data", "web"]);
    expect(sources.parse("data, web")).toEqual(["data", "web"]);
    expect(sources.parse("data,,web,")).toEqual(["data", "web"]);
  });

  it("still rejects values the wrapped schema rejects", () => {
    expect(() => sources.parse("bing")).toThrow();
    expect(() => sources.parse('["bing"]')).toThrow();
    expect(() => sources.parse("")).toThrow();
    expect(() => sources.parse([])).toThrow();
    expect(() => sources.parse(7)).toThrow();
  });

  // Coercion must not invent an array out of a shape that isn't one: a JSON
  // object string stays a string and fails validation, so the caller gets the
  // type error that describes what they actually sent.
  it("leaves a non-array JSON string alone", () => {
    expect(() => sources.parse('{"source":"data"}')).toThrow();
    expect(() => sources.parse("[not json")).toThrow();
  });

  it("wraps a single JSON object string for object-item arrays", () => {
    const items = looseArray(z.array(z.object({ id: z.string() })).min(1));
    expect(items.parse('{"id":"a"}')).toEqual([{ id: "a" }]);
    expect(items.parse('[{"id":"a"},{"id":"b"}]')).toEqual([{ id: "a" }, { id: "b" }]);
  });

  // The whole point of preprocessing (instead of a z.union) is that the
  // ADVERTISED schema is untouched: well-behaved clients must keep seeing a
  // plain array with its item enum, minItems, default and description, or
  // leniency here would teach every other client to send strings too.
  it("publishes the same JSON Schema as the unwrapped array", () => {
    const inner = z
      .array(z.enum(["data", "web", "tako"]))
      .min(1)
      .default(["data", "web"])
      .describe("Source(s) to ground in.");
    const strict = z.toJSONSchema(z.object({ sources: inner }), { io: "input" });
    const loose = z.toJSONSchema(z.object({ sources: looseArray(inner) }), {
      io: "input",
    });
    expect(loose).toEqual(strict);
  });
});

/**
 * Coverage guard. Wrapping is per-field and therefore forgettable: a new tool
 * (or a new field) that publishes `type: "array"` without `looseArray` brings
 * the -32602 back for exactly the hosts this exists for. This walks the real
 * registry, finds every array-typed input field from the PUBLISHED JSON Schema
 * (the same `z.toJSONSchema(…, { io: "input" })` the MCP SDK publishes — no
 * zod internals), and fails naming the field.
 */
describe("every array-typed tool input accepts a stringified array", () => {
  const arrayFields = (tool: (typeof TOOL_REGISTRY)[number]): string[] => {
    const published = z.toJSONSchema(z.object(tool.inputSchema.shape), {
      io: "input",
    }) as { properties?: Record<string, { type?: unknown }> };
    return Object.entries(published.properties ?? {})
      .filter(([, schema]) => schema.type === "array")
      .map(([name]) => name);
  };

  for (const tool of TOOL_REGISTRY) {
    for (const field of arrayFields(tool)) {
      it(`${tool.name}.${field}`, () => {
        const result = z
          .object(tool.inputSchema.shape)
          .safeParse({ [field]: '["x"]' });
        // Other fields' issues are irrelevant here (the input is deliberately
        // incomplete) — what must NOT appear is a type complaint about THIS
        // field, i.e. the string being rejected for being a string.
        const typeIssue = result.error?.issues.find(
          (issue) =>
            issue.code === "invalid_type" &&
            issue.path.length === 1 &&
            issue.path[0] === field,
        );
        expect(typeIssue, `${field} rejects a stringified array — wrap it in looseArray()`).toBeUndefined();
      });
    }
  }
});
