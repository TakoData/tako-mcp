import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyInputPins,
  describePins,
  descriptionForConnection,
  effectivePins,
  inputSchemaForConnection,
  NO_PINS,
  pinnedField,
  readInputPins,
  SOURCE_VALUES,
} from "./_input_pins.js";
import type { AnyToolModule } from "./types.js";

describe("readInputPins", () => {
  const read = (query: string) => readInputPins(new URL(`https://mcp.tako.com/mcp${query}`));

  it("returns no pins when the parameter is absent", () => {
    expect(read("")).toEqual({ ok: true, pins: {} });
    expect(read("?tools=search&takoApiToken=x")).toEqual({ ok: true, pins: {} });
  });

  it("parses each accepted value in canonical order", () => {
    expect(read("?sources=data")).toEqual({ ok: true, pins: { sources: ["data"] } });
    expect(read("?sources=web")).toEqual({ ok: true, pins: { sources: ["web"] } });
    expect(read("?sources=web,data")).toEqual({ ok: true, pins: { sources: ["data", "web"] } });
  });

  it("trims, lowercases, joins repeats, and dedupes", () => {
    expect(read("?sources=%20Data%20,%20WEB")).toEqual({ ok: true, pins: { sources: ["data", "web"] } });
    expect(read("?sources=data&sources=web")).toEqual({ ok: true, pins: { sources: ["data", "web"] } });
    expect(read("?sources=data,data")).toEqual({ ok: true, pins: { sources: ["data"] } });
  });

  it("rejects an unknown value and names the parameter", () => {
    const result = read("?sources=dta");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parameter).toBe("sources");
      expect(result.message).toBe(
        'The "sources" URL parameter has an invalid value: "dta". Use data, web, or data,web.',
      );
    }
  });

  it("caps the echoed value at 200 characters", () => {
    const result = read(`?sources=${"x".repeat(500)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(`"${"x".repeat(200)}"`);
    if (!result.ok) expect(result.message).not.toContain("x".repeat(201));
  });

  it("rejects an empty value", () => {
    const empty = 'The "sources" URL parameter is empty. Use data, web, or data,web.';
    expect(read("?sources=")).toEqual({ ok: false, parameter: "sources", message: empty });
    expect(read("?sources=,")).toEqual({ ok: false, parameter: "sources", message: empty });
  });
});

describe("describePins", () => {
  it("names each pin, or none", () => {
    expect(describePins({ sources: ["data"] })).toBe("sources=data");
    expect(describePins({ sources: ["data", "web"] })).toBe("sources=data,web");
    expect(describePins(NO_PINS)).toBe("(none)");
  });
});

describe("connection resolvers", () => {
  const schema = z.object({
    query: z.string(),
    sources: z.array(z.enum(SOURCE_VALUES)).optional(),
  });
  const pinnable = {
    description: "unpinned",
    inputSchema: schema,
    inputPins: { sources: pinnedField("sources", (v) => `pinned ${v.join(",")}`) },
  };
  const unpinnable: Pick<AnyToolModule, "description" | "inputSchema" | "inputPins"> = {
    description: "plain",
    inputSchema: schema,
  };

  it("drops a pinned field from the schema and keeps the unpinned schema object", () => {
    expect(inputSchemaForConnection(pinnable, "generic", { sources: ["data"] }).shape).not.toHaveProperty(
      "sources",
    );
    expect(inputSchemaForConnection(pinnable, "generic", NO_PINS)).toBe(schema);
  });

  it("replaces a model-supplied value with the pinned one", () => {
    expect(
      applyInputPins(pinnable, "generic", { sources: ["data"] }, { query: "q", sources: ["web"] }),
    ).toEqual({ query: "q", sources: ["data"] });
  });

  it("describes the tool for the pinned value", () => {
    expect(descriptionForConnection(pinnable, "generic", { sources: ["web"] })).toBe("pinned web");
    expect(descriptionForConnection(pinnable, "generic", NO_PINS)).toBe("unpinned");
  });

  it("ignores pins on the chatgpt surface", () => {
    const pins = { sources: ["data"] as const };
    expect(inputSchemaForConnection(pinnable, "chatgpt", pins)).toBe(schema);
    expect(descriptionForConnection(pinnable, "chatgpt", pins)).toBe("unpinned");
    expect(applyInputPins(pinnable, "chatgpt", pins, { query: "q", sources: ["web"] })).toEqual({
      query: "q",
      sources: ["web"],
    });
  });

  it("ignores pins a tool doesn't declare", () => {
    expect(inputSchemaForConnection(unpinnable, "generic", { sources: ["data"] })).toBe(schema);
    expect(applyInputPins(unpinnable, "generic", { sources: ["data"] }, { query: "q" })).toEqual({
      query: "q",
    });
  });

  it("keeps only pins that a listed tool declares", () => {
    expect(effectivePins([unpinnable], { sources: ["data"] })).toEqual({});
    expect(effectivePins([unpinnable, pinnable], { sources: ["data"] })).toEqual({ sources: ["data"] });
  });
});
