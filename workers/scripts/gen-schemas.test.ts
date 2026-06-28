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
});
