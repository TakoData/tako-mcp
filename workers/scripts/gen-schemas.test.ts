import { describe, it, expect } from "vitest";
import { generateZodModule } from "./gen-schemas.js";

describe("generateZodModule", () => {
  it("emits a named const + type per component schema", () => {
    const out = generateZodModule({
      Pet: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
    expect(out).toContain("export const Pet =");
    expect(out).toContain("export type Pet = z.infer<typeof Pet>");
    expect(out).toContain('import { z } from "zod"');
    expect(out).toContain("GENERATED");
  });

  it("resolves intra-document $ref to the other generated const via z.lazy", () => {
    const out = generateZodModule({
      Owner: { type: "object", properties: { pet: { $ref: "#/components/schemas/Pet" } } },
      Pet: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(out).toContain("z.lazy(() => Pet)");
  });

  it("preserves enums", () => {
    const out = generateZodModule({
      Mode: { type: "string", enum: ["url", "inline"] },
    });
    expect(out).toMatch(/z\.enum\(\[\s*"url",\s*"inline"\s*\]\)/);
  });

  it("keeps $ref sibling keywords (default/description) and makes non-required ref fields optional", () => {
    // OpenAPI 3.1: a `$ref` property may carry sibling `default`/`description`,
    // and a property absent from `required` must be optional on input.
    const out = generateZodModule({
      Req: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          // $ref WITH a sibling default + description, NOT in `required`.
          mode: {
            $ref: "#/components/schemas/Mode",
            description: "Delivery mode",
            default: "url",
          },
          // $ref WITH a description but NO default, NOT in `required`.
          sources: {
            $ref: "#/components/schemas/Mode",
            description: "no default here",
          },
        },
      },
      Mode: { type: "string", enum: ["url", "inline"] },
    });

    // The default-bearing ref keeps both its target reference and its default
    // (a Zod `.default(v)` makes the field optional-on-input).
    expect(out).toContain('"mode": z.lazy(() => Mode)');
    expect(out).toContain('.default("url")');
    expect(out).toContain('.describe("Delivery mode")');

    // The non-default ref field is still optional (not in `required`) and keeps
    // its description.
    expect(out).toMatch(/"sources": z\.lazy\(\(\) => Mode\)\.describe\("no default here"\)\.optional\(\)/);

    // Single-element allOf over a parser-overridden ref must NOT introduce an
    // intersection wrapper.
    expect(out).not.toContain("z.intersection");
  });
});
