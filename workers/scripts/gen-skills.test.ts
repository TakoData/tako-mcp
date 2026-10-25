import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import { readSkills, renderSkillsModule, skillMarkdownPaths } from "./gen-skills.js";

const WORKERS_DIR = path.resolve(import.meta.dirname, "..");
const SKILLS_DIR = path.resolve(WORKERS_DIR, "..", "skills");
const GENERATED_PATH = path.join(WORKERS_DIR, "src", "generated", "skills.ts");
const TOOL_NAMES = TOOL_REGISTRY.map((tool) => tool.name);

function frontmatterOf(markdown: string): string {
  const captured = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (captured === undefined) throw new Error("no YAML frontmatter fence found");
  return captured;
}

function tempSkillsDir(skills: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-skills-"));
  for (const [dirName, markdown] of Object.entries(skills)) {
    fs.mkdirSync(path.join(dir, dirName));
    fs.writeFileSync(path.join(dir, dirName, "SKILL.md"), markdown);
  }
  return dir;
}

function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: >-\n  A test skill.\n---\n\n${body}\n`;
}

describe("readSkills", () => {
  const skills = readSkills(SKILLS_DIR, TOOL_NAMES);

  it("reads one record per skill directory", () => {
    expect(skills.map((skill) => skill.name)).toEqual(["tako-agent", "tako-search"]);
    for (const skill of skills) {
      expect(skill.uri).toBe(`skill://${skill.name}/SKILL.md`);
    }
  });

  it("serves the file bytes verbatim", () => {
    for (const skill of skills) {
      const text = fs.readFileSync(path.join(SKILLS_DIR, skill.name, "SKILL.md"), "utf8");
      expect(skill.text).toBe(text);
      expect(skill.size).toBe(Buffer.byteLength(text, "utf8"));
    }
    const agent = skills.find((skill) => skill.name === "tako-agent");
    expect(agent?.size).not.toBe(agent?.text.length);
  });

  it("digests the served bytes", () => {
    for (const skill of skills) {
      expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(skill.digest).toBe(`sha256:${createHash("sha256").update(skill.text, "utf8").digest("hex")}`);
    }
  });

  it("frontmatter equals a fresh YAML parse", () => {
    for (const skill of skills) {
      expect(skill.frontmatter).toEqual(
        yaml.load(frontmatterOf(skill.text), { schema: yaml.CORE_SCHEMA }),
      );
      expect(skill.frontmatter.name).toBe(skill.name);
    }
  });

  it("derives the tools each skill names", () => {
    expect(Object.fromEntries(skills.map((skill) => [skill.name, skill.toolNames]))).toEqual({
      "tako-agent": ["tako_agent", "tako_company_agent"],
      "tako-search": ["tako_available_data", "tako_contents", "tako_graph_related", "tako_search"],
    });
  });

  it("does not match a tool name inside a longer one", () => {
    const dir = tempSkillsDir({ probe: skillMarkdown("probe", "Call `tako_search_advanced`.") });
    const [probe] = readSkills(dir, ["tako_search", "tako_search_advanced"]);
    expect(probe?.toolNames).toEqual(["tako_search_advanced"]);
  });

  it("rejects a skill that names no registered tool", () => {
    const dir = tempSkillsDir({ silent: skillMarkdown("silent", "No tools here.") });
    expect(() => readSkills(dir, TOOL_NAMES)).toThrow(/silent/);
  });

  it("rejects a frontmatter name that differs from its directory", () => {
    const dir = tempSkillsDir({ "dir-name": skillMarkdown("other-name", "Call `tako_search`.") });
    expect(() => readSkills(dir, TOOL_NAMES)).toThrow(/dir-name[\s\S]*other-name|other-name[\s\S]*dir-name/);
  });

  it("rejects a skill directory that holds files other than SKILL.md", () => {
    const dir = tempSkillsDir({ extra: skillMarkdown("extra", "Call `tako_search`.") });
    fs.mkdirSync(path.join(dir, "extra", "references"));
    fs.writeFileSync(path.join(dir, "extra", "references", "notes.md"), "notes\n");
    expect(() => readSkills(dir, TOOL_NAMES)).toThrow(/extra[\s\S]*references/);
  });

  it("the committed generated module is current", () => {
    expect(renderSkillsModule(skills)).toBe(fs.readFileSync(GENERATED_PATH, "utf8"));
  });
});

describe("skillMarkdownPaths", () => {
  it("lists every SKILL.md under the skills directory, sorted", () => {
    expect(skillMarkdownPaths(SKILLS_DIR)).toEqual([
      path.join(SKILLS_DIR, "tako-agent", "SKILL.md"),
      path.join(SKILLS_DIR, "tako-search", "SKILL.md"),
    ]);
  });
});
