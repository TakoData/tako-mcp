import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import takoGraphRelated from "../src/tools/tako_graph_related.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = readFileSync(resolve(HERE, "../../openapi/sdk.yaml"), "utf8");

describe("tako_graph_related named-relation examples", () => {
  it("every rel:<phrase> example in the description appears in openapi/sdk.yaml", () => {
    // The description may cite named edges only if the API contract itself
    // cites them — the spec says the keys are read from the response, not
    // remembered. `rel:<phrase>` is the placeholder form and is exempt.
    const examples = [...takoGraphRelated.description.matchAll(/rel:[a-z_]+/g)]
      .map((m) => m[0])
      .filter((k) => k !== "rel:<phrase>");
    expect(examples.length).toBeGreaterThan(0);
    for (const key of examples) expect(SPEC, key).toContain(key);
  });
});
