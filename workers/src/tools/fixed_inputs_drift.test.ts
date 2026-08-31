/**
 * `fixedInputs` is a HAND-WRITTEN declaration that `docs/TOOLS.md` renders
 * verbatim under "Fixed request inputs (the caller cannot change these)".
 * Nothing in the type system links it to the body a handler actually sends, so
 * a retune breaks the handler's own body tests, gets fixed there, and leaves
 * the declaration stale — with the published doc asserting a value the server
 * no longer sends. `annotations.test.ts` only checks that `field` and `note`
 * are non-empty; `value` went unchecked everywhere except `tako_search`.
 *
 * This file closes that gap for every row whose `field` is a real wire path
 * and whose `value` is a JSON literal. Two rules keep it derived rather than a
 * second copy of the constants:
 *
 *  - The checkable rows are COMPUTED from the declaration, not listed. A row
 *    is checkable when it is request-scoped, its value parses as JSON (so
 *    `= count`, `5 s / 295 s` and `min(100000, 250000 / batch size)` are out)
 *    and its field reduces to a dotted path (so `graph/search limit` and
 *    `poll interval / budget` are out — those name endpoint query params and
 *    Worker loop constants, not request fields). `scope: "worker"` is the
 *    explicit half of that and `scope agrees with the wire-path heuristic`
 *    below asserts the two never disagree.
 *  - `every tool with a checkable row is covered here` asserts the map below
 *    is COMPLETE. Add a checkable row to a tool that has no entry and this
 *    file fails, rather than silently skipping it.
 *
 * A trailing parenthetical qualifier is stripped for path extraction
 * (`max_chars (when omitted)` → `max_chars`), so each entry must supply an
 * input that exercises the declared case.
 *
 * `tako_visualize` has no entry ON PURPOSE: its rows name chart-URL render
 * settings, not request fields, so none of them is wire-path-shaped and the
 * completeness check below does not ask for it. Those three values are pinned
 * to `DEFAULT_WIDTH` / `DEFAULT_HEIGHT` / `DEFAULT_DARK_MODE` in
 * `tako_visualize.test.ts` instead.
 */
import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./_registry.js";
import tako_agent, { buildAgentBody } from "./tako_agent.js";
import tako_contents, { buildContentsBody } from "./tako_contents.js";
import tako_search, { buildSearchBody } from "./tako_search.js";

type FixedInput = {
  readonly field: string;
  readonly value: string;
  readonly scope?: "request" | "worker";
};

/** The field as a wire path, or null when the row does not name one. */
function wirePath(field: string): string[] | null {
  const bare = field.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/.test(bare) ? bare.split(".") : null;
}

/** The declared value as JSON, or undefined when it is prose or a reference. */
function jsonValue(value: string): { ok: true; parsed: unknown } | { ok: false } {
  if (value.startsWith("=")) return { ok: false };
  try {
    return { ok: true, parsed: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function checkableRows(fixedInputs: readonly FixedInput[]): FixedInput[] {
  return fixedInputs.filter(
    (f) => (f.scope ?? "request") === "request" && wirePath(f.field) !== null && jsonValue(f.value).ok,
  );
}

const CASES: ReadonlyArray<{
  name: string;
  fixedInputs: readonly FixedInput[];
  body: () => unknown;
}> = [
  {
    name: tako_search.name,
    fixedInputs: tako_search.fixedInputs,
    body: () =>
      buildSearchBody(
        tako_search.inputSchema.parse({ query: "US GDP", sources: ["data", "web"] }),
      ),
  },
  {
    name: tako_agent.name,
    fixedInputs: tako_agent.fixedInputs,
    body: () => buildAgentBody(tako_agent.inputSchema.parse({ query: "US GDP" })),
  },
  {
    name: tako_contents.name,
    fixedInputs: tako_contents.fixedInputs,
    // batchSize 1, which is the `max_chars (when omitted)` row's own case:
    // min(100000, 250000 / 1) → the 100k single-url default. That row is not
    // checkable (its value is an expression, not JSON), but the two rows that
    // ARE — `mode` and `content_format` — are the ones this tool decides on the
    // caller's behalf, so a silent revert to the backend's "url"/"csv"
    // defaults would publish a doc claim the server no longer honors.
    body: () =>
      buildContentsBody(
        "https://tako.com/card/abc",
        tako_contents.inputSchema.parse({ urls: ["https://tako.com/card/abc"] }),
        1,
      ),
  },
];

describe("fixedInputs matches what the handler sends", () => {
  for (const { name, fixedInputs, body } of CASES) {
    const rows = checkableRows(fixedInputs);

    it(`${name} declares at least one checkable row`, () => {
      // Guards against the whole case passing vacuously if a `field` or
      // `value` is reworded into an unparseable shape.
      expect(rows.length, `${name} has no checkable fixedInputs rows`).toBeGreaterThan(0);
    });

    for (const row of rows) {
      it(`${name}: ${row.field} is really ${row.value} on the wire`, () => {
        const path = wirePath(row.field);
        expect(path, row.field).not.toBeNull();
        const parsed = jsonValue(row.value);
        expect(parsed.ok, row.value).toBe(true);
        const actual = (path as string[]).reduce<unknown>(
          (o, key) => (o as Record<string, unknown> | undefined)?.[key],
          body(),
        );
        expect(actual, `${name}.${row.field}`).toEqual(
          (parsed as { ok: true; parsed: unknown }).parsed,
        );
      });
    }
  }

  // `scope` decides which section `docs/TOOLS.md` renders a row under, and the
  // wire-path/JSON heuristic decides whether this file checks it. They are two
  // spellings of one question, so a disagreement means the doc is publishing a
  // Worker constant as a request field, or this file is skipping a real one.
  // Neither is visible from the row itself, which is why it is asserted.
  it("scope agrees with the wire-path heuristic on every row", () => {
    const disagreeing: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      for (const row of (tool.fixedInputs ?? []) as readonly FixedInput[]) {
        const declaredRequest = (row.scope ?? "request") === "request";
        const looksLikeWire = wirePath(row.field) !== null && jsonValue(row.value).ok;
        // A request-scoped row need not be checkable — `effort` is a request
        // field whose value is a JSON string, and `graph/search limit` names an
        // endpoint query param. Only the reverse is a defect: a row that IS
        // wire-shaped but marked `"worker"` skips the drift check silently.
        if (!declaredRequest && looksLikeWire) {
          disagreeing.push(`${tool.name}.${row.field}`);
        }
      }
    }
    expect(
      disagreeing,
      'marked scope: "worker" but the field and value are wire-shaped — ' +
        "either it is a request field (drop the scope) or the field names a " +
        "Worker setting and should not read as a dotted path",
    ).toEqual([]);
  });

  it("every tool with a checkable row is covered here", () => {
    const covered = new Set(CASES.map((c) => c.name));
    const uncovered = TOOL_REGISTRY.filter(
      (tool) => checkableRows(tool.fixedInputs ?? []).length > 0 && !covered.has(tool.name),
    ).map((tool) => tool.name);
    expect(uncovered, "add a CASES entry with this tool's body builder").toEqual([]);
  });
});
