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

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import {
  pinAdvisingSentences,
  pinFormProblem,
  PLURAL_UNQUALIFIED,
} from "../src/tools/_pin_form_rules.js";
import {
  FREE_TIER_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from "../src/instructions.js";
import { publishedJsonSchema } from "../src/tools/_published_schema.js";
import {
  FREE_TIER_TOOL_NAMES,
  isToolOnSurface,
  resolveToolSet,
  toolAnnotationsForSurface,
} from "../src/tools/_surface.js";
import { TOOL_NAME_PREFIX } from "../src/tools/_tools_param.js";
import type { Surface } from "../src/surface.js";
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
  "tako_agent",
  "tako_answer",
  "tako_available_data",
  "tako_contents",
  "tako_credit_balance",
  "tako_graph_related",
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
 * mention every input param inside it. A prose-only mention is enough for a
 * tool with no section of its own.
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
 * Assert that `chatgpt-app-submission.json` matches the runtime chatgpt
 * SURFACE (`https://mcp.tako.com/mcp/chatgpt`). The submission file is
 * hand-maintained (its justifications and test cases cannot be
 * generated), so this validates instead of emitting: the declared tool
 * set must equal the chatgpt surface's default tool set (the surface is
 * OAuth-only — no anonymous state exists there, spec D9), and each
 * tool's annotation hints must equal what
 * `toolAnnotationsForSurface(tool, "chatgpt")` actually serves. Without
 * this, an edit to a tool's annotations (canonical or
 * `annotationsBySurface`) would leave the submitted app metadata
 * claiming something production no longer serves.
 */
export function assertChatgptSubmissionParity(
  tools: ReadonlyArray<
    Pick<ToolModule, "name" | "annotations" | "annotationsBySurface">
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

  // The submission covers the chatgpt surface, which is FIXED (spec D2):
  // `?tools=` is ignored there, so `null` is the only allowlist that exists.
  const expected = new Map(
    tools
      .filter((t) => isToolOnSurface(t.name, "chatgpt", null))
      .map((t) => [t.name, toolAnnotationsForSurface(t, "chatgpt")]),
  );

  const problems: string[] = [];
  const declaredNames = new Set(Object.keys(declaredTools));
  for (const name of expected.keys()) {
    if (!declaredNames.has(name)) {
      problems.push(`missing tool "${name}" (on the chatgpt surface)`);
    }
  }
  for (const name of declaredNames) {
    if (!expected.has(name)) {
      problems.push(`extra tool "${name}" (not on the chatgpt surface)`);
    }
  }

  // All FOUR MCP hints: OpenAI review (2026-08-25) rejects hints "not
  // explicitly set to true or false (not null)".
  const HINT_KEYS = [
    "readOnlyHint",
    "openWorldHint",
    "destructiveHint",
    "idempotentHint",
  ] as const;
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
      )}\nEach problem line names its remediation; for annotation/tool-set drift, update chatgpt-app-submission.json to match the runtime surface (toolAnnotationsForSurface(tool, "chatgpt")).`,
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

/**
 * The surface `lhm.plugin.json`'s `cloudEndpoint` resolves to. Change the
 * endpoint's path and change this with it — the reachability guard below is
 * only as correct as this pairing.
 */
const LOBEHUB_SURFACE: Surface = "generic";
const BARREL_PATH = resolve(TOOLS_DIR, "_registry.ts");
const LLMS_FULL_PATH = resolve(REPO_ROOT, "llms-full.txt");
// The short index. Agents fetch `llms.txt` and `llms-full.txt` alike to learn
// the tool surface, but only the long one was guarded — so the two drifted:
// `llms.txt` went on saying `tako_visualize` was "already on by default for
// ChatGPT" after it became default-on for Claude too, and it named neither of
// the agent tools that shipped after it. It has no
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
const SNAPSHOT_PATH = resolve(REPO_ROOT, "chatgpt-app-snapshot.json");
const TOOLS_DOC_PATH = resolve(REPO_ROOT, "docs", "TOOLS.md");
/**
 * Hand-written distribution listings. Neither is generated, so both drifted
 * silently when four tools moved behind `?tools=` and the UA classifier was
 * deleted: `smithery.yaml` advertised all four against a bare `/mcp`, and
 * `agent.json` still claimed `tako_visualize` was "on by default for ChatGPT
 * and Claude" — true only under the classifier. Enumerated here for the
 * opt-in-disclosure guard for the same reason `SKILL_PATHS` is: close the gap
 * by enumeration rather than waiting for the next survivor.
 */
const LISTING_PATHS = [
  resolve(REPO_ROOT, "registry", "smithery.yaml"),
  resolve(REPO_ROOT, "agent.json"),
];

/**
 * Every file `registry:check` READS, repo-relative, for
 * `scripts/ci_paths.test.ts`.
 *
 * `workers-ci.yml`'s rule is that every file a guard reads must be a trigger
 * path, or an edit to that file runs no CI and the guard is silently skipped.
 * The rule failed three times while it was maintained by hand: `skills/**` and
 * `.claude-plugin/**` (a skill with unparseable frontmatter shipped),
 * `README.md`, then `chatgpt-app-snapshot.json` / `docs/TOOLS.md` /
 * `agent.json`. This list is what makes it checkable — add a read here in the
 * same commit that adds the `readFileSync`, and CI names the missing trigger
 * path instead of skipping itself.
 *
 * Outputs count as inputs: the drift comparisons at the end of `--check` read
 * the committed copy of every artifact the generator writes.
 */
