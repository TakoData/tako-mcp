/**
 * `workers/src` must stay acyclic on its VALUE imports.
 *
 * Why a test and not a convention: `freetier.ts` needs each free tool's own
 * `anonymousInputRejects` verdict, and the obvious `import { TOOL_REGISTRY }`
 * closed `freetier → _registry → _chart_widget → embed_proxy → freetier`
 * (`_chart_widget.ts` took `EMBED_PROXY_PREFIX` from `embed_proxy.ts`, which
 * imports `freeTierRateLimitKey` from `freetier.ts`). The fix moved that one
 * constant into `env.ts`, which imports nothing.
 *
 * The failure mode is why this is worth a test. It is NOT a load error:
 * `HTTP_URL_REGEX` (`_chart_widget.ts`) arrives `undefined` at
 * `_search_results.ts`, zod stores it without checking, and the FIRST PARSE
 * throws `Cannot set properties of undefined (setting 'lastIndex')` from
 * inside a handler. `npm run typecheck` stays clean and every schema-only
 * test passes, so the only signal is a handful of handler tests failing with
 * a zod internal stack that names neither module. A previous revision of this
 * repo shipped a comment describing the wrong cycle for exactly that reason.
 *
 * Type-only edges (`import type`, `export type`) are erased before the module
 * ever loads, so they cannot cause this and are not counted.
 *
 * Runs under the `scripts` vitest project (plain node, filesystem access) —
 * `src/**` runs in workerd and cannot read files.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "..", "src");

/** Every non-test `.ts` file under `src`, as paths relative to `src`. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path.relative(SRC, full));
    }
  }
  return out;
}

/**
 * Relative-specifier targets of `file`'s value imports.
 *
 * Comments are stripped first: a `from "./x.js"` inside a docblock is prose,
 * and this guard's whole point is that prose about the graph drifts from it.
 */
function valueImports(file: string): string[] {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const targets: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\b([^;]*?)from\s+"([^"]+)"/g;
  for (const match of code.matchAll(pattern)) {
    const [, keyword, clause, specifier] = match;
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    // `import type {…}` / `export type {…}` are erased by the compiler and
    // cannot affect load order. A `{ type Foo, bar }` inline-type clause is
    // NOT erased — `bar` is a value — so only the leading form is skipped.
    if (new RegExp(`^\\s*type\\b`).test(clause ?? "")) continue;
    if (keyword === undefined) continue;
    const resolved = path.normalize(
      path.join(path.dirname(file), specifier.replace(/\.js$/, ".ts")),
    );
    if (fs.existsSync(path.join(SRC, resolved))) targets.push(resolved);
  }
  return targets;
}

/** Every cycle in the value-import graph, as a list of file paths. */
function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...cycle].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (state.get(next) === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...graph.keys()].sort()) {
    if (state.get(node) === undefined) visit(node);
  }
  return cycles;
}

describe("workers/src module graph", () => {
  const files = sourceFiles();
  const graph = new Map(files.map((file) => [file, valueImports(file)]));

  it("scans a plausible number of modules", () => {
    // Guards against the walker silently finding nothing — an empty graph has
    // no cycles and would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no value-import cycles", () => {
    const cycles = findCycles(graph).map((cycle) => cycle.join(" -> "));
    expect(cycles).toEqual([]);
  });

  it("keeps EMBED_PROXY_PREFIX out of the tool modules' reach via embed_proxy", () => {
    // The specific edge that closed the cycle. Stated separately from the
    // generic check so the failure names the constant to move, not a
    // four-hop path the reader has to re-derive.
    expect(graph.get(path.join("tools", "_chart_widget.ts"))).not.toContain(
      "embed_proxy.ts",
    );
  });

  it("keeps env.ts a leaf, so constants parked there cannot cycle", () => {
    // `EMBED_PROXY_PREFIX` lives in env.ts only because env.ts imports
    // nothing. Give env.ts an import and that guarantee is gone.
    expect(graph.get("env.ts")).toEqual([]);
  });
});
