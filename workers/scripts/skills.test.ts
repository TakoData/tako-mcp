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
 * plain scalar was meant to produce. Each skill is byte-identical to the
 * README's copy of it as a result, and the parity test below is what keeps it
 * that way — the drift between those two copies IS the recurrence mechanism.
 * That test covers the BODY as well as the frontmatter, because the second
 * recurrence went through the body: see its comment.
 *
 * On the strength of the claim: the YAML-parses assertion was verified to fail
 * on the pre-fix `tako-web-traffic/SKILL.md` (js-yaml 4.1.0 throws
 * `bad indentation of a mapping entry (2:54)` on it), and the other two skills
 * parsed cleanly at that same commit. So it is a real regression test for the
 * file that broke, and a convention check for the other two — which is what the
 * `>-` assertion is there to carry.
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

// The ONE sanctioned difference between a SKILL.md and its README copy. The
// README block is step 2 of a numbered install flow, so it points back at the
// server the reader just added; the installed file has no such context and
// names the server instead. Both spellings appear exactly three times, once
// per skill. Any OTHER difference is drift, and the parity test says so.
const README_CONTEXT = "Tako MCP server installed in Step 1.";
const SKILL_CONTEXT = "Tako MCP server (server name `tako`).";

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

      it("matches the README's copy-paste block, body included", () => {
        // THE check the module docblock is actually arguing for.
        //
        // The recurrence mechanism was drift between two copies: b12e4c6 fixed
        // the frontmatter in the README's manual-upload blocks and never in the
        // SKILL.md files the plugin installs, and nothing noticed for as long
        // as it took to find the dead skill. Neither `gen-registry.ts` nor
        // `gen-schemas.ts` reads `skills/` at all, so nothing else diffs them.
        //
        // This compared FRONTMATTER ONLY until review caught what that misses.
        // The README embeds each skill whole — frontmatter and body — so a
        // routing line rewritten in SKILL.md and left stale in the README kept
        // the suite green. Not hypothetical: it is what happened one commit
        // ago, when the free-tool hedge came out of both SKILL.md files and
        // survived in `README.md` at the two lines that mirror them. Same
        // drift, same two copies, one section below where the guard reached.
        //
        // The README block is the whole file, with ONE substitution: its
        // install-flow context sentence, since the block is step 2 of a
        // numbered setup and "server name `tako`" names something the reader
        // meets two steps later. Declared as data above rather than fuzzed
        // over, so a second intentional delta cannot be introduced silently —
        // it has to be written there, where the next reader will see it.
        const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
        const start = new RegExp(`^---\\nname: ${name}\\n`, "m").exec(readme);
        expect(
          start,
          `README.md has no copy-paste block for ${name}`,
        ).not.toBeNull();
        // The block runs to the install flow's next step, which is README
        // scaffolding rather than skill content.
        const tail = readme.slice(start!.index);
        const end = /^Step 3: Ask the user to restart Claude Code$/m.exec(tail);
        expect(
          end,
          `README.md block for ${name} has no "Step 3" terminator`,
        ).not.toBeNull();
        const block = tail.slice(0, end!.index).trimEnd();
        expect(block.replaceAll(README_CONTEXT, SKILL_CONTEXT)).toBe(
          markdown.trimEnd(),
        );
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
