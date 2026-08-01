/**
 * Guards on the files the Claude Code / Claude.ai plugin ships that no other
 * check covers: the bundled skills' YAML frontmatter, and the plugin
 * manifests' version pinning.
 *
 * Why this exists — a shipped regression, not a hypothetical. Every skill
 * description names its data source, and `tako-web-traffic` wrote that as
 * `(source: SimilarWeb)`. A bare `: ` inside a YAML PLAIN scalar is a mapping
 * separator, so the whole frontmatter block failed to parse, and Claude Code's
 * loader falls back to EMPTY metadata on a parse failure rather than erroring
 * — dropping `name` and `description` silently. A skill with no description is
 * a skill the model never knows to invoke: it was dead on every install from
 * the day the wording changed, with nothing in CI or at load time to say so.
 *
 * The same bug was diagnosed and fixed once before (b12e4c6, "quote skill
 * descriptions as YAML folded blocks") — but only in the README's copy-paste
 * blocks for manual claude.ai upload, never in the SKILL.md files the plugin
 * actually installs. So the failure mode is proven to recur; hence a test
 * rather than a careful wording convention.
 *
 * `>-` (folded, chomped) is the fix and the convention: a block scalar has no
 * indicator characters, so colons, quotes, and apostrophes all pass through
 * untouched, and folding a single-line body yields the identical string the
 * plain scalar was meant to produce. The frontmatter here is byte-identical to
 * the README's blocks as a result, which makes the two copies diffable.
 *
 * Runs under the `scripts` vitest project (plain node, filesystem access) —
 * `src/**` runs in workerd and cannot read files.
 */
import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/** Repo root — this file lives at `workers/scripts/`. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");

function skillDirNames(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The raw text between the opening and closing `---` fences. */
function frontmatterOf(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error("no YAML frontmatter fence found");
  }
  return captured;
}

describe("bundled plugin skills", () => {
  const names = skillDirNames();

  it("ships the three research skills", () => {
    expect(names).toEqual([
      "tako-financial-research",
      "tako-macroeconomics",
      "tako-web-traffic",
    ]);
  });

  for (const name of names) {
    describe(name, () => {
      const file = path.join(SKILLS_DIR, name, "SKILL.md");
      const markdown = fs.readFileSync(file, "utf8");

      it("has frontmatter that parses as YAML", () => {
        // The assertion that matters: a throw here is exactly the condition
        // under which Claude Code loads the skill with empty metadata.
        expect(() => yaml.load(frontmatterOf(markdown))).not.toThrow();
      });

      it("declares a name matching its directory and a non-empty description", () => {
        const parsed = yaml.load(frontmatterOf(markdown)) as Record<
          string,
          unknown
        >;
        expect(parsed.name).toBe(name);
        expect(typeof parsed.description).toBe("string");
        expect((parsed.description as string).length).toBeGreaterThan(40);
      });

      it("writes the description as a folded block scalar", () => {
        // Enforces the convention, not just the outcome: a plain scalar that
        // happens to parse today breaks the moment someone adds a colon,
        // which is precisely how this shipped broken once already.
        expect(markdown).toMatch(/^description: >-$/m);
      });
    });
  }
});

describe("plugin manifests", () => {
  const version = fs
    .readFileSync(path.join(REPO_ROOT, "version.txt"), "utf8")
    .trim();

  it("pins plugin.json to the released version", () => {
    // release-please bumps this via `extra-files`; a manual edit that skips it
    // makes `claude plugin update` a no-op for everyone already installed.
    const plugin = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { version?: string; mcpServers?: Record<string, { url?: string }> };
    expect(plugin.version).toBe(version);
  });

  it("points the plugin's MCP server at the production endpoint", () => {
    const plugin = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { mcpServers?: Record<string, { type?: string; url?: string }> };
    expect(plugin.mcpServers?.tako?.type).toBe("http");
    expect(plugin.mcpServers?.tako?.url).toBe("https://mcp.tako.com/mcp");
  });

  it("declares the plugin in the marketplace manifest", () => {
    const marketplace = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins?: Array<{ name?: string; source?: string }> };
    expect(marketplace.plugins?.map((p) => p.name)).toContain("tako");
  });
});
