import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyInputPins,
  describePins,
  descriptionForConnection,
  effectivePins,
  everySinglePin,
  inputSchemaForConnection,
  NO_PINS,
  pinnedField,
  readInputPins,
  SOURCE_VALUES,
} from "./_input_pins.js";
import { TOOL_REGISTRY } from "./_registry.js";
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
  const pinnable: Pick<AnyToolModule, "description" | "inputSchema" | "inputPins" | "describeForPins"> = {
    description: "unpinned",
    inputSchema: schema,
    inputPins: { sources: pinnedField("sources") },
    describeForPins: (pins) => (pins.sources === undefined ? "unpinned" : `pinned ${pins.sources.join(",")}`),
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
      applyInputPins(pinnable, { sources: ["data"] }, { query: "q", sources: ["web"] }),
    ).toEqual({ query: "q", sources: ["data"] });
  });

  it("describes the tool for the pinned value", () => {
    expect(descriptionForConnection(pinnable, { sources: ["web"] })).toBe("pinned web");
    expect(descriptionForConnection(pinnable, NO_PINS)).toBe("unpinned");
    expect(descriptionForConnection(unpinnable, { sources: ["web"] })).toBe("plain");
  });

  it("applies no pins on the chatgpt surface", () => {
    expect(effectivePins([pinnable], "chatgpt", { sources: ["data"] })).toEqual(NO_PINS);
  });

  it("ignores pins a tool doesn't declare", () => {
    expect(inputSchemaForConnection(unpinnable, "generic", { sources: ["data"] })).toBe(schema);
    expect(applyInputPins(unpinnable, { sources: ["data"] }, { query: "q" })).toEqual({
      query: "q",
    });
  });

  it("keeps only pins that a listed tool declares", () => {
    expect(effectivePins([unpinnable], "generic", { sources: ["data"] })).toEqual({});
    expect(effectivePins([unpinnable, pinnable], "generic", { sources: ["data"] })).toEqual({
      sources: ["data"],
    });
  });
});

describe("sources pin parity with each tool's own schema", () => {
  const declaring = TOOL_REGISTRY.filter(
    (tool) => "sources" in tool.inputSchema.shape && tool.inputPins?.sources !== undefined,
  );

  it("covers the search tool and both agents", () => {
    expect(declaring.map((tool) => tool.name).sort()).toEqual([
      "tako_agent",
      "tako_company_agent",
      "tako_search",
    ]);
  });

  it("accepts every value the URL accepts", () => {
    for (const tool of declaring) {
      const field = tool.inputSchema.shape.sources!;
      for (const { sources } of everySinglePin()) {
        expect(z.safeParse(field, sources).success, `${tool.name} ${String(sources)}`).toBe(true);
      }
    }
  });
});
