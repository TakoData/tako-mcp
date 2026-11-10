import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapLooseArray } from "./_loose_array.js";
import { optionalWithoutDefaults } from "./_optional_without_defaults.js";

const Inner = z.object({ flag: z.boolean().default(false), name: z.string().optional() });
const generated = {
  count: z.number().int().describe("How many.").default(5),
  strict: z.boolean().default(false),
  label: z.union([z.string(), z.null()]).describe("A label.").optional(),
  tags: z.union([z.array(z.string()), z.null()]).describe("Tags.").optional(),
  settings: z.union([z.lazy(() => Inner), z.null()]).optional(),
};

const descriptionOf = (shape: z.ZodRawShape, key: string): string | undefined =>
  (z.toJSONSchema(z.object(shape), { io: "input" }) as { properties: Record<string, { description?: string }> })
    .properties[key]?.description;

describe("optionalWithoutDefaults", () => {
  it("drops every default, so an omitted field stays omitted", () => {
    expect(z.object(generated).parse({})).toEqual({ count: 5, strict: false });
    expect(z.object(optionalWithoutDefaults(generated)).parse({})).toEqual({});
  });

  it("keeps a value the caller sends, and the field's own validation", () => {
    const schema = z.object(optionalWithoutDefaults(generated));
    expect(schema.parse({ count: 3, label: null })).toEqual({ count: 3, label: null });
    expect(schema.safeParse({ count: 1.5 }).success).toBe(false);
  });

  it("publishes no default and keeps the generated description", () => {
    const published = z.toJSONSchema(z.object(optionalWithoutDefaults(generated)), { io: "input" }) as {
      properties: Record<string, { default?: unknown; description?: string }>;
      required?: string[];
    };
    expect(published.properties.count).not.toHaveProperty("default");
    expect(published.properties.count?.description).toBe("How many.");
    expect(published.required ?? []).toEqual([]);
  });

  it("replaces a description only where one is given", () => {
    const shape = optionalWithoutDefaults(generated, { label: "A better label.", strict: "Now described." });
    expect(descriptionOf(shape, "label")).toBe("A better label.");
    expect(descriptionOf(shape, "strict")).toBe("Now described.");
    expect(descriptionOf(shape, "tags")).toBe("Tags.");
  });

  it("wraps only the named array inputs, labelled with the tool and the field", () => {
    const warn: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => void warn.push(line);
    try {
      const shape = optionalWithoutDefaults(generated, {}, { tool: "tako_example", fields: { tags: {} } });
      expect(unwrapLooseArray(shape.tags)).toBeDefined();
      expect(unwrapLooseArray(shape.label)).toBeUndefined();
      expect(z.object(shape).parse({ tags: '["a","b"]' })).toEqual({ tags: ["a", "b"] });
      expect(warn.join("\n")).toContain("field=tako_example.tags");
      expect(z.toJSONSchema(z.object(shape), { io: "input" })).toEqual(
        z.toJSONSchema(z.object(optionalWithoutDefaults(generated)), { io: "input" }),
      );
    } finally {
      console.warn = original;
    }
  });

  it("wraps nothing when no array inputs are named", () => {
    const shape = optionalWithoutDefaults(generated);
    expect(unwrapLooseArray(shape.tags)).toBeUndefined();
    expect(z.object(shape).safeParse({ tags: '["a"]' }).success).toBe(false);
  });

  it("reaches ONE level: an object-valued field keeps its own defaults", () => {
    // The limit the module documents. A tool whose generated shape has such a
    // field rebuilds it by hand, as `tako_search_advanced` does for
    // `output_settings`; `noDefaultsLeak` in its test file guards that tool.
    const schema = z.object(optionalWithoutDefaults(generated));
    expect(schema.parse({ settings: { name: "x" } })).toEqual({ settings: { name: "x", flag: false } });
  });
});
