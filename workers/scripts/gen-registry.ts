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
  SERVER_INSTRUCTIONS,
} from "../src/instructions.js";
import {
  FREE_TIER_TOOL_NAMES,
  isToolOnSurface,
  resolveToolSet,
  toolAnnotationsForSurface,
} from "../src/tools/_surface.js";
import { TOOL_NAME_PREFIX } from "../src/tools/_tools_param.js";
import { pickDeclared } from "../src/tools/_pick_declared.js";
import { outputSchemaForSurface, publishedOutputJsonSchema } from "../src/tools/_surface.js";
import {
  buildSearchOutput,
  takoCardSchema,
  webResultSchema,
  type Usage,
} from "../src/tools/_search_results.js";
import {
  fenceRunFor,
  renderAvailableDataMarkdown,
  renderContentsText,
  renderGraphRelatedMarkdown,
  renderSearchMarkdown,
  renderVisualizeMarkdown,
} from "../src/tools/_render_markdown.js";
import {
  contentsOutputShape,
  contentsUsage,
  projectContentsItem,
  type ContentsWireItem,
  type ProjectedContentsItem,
} from "../src/tools/_contents.js";
import { defaultMaxChars } from "../src/tools/tako_contents.js";
import { DEFAULT_HEIGHT } from "../src/tools/_chart_widget.js";
import { buildVisualizeOutput } from "../src/tools/tako_visualize.js";
import { ThinVizCard } from "../src/generated/schemas.js";
import {
  buildMatch,
  candidateRef,
  projectCandidate,
  projectMatch,
  searchToolFor,
  type OtherMatch,
} from "../src/tools/_available_data.js";
import { graphRelatedOutputShape, graphSearchOutputShape, projectRelated } from "../src/tools/_graph.js";
import type { Env } from "../src/env.js";
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
  "tako_available_data",
  "tako_contents",
  "tako_graph_related",
  "tako_search",
  "tako_search_advanced",
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
 * Assert the connect-time docs name no tool that does not exist.
 *
 * `assertLlmsFullCoverage` asks the question in ONE direction: is every
 * registered tool mentioned. It has no rule against a mention of a tool that
 * was DELETED, so `tako_answer` survived its own deletion in two places — the
 * Connecting paragraph's opt-in list and the `tako_agent` fallback sentence —
 * while coverage stayed green because the replacement tool has a section of its
 * own. A model reads these two files on connect and would have asked for a tool
 * the server cannot register.
 *
 * PAST-TENSE HISTORY IS WHY THIS IS SCOPED TO `llms*.txt` AND NOT README.
 * `README.md` legitimately says a field "was removed from `tako_answer`", which
 * is a changelog note, not an instruction. These two files are uniformly
 * prescriptive about the live surface, so any tool name in them is a claim that
 * the tool exists.
 */
