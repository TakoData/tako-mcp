import { TOOL_REGISTRY } from "../src/tools/_registry.js";
import { GENERIC_DEFAULT_TOOL_NAMES } from "../src/tools/_surface.js";
import { parseToolsParam, readToolsParam } from "../src/tools/_tools_param.js";

export const PLUGIN_TOOL_NAMES: readonly string[] = [
  ...GENERIC_DEFAULT_TOOL_NAMES,
  "tako_agent",
  "tako_company_agent",
  "tako_visualize",
].sort();

const REGISTRY_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((tool) => tool.name),
);

export interface ResolvedToolUrl {
  endpoint: string;
  tokenCount: number;
  toolNames: string[];
}

export function resolveToolUrl(url: string): ResolvedToolUrl {
  const parsed = new URL(url);
  const rawTools = readToolsParam(parsed);
  const tokens = (rawTools ?? "").split(",").filter((token) => token.trim() !== "");
  return {
    endpoint: `${parsed.origin}${parsed.pathname}`,
    tokenCount: tokens.length,
    toolNames: [...(parseToolsParam(rawTools, REGISTRY_TOOL_NAMES) ?? [])].sort(),
  };
}

export const EXPECTED_PLUGIN_TOOL_URL: ResolvedToolUrl = {
  endpoint: "https://mcp.tako.com/mcp",
  tokenCount: PLUGIN_TOOL_NAMES.length,
  toolNames: [...PLUGIN_TOOL_NAMES],
};
