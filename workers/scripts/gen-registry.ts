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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import {
  pinAdvisingSentences,
  pinFormProblem,
  PLURAL_UNQUALIFIED,
} from "../src/tools/_pin_form_rules.js";
import {
  isToolOnSurface,
  toolAnnotationsForClient,
  WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES,
} from "../src/tools/_surface.js";
import type { ToolAnnotations, ToolModule } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Curated tool surface
// ---------------------------------------------------------------------------

/**
 * Curated MCP tool surface. `classify` is in the sdk spec but intentionally
 * not a tool — it is an API operation only, not an MCP-callable tool.
 *
 * This list is the source-of-truth for which tool files are allowed to exist
 * under `workers/src/tools/`. The generator asserts (both in write mode and
 * in `--check`) that the discovered set equals this list exactly, so adding
 * or removing a tool file without updating the allowlist fails the build.
 */
export const MCP_TOOL_ALLOWLIST = [
  "get_credit_balance",
  "tako_agent",
  "tako_agent_start",
  "tako_agent_wait",
  "tako_answer",
  "tako_available_data",
  "tako_contents",
  "tako_graph_node",
  "tako_graph_related",
  "tako_graph_search",
  "tako_search",
  "tako_visualize",
] as const;

/**
 * Deliberately curated subset advertised on the LobeHub listing
 * (`registry/lhm.plugin.json`): the core retrieval surface every client
 * gets by default, without the opt-in/ChatGPT-only/write tools. The
 * descriptions and schemas are generated from the tool modules so they
 * cannot drift; the CHOICE of tools is editorial and lives here.
 */
export const LOBEHUB_TOOL_ALLOWLIST = [
  "tako_answer",
  "tako_available_data",
  "tako_contents",
  "tako_search",
] as const;

/**
 * Assert that every tool in the registry has a non-empty description.
 * Throws with the list of offending tool names if any are missing.
 */
export function assertAllToolsDescribed(
  tools: ReadonlyArray<{ name: string; description?: string }>,
): void {
  const missing = tools
    .filter((t) => !t.description || t.description.trim() === "")
    .map((t) => t.name);
  if (missing.length > 0) {
    throw new Error(`MCP tools missing a description: ${missing.join(", ")}`);
  }
}

/**
 * Assert that the hand-written `llms-full.txt` covers the live tool surface.
 *
 * `registry/server.json` and `_registry.ts` are generated so they cannot
 * drift, but `llms-full.txt` restates tools and params by hand and has
 * already drifted silently once (the graph tools had no sections and
 * search/answer were missing `node_ids`/`strict`). This is the lighter
 * guard: every tool name must be mentioned (a `### <name>` section or an
 * inline `` `name` `` reference), and any tool that HAS a section must
 * mention every input param inside it. Prose-only mentions (e.g. the
 * ChatGPT-only `tako_agent_start`/`tako_agent_wait` pair) need no section.
 */
