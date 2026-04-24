#!/usr/bin/env tsx
/**
 * Codegen: read every tool module under `workers/src/tools/*.ts`, merge with
 * the hand-maintained static fields in `registry/metadata.json`, and emit:
 *
 *   - `registry/server.json` — the external MCP registry discovery card
 *   - `workers/src/tools/_registry.ts` — a static barrel importable by `mcp.ts`
 *
 * Modes:
 *   `tsx gen-registry.ts`           — write both files
 *   `tsx gen-registry.ts --check`   — regenerate in-memory, diff against
 *                                     committed files, exit 1 on drift
 *
 * Two outputs, one scan: the registry and the runtime-import barrel come
 * from the same tool enumeration, so they cannot drift. CI runs `--check`
 * on every PR so a stale registry or barrel fails the build.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import type { ToolAnnotations, ToolModule } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(WORKERS_DIR, "..");
const TOOLS_DIR = resolve(WORKERS_DIR, "src", "tools");
const METADATA_PATH = resolve(REPO_ROOT, "registry", "metadata.json");
const REGISTRY_PATH = resolve(REPO_ROOT, "registry", "server.json");
const BARREL_PATH = resolve(TOOLS_DIR, "_registry.ts");

// Filename conventions for the tools/ directory. Anything matching `types.ts`,
// `_registry.ts`, or `*.test.ts` is NOT a tool module. Everything else must
// default-export a `ToolModule`.
const NON_TOOL_FILES = new Set(["types.ts", "_registry.ts"]);

// ---------------------------------------------------------------------------
// Registry shape (mirrors `registry/server.json` `tools[]` entries)
// ---------------------------------------------------------------------------

interface ParameterSpec {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

interface RegistryTool {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  annotations: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// Tool loading
// ---------------------------------------------------------------------------

interface LoadedModule {
  file: string;
  tool: ToolModule;
}

async function loadToolModules(): Promise<LoadedModule[]> {
  const files = readdirSync(TOOLS_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !NON_TOOL_FILES.has(f) &&
        !f.endsWith(".test.ts"),
    )
    .sort();

  const modules: LoadedModule[] = [];
  for (const file of files) {
    const url = pathToFileURL(join(TOOLS_DIR, file)).href;
    const mod = (await import(url)) as { default?: unknown };
    const tool = mod.default as ToolModule | undefined;
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
      throw new Error(
        `${file}: expected default export of shape ToolModule (with a string .name)`,
      );
    }
    modules.push({ file, tool });
  }

  // Guard against duplicate tool names — Phase 2 authors could accidentally
  // ship two files with the same `name`, and MCP SDK's registerTool would
  // throw at runtime. Fail loud at codegen time instead.
  const seen = new Set<string>();
  for (const { file, tool } of modules) {
    if (seen.has(tool.name)) {
      throw new Error(
        `duplicate tool name "${tool.name}" (second occurrence in ${file})`,
      );
    }
    seen.add(tool.name);
  }

  return modules;
}

// ---------------------------------------------------------------------------
// Zod -> registry parameters
// ---------------------------------------------------------------------------

/**
 * Flatten a JSON Schema `object` into the registry's parameter-map format.
 *
 * Current registry format per tool:
 *
 *   "parameters": {
 *     "query":     { "type": "string",  "description": "...", "required": true },
 *     "count":     { "type": "integer", "description": "...", "default": 5 }
 *   }
 *
 * This is NOT JSON Schema — it's a flat, hand-friendly shape. The conversion
 * collapses `required: [...]` into a per-property boolean and preserves
 * `default` where present. Everything else (`additionalProperties`, `$schema`,
 * nested schemas, enums, format annotations) is dropped because the external
 * registry's parameter format does not carry them.
 */
function flattenParameters(
  jsonSchema: unknown,
): Record<string, ParameterSpec> {
  const schema = jsonSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const out: Record<string, ParameterSpec> = {};
  for (const [name, rawPropSchema] of Object.entries(properties)) {
    const prop = rawPropSchema as {
      type?: string;
      description?: string;
      default?: unknown;
    };
    const spec: ParameterSpec = {
      type: prop.type ?? "unknown",
    };
    if (prop.description !== undefined) spec.description = prop.description;
    const hasDefault = Object.prototype.hasOwnProperty.call(prop, "default");
    if (hasDefault) {
      spec.default = prop.default;
    }
    // Fields with a default are semantically optional from the caller's
    // perspective: the handler always receives a value, but the caller
    // doesn't have to send one. Zod's emitted JSON Schema includes
    // defaulted fields in `required`, so we strip that annotation here to
    // match the external registry's hand-written convention.
    if (required.has(name) && !hasDefault) spec.required = true;
    out[name] = spec;
  }
  return out;
}

