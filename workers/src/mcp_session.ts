/**
 * MCP Apps UI resource MIME type. Hosts (claude.ai, ChatGPT Apps SDK, VS
 * Code Insiders, Goose) gate sandbox-iframe rendering on this exact value
 * — plain `text/html` resources are treated as opaque and not rendered as
 * widgets. Source: MCP Apps standard ("text/html;profile=mcp-app") and
 * the OpenAI Apps SDK "Build your MCP server" guide.
 */
export const APP_UI_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APPS_UI_EXTENSION = "io.modelcontextprotocol/ui";

const UI_SESSION_PREFIX = "ui-";
const NO_UI_SESSION_PREFIX = "noui-";

export type SessionIdKind = "ui" | "noui" | "absent" | "other";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function initializeDeclaresUi(body: unknown): boolean | undefined {
  if (!isRecord(body) || body.method !== "initialize") return undefined;
  const params = body.params;
  if (!isRecord(params) || !isRecord(params.capabilities)) return false;
  const extensions = params.capabilities.extensions;
  if (!isRecord(extensions)) return false;
  const uiExtension = extensions[MCP_APPS_UI_EXTENSION];
  if (!isRecord(uiExtension)) return false;
  const mimeTypes = uiExtension.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(APP_UI_MIME_TYPE);
}

export function mintSessionId(rendersUi: boolean): string {
  const prefix = rendersUi ? UI_SESSION_PREFIX : NO_UI_SESSION_PREFIX;
  return `${prefix}${crypto.randomUUID()}`;
}

export function sessionRendersUi(sessionId: string | null): boolean {
  return sessionId !== null && sessionId.startsWith(UI_SESSION_PREFIX);
}

export function sessionIdKind(sessionId: string | null): SessionIdKind {
  if (!sessionId) return "absent";
  if (sessionId.startsWith(UI_SESSION_PREFIX)) return "ui";
  if (sessionId.startsWith(NO_UI_SESSION_PREFIX)) return "noui";
  return "other";
}
