/**
 * `workers-ci.yml`'s rule: every file a guard READS must be a trigger path.
 * Break it and the guard does not fail — it never runs, because the PR that
 * edits the file matches no `paths:` entry and CI skips entirely.
 *
 * The rule failed three times while it lived only in a comment:
 *
 *   1. `skills/**` and `.claude-plugin/**` were absent — a skill with
 *      unparseable YAML frontmatter shipped.
 *   2. `README.md` was absent, and it feeds two guards.
 *   3. `chatgpt-app-snapshot.json`, `docs/TOOLS.md` and `agent.json` were
 *      absent. The first is the ChatGPT drift digest, so the one edit you would
 *      most want CI to see — silencing the guard — ran nothing.
 *
 * This test is the rule as code. `GUARD_INPUT_PATHS` (exported from
 * `gen-registry.ts`) is the generator's own read-set, so a new `readFileSync`
 * there surfaces here rather than in a post-mortem.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { GUARD_INPUT_PATHS } from "./gen-registry.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "workers-ci.yml");

/**
 * Reads by the two guards that are NOT the registry generator. Hand-listed
 * because neither exports a read-set, but still CHECKED: drop one of these
 * from the workflow and this test fails.
 */
const OTHER_GUARD_INPUTS: readonly string[] = [
  "skills/tako-macroeconomics/SKILL.md", // scripts/skills.test.ts
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "version.txt",
  "gemini-extension.json", // scripts/gemini-extension.test.ts
  "commands/answer.md",
  "docs/gemini/GEMINI.md",
];

/** True when a GitHub `paths:` pattern matches a repo-relative file. */
function patternMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) {
    return file.startsWith(`${pattern.slice(0, -3)}/`);
  }
  if (pattern.includes("*")) {
    const rx = new RegExp(
      `^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`,
    );
    return rx.test(file);
  }
  return pattern === file;
}

function triggerPaths(): { push: string[]; pull_request: string[] } {
  const doc = jsYaml.load(readFileSync(WORKFLOW, "utf8")) as {
    // `on:` parses as the boolean `true` under YAML 1.1.
    true?: Record<string, { paths?: string[] }>;
    on?: Record<string, { paths?: string[] }>;
  };
  const triggers = doc.on ?? doc[true as unknown as "true"];
  return {
    push: triggers?.push?.paths ?? [],
    pull_request: triggers?.pull_request?.paths ?? [],
  };
}

describe("workers-ci trigger paths cover every guard input", () => {
  const { push, pull_request } = triggerPaths();

  it("parses both trigger lists", () => {
    // Without this the coverage checks below pass vacuously if the workflow
    // shape changes and the lists come back empty.
    expect(push.length).toBeGreaterThan(5);
    expect(pull_request.length).toBeGreaterThan(5);
  });

  it("keeps the push and pull_request lists identical", () => {
    // A file guarded on PRs but not on main (or the reverse) is the same gap
    // in one direction.
    expect([...push].sort()).toEqual([...pull_request].sort());
  });

  it("has a non-empty generator read-set", () => {
    expect(GUARD_INPUT_PATHS.length).toBeGreaterThan(5);
  });

  for (const file of [...GUARD_INPUT_PATHS, ...OTHER_GUARD_INPUTS]) {
    it(`${file} is a trigger path`, () => {
      const covering = pull_request.filter((pattern) => patternMatches(pattern, file));
      expect(
        covering,
        `${file} is read by a guard but matches no paths: entry in workers-ci.yml — ` +
          "add it, or CI will skip the PR that edits it",
      ).not.toEqual([]);
    });
  }
});