function buildTool(tool: ToolModule): RegistryTool {
  // zod 4 ships native JSON Schema export (`z.toJSONSchema`). We flatten
  // the output into the registry's per-property shape immediately, so the
  // emitted draft dialect is irrelevant downstream.
  const jsonSchema = z.toJSONSchema(tool.inputSchema);
  return {
    name: tool.name,
    description: tool.description,
    parameters: flattenParameters(jsonSchema),
    annotations: tool.annotations,
  };
}

// ---------------------------------------------------------------------------
// Registry assembly
// ---------------------------------------------------------------------------

/**
 * Merge metadata + tool-derived entries into the final registry shape.
 *
 * Top-level key order is preserved from `metadata.json`. `tools` is inserted
 * immediately before `links` to match the hand-written registry's original
 * ordering. This keeps the generated output visually stable and minimizes
 * diff noise for reviewers.
 */
function buildRegistry(
  metadata: Record<string, unknown>,
  tools: RegistryTool[],
): Record<string, unknown> {
  const { links, ...rest } = metadata as { links?: unknown };
  const result: Record<string, unknown> = { ...rest, tools };
  if (links !== undefined) result.links = links;
  return result;
}

/** Canonical JSON serializer. 2-space indent + LF line endings + trailing newline. */
function serializeJson(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Barrel emission
// ---------------------------------------------------------------------------

/**
 * Emit the `workers/src/tools/_registry.ts` barrel. `mcp.ts` imports this
 * at module-init time to auto-register every tool. The barrel is kept in
 * lockstep with `registry/server.json` by being generated from the same
 * module scan.
 */
function buildBarrel(modules: LoadedModule[]): string {
  const lines: string[] = [];
  const idents: string[] = [];

  for (const { file } of modules) {
    const basename = file.replace(/\.ts$/, "");
    // Produce a JS-safe identifier. Leading `_` becomes `tool_` so
    // `_example.ts` imports as `tool_example`. Any other non-word chars
    // (hyphens, dots) also collapse to `_`.
    const ident = basename
      .replace(/^_/, "tool_")
      .replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`import ${ident} from "./${basename}.js";`);
    idents.push(ident);
  }

  const header = [
    "/**",
    " * GENERATED FILE — do not edit by hand.",
    " *",
    " * Regenerated by `workers/scripts/gen-registry.ts`. The set of imports",
    " * below is the authoritative list of tools the Worker registers with the",
    " * MCP SDK at runtime, kept in lockstep with `registry/server.json` by",
    " * being emitted from the same scan.",
    " *",
    " * To add or remove a tool: drop (or delete) a file under",
    " * `workers/src/tools/` and run `npm run registry:gen`.",
    " */",
    "",
    'import type { AnyToolModule } from "./types.js";',
    "",
  ];

  const footer = [
    "",
    "// Cast at the barrel boundary because function parameters are invariant:",
    "// each tool's handler has a narrow input type from its Zod schema, which",
    "// TS will not assign to the erased `AnyToolModule` handler signature.",
    "// Runtime Zod validation inside the MCP SDK narrows safely.",
    "export const TOOL_REGISTRY: ReadonlyArray<AnyToolModule> = [",
    ...idents.map((id) => `  ${id} as unknown as AnyToolModule,`),
    "];",
    "",
  ];

  return [...header, ...lines, ...footer].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");

  const metadata = JSON.parse(readFileSync(METADATA_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const modules = await loadToolModules();
  const registry = buildRegistry(
    metadata,
    modules.map((m) => buildTool(m.tool)),
  );
  const registryJson = serializeJson(registry);
  const barrel = buildBarrel(modules);

  if (checkMode) {
    const committedRegistry = readFileSync(REGISTRY_PATH, "utf8");
    const committedBarrel = readFileSync(BARREL_PATH, "utf8");
    let drift = false;
    if (committedRegistry !== registryJson) {
      console.error(
        `[registry:check] drift: ${REGISTRY_PATH} does not match generator output`,
      );
      drift = true;
    }
    if (committedBarrel !== barrel) {
      console.error(
        `[registry:check] drift: ${BARREL_PATH} does not match generator output`,
      );
      drift = true;
    }
    if (drift) {
      console.error(
        "Run `npm run registry:gen` in workers/ and commit the changes.",
      );
      process.exit(1);
    }
    console.log(`[registry:check] ok (${modules.length} tools)`);
    return;
  }

  writeFileSync(REGISTRY_PATH, registryJson);
  writeFileSync(BARREL_PATH, barrel);
  console.log(`wrote ${REGISTRY_PATH}`);
  console.log(`wrote ${BARREL_PATH}`);
  console.log(`(${modules.length} tools)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