export function assertLlmsFullCoverage(
  tools: ReadonlyArray<{ name: string; parameters: Record<string, unknown> }>,
  llmsFull: string,
): void {
  const sections = new Map<string, string>();
  for (const part of llmsFull.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    sections.set(heading, nl === -1 ? "" : part.slice(nl + 1));
  }

  const problems: string[] = [];
  for (const tool of tools) {
    const section = sections.get(tool.name);
    if (section === undefined) {
      if (!llmsFull.includes(`\`${tool.name}\``)) {
        problems.push(`tool "${tool.name}" is never mentioned`);
      }
      continue;
    }
    for (const param of Object.keys(tool.parameters)) {
      if (!section.includes(`\`${param}\``)) {
        problems.push(
          `section "### ${tool.name}" does not mention param \`${param}\``,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `llms-full.txt drift — hand-written docs out of sync with tool modules:\n  ${problems.join(
        "\n  ",
      )}\nUpdate llms-full.txt to match the tool surface.`,
    );
  }
}

/**
 * Assert that the hand-written `llms-full.txt` advises the pin form measured to
 * WORK: the METRIC node id alone, with `strict: true`.
 *
 * `_pin_form.test.ts` guards this invariant across tool descriptions and
 * published field descriptions, but it walks in-process objects and cannot see a
 * docs file. That gap is not hypothetical — it is where the broken form
 * survived a sweep whose commit message claimed "every surface": llms-full.txt's
 * tako_answer paragraph still read "ask here with its node_ids pinned", with no
 * `strict`, describing the variant measured to do nothing.
 *
 * Sentence-level and pattern-based (shared with the vitest guard via
 * `_pin_form_rules.ts`), so rewording the advice stays free and only the
 * invariant is pinned. Runs inside `registry:check`, which already gates
 * workers-ci and workers-deploy.
 */
export function assertPinFormInDocs(
  docs: ReadonlyArray<{ file: string; text: string; requireStrict: boolean }>,
): void {
  const problems: string[] = [];
  for (const { file, text, requireStrict } of docs) {
    const sentenceProblems: string[] = [];
    let pluralNamed = false;
    for (const sentence of pinAdvisingSentences(text)) {
      const problem = pinFormProblem(sentence, { requireStrict });
      if (problem === null) continue;
      if (PLURAL_UNQUALIFIED.test(sentence)) pluralNamed = true;
      sentenceProblems.push(`${file}: ${problem}\n      "${sentence.slice(0, 160)}"`);
    }
    // Document-wide safety net for the plural rule, NOT gated on
    // `pinAdvisingSentences`: mirrors how `_pin_form.test.ts` applies this rule
    // to a whole description, and it is what actually caught the form that
    // shipped in llms-full.txt — `ADVISES_PINNING` could not span the backtick
    // in "`nodes` ids", so the sentence loop never saw the offending sentence.
    // Both layers stay: the detector is a regex over prose and will have another
    // blind spot eventually. Reported only when the sentence loop did not
    // already name it, so one offending sentence yields one problem, with its
    // text quoted where we have it.
    if (!pluralNamed && PLURAL_UNQUALIFIED.test(text)) {
      problems.push(
        `${file}: advises pinning every node id on the card (the measured no-op); pin the METRIC node id ALONE`,
      );
    }
    problems.push(...sentenceProblems);
  }
  if (problems.length > 0) {
    throw new Error(
      `pin-form drift — docs advise a pin form measured NOT to steer retrieval:\n  ${problems.join(
        "\n  ",
      )}\nUse the PINNED_RETRY / PINNED_FROM_CARD wording from workers/src/tools/_search_results.ts.`,
    );
  }
}

/**
 * Assert that `chatgpt-app-submission.json` matches the runtime ChatGPT
 * descriptors. The submission file is hand-maintained (its justifications
 * and test cases cannot be generated), so this validates instead of
 * emitting: the declared tool set must equal ChatGPT's default
 * AUTHENTICATED tool surface, and each tool's annotation hints must equal
 * what `toolAnnotationsForClient(tool, "chatgpt")` actually serves.
 * Without this, an edit to a tool's annotations (canonical or
 * `annotationsByClient`) would leave the submitted app metadata claiming
 * something production no longer serves.
 *
 * The anonymous free-tier ChatGPT surface is asserted separately as an
 * EQUALITY: the ChatGPT link-account flow requires auth-only tools to
 * stay listed pre-auth (`CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES` in
 * `tools/_surface.ts`), so the anonymous ChatGPT listing must match the
 * declared tools exactly — growing past the submission and shrinking
 * below it are both errors. `tako_contents` / `tako_visualize` only
 * EXECUTE on an OAuth-linked connection, which is what the submission's
 * test cases assume.
 *
 * Transitive consequence (deliberate, worth stating): because BOTH the
 * authenticated ChatGPT surface and the anonymous ChatGPT surface must
 * equal the declared tools, the two surfaces are necessarily IDENTICAL —
 * every submitted ChatGPT tool is visible pre-auth. That is the current
 * product intent (OpenAI's link-account UI needs pre-auth listing). A
 * future ChatGPT tool that should stay HIDDEN until sign-in cannot exist
 * under this check; supporting one means relaxing the anonymous-side
 * equality back to "anonymous ⊆ declared" plus an explicit allowlist of
 * intentionally-hidden-pre-auth names — do that deliberately, not by
 * listing the tool anonymously to silence the error.
 */
export function assertChatgptSubmissionParity(
  tools: ReadonlyArray<
    Pick<ToolModule, "name" | "annotations" | "annotationsByClient">
  >,
  submissionJson: string,
): void {
  const submission = JSON.parse(submissionJson) as {
    tools?: Record<string, { annotations?: Record<string, unknown> }>;
  };
  if (submission.tools === undefined || typeof submission.tools !== "object") {
    throw new Error(
      'chatgpt-app-submission.json: missing top-level "tools" object',
    );
  }
  const declaredTools = submission.tools;

  // The submission covers the DEFAULT production MCP URL over an
  // AUTHENTICATED (OAuth-linked) connection: no `?tools=` opt-ins, client
  // detected as chatgpt, tier "authenticated".
  const noOptIns: ReadonlySet<string> = new Set();
  const expected = new Map(
    tools
      .filter((t) => isToolOnSurface(t.name, "chatgpt", noOptIns, "authenticated"))
      .map((t) => [t.name, toolAnnotationsForClient(t, "chatgpt")]),
  );

  const problems: string[] = [];
  const declaredNames = new Set(Object.keys(declaredTools));
  for (const name of expected.keys()) {
    if (!declaredNames.has(name)) {
      problems.push(`missing tool "${name}" (on ChatGPT's default surface)`);
    }
  }
  for (const name of declaredNames) {
    if (!expected.has(name)) {
      problems.push(`extra tool "${name}" (not on ChatGPT's default surface)`);
    }
  }

  // The anonymous ChatGPT surface must EQUAL the declared tools, both
  // directions. Outgrowing the submission would show OpenAI review
  // tooling an undeclared tool; SHRINKING below it (e.g. deleting a name
  // from CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES) would remove a
  // submitted tool from the pre-link listing and silently break its
  // link-account affordance — the exact regression the discoverability
  // change exists to prevent (PR #183 review).
  const freeChatgptSurface = new Set(
    tools
      .filter((t) => isToolOnSurface(t.name, "chatgpt", noOptIns, "free"))
      .map((t) => t.name),
  );
  for (const name of freeChatgptSurface) {
    if (!declaredNames.has(name)) {
      problems.push(
        `tool "${name}" is on the anonymous free-tier ChatGPT surface but not declared in the submission`,
      );
    }
  }
  for (const name of declaredNames) {
    if (!freeChatgptSurface.has(name)) {
      problems.push(
        `tool "${name}" is declared in the submission but missing from the anonymous free-tier ChatGPT surface (link-account UI needs it listed pre-auth) — fix by restoring the name in CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES / FREE_TIER_TOOL_NAMES (workers/src/tools/_surface.ts, workers/src/freetier.ts), NOT by editing the submission`,
      );
    }
  }

  // The submission covers the ChatGPT PRODUCT, and the product has two MCP
  // transports: chatgpt.com's connector AND the desktop app (detected as
  // "codex"). Every surface equality above is asserted against "chatgpt"
  // only, so without this block a revert of codex's FAMILY membership
  // (dropping it from `isChatGptFamilyClient`) would leave `registry:check`
  // green while the desktop app lists a DIFFERENT tool set than the
  // submission declares — review finding on PR #239.
  //
  // Deliberately compared MODULO the widget-default-on names: this check
  // runs as a DEPLOY GATE (workers-deploy.yml), and the widget flip's only
  // rollback lever is removing `codex` from `isWidgetClient` (there is no
  // widget kill switch in `Env`). That one-line revert drops the
  // default-on `tako_visualize` from codex while chatgpt keeps it — a raw
  // surface equality here would fail the gate and BLOCK the rollback
  // deploy, telling the operator to undo their rollback (round-3 review
  // finding on PR #239). So the gate asserts only what the FAMILY
  // predicate feeds; codex's widget membership is pinned in the test
  // suites instead (_surface.test.ts membership table, index.test.ts,
  // mcp.test.ts), which fail loudly without holding a deploy hostage.
  for (const tier of ["authenticated", "free"] as const) {
    const familySurface = (client: "chatgpt" | "codex"): string[] =>
      tools
        .filter(
          (t) =>
            !WIDGET_CLIENT_DEFAULT_ON_TOOL_NAMES.has(t.name) &&
            isToolOnSurface(t.name, client, noOptIns, tier),
        )
        .map((t) => t.name)
        .sort();
    const chatgptSurface = familySurface("chatgpt");
    const codexSurface = familySurface("codex");
    if (JSON.stringify(codexSurface) !== JSON.stringify(chatgptSurface)) {
      problems.push(
        `codex (ChatGPT desktop app) ${tier} surface [${codexSurface.join(
          ", ",
        )}] diverges from chatgpt's [${chatgptSurface.join(
          ", ",
        )}] (widget-default-on names excluded) — the submission describes the ChatGPT product, which includes the desktop app; restore family membership in workers/src/tools/_surface.ts`,
      );
    }
  }

  const HINT_KEYS = ["readOnlyHint", "openWorldHint", "destructiveHint"] as const;
  for (const [name, resolved] of expected) {
    const declared = declaredTools[name];
    if (declared === undefined) continue;
    const annotations = declared.annotations ?? {};
    for (const hint of HINT_KEYS) {
      if (annotations[hint] !== resolved[hint]) {
        problems.push(
          `tool "${name}" ${hint}: submission declares ${JSON.stringify(
            annotations[hint],
          )}, runtime serves ${JSON.stringify(resolved[hint])}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `chatgpt-app-submission.json drift — submitted app metadata out of sync with runtime ChatGPT descriptors:\n  ${problems.join(
        "\n  ",
      )}\nEach problem line names its remediation; for annotation/tool-set drift, update chatgpt-app-submission.json to match the runtime surface (toolAnnotationsForClient(tool, "chatgpt")); for a shrunken anonymous surface, restore the tool-set constants in workers/src.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(WORKERS_DIR, "..");
const TOOLS_DIR = resolve(WORKERS_DIR, "src", "tools");
const METADATA_PATH = resolve(REPO_ROOT, "registry", "metadata.json");
const REGISTRY_PATH = resolve(REPO_ROOT, "registry", "server.json");
const LOBEHUB_PATH = resolve(REPO_ROOT, "registry", "lhm.plugin.json");
const BARREL_PATH = resolve(TOOLS_DIR, "_registry.ts");
const LLMS_FULL_PATH = resolve(REPO_ROOT, "llms-full.txt");
// The short index. Agents fetch `llms.txt` and `llms-full.txt` alike to learn
// the tool surface, but only the long one was guarded — so the two drifted:
// `llms.txt` went on saying `tako_visualize` was "already on by default for
// ChatGPT" after it became default-on for Claude too, and it never mentioned
// the ChatGPT `tako_agent_start` / `tako_agent_wait` split at all. It has no
// `### <tool>` sections, so `assertLlmsFullCoverage` degrades to exactly the
// right check for an index: every tool has to be named somewhere in it.
const LLMS_PATH = resolve(REPO_ROOT, "llms.txt");
// Checked for pin-form drift only (its contents are hand-written prose, and it
// embeds the bundled skills' recovery protocols verbatim).
const README_PATH = resolve(REPO_ROOT, "README.md");
// The bundled skills are model-facing prose that advises pinning, and NEITHER
// existing guard could see them: `_pin_form.test.ts` walks tool descriptions,
// and this function was only given llms-full.txt and README. That is the same
// gap that let the broken form survive in llms-full.txt, so close it by
// enumeration rather than waiting for the next survivor.
const SKILL_PATHS = [
  resolve(REPO_ROOT, "skills", "tako-financial-research", "SKILL.md"),
  resolve(REPO_ROOT, "skills", "tako-macroeconomics", "SKILL.md"),
  resolve(REPO_ROOT, "skills", "tako-web-traffic", "SKILL.md"),
];
const SUBMISSION_PATH = resolve(REPO_ROOT, "chatgpt-app-submission.json");

// Filename conventions for the tools/ directory. A tool module is any `.ts`
// file that does NOT match one of the following:
//   - `types.ts`                    (shared types, no default export)
//   - a name starting with `_`      (e.g. `_registry.ts`, `__test_helpers.ts`
//                                    — the leading underscore signals
//                                    "private to the tools/ dir, not a tool")
//   - a `*.test.ts` suffix          (vitest suites)
// Everything else must default-export a `ToolModule`.
const NON_TOOL_FILES = new Set(["types.ts"]);

// ---------------------------------------------------------------------------
// Registry shape (mirrors `registry/server.json` `tools[]` entries)
// ---------------------------------------------------------------------------

interface ParameterSpec {
  type: string;
  description?: string;
  enum?: unknown[];
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
        !f.startsWith("_") &&
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
 * `default` and `enum` where present. Everything else (`additionalProperties`,
 * `$schema`, nested schemas, format annotations) is dropped because the
 * external registry's parameter format does not carry them.
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
      enum?: unknown[];
    };
    const spec: ParameterSpec = {
      type: prop.type ?? "unknown",
    };
    if (prop.description !== undefined) spec.description = prop.description;
    // Forward `enum` so callers reading the registry (LLMs and humans
    // alike) see the constrained value set. Zod emits `enum` for
    // `z.enum(...)`, `z.literal(...)` unions, and similar; without
    // forwarding, the registry only advertises `type: "string"` and
    // a non-Zod consumer can't tell what values are valid.
    if (Array.isArray(prop.enum)) spec.enum = prop.enum;
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
// LobeHub plugin descriptor
// ---------------------------------------------------------------------------

/**
 * Rebuild `registry/lhm.plugin.json` from its own committed static fields
 * plus generated `version` and `tools`. The committed file is the source of
 * truth for the descriptor's static metadata (identifier, tags, endpoints…);
 * `version` comes from `metadata.json` (release-please bumps both in
 * lockstep) and `tools` is emitted from the LOBEHUB_TOOL_ALLOWLIST subset of
 * the live tool modules — full draft-7 input schemas, since LobeHub renders
 * them (unlike `server.json`'s flat parameter map).
 */
export function buildLobehubPlugin(
  committed: Record<string, unknown>,
  version: string,
  modules: LoadedModule[],
): Record<string, unknown> {
  const byName = new Map(modules.map((m) => [m.tool.name, m.tool]));
  const missing = LOBEHUB_TOOL_ALLOWLIST.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(
      `LOBEHUB_TOOL_ALLOWLIST entries with no tool file: ${missing.join(", ")}`,
    );
  }
  const tools = LOBEHUB_TOOL_ALLOWLIST.map((name) => {
    const tool = byName.get(name) as ToolModule;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7" }),
    };
  });
  return { ...committed, version, tools };
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

  // --- Guards: run in both write and --check modes ---

  // 1. Description completeness: every tool must have a non-empty description.
  assertAllToolsDescribed(modules.map((m) => m.tool));

  // 2. Allowlist parity: discovered tool names must equal MCP_TOOL_ALLOWLIST
  //    exactly. Adding or removing a tool file without updating the allowlist
  //    (or vice-versa) fails the build.
  const discoveredNames = new Set(modules.map((m) => m.tool.name));
  const allowlistNames = new Set<string>(MCP_TOOL_ALLOWLIST);
  const extra = [...discoveredNames].filter((n) => !allowlistNames.has(n));
  const missing = [...allowlistNames].filter((n) => !discoveredNames.has(n));
  if (extra.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (extra.length > 0) parts.push(`extra tool files not in allowlist: ${extra.join(", ")}`);
    if (missing.length > 0) parts.push(`allowlist entries with no tool file: ${missing.join(", ")}`);
    throw new Error(
      `MCP_TOOL_ALLOWLIST mismatch — update the allowlist in gen-registry.ts.\n  ${parts.join("\n  ")}`,
    );
  }

  const registryTools = modules.map((m) => buildTool(m.tool));

  // 3. llms-full.txt coverage: the hand-written doc must mention every tool,
  //    and any tool with a `### <name>` section must document all its params.
  const llmsFull = readFileSync(LLMS_FULL_PATH, "utf8");
  assertLlmsFullCoverage(registryTools, llmsFull);
  // Same check against the short index, which agents fetch just as readily.
  assertLlmsFullCoverage(registryTools, readFileSync(LLMS_PATH, "utf8"));

  // 3b. Pin-form: any doc sentence that advises pinning must name the form
  //     measured to work. llms-full.txt is uniformly prescriptive about the
  //     tool surface, so both rules apply; README mixes in descriptive mentions
  //     ("or you're pinning `node_ids`", about narrowing `sources`) that no
  //     regex separates from instructions, so only the unambiguous rule runs
  //     there. See pinFormProblem.
  //
  //     The bundled skills carry the SAME descriptive `sources` sentence README
  //     is exempted for, so they join at `requireStrict: false` too. Verified:
  //     all three are clean under the unambiguous rule, and each trips the
  //     strict rule on that one sentence alone.
  assertPinFormInDocs([
    { file: "llms-full.txt", text: llmsFull, requireStrict: true },
    { file: "README.md", text: readFileSync(README_PATH, "utf8"), requireStrict: false },
    ...SKILL_PATHS.map((path) => ({
      file: relative(REPO_ROOT, path),
      text: readFileSync(path, "utf8"),
      requireStrict: false,
    })),
  ]);

  // 4. ChatGPT app-submission parity: the hand-maintained submission
  //    metadata must describe exactly the tools (and annotation hints)
  //    ChatGPT receives from the default production MCP URL.
  assertChatgptSubmissionParity(
    modules.map((m) => m.tool),
    readFileSync(SUBMISSION_PATH, "utf8"),
  );

  const registry = buildRegistry(metadata, registryTools);
  const registryJson = serializeJson(registry);
  const barrel = buildBarrel(modules);
  const committedLobehub = JSON.parse(
    readFileSync(LOBEHUB_PATH, "utf8"),
  ) as Record<string, unknown>;
  const lobehubJson = serializeJson(
    buildLobehubPlugin(committedLobehub, String(metadata.version), modules),
  );

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
    if (readFileSync(LOBEHUB_PATH, "utf8") !== lobehubJson) {
      console.error(
        `[registry:check] drift: ${LOBEHUB_PATH} does not match generator output`,
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
  writeFileSync(LOBEHUB_PATH, lobehubJson);
  console.log(`wrote ${REGISTRY_PATH}`);
  console.log(`wrote ${BARREL_PATH}`);
  console.log(`wrote ${LOBEHUB_PATH}`);
  console.log(`(${modules.length} tools)`);
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
