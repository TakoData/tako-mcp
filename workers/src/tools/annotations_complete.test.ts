import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "./_registry.js";
import { toolAnnotationsForSurface } from "./_surface.js";

const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

// OpenAI app review (2026-08-25) rejects hints "not explicitly set to true
// or false (not null)". Assert every hint is a literal boolean on every
// tool, on BOTH surfaces (spec: annotation-completeness section).
describe("annotation completeness", () => {
  for (const tool of TOOL_REGISTRY) {
    for (const surface of ["generic", "chatgpt"] as const) {
      it(`${tool.name} on ${surface} sets all four hints explicitly`, () => {
        const a = toolAnnotationsForSurface(tool, surface);
        for (const hint of HINTS) {
          expect(typeof a[hint], `${tool.name}.${hint}`).toBe("boolean");
        }
      });
    }
  }
});
