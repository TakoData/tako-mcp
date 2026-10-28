import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SKILLS, type GeneratedSkill } from "./generated/skills.js";
import type { Surface } from "./surface.js";
import { type InputPins, NO_PINS, type Source, soleSource } from "./tools/_input_pins.js";

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SKILL_MIME_TYPE = "text/markdown";

const SkillsListRequest = z.object({
  method: z.literal("skills/list"),
  params: z.looseObject({}).optional(),
});

const SkillsGetRequest = z.object({
  method: z.literal("skills/get"),
  params: z.looseObject({}).optional(),
});
const SkillsGetParams = z.looseObject({ uri: z.string() });

/** The skills whose every named tool is in `registered`. */
export function skillsForTools(
  registered: ReadonlySet<string>,
  skills: readonly GeneratedSkill[] = SKILLS,
): GeneratedSkill[] {
  return skills.filter((skill) => skill.toolNames.every((toolName) => registered.has(toolName)));
}

/** The skills a surface serves over MCP; `/mcp/chatgpt` serves none, because ChatGPT installs them from the plugin zip. */
const PINNED_SOURCE_NOTES: Record<Source, string> = {
  data: "> This connection is pinned to Tako data: searches and agent runs return no web results. Skip any step below that relies on web results.",
  web: "> This connection is pinned to the web: searches and agent runs return no Tako data cards. Skip any step below that relies on cards.",
};

const FRONTMATTER_CLOSE = "\n---\n";

function withNote(skill: GeneratedSkill, note: string): GeneratedSkill {
  const bodyStart = skill.text.indexOf(FRONTMATTER_CLOSE, 1) + FRONTMATTER_CLOSE.length;
  const text = `${skill.text.slice(0, bodyStart)}${note}\n\n${skill.text.slice(bodyStart)}`;
  return {
    ...skill,
    text,
    digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    size: new TextEncoder().encode(text).byteLength,
  };
}

export function skillsForSurface(
  surface: Surface,
  registered: ReadonlySet<string>,
  skills: readonly GeneratedSkill[] = SKILLS,
  pins: InputPins = NO_PINS,
): GeneratedSkill[] {
  if (surface !== "generic") return [];
  const served = skillsForTools(registered, skills);
  const only = pins.sources === undefined ? undefined : soleSource(pins.sources);
  return only === undefined ? served : served.map((skill) => withNote(skill, PINNED_SOURCE_NOTES[only]));
}

function skillEntry(skill: GeneratedSkill) {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: [{ uri: skill.uri, digest: skill.digest, size: skill.size }],
  };
}

/** Serve `skills` through the MCP Skills extension (SEP-2640); registers nothing when `skills` is empty. */
export function registerSkills(server: McpServer, skills: readonly GeneratedSkill[]): void {
  if (skills.length === 0) return;

  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } });

  for (const skill of skills) {
    server.registerResource(
      skill.name,
      skill.uri,
      { description: skill.frontmatter.description, mimeType: SKILL_MIME_TYPE },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: SKILL_MIME_TYPE, text: skill.text }] }),
    );
  }

  const entriesByUri = new Map(skills.map((skill) => [skill.uri, skillEntry(skill)]));

  server.server.setRequestHandler(SkillsListRequest, (request) => {
    if (request.params?.cursor !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, "skills/list issues no cursors");
    }
    return { resultType: "complete", skills: [...entriesByUri.values()] };
  });

  server.server.setRequestHandler(SkillsGetRequest, (request) => {
    const params = SkillsGetParams.safeParse(request.params ?? {});
    const entry = params.success ? entriesByUri.get(params.data.uri) : undefined;
    if (entry === undefined) {
      throw new McpError(ErrorCode.InvalidParams, "skills/get: unknown skill URI");
    }
    return { resultType: "complete", skill: entry };
  });
}