export const GUARD_INPUT_PATHS: readonly string[] = [
  METADATA_PATH,
  REGISTRY_PATH,
  LOBEHUB_PATH,
  BARREL_PATH,
  SUBMISSION_PATH,
  SNAPSHOT_PATH,
  TOOLS_DOC_PATH,
  LLMS_FULL_PATH,
  LLMS_PATH,
  README_PATH,
  ...SKILL_PATHS,
  ...LISTING_PATHS,
].map((absolute) => relative(REPO_ROOT, absolute).split(sep).join("/"));

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
// docs/TOOLS.md — the tool reference, rendered from the same objects that
// serve tools/list, so a human reads exactly what the model reads.
// ---------------------------------------------------------------------------

export interface ToolsDocInput {
  modules: ReadonlyArray<ToolModule>;
  registryTools: ReadonlyArray<RegistryTool>;
  instructions: { authenticated: string; anonymous: string };
  freeTierToolNames: ReadonlySet<string>;
}

/**
 * The `?tools=` set an opt-in tool needs to be USABLE: every default tool its
 * own published text names, plus itself.
 *
 * `?tools=` replaces the default listing (spec D1), so `?tools=answer` lists
 * `tako_answer` alone — and `tako_answer`'s description tells the model to
 * "Run `tako_available_data` first when unsure the data exists" and to call
 * `tako_contents` on a cited url. A caller who installs against that URL gets
 * a model instructed to call two tools that answer the SDK's bare "tool not
 * found". `docs/TOOLS.md` states the rule ("include the defaults you rely on")
 * and the hand-written distribution listings were the files that broke it.
 *
 * DERIVED from the descriptions, not hand-listed, because that is the thing
 * that drifts: reword a description to stop naming `tako_contents` and the
 * requirement disappears on its own.
 */
function minimumToolsFor(
  tool: ToolModule,
  modules: ReadonlyArray<ToolModule>,
): ReadonlySet<string> {
  const defaults = resolveToolSet("generic", null);
  const published = [
    tool.description,
    JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" })),
  ].join(" ");
  const needed = new Set<string>([tool.name]);
  for (const other of modules) {
    if (other.name === tool.name || !defaults.has(other.name)) continue;
    if (new RegExp(`\\b${other.name}\\b`).test(published)) needed.add(other.name);
  }
  return needed;
}

/** `?tools=` token for a tool name — the `tako_` prefix is optional (spec D1). */
function toolsToken(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name;
}

const SURFACE_PATHS: ReadonlyArray<{ surface: Surface; path: string; title: string }> = [
  { surface: "generic", path: "/mcp", title: "the generic surface, every client" },
  { surface: "chatgpt", path: "/mcp/chatgpt", title: "the ChatGPT app surface, OAuth only" },
];

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderAnnotations(a: ToolAnnotations): string {
  return `title: ${a.title}; readOnlyHint: ${a.readOnlyHint}; destructiveHint: ${a.destructiveHint}; idempotentHint: ${a.idempotentHint}; openWorldHint: ${a.openWorldHint}`;
}

