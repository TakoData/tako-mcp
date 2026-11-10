/**
 * Fixtures the four enrichment tool tests share. Not a `.test.ts` file, so
 * vitest doesn't run it as a suite.
 */
import { z } from "zod";

import { DjangoError } from "../django.js";
import type { Env } from "../env.js";
import { djangoErrorToToolResult } from "../mcp.js";
import { TOOL_REGISTRY } from "./_registry.js";
import { CHATGPT_TOOL_NAMES, FREE_TIER_TOOL_NAMES, isToolOnSurface } from "./_surface.js";
import { parseToolsParam } from "./_tools_param.js";
import { noopSendProgress } from "./__test_helpers.js";
import type { AnyToolModule, ToolContext } from "./types.js";

export const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
export const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  surface: "generic",
  registeredTools: new Set(["tako_contents"]),
};

/** A list card as the enrichment endpoints return it. */
export const listCard = (title: string): Record<string, unknown> => ({
  card_id: "abc",
  title,
  description: `${title}.\n\n| Name |\n| --- |\n| First row |`,
  webpage_url: "https://tako.com/card/abc/",
  embed_url: "https://tako.com/embed/abc/",
  image_url: "https://tako.com/image/abc/",
  exportable: true,
  sources: [{ source_name: "People Data Labs", source_index: "data" }],
  content: { cost: 0.01, total_rows: 12 },
});

/** The text the model reads when `call` fails with a Django error. */
export async function errorTextOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (err) {
    if (err instanceof DjangoError) return djangoErrorToToolResult(err).content[0]?.text ?? "";
    throw err;
  }
  throw new Error("expected the call to fail");
}

/** The property names of a tool's published input schema. */
export function inputKeys(tool: Pick<AnyToolModule, "inputSchema">): string[] {
  const published = z.toJSONSchema(tool.inputSchema, { io: "input" }) as { properties: Record<string, unknown> };
  return Object.keys(published.properties).sort();
}

/** Where a tool is listed: named in `?tools=` on `/mcp`, and nowhere else. */
export function surfaceMembership(name: string): {
  byDefault: boolean;
  whenNamed: boolean;
  onChatgpt: boolean;
  anonymous: boolean;
} {
  const token = name.replace(/^tako_/, "");
  const known = new Set(TOOL_REGISTRY.map((tool) => tool.name));
  return {
    byDefault: isToolOnSurface(name, "generic", null),
    whenNamed: isToolOnSurface(name, "generic", parseToolsParam(`search,${token}`, known)),
    onChatgpt: CHATGPT_TOOL_NAMES.has(name) || isToolOnSurface(name, "chatgpt", parseToolsParam(token, known)),
    anonymous: FREE_TIER_TOOL_NAMES.has(name),
  };
}

export const OPT_IN_ONLY = { byDefault: false, whenNamed: true, onChatgpt: false, anonymous: false };
