import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { SKILLS, type GeneratedSkill } from "./generated/skills.js";
import { registerSkills, skillsForSurface, skillsForTools } from "./skills.js";
import { CHATGPT_TOOL_NAMES, GENERIC_DEFAULT_TOOL_NAMES } from "./tools/_surface.js";
import { PLUGIN_TOOL_NAMES } from "../scripts/plugin-tool-url.js";

const CLAUDE_PLUGIN_TOOLS = new Set(PLUGIN_TOOL_NAMES);
const AnyResult = z.object({}).passthrough();
const SEARCH_URI = "skill://tako-search/SKILL.md";

function skillNamed(name: string): GeneratedSkill {
  const skill = SKILLS.find((candidate) => candidate.name === name);
  if (skill === undefined) throw new Error(`no generated skill ${name}`);
  return skill;
}

function namesOf(skills: readonly GeneratedSkill[]): string[] {
  return skills.map((skill) => skill.name);
}

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connectWith(skills: readonly GeneratedSkill[]): Promise<Client> {
  const server = new McpServer(
    { name: "skills-test", version: "0.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerSkills(server, skills);
  const client = new Client(
    { name: "skills-test-client", version: "0.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

async function errorCodeOf(request: Promise<unknown>): Promise<number | undefined> {
  try {
    await request;
  } catch (error) {
    if (error instanceof McpError) return error.code;
    throw error;
  }
  return undefined;
}

describe("skillsForTools", () => {
  it("serves tako-search alone on a default /mcp connection", () => {
    expect(namesOf(skillsForTools(GENERIC_DEFAULT_TOOL_NAMES))).toEqual(["tako-search"]);
  });

  it("serves both skills on the Claude plugin tool set", () => {
    expect(namesOf(skillsForTools(CLAUDE_PLUGIN_TOOLS))).toEqual(["tako-agent", "tako-search"]);
  });

  it("serves every skill on the ChatGPT tool set, which the ChatGPT zip ships unfiltered", () => {
    expect(namesOf(skillsForTools(CHATGPT_TOOL_NAMES))).toEqual(namesOf(SKILLS));
  });

  it("serves tako-agent alone when only the agent tools are registered", () => {
    expect(namesOf(skillsForTools(new Set(["tako_agent", "tako_company_agent"])))).toEqual([
      "tako-agent",
    ]);
  });

  it("serves no skill when a connection registers only some of its tools", () => {
    expect(skillsForTools(new Set(["tako_search", "tako_contents"]))).toEqual([]);
  });
});

describe("skillsForSurface", () => {
  it("serves the generic surface the skills its registered tools cover", () => {
    expect(namesOf(skillsForSurface("generic", CLAUDE_PLUGIN_TOOLS))).toEqual(["tako-agent", "tako-search"]);
  });

  it("serves no skill on the chatgpt surface, which gets its skills from the plugin zip", () => {
    expect(skillsForSurface("chatgpt", CHATGPT_TOOL_NAMES)).toEqual([]);
  });
});

describe("registerSkills", () => {
  const search = skillNamed("tako-search");
  const searchEntry = {
    uri: search.uri,
    frontmatter: search.frontmatter,
    resources: [{ uri: search.uri, digest: search.digest, size: search.size }],
  };

  it("declares the skills extension", async () => {
    const client = await connectWith([search]);
    expect(client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/skills": {},
    });
  });

  it("skills/list returns one entry per served skill", async () => {
    const client = await connectWith([search]);
    const result = await client.request({ method: "skills/list", params: {} }, AnyResult);
    expect(result).toEqual({ resultType: "complete", skills: [searchEntry] });
  });

  it("skills/get returns the list entry", async () => {
    const client = await connectWith([search]);
    const result = await client.request(
      { method: "skills/get", params: { uri: SEARCH_URI } },
      AnyResult,
    );
    expect(result).toEqual({ resultType: "complete", skill: searchEntry });
  });

  it("skills/get rejects URIs it doesn't serve", async () => {
    const client = await connectWith([search]);
    for (const uri of ["skill://tako-agent/SKILL.md", "skill://tako-search/README.md", "not-a-uri"]) {
      expect(
        await errorCodeOf(client.request({ method: "skills/get", params: { uri } }, AnyResult)),
        uri,
      ).toBe(-32602);
    }
  });

  it("skills/list rejects a cursor", async () => {
    const client = await connectWith([search]);
    expect(
      await errorCodeOf(
        client.request({ method: "skills/list", params: { cursor: "x" } }, AnyResult),
      ),
    ).toBe(-32602);
  });

  it("resources/read returns the listed bytes", async () => {
    const client = await connectWith([search]);
    const result = await client.readResource({ uri: SEARCH_URI });
    expect(result.contents).toEqual([
      { uri: SEARCH_URI, mimeType: "text/markdown", text: search.text },
    ]);
  });

  it("an empty skill set registers nothing", async () => {
    const client = await connectWith([]);
    expect(client.getServerCapabilities()).not.toHaveProperty("extensions");
    expect(client.getServerCapabilities()).not.toHaveProperty("resources");
    expect(
      await errorCodeOf(client.request({ method: "skills/list", params: {} }, AnyResult)),
    ).toBe(-32601);
    expect(
      await errorCodeOf(
        client.request({ method: "skills/get", params: { uri: SEARCH_URI } }, AnyResult),
      ),
    ).toBe(-32601);
  });
});