export function buildToolsDoc(input: ToolsDocInput): string {
  const byName = new Map(input.registryTools.map((t) => [t.name, t]));
  const modules = [...input.modules].sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  out.push(
    `<!-- GENERATED by workers/scripts/gen-registry.ts from workers/src/tools/*.ts. Do not edit; run npm run registry:gen in workers/. -->`,
    "",
    "# Tako MCP tools",
    "",
    "Rendered from the same objects that serve `tools/list`, so every schema and every line of prose below is byte-for-byte what the server publishes.",
    "",
    "## What reaches whom",
    "",
    "Publishing something is not the same as the model reading it. Three bands, and every section below carries the label of the one it belongs to.",
    "",
    "**Model-visible** — reaches the model's context. Server `instructions`, and per tool the `name`, `description`, and `inputSchema` (each property's description, default, and enum included). At call time the result's `content[].text` joins them.",
    "",
    "**Client-visible** — published on `tools/list`, then dropped by the host when it builds the model's tool catalog: `outputSchema`, `annotations`, `_meta`. Clients use them to validate structured results, label the tool in a UI, and drive widgets. The model never sees them. Claude Code hands the model `name`, `description`, and `parameters` (= `inputSchema`) only, and reads `outputSchema` for renderer validation ([claude-code#54197](https://github.com/anthropics/claude-code/issues/54197), open as of 2026-08-26); VS Code has the same gap. The spec permits this: servers MUST emit conforming `structuredContent` and clients SHOULD validate it against `outputSchema`, but nothing requires either to reach the model. Whether `structuredContent` itself reaches the model is host-dependent — Claude Code prefers `content` when a result carries both. Host-level `_meta` (security schemes, widget bindings) is client-visible and is not rendered here.",
    "",
    "**Repo-only** — never on the wire in any form. Which surfaces list a tool, whether it runs anonymously, its fixed request inputs, and the `?tools=` rules below. These describe how the server is deployed. They are written for you and sent to nobody.",
    "",
    "## Choosing tools with `?tools=` (repo-only)",
    "",
    "On `/mcp`, `?tools=` on the connection URL is an allowlist that **replaces** the default listing: `?tools=search,contents` lists exactly those two. Tokens are tool names; the `tako_` prefix is optional. Unknown tokens are dropped, and a param that names nothing recognizable yields the defaults, so a typo never breaks a connection. If you list tools, include the defaults you rely on — descriptions assume `tako_search`, `tako_available_data`, and `tako_contents` are present. `/mcp/chatgpt` ignores the param: its listing is fixed at submission.",
    "",
  );

  for (const { surface, path, title } of SURFACE_PATHS) {
    const listed = resolveToolSet(surface, null);
    out.push(`## \`${path}\` — ${title}`, "");
    out.push("Default listing (repo-only — the model sees the resulting list, not this statement):", "");
    for (const m of modules) if (listed.has(m.name)) out.push(`- \`${m.name}\``);
    const optIn = modules.filter((m) => !listed.has(m.name));
    if (surface === "generic" && optIn.length > 0) {
      out.push("", "Opt-in (name them in `?tools=`):", "");
      // Defaults + the tool, NOT the bare token. A bare `?tools=agent` is a
      // one-tool surface whose own description names `tako_search` with
      // nothing to call — the exact failure the "include the defaults you
      // rely on" warning six lines above exists to prevent, and this list is
      // the thing a reader copies.
      for (const m of optIn) {
        const value = [...modules.filter((x) => listed.has(x.name)).map((x) => x.name), m.name]
          .map(toolsToken)
          .join(",");
        out.push(`- \`${m.name}\` — \`?tools=${value}\``);
      }
    }
    out.push("", "Server instructions, authenticated (model-visible — the host injects these into the model's context):", "", "```text", input.instructions.authenticated, "```", "");
    if (surface === "generic") {
      out.push("Server instructions, anonymous (model-visible):", "", "```text", input.instructions.anonymous, "```", "");
    }
  }

  out.push("## Tools", "");
  for (const m of modules) {
    const reg = byName.get(m.name);
    if (reg === undefined) throw new Error(`buildToolsDoc: no registry entry for ${m.name}`);
    out.push(`### ${m.name}`, "");
    out.push(`**${m.annotations.title}**`, "");
    // Banded, not flat. The flat order interleaved the three audiences, and a
    // reader auditing what the model reads had to know, heading by heading,
    // which ones were even on the wire — `fixedInputs` sat directly under
    // Parameters and reads as more parameters. Bands let that reader take one
    // pass down `#### Model-visible` across every tool.
    out.push("#### Model-visible", "");
    out.push("Description:", "", m.description, "");
    out.push("Parameters:", "");
    const params = Object.entries(reg.parameters);
    if (params.length === 0) {
      out.push("_none_", "");
    } else {
      out.push("| Name | Type | Required | Default | Description |", "|---|---|---|---|---|");
      for (const [name, spec] of params) {
        const type = spec.enum ? `${spec.type} (${spec.enum.map((v) => JSON.stringify(v)).join(" \\| ")})` : spec.type;
        const def = spec.default === undefined ? "" : `\`${JSON.stringify(spec.default)}\``;
        out.push(`| \`${name}\` | ${mdCell(type)} | ${spec.required ? "yes" : "no"} | ${def} | ${mdCell(spec.description ?? "")} |`);
      }
      out.push("");
    }
    const inputSchema = publishedJsonSchema(m.inputSchema, "input");
    if (inputSchema === undefined) {
      throw new Error(`buildToolsDoc: ${m.name} has an inputSchema the SDK cannot publish`);
    }
    out.push("<details><summary>Published input schema (JSON Schema)</summary>", "", "```json",
      JSON.stringify(inputSchema, null, 2), "```", "</details>", "");

    out.push("#### Client-visible", "");
    out.push("Annotations:", "");
    for (const { surface, path } of SURFACE_PATHS) {
      out.push(`- \`${path}\`: ${renderAnnotations(toolAnnotationsForSurface(m, surface))}`);
    }
    out.push("");
    // The output schema is what `structuredContent` is validated against, and
    // it is the half of the contract no model ever reads — which is why it
    // went unrendered here for so long, and why the band label matters more
    // on this block than on any other.
    const outputSchema =
      m.outputSchema === undefined ? undefined : publishedJsonSchema(m.outputSchema, "output");
    if (outputSchema === undefined) {
      out.push(
        m.outputSchema === undefined
          ? "Published output schema: _none — this tool declares no `outputSchema`_"
          : "Published output schema: _none — the declared `outputSchema` is not an object schema, so `mcp.ts` does not advertise it_",
        "",
      );
    } else {
      out.push("<details><summary>Published output schema (JSON Schema)</summary>", "", "```json",
        JSON.stringify(outputSchema, null, 2), "```", "</details>", "");
    }

    out.push("#### Repo-only", "");
    const surfaces = SURFACE_PATHS.filter((s) => isToolOnSurface(m.name, s.surface, null)).map((s) => `\`${s.path}\``);
    out.push(`- Listed by default on: ${surfaces.length > 0 ? surfaces.join(", ") : "none (opt-in on `/mcp`)"}`);
    // Qualified with the path: anonymous connections exist only on `/mcp`.
    // `/mcp/chatgpt` is OAuth-only and 401s before admission, so an
    // unqualified "Runs anonymously: yes" reads as a claim about a surface
    // that has no anonymous tier.
    out.push(
      `- Runs anonymously (on \`/mcp\`): ${input.freeTierToolNames.has(m.name) ? "yes" : "no (answers with sign-in instructions)"}`,
      "",
    );
    // Two sections, because one heading made a false claim about half the
    // rows: the Worker's poll loop and the chart-URL render params never reach
    // a request body, and publishing them under "Fixed request inputs" sent
    // readers hunting for `width` and `poll interval` in the request. Relabeling
    // the fields did not help — this heading is emitted for every non-empty
    // `fixedInputs`, so the wrong claim just got a longer label. `scope` on
    // the row is what moves it.
    const fixed = m.fixedInputs ?? [];
    const requestRows = fixed.filter((f) => (f.scope ?? "request") === "request");
    const workerRows = fixed.filter((f) => f.scope === "worker");
    out.push("Fixed request inputs (the caller cannot change these):", "");
    if (requestRows.length === 0) out.push("_none_", "");
    else {
      for (const f of requestRows) out.push(`- \`${f.field}\` = \`${f.value}\` — ${f.note}`);
      out.push("");
    }
    if (workerRows.length > 0) {
      out.push("Fixed worker-side settings (not request fields):", "");
      for (const f of workerRows) out.push(`- \`${f.field}\` = \`${f.value}\` — ${f.note}`);
      out.push("");
    }
  }
  return out.join("\n");
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
// ChatGPT snapshot: description + input schema of every reviewed tool
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted at every depth — see the hash site below. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface ChatgptSnapshot {
  note: string;
  tools: Record<string, { description_sha256: string; input_schema_sha256: string }>;
}

const SNAPSHOT_NOTE =
  "The description and input schema of every tool on the fixed /mcp/chatgpt surface, as last ACCEPTED here. OpenAI snapshots that text at submission and does not update it live, so this file equals OpenAI's copy only after a resubmission — between submissions it is what we intend to submit next. registry:check fails on any drift. Accept a deliberate change with: npm run registry:gen -- --accept-chatgpt-snapshot";

/** The snapshot for the tools on the fixed chatgpt surface, serialized. */
export function buildChatgptSnapshot(
  tools: ReadonlyArray<Pick<ToolModule, "name" | "description" | "inputSchema">>,
): string {
  const snapshot: ChatgptSnapshot = { note: SNAPSHOT_NOTE, tools: {} };
  for (const tool of tools) {
    if (!isToolOnSurface(tool.name, "chatgpt", null)) continue;
    snapshot.tools[tool.name] = {
      description_sha256: sha256(tool.description),
      // Key-SORTED before hashing: `z.toJSONSchema` emits keys in whatever
      // order the zod version happens to build them, so hashing the raw
      // stringify makes a zod upgrade flip all five digests at once and
      // report "input_schema changed since the accepted snapshot" — a
      // resubmission order for text nobody edited. Sorting makes the digest
      // depend on the schema's content, which is what OpenAI reviewed.
      input_schema_sha256: sha256(stableStringify(z.toJSONSchema(tool.inputSchema, { io: "input" }))),
    };
  }
  return serializeJson(snapshot);
}

/**
 * Fail when a tool on the chatgpt surface no longer matches the accepted
 * snapshot. `assertChatgptSubmissionParity` guards the tool SET and the
 * annotations; this guards the two things OpenAI's snapshot also carries
 * and that check cannot see — the description and the input schema.
 */
export function assertChatgptSnapshot(
  tools: ReadonlyArray<Pick<ToolModule, "name" | "description" | "inputSchema">>,
  snapshotJson: string,
): void {
  const accepted = JSON.parse(snapshotJson) as ChatgptSnapshot;
  const live = JSON.parse(buildChatgptSnapshot(tools)) as ChatgptSnapshot;
  const problems: string[] = [];
  for (const [name, hashes] of Object.entries(live.tools)) {
    const was = accepted.tools[name];
    if (was === undefined) {
      problems.push(`tool "${name}" is on the chatgpt surface but not in the snapshot`);
      continue;
    }
    if (was.description_sha256 !== hashes.description_sha256) {
      problems.push(`tool "${name}" description changed since the accepted snapshot`);
    }
    if (was.input_schema_sha256 !== hashes.input_schema_sha256) {
      problems.push(`tool "${name}" input_schema changed since the accepted snapshot`);
    }
  }
  for (const name of Object.keys(accepted.tools)) {
    if (!(name in live.tools)) {
      problems.push(`tool "${name}" is in the snapshot but no longer on the chatgpt surface`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `chatgpt-app-snapshot.json drift — a reviewed ChatGPT tool changed:\n  ${problems.join(
        "\n  ",
      )}\nOpenAI's copy is fixed at whatever was last SUBMITTED, so a change here reaches ChatGPT users only at the next resubmission. If the change is intended, accept it: npm run registry:gen -- --accept-chatgpt-snapshot — and make sure the app is resubmitted before this text is relied on. Do NOT resubmit just to clear this check: an intermediate PR may deliberately change a reviewed tool ahead of one later submission.`,
    );
  }
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
  // Only `version` and `tools` are regenerated. EVERYTHING ELSE — including
  // `description` — is carried through from the committed file, so trimming
  // the allowlist does NOT correct prose that advertises the tool you just
  // removed. That already happened: the tools array dropped `tako_answer`
  // while the description went on saying "Answer returns grounded prose" in
  // the same sentence that names `cloudEndpoint`. Neither guard can catch it
  // — 2b reads tool names from the allowlist, 2c matches tool names in text,
  // and "Answer" is a capability word. Matching capability words means a
  // hand-written vocabulary, which is banned for the same reason the
  // row-pricing guard stops at `workers/src`. So: after changing
  // LOBEHUB_TOOL_ALLOWLIST, re-read `description` by hand.
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
  const acceptSnapshot = process.argv.includes("--accept-chatgpt-snapshot");

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

  // 2b. LobeHub reachability: the listing advertises its tools against a bare
  //     `cloudEndpoint` with no `?tools=`, so every name in it must be
  //     registered by DEFAULT on that endpoint's surface. `tako_answer` sat
  //     here after moving behind `?tools=answer`, which promised LobeHub
  //     installs a tool the server never registers — the SDK answers "tool
  //     not found" and the listing is the only thing that said otherwise.
  //     `--check` diffs the generated JSON against the committed JSON, so it
  //     cannot see this: both sides agree, and both are wrong.
  const lobehubUnreachable = LOBEHUB_TOOL_ALLOWLIST.filter(
    (name) => !isToolOnSurface(name, LOBEHUB_SURFACE, null),
  );
  if (lobehubUnreachable.length > 0) {
    throw new Error(
      `LOBEHUB_TOOL_ALLOWLIST advertises tools that ${LOBEHUB_SURFACE} does not register by default: ` +
        `${lobehubUnreachable.join(", ")}\n  ` +
        `A LobeHub install connects to lhm.plugin.json's cloudEndpoint with no \`?tools=\`, so an ` +
        `opt-in tool listed here resolves to the SDK's "tool not found". Drop it from the allowlist, ` +
        `or make it default-on for that surface.`,
    );
  }

  // 2c. Opt-in disclosure: a hand-written listing may name an opt-in tool, but
  //     it must also name the `?tools=` form that turns it on. Otherwise a
  //     reader installs against the listing's own URL and the tool is not
  //     there. The opt-in set is derived from the generic surface's default
  //     listing, so a tool moving surface fails here instead of drifting.
  //
  //     KEYED ON TOOL NAMES, so it only sees a listing that names them.
  //     `smithery.yaml` names every tool and is fully covered; `agent.json`
  //     describes capabilities in prose ("Create an embeddable Tako
  //     chart/card") and names one tool per entry. A prose claim about a
  //     default — which is what actually went stale in `agent.json`, "on by
  //     default for ChatGPT and Claude" — is NOT caught. Adding a tool name to
  //     that file brings it in scope; nothing brings the prose in scope short
  //     of generating the file.
  //
  //     `?tools=` is an allowlist of tool NAMES (spec D1), with the `tako_`
  //     prefix optional, so both forms count as disclosure.
  const genericDefaults = resolveToolSet("generic", null);
  const optInNames = modules
    .map((m) => m.tool.name)
    .filter((name) => !genericDefaults.has(name));
  const disclosureProblems: string[] = [];
  for (const listingPath of LISTING_PATHS) {
    const text = readFileSync(listingPath, "utf8");
    const where = relative(REPO_ROOT, listingPath);
    for (const name of optInNames) {
      const token = toolsToken(name);
      // Word-boundary, so a tool name does not match a longer name that
      // starts with it.
      const nameMentioned = new RegExp(`\\b${name}\\b`).test(text);
      // Every `?tools=` value in the file that names this tool.
      // Comma is NOT excluded — it separates tokens, so excluding it would
      // truncate `?tools=search,answer` to `search` and report a false gap.
      // A trailing sentence period is trimmed instead.
      const values = [...text.matchAll(/\?tools=([^\s`"')]+)/g)]
        .map((m) => (m[1] ?? "").replace(/[.,;:]+$/, ""))
        .filter((value) =>
          value.split(",").some((raw) => {
            const t = raw.trim().toLowerCase();
            return t === name || t === token;
          }),
        );
      // An entry can advertise a tool by TOKEN alone (`?tools=visualize`,
      // never spelling `tako_visualize`), so the token counts as advertising
      // it. Keying only on the full name let two agent.json entries publish a
      // one-tool URL unchecked.
      if (!nameMentioned && values.length === 0) continue;
      if (values.length === 0) {
        disclosureProblems.push(
          `${where} names ${name} without naming ?tools=${token}`,
        );
        continue;
      }
      // ADEQUACY, not mere presence, on EVERY value: each must list every
      // default tool this tool's own description names, or a reader who copies
      // that URL gets a model told to call something unregistered.
      //
      // Every value, not at-least-one. The old rule let one adequate URL vouch
      // for the whole file, so a second capability card carrying a bare
      // `?tools=answer` was never checked — and a bare token is the WORST case,
      // not a benign one: it is a one-tool connection whose lone tool names
      // absent siblings. The carve-out existed because the listings wrote the
      // token explainer as a `?tools=` string too, which the guard cannot tell
      // apart from a URL by its value. The listings now write the bare token as
      // a token (`add the \`answer\` token to the ?tools= allowlist`), so every
      // remaining `?tools=` string in a listing IS a copyable URL and there is
      // nothing left to exempt. Restore an explainer to `?tools=X` form and
      // this fails, which is the intended pressure.
      const required = minimumToolsFor(
        modules.find((m) => m.tool.name === name)!.tool,
        modules.map((m) => m.tool),
      );
      const isAdequate = (value: string): boolean => {
        const listedTokens = new Set(
          value.split(",").map((raw) => toolsToken(raw.trim().toLowerCase())),
        );
        return [...required].every((needed) => listedTokens.has(toolsToken(needed)));
      };
      const inadequate = values.filter((value) => !isAdequate(value));
      if (inadequate.length > 0) {
        const want = [...required].map(toolsToken).join(",");
        disclosureProblems.push(
          `${where} discloses ${name} via an INADEQUATE ?tools= value ` +
            `(${inadequate.join(" | ")}) — ${name}'s own description names default tools ` +
            `the value omits, so a reader who copies it gets "tool not found". ` +
            `Minimum: ?tools=${want}`,
        );
      }
    }
  }
  if (disclosureProblems.length > 0) {
    throw new Error(
      `listing drift — a distribution listing advertises an opt-in tool without its opt-in form:\n  ${disclosureProblems.join(
        "\n  ",
      )}\nAdd the \`?tools=\` form to that tool's entry, or remove the tool from the listing.`,
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

  // 4b. ChatGPT description/schema snapshot: OpenAI serves the text it
  //     reviewed, so editing a listed tool's description or input schema
  //     silently desynchronizes the app from this server until a
  //     resubmission. The parity check above cannot see either field.
  const liveSnapshot = buildChatgptSnapshot(modules.map((m) => m.tool));
  if (acceptSnapshot && !checkMode) {
    writeFileSync(SNAPSHOT_PATH, liveSnapshot);
    console.log(`wrote ${SNAPSHOT_PATH} (accepted the current chatgpt surface)`);
  } else {
    assertChatgptSnapshot(
      modules.map((m) => m.tool),
      readFileSync(SNAPSHOT_PATH, "utf8"),
    );
  }

  const registry = buildRegistry(metadata, registryTools);
  const registryJson = serializeJson(registry);
  const barrel = buildBarrel(modules);
  const committedLobehub = JSON.parse(
    readFileSync(LOBEHUB_PATH, "utf8"),
  ) as Record<string, unknown>;
  const lobehubJson = serializeJson(
    buildLobehubPlugin(committedLobehub, String(metadata.version), modules),
  );
  const toolsDoc = buildToolsDoc({
    modules: modules.map((m) => m.tool),
    registryTools,
    instructions: {
      authenticated: SERVER_INSTRUCTIONS,
      anonymous: FREE_TIER_SERVER_INSTRUCTIONS,
    },
    freeTierToolNames: FREE_TIER_TOOL_NAMES,
  });

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
    // A missing file counts as drift: the doc is generated, so its absence is
    // the same failure as a stale copy.
    const committedToolsDoc = existsSync(TOOLS_DOC_PATH)
      ? readFileSync(TOOLS_DOC_PATH, "utf8")
      : "";
    if (committedToolsDoc !== toolsDoc) {
      console.error(
        `[registry:check] drift: ${TOOLS_DOC_PATH} does not match generator output`,
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
  writeFileSync(TOOLS_DOC_PATH, toolsDoc);
  console.log(`wrote ${REGISTRY_PATH}`);
  console.log(`wrote ${BARREL_PATH}`);
  console.log(`wrote ${LOBEHUB_PATH}`);
  console.log(`wrote ${TOOLS_DOC_PATH}`);
  console.log(`(${modules.length} tools)`);
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