export function assertNoPhantomToolsInDocs(
  knownNames: ReadonlyArray<string>,
  docs: ReadonlyArray<{ path: string; text: string }>,
): void {
  const known = new Set(knownNames);
  const problems: string[] = [];
  for (const doc of docs) {
    for (const match of doc.text.matchAll(/`(tako_[a-z0-9_]+)`/g)) {
      const name = match[1];
      if (name !== undefined && !known.has(name)) {
        problems.push(`${doc.path} names \`${name}\`, which no tool module registers`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `phantom tool in connect-time docs:\n  ${[...new Set(problems)].join(
        "\n  ",
      )}\nA model reads these files on connect. Remove the name or point it at the tool that replaced it.`,
    );
  }
}

/**
 * Assert every published parameter carries a usable type and description.
 *
 * BOTH FAILURES ARE SILENT AND BOTH ALREADY SHIPPED. `output_settings` reached
 * `registry/server.json` with `"description": ""` because a hand-written
 * `.describe(x.description ?? "")` read the OUTER `.optional()` wrapper, where
 * the generated text does not live, and the empty string then beat the
 * description `flattenParameters` would otherwise have found. Five parameters
 * reached it with `"type": "unknown"` because `z.union([T, z.null()])` emits no
 * top-level `type`. Neither shows up in a diff review of a 300-line
 * `docs/TOOLS.md` regeneration.
 *
 * This is the discovery card MCP directories and non-Zod consumers read, so an
 * untyped or undescribed parameter is invisible to exactly the audience the
 * card exists for. Fail generation instead.
 */
export function assertPublishedParametersUsable(
  tools: ReadonlyArray<{
    name: string;
    parameters: Record<string, { type?: string; description?: string }>;
  }>,
): void {
  const problems: string[] = [];
  for (const tool of tools) {
    for (const [param, spec] of Object.entries(tool.parameters)) {
      if (spec.type === undefined || spec.type === "unknown") {
        problems.push(`${tool.name}.${param} has no usable type`);
      }
      if (spec.description === undefined || spec.description.trim() === "") {
        problems.push(`${tool.name}.${param} has no description`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `published parameter drift — the registry card would advertise unusable parameters:\n  ${problems.join(
        "\n  ",
      )}\nGive the field a \`.describe()\` that reads the generated text (unwrap the optional first), or teach \`declaredType\` the shape it emits.`,
    );
  }
}

/**
 * Assert no `llms-full.txt` section advises a pin for a tool that cannot take one.
 *
 * DISTINCT FROM PIN FORM, and that distinction is the whole point. The form guard
 * below asks "is this the pin that works"; this asks "can the tool it is written
 * under accept a pin at all". A sentence passes the form guard while being wrong:
 * the `tako_available_data` section read "pin THAT metric node id alone with
 * `strict: true` … `next_call` is that follow-up prewritten (query + the metric
 * node + `strict`)" — the exact measured-correct recipe, naming `strict: true`,
 * under a tool whose `next_call` targets `tako_search`, which rejects both
 * parameters. Perfect form, unreachable target, guard silent.
 *
 * Attribution is by SECTION rather than by naming a tool in the sentence, because
 * the legitimate advice doesn't name one: llms-full's two surviving pin
 * sentences say "ask here" and rely on the `### <tool>` heading above them. A
 * name-in-sentence rule flags both, plus AGENTS.md's "search on that name, since
 * `tako_search` takes no pin" — a sentence asserting the OPPOSITE, which
 * `ADVISES_PINNING` matches anyway because it is a prose detector.
 *
 * Pin capability is derived from the tool's own published input schema, nested
 * properties included (`tako_search_advanced` carries `node_ids` inside `data`),
 * so nothing here goes stale when a tool gains or loses the parameter.
 */
export function assertPinAdviceReachableInLlmsFull(
  llmsFull: string,
  pinCapableTools: ReadonlySet<string>,
): void {
  if (pinCapableTools.size === 0) return;
  const problems: string[] = [];
  for (const part of llmsFull.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    if (pinCapableTools.has(heading)) continue;
    const body = nl === -1 ? "" : part.slice(nl + 1);
    for (const sentence of pinAdvisingSentences(body)) {
      problems.push(
        `section "### ${heading}" advises a pin, but that tool accepts no \`node_ids\`\n      "${sentence.slice(0, 160)}"`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `pin advice points at a tool that rejects it:\n  ${problems.join("\n  ")}\n` +
        `Only ${[...pinCapableTools].sort().join(", ")} accept a pin. ` +
        `Route the rest to the canonical NAME, which is what recovers cards.`,
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
      `pin-form drift — docs advise a pin form measured NOT to land the metric:\n  ${problems.join(
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

/**
 * Parameter-level changes between the committed `server.json` and this run, one
 * line per tool, sorted.
 *
 * Printed in write mode so the regen commit on an `auto/sdk-sync` PR NAMES what
 * it changed on a published tool. `tako_search_advanced` derives its schema from
 * the generated components, so a backend field reaches `tools/list` through that
 * commit and nowhere else — the spec diff shows a schema change, not which tool
 * grew a parameter.
 */
export function diffRegistryParameters(
  committed: { tools?: ReadonlyArray<{ name: string; parameters: Record<string, unknown> }> },
  generated: ReadonlyArray<{ name: string; parameters: Record<string, unknown> }>,
): string[] {
  const before = new Map(
    (committed.tools ?? []).map((t) => [t.name, new Set(Object.keys(t.parameters))]),
  );
  const lines: string[] = [];
  for (const tool of generated) {
    const prev = before.get(tool.name);
    const keys = Object.keys(tool.parameters).sort();
    if (prev === undefined) {
      lines.push(`${tool.name}: new tool (${keys.join(", ")})`);
      continue;
    }
    const added = keys.filter((k) => !prev.has(k)).map((k) => `+${k}`);
    const removed = [...prev]
      .filter((k) => !(k in tool.parameters))
      .sort()
      .map((k) => `-${k}`);
    if (added.length + removed.length > 0) {
      lines.push(`${tool.name}: ${[...added, ...removed].join(" ")}`);
    }
  }
  for (const name of before.keys()) {
    if (!generated.some((t) => t.name === name)) lines.push(`${name}: tool removed`);
  }
  return lines.sort();
}

// ---------------------------------------------------------------------------
// Prose budgets (spec D1) — enforced at generation, so an over-budget string
// cannot ship. The numbers exist because hosts CUT, not because short is
// pretty: Claude Code truncates a tool description at 2,048 chars, and every
// char of description+params is paid on every request on every host.
// ---------------------------------------------------------------------------

export const DESCRIPTION_MAX_CHARS = 1_000;
export const DESCRIPTION_MAX_LINES = 6;
// 320, raised from 200 on the pilot's review round. The per-param cap is a
// SHAPE rule, not a cost rule: what a host pays per request is
// TOOL_ENTRY_MAX_CHARS, and moving a sentence between the description and a
// param moves the entry total by zero. This cap exists to stop tool-description
// prose leaking down into a param, and 320 still forbids that while leaving
// room for the rules a model needs while it BUILDS the argument — query
// quoting syntax being the case that forced the number. Raise the entry cap,
// not this one, if the real complaint is cost.
export const PARAM_MAX_CHARS = 320;
export const TOOL_ENTRY_MAX_CHARS = 2_000; // description + every param description
export const INSTRUCTIONS_MAX_CHARS = 900;
// D1's sixth cap, wired for the first time here — it went unenforced through
// the pilot, which is how `tako_search` shipped at 4,381.
//
// 2,000, not D1's stated 1,500. That number was a policy target set without
// measuring a wide tool, and it is unreachable for one: strip EVERY field
// description from `tako_search` and its bare structure is still 1,907, 27%
// over. Ten root fields and an 11-field `cards.items` cost that much in braces
// alone, so 1,500 could only ever be met by dropping advertised fields, which
// is a D3/D4 call and not a copy edit. 2,000 leaves the narrowest migrated
// shape real headroom (`tako_contents`, 1,483 — 8 item fields plus a nested
// `rows`) and still fails `tako_search` by more than 2x, so the gate binds
// from the day it lands instead of being tuned to pass what exists.
//
// Measured on the PUBLISHED schema (`publishedOutputJsonSchema`), which is
// what `tools/list` serves: the SDK rebuilds the top level strict and emits
// draft-07, so a count off the raw zod JSON Schema would gate a string no host
// ever reads.
export const OUTPUT_SCHEMA_MAX_CHARS = 2_000;

/**
 * Shrink-only ceilings for the output schemas already over the cap, the same
 * bargain `LEGACY_PROSE_CEILINGS` strikes for prose: a listed tool may shrink
 * freely, and growing fails generation.
 *
 * Separate from that map on purpose. A tool listed there is exempt from the
 * PROSE caps because its description has not been rewritten; `tako_search` has
 * been rewritten and holds every prose cap. Only its schema is oversized, and
 * folding it into the prose ratchet would silently switch off four caps it
 * currently passes.
 *
 * 2,474 of `tako_search`'s 4,381 is field descriptions — `coverage_end` alone
 * spends 273 explaining itself against `last_updated`. That is what its fan-out
 * PR can recover without touching the shape. Delete the row when it does.
 */
export const LEGACY_OUTPUT_SCHEMA_CEILINGS: Record<string, { generic: number; chatgpt: number }> = {
  // Measured 2026-08-31, the day the gate landed.
  tako_search: { generic: 4381, chatgpt: 4704 },
  // `tako_available_data` IS migrated — description 759/5 lines, max param
  // 181, every prose cap held — and still cannot reach 2,000, because its BARE
  // structure is 2,389 with every field description deleted. Measured cost per
  // root field: matches 1,401, candidates 866, the four pair fields 890,
  // verified 300, next_call 285. Even one merged node array plus found,
  // verified, guidance and next_call is 2,188 before a word of prose.
  //
  // So the remaining 1,251 of descriptions is not what to cut — reaching the
  // cap means dropping advertised fields, which is a D3/D4 decision, not a
  // copy edit. The candidate is merging `matches` and `candidates` into one
  // node list (the evidence gradient is already legible: `coverage.items`
  // present = drilled, `coverage` alone = counted, absent = unchecked), which
  // measures ~2,770 and removes a vocabulary term. Raised, not taken, in the
  // fan-out PR: it is a shape change and the shape was signed off as two
  // fields.
  tako_available_data: { generic: 3638, chatgpt: 3638 },
};

/**
 * The ratchet for tools the redesign has not reached yet: each fan-out PR
 * rewrites one tool, deletes its row here, and the caps above take over.
 * A listed tool may SHRINK freely; growing past its recorded ceiling fails
 * generation, so legacy prose can only move toward the cap. Numbers are the
 * measured sizes when the gate landed (see the pilot PR).
 */
export const LEGACY_PROSE_CEILINGS: Record<
  string,
  { description: number; param: number; entry: number }
> = {
  // Measured 2026-08-30, the day the gate landed. Delete a row when its
  // tool's fan-out PR lands the rewrite.
  tako_agent: { description: 448, param: 489, entry: 1134 },
  // Re-baselined after #273 folded tako_answer in and exposed the whole
  // SearchRequest body — the generated param prose is a cross-repo fix
  // (the tako repo's schema builder), tracked for that tool's fan-out PR.
  tako_search_advanced: { description: 2611, param: 831, entry: 4860 },
};

export function assertProseBudget(
  // Narrowed to the fields this reads, like every sibling assert helper: the
  // gate is testable with a plain literal instead of a cast of a whole
  // ToolModule, and the signature states what it actually inspects.
  modules: ReadonlyArray<Pick<ToolModule, "name" | "description" | "outputSchema" | "outputSchemaBySurface">>,
  registryTools: ReadonlyArray<{
    name: string;
    parameters: Record<string, { description?: string }>;
  }>,
  instructions: string,
): void {
  const failures: string[] = [];
  const byName = new Map(registryTools.map((t) => [t.name, t]));
  for (const m of modules) {
    const reg = byName.get(m.name);
    const paramLens = Object.entries(reg?.parameters ?? {}).map(
      ([name, spec]) => [name, (spec.description ?? "").length] as const,
    );
    const maxParam = paramLens.reduce((a, [, len]) => Math.max(a, len), 0);
    const entry = m.description.length + paramLens.reduce((a, [, len]) => a + len, 0);
    const legacy = LEGACY_PROSE_CEILINGS[m.name];
    if (legacy !== undefined) {
      if (m.description.length > legacy.description)
        failures.push(
          `${m.name}: description grew to ${m.description.length} chars (legacy ceiling ${legacy.description}). Legacy prose only shrinks; rewrite it to the ${DESCRIPTION_MAX_CHARS}-char cap instead.`,
        );
      if (maxParam > legacy.param)
        failures.push(
          `${m.name}: a parameter description grew to ${maxParam} chars (legacy ceiling ${legacy.param}).`,
        );
      if (entry > legacy.entry)
        failures.push(`${m.name}: tool entry grew to ${entry} chars (legacy ceiling ${legacy.entry}).`);
      // A ratcheted tool is exempt from the LINE cap and the per-param cap too,
      // not just the char ceilings: legacy prose is multi-paragraph by
      // construction, and those two caps only become meaningful once the tool
      // has been rewritten. Deleting the row is what turns them on.
      continue;
    }
    if (m.description.length > DESCRIPTION_MAX_CHARS)
      failures.push(
        `${m.name}: description is ${m.description.length} chars (cap ${DESCRIPTION_MAX_CHARS}).`,
      );
    const lines = m.description.split("\n").length;
    if (lines > DESCRIPTION_MAX_LINES)
      failures.push(`${m.name}: description is ${lines} lines (cap ${DESCRIPTION_MAX_LINES}).`);
    for (const [name, len] of paramLens) {
      if (len > PARAM_MAX_CHARS)
        failures.push(`${m.name}.${name}: parameter description is ${len} chars (cap ${PARAM_MAX_CHARS}).`);
    }
    if (entry > TOOL_ENTRY_MAX_CHARS)
      failures.push(`${m.name}: tool entry is ${entry} chars (cap ${TOOL_ENTRY_MAX_CHARS}).`);
    // Per SURFACE, not once per tool: `tako_search` publishes a wider schema on
    // chatgpt (the six widget fields), and the cap is about what one host
    // receives. Sits below the legacy `continue`, so a ratcheted tool is exempt
    // here too — deleting its row is what turns this on, like the other caps.
    for (const surface of ["generic", "chatgpt"] as const) {
      const schema = outputSchemaForSurface(m, surface);
      if (schema === undefined) continue;
      const chars = JSON.stringify(publishedOutputJsonSchema(schema)).length;
      const ceiling = LEGACY_OUTPUT_SCHEMA_CEILINGS[m.name]?.[surface];
      if (ceiling !== undefined) {
        if (chars > ceiling)
          failures.push(
            `${m.name}: ${surface} outputSchema grew to ${chars} chars (legacy ceiling ${ceiling}). An oversized schema only shrinks; bring it to the ${OUTPUT_SCHEMA_MAX_CHARS}-char cap and delete the row.`,
          );
        continue;
      }
      if (chars > OUTPUT_SCHEMA_MAX_CHARS)
        failures.push(
          `${m.name}: ${surface} outputSchema is ${chars} chars (cap ${OUTPUT_SCHEMA_MAX_CHARS}).`,
        );
    }
  }
  if (instructions.length > INSTRUCTIONS_MAX_CHARS)
    failures.push(
      `instructions: ${instructions.length} chars (cap ${INSTRUCTIONS_MAX_CHARS}).`,
    );
  if (failures.length > 0) {
    throw new Error(`[prose-budget] over budget:\n  - ${failures.join("\n  - ")}`);
  }
}

// ---------------------------------------------------------------------------
// Sample results for docs/TOOLS.md (spec, "TOOLS.md output rendering"): a
// small canonical wire fixture per tool runs through the REAL pipeline —
// projection → pickDeclared → renderText — at generation time, so the samples
// can never drift from what the model sees; registry:check fails on drift.
// ---------------------------------------------------------------------------

export interface ToolSample {
  structured: Record<string, unknown>;
  text: string;
}

const SAMPLE_FIXTURE_ENV = {
  PUBLIC_BASE_URL: "https://tako.com",
  PUBLIC_API_URL: "https://tako.com",
  DJANGO_BASE_URL: "https://tako.com",
} as unknown as Env;

const SEARCH_SAMPLE_FIXTURE = resolve(HERE, "../test/fixtures/tako_search_sample.json");

function buildSearchSample(tool: ToolModule): ToolSample {
  const raw = JSON.parse(readFileSync(SEARCH_SAMPLE_FIXTURE, "utf8")) as {
    request_id: string;
    usage: Usage | null;
    cards: unknown;
    web_results: unknown;
  };
  const cards = z.array(takoCardSchema).parse(raw.cards);
  const webResults = z.array(webResultSchema).parse(raw.web_results);
  const output = buildSearchOutput(
    cards,
    webResults,
    raw.request_id,
    raw.usage,
    SAMPLE_FIXTURE_ENV,
    ["data", "web"],
    false,
    "authenticated",
    { rowCap: null, keepWebText: false },
  );
  return {
    // The generic-surface narrowing — what an `/mcp` client's model reads.
    structured: pickDeclared(
      outputSchemaForSurface(tool, "generic"),
      output as unknown as Record<string, unknown>,
    ),
    text: renderSearchMarkdown(output),
  };
}

const CONTENTS_SAMPLE_FIXTURE = resolve(HERE, "../test/fixtures/tako_contents_sample.json");

/**
 * The `tako_contents` sample: the fixture's per-url wire items through the real
 * projection and renderer. Two urls, so one sample shows a Tako card's rows, a
 * web page's text, and the batch envelope.
 *
 * `effectiveMaxChars` calls the server's own `defaultMaxChars`, not a copy of
 * the expression, so the sample cannot disagree with what a caller gets.
 */
function buildContentsSample(tool: ToolModule): ToolSample {
  const raw = JSON.parse(readFileSync(CONTENTS_SAMPLE_FIXTURE, "utf8")) as {
    urls: Array<{ url: string; item: ContentsWireItem }>;
  };
  const effectiveMaxChars = defaultMaxChars(raw.urls.length);
  const results: ProjectedContentsItem[] = raw.urls.map(({ url, item }) =>
    projectContentsItem(item, url, { effectiveMaxChars }),
  );
  const output = contentsOutputShape.parse({ results, usage: contentsUsage(results) });
  return {
    structured: pickDeclared(
      outputSchemaForSurface(tool, "generic"),
      output as unknown as Record<string, unknown>,
    ),
    text: renderContentsText(output),
  };
}

const VISUALIZE_SAMPLE_FIXTURE = resolve(HERE, "../test/fixtures/tako_visualize_sample.json");

/**
 * The `tako_visualize` sample: the fixture's create-response wire item through
 * `buildVisualizeOutput` — the one place the advertised fields are built — and
 * the same renderer the handler declares.
 */
function buildVisualizeSample(tool: ToolModule): ToolSample {
  const wire = ThinVizCard.parse(
    JSON.parse(readFileSync(VISUALIZE_SAMPLE_FIXTURE, "utf8")) as unknown,
  );
  // The handler treats a missing card_id as fatal, so this must too. A `?? ""`
  // here rendered `/embed//?dark_mode=auto` into docs/TOOLS.md instead — the
  // fixture pipeline exists so a bad hand-edit FAILS registry:check rather
  // than shipping a wrong sample.
  const cardId = wire.card_id;
  if (cardId === undefined || cardId === null || cardId === "") {
    throw new Error(
      `${VISUALIZE_SAMPLE_FIXTURE}: card_id is required — without it the sample ` +
        `renders urls with an empty path segment, and the handler rejects the ` +
        `same wire outright.`,
    );
  }
  const output = buildVisualizeOutput(wire, cardId, SAMPLE_FIXTURE_ENV, DEFAULT_HEIGHT);
  return {
    // The generic-surface narrowing — what an `/mcp` client's model reads.
    structured: pickDeclared(
      outputSchemaForSurface(tool, "generic"),
      output as unknown as Record<string, unknown>,
    ),
    text: renderVisualizeMarkdown(output),
  };
}

const AVAILABLE_DATA_SAMPLE_FIXTURE = resolve(HERE, "../test/fixtures/tako_available_data_sample.json");
const GRAPH_RELATED_SAMPLE_FIXTURE = resolve(HERE, "../test/fixtures/tako_graph_related_sample.json");

/**
 * `tako_available_data` runs a multi-call orchestration, so the fixture is the
 * WIRE pieces (one graph/search response plus the coverage drill for its top
 * result) rather than a canned output: the sample then exercises the real
 * `selectCoverage` -> `projectMatch` / `projectCandidate` -> renderer chain,
 * which is the part that drifts. Which branch the orchestrator picks is not
 * what TOOLS.md documents, so the discovery happy path stands for all of them.
 */
function buildAvailableDataSample(tool: ToolModule): ToolSample {
  const raw = JSON.parse(readFileSync(AVAILABLE_DATA_SAMPLE_FIXTURE, "utf8")) as {
    search: unknown;
    related: unknown;
    candidate_coverage: Record<string, { total: number; capped: boolean }>;
  };
  const search = z.object(graphSearchOutputShape).parse(raw.search);
  const related = z.object(graphRelatedOutputShape).parse(raw.related);
  const top = search.results[0];
  if (top === undefined) throw new Error("available_data fixture: empty search results");
  const match = buildMatch(top, related.relation);
  const candidates: OtherMatch[] = search.results.slice(1).map((n) => {
    const probe = raw.candidate_coverage[n.id];
    return probe === undefined
      ? candidateRef(n)
      : { ...candidateRef(n), coverage_total: probe.total, coverage_capped: probe.capped };
  });
  const output = {
    found: true,
    verified: "coverage" as const,
    matches: [projectMatch(match)],
    candidates: candidates.map(projectCandidate),
    // The default toolset, which is what a reader of the docs is on.
    next_call: { tool: searchToolFor(undefined) ?? "tako_search", query: `${match.name} Revenues` },
  };
  return {
    structured: pickDeclared(
      outputSchemaForSurface(tool, "generic"),
      output as unknown as Record<string, unknown>,
    ),
    text: renderAvailableDataMarkdown(output),
  };
}

function buildGraphRelatedSample(tool: ToolModule): ToolSample {
  const raw = JSON.parse(readFileSync(GRAPH_RELATED_SAMPLE_FIXTURE, "utf8"));
  const output = projectRelated(z.object(graphRelatedOutputShape).parse(raw));
  return {
    structured: pickDeclared(
      outputSchemaForSurface(tool, "generic"),
      output as unknown as Record<string, unknown>,
    ),
    text: renderGraphRelatedMarkdown(output),
  };
}

export function buildToolSamples(modules: ReadonlyArray<ToolModule>): Map<string, ToolSample> {
  const samples = new Map<string, ToolSample>();
  for (const m of modules) {
    // One builder per migrated tool; fan-out PRs add theirs here with a
    // fixture under workers/test/fixtures/.
    if (m.name === "tako_search") samples.set(m.name, buildSearchSample(m));
    if (m.name === "tako_contents") samples.set(m.name, buildContentsSample(m));
    if (m.name === "tako_visualize") samples.set(m.name, buildVisualizeSample(m));
    if (m.name === "tako_available_data") samples.set(m.name, buildAvailableDataSample(m));
    if (m.name === "tako_graph_related") samples.set(m.name, buildGraphRelatedSample(m));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// docs/TOOLS.md — the tool reference, rendered from the same objects that
// serve tools/list, so a human reads exactly what the model reads.
// ---------------------------------------------------------------------------

export interface ToolsDocInput {
  modules: ReadonlyArray<ToolModule>;
  registryTools: ReadonlyArray<RegistryTool>;
  instructions: string;
  freeTierToolNames: ReadonlySet<string>;
  /** Generated sample results (see `buildToolSamples`); tools without an
   *  entry render schemas only. */
  samples?: ReadonlyMap<string, ToolSample>;
}

/**
 * The `?tools=` set an opt-in tool needs to be USABLE: every default tool its
 * own published text names, plus itself.
 *
 * `?tools=` replaces the default listing (spec D1), so `?tools=search_advanced`
 * lists `tako_search_advanced` alone — and its description tells the model to
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
    "This page is rendered from the same objects the server publishes on `tools/list`.",
    "",
    "**What here is wire text, and what is not.** Blocks marked _wire_ — tool descriptions, parameter descriptions, annotations, server instructions, and the published input and output schemas — are byte-for-byte what a client receives. Blocks marked _illustrative_ are not: a sample result is generated by running a checked-in fixture through the real projection and renderer, so it tracks the code and `registry:check` fails when it drifts, but no call ever returned it. A live `/mcp` result also carries an inline chart PNG and `_meta` fields that the samples leave out, so do not size a payload from one. Host-level `_meta` (security schemes, widget bindings) is not shown anywhere on this page.",
    "",
    "## Choosing tools with `?tools=`",
    "",
    "On `/mcp`, `?tools=` on the connection URL is an allowlist that **replaces** the default listing: `?tools=search,contents` lists exactly those two. Tokens are tool names; the `tako_` prefix is optional. Unknown tokens are dropped, and a param that names nothing recognizable yields the defaults, so a typo never breaks a connection. If you list tools, include the defaults you rely on — descriptions assume `tako_search`, `tako_available_data`, and `tako_contents` are present, and a `tako_available_data` result hands back a `next_call` handle naming `tako_search`, so a listing without it gives the model a call it cannot run. `/mcp/chatgpt` ignores the param: its listing is fixed at submission.",
    "",
  );

  for (const { surface, path, title } of SURFACE_PATHS) {
    const listed = resolveToolSet(surface, null);
    out.push(`## \`${path}\` — ${title}`, "");
    out.push("Default listing:", "");
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
    // One string for every tier: the host loads it once at `initialize`,
    // so a per-tier variant would outlive a mid-conversation sign-in (see
    // `instructions.ts`). Anonymous connections differ only at dispatch.
    out.push("", "Server instructions:", "", "```text", input.instructions, "```", "");
  }

  out.push("## Tools", "");
  for (const m of modules) {
    const reg = byName.get(m.name);
    if (reg === undefined) throw new Error(`buildToolsDoc: no registry entry for ${m.name}`);
    out.push(`### ${m.name}`, "");
    out.push(`**${m.annotations.title}**`, "");
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
    out.push("Annotations:", "");
    for (const { surface, path } of SURFACE_PATHS) {
      out.push(`- \`${path}\`: ${renderAnnotations(toolAnnotationsForSurface(m, surface))}`);
    }
    out.push("", "<details><summary>wire — Published input schema (JSON Schema)</summary>", "", "```json",
      JSON.stringify(z.toJSONSchema(m.inputSchema, { io: "input" }), null, 2), "```", "</details>", "");

    // Result channels — the other half of what the model reads. The schema is
    // rendered exactly as tools/list advertises it (per surface when the two
    // differ), and the samples are GENERATED by running the tool's fixture
    // through the real projection + renderer, so a PR that changes either
    // shows the model-facing diff right here.
    const genericSchema = outputSchemaForSurface(m, "generic");
    const chatgptSchema = outputSchemaForSurface(m, "chatgpt");
    if (genericSchema !== undefined) {
      out.push("<details><summary>wire — Published output schema (JSON Schema)</summary>", "", "```json",
        JSON.stringify(publishedOutputJsonSchema(genericSchema), null, 2), "```", "</details>", "");
      if (chatgptSchema !== genericSchema && chatgptSchema !== undefined) {
        // A SCHEMA, not a sentence listing the extra field names. This is the
        // surface OpenAI reviews, and a reader cannot check a widget contract
        // against prose. Only one tool has a divergent surface today, so this
        // costs one extra block in the page.
        out.push(
          "<details><summary>wire — Published output schema on `/mcp/chatgpt` (JSON Schema)</summary>",
          "",
          "The chart-widget fields are declared only here; the widget reads them from `window.openai.toolOutput`, and `pickDeclared` strips them from `/mcp` responses by construction.",
          "",
          "```json",
          JSON.stringify(publishedOutputJsonSchema(chatgptSchema), null, 2),
          "```",
          "</details>",
          "",
        );
      }
    }
    const sample = input.samples?.get(m.name);
    if (sample !== undefined) {
      // The wrapper run is COMPUTED, never a literal: `renderSearchMarkdown`
      // fences web snippets with `fenceRunFor`, so a fixture snippet holding a
      // triple-backtick run makes the inner fence four backticks — which would
      // close a hardcoded ```` wrapper early and spill raw markdown into the
      // page. Same helper both sides, so they cannot disagree.
      const wrap = fenceRunFor(sample.text);
      out.push(
        "<details><summary>illustrative — Sample result (generated from the checked-in fixture)</summary>",
        "",
        "`structuredContent` (as served on `/mcp`):",
        "",
        "```json",
        JSON.stringify(sample.structured, null, 2),
        "```",
        "",
        "`content[0].text`:",
        "",
        `${wrap}markdown`,
        sample.text,
        wrap,
        "</details>",
        "",
      );
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
 * The declared type, reading THROUGH a nullable union.
 *
 * `z.union([T, z.null()])` — how `src/generated/schemas.ts` emits every
 * nullable and object-valued field — produces
 * `{"anyOf": [{"type": "..."}, {"type": "null"}]}` with NO top-level `type`.
 * Reading `prop.type` alone published `"type": "unknown"` for five
 * `tako_search_advanced` parameters, a plain string (`timezone`) and a bounded
 * integer (`include_related`) among them, on the discovery card MCP directories
 * and non-Zod consumers read.
 *
 * A union with more than one non-null branch stays "unknown" on purpose: the
 * registry format carries one type per parameter and has nowhere to put the
 * rest.
 */
export function declaredType(prop: {
  type?: string;
  anyOf?: Array<{ type?: string }>;
  oneOf?: Array<{ type?: string }>;
}): string {
  if (prop.type !== undefined) return prop.type;
  const named = (prop.anyOf ?? prop.oneOf ?? [])
    .map((branch) => branch.type)
    .filter((t): t is string => t !== undefined && t !== "null");
  const only = named.length === 1 ? named[0] : undefined;
  return only ?? "unknown";
}

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
      anyOf?: Array<{ type?: string }>;
      oneOf?: Array<{ type?: string }>;
      description?: string;
      default?: unknown;
      enum?: unknown[];
    };
    const spec: ParameterSpec = {
      type: declaredType(prop),
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
  tools: Record<
    string,
    { description_sha256: string; input_schema_sha256: string; output_schema_sha256?: string }
  >;
}

const SNAPSHOT_NOTE =
  "The description, input schema and chatgpt-surface output schema of every tool on the fixed /mcp/chatgpt surface, as last ACCEPTED here. OpenAI snapshots that text at submission and does not update it live, so this file equals OpenAI's copy only after a resubmission — between submissions it is what we intend to submit next. registry:check fails on any drift. Accept a deliberate change with: npm run registry:gen -- --accept-chatgpt-snapshot";

/** The snapshot for the tools on the fixed chatgpt surface, serialized. */
export function buildChatgptSnapshot(
  tools: ReadonlyArray<
    Pick<ToolModule, "name" | "description" | "inputSchema" | "outputSchema" | "outputSchemaBySurface">
  >,
): string {
  const snapshot: ChatgptSnapshot = { note: SNAPSHOT_NOTE, tools: {} };
  for (const tool of tools) {
    if (!isToolOnSurface(tool.name, "chatgpt", null)) continue;
    // The OUTPUT schema is surface-specific now (`outputSchemaBySurface`), so
    // without this digest the one part of the ChatGPT contract that only
    // ChatGPT reads — the six widget fields its bundle takes from
    // `window.openai.toolOutput` — could change with no snapshot diff and no
    // resubmission prompt. Hashed in its WIRE form and key-sorted, for the
    // same two reasons the input digest documents.
    const outputSchema = outputSchemaForSurface(tool, "chatgpt");
    snapshot.tools[tool.name] = {
      description_sha256: sha256(tool.description),
      // Key-SORTED before hashing: `z.toJSONSchema` emits keys in whatever
      // order the zod version happens to build them, so hashing the raw
      // stringify makes a zod upgrade flip all five digests at once and
      // report "input_schema changed since the accepted snapshot" — a
      // resubmission order for text nobody edited. Sorting makes the digest
      // depend on the schema's content, which is what OpenAI reviewed.
      input_schema_sha256: sha256(stableStringify(z.toJSONSchema(tool.inputSchema, { io: "input" }))),
      ...(outputSchema !== undefined
        ? { output_schema_sha256: sha256(stableStringify(publishedOutputJsonSchema(outputSchema))) }
        : {}),
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
  tools: ReadonlyArray<
    Pick<ToolModule, "name" | "description" | "inputSchema" | "outputSchema" | "outputSchemaBySurface">
  >,
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
    if (was.output_schema_sha256 !== hashes.output_schema_sha256) {
      problems.push(`tool "${name}" output_schema changed since the accepted snapshot`);
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
      // `io: "input"` matters and its absence was a real defect: without it zod
      // serializes with OUTPUT semantics, where a `.default()` field is always
      // present and therefore lands in `required`. LobeHub then read
      // `tako_search.sources` as mandatory while the MCP schema — which does pass
      // `io: "input"` — called it optional, so the two published descriptions of
      // the same tool disagreed. Measured: required goes from
      // ["query","sources"] to ["query"].
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }),
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

  // 2b. Every advertised parameter must carry a type and a description. Both
  //     have shipped empty before; see `assertPublishedParametersUsable`.
  assertPublishedParametersUsable(registryTools);

  // 3. llms-full.txt coverage: the hand-written doc must mention every tool,
  //    and any tool with a `### <name>` section must document all its params.
  const llmsFull = readFileSync(LLMS_FULL_PATH, "utf8");
  assertLlmsFullCoverage(registryTools, llmsFull);
  // Same check against the short index, which agents fetch just as readily.
  const llms = readFileSync(LLMS_PATH, "utf8");
  assertLlmsFullCoverage(registryTools, llms);
  // ...and the mirror question coverage cannot ask: does either file name a
  // tool that no longer exists? See `assertNoPhantomToolsInDocs`.
  assertNoPhantomToolsInDocs(
    registryTools.map((t) => t.name),
    [
      { path: "llms-full.txt", text: llmsFull },
      { path: "llms.txt", text: llms },
    ],
  );

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
  // Derived, never listed: a tool accepts a pin iff its published input schema
  // carries `node_ids` anywhere (nested counts — see the function's doc comment).
  const pinCapableTools = new Set(
    modules
      .filter((m) =>
        JSON.stringify(z.toJSONSchema(m.tool.inputSchema, { io: "input" })).includes(
          '"node_ids"',
        ),
      )
      .map((m) => m.tool.name),
  );
  assertPinAdviceReachableInLlmsFull(llmsFull, pinCapableTools);

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
  // The prose-budget gate runs in BOTH modes: an over-budget string fails
  // registry:check in CI the same way it fails a local registry:gen.
  assertProseBudget(modules.map((m) => m.tool), registryTools, SERVER_INSTRUCTIONS);
  const toolsDoc = buildToolsDoc({
    modules: modules.map((m) => m.tool),
    registryTools,
    instructions: SERVER_INSTRUCTIONS,
    freeTierToolNames: FREE_TIER_TOOL_NAMES,
    samples: buildToolSamples(modules.map((m) => m.tool)),
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

  // Read BEFORE the write: after it, the committed copy is this run's output.
  const paramDiff = diffRegistryParameters(
    existsSync(REGISTRY_PATH)
      ? (JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as { tools?: [] })
      : {},
    registryTools,
  );
  writeFileSync(REGISTRY_PATH, registryJson);
  writeFileSync(BARREL_PATH, barrel);
  writeFileSync(LOBEHUB_PATH, lobehubJson);
  writeFileSync(TOOLS_DOC_PATH, toolsDoc);
  console.log(`wrote ${REGISTRY_PATH}`);
  console.log(`wrote ${BARREL_PATH}`);
  console.log(`wrote ${LOBEHUB_PATH}`);
  console.log(`wrote ${TOOLS_DOC_PATH}`);
  for (const line of paramDiff) console.log(`[registry:gen] parameters ${line}`);
  console.log(`(${modules.length} tools)`);
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
