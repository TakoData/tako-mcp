import type { Surface } from "./surface.js";

export type AuthMode = "oauth" | "api_key" | "anonymous";

export interface CallerStamp {
  surface: Surface;
  authMode: AuthMode;
  serverVersion: string;
  tool?: string | undefined;
  clientUserAgent?: string | undefined;
}

export const CALLER_HEADER = "X-Tako-Caller";

const CLIENT_UA_MAX_CHARS = 200;

export function callerUserAgent(stamp: CallerStamp): string {
  return `tako-mcp/${stamp.serverVersion}`;
}

export function serializeCallerHeader(stamp: CallerStamp): string {
  const items = ["channel=mcp", `surface=${token(stamp.surface)}`, `tier=${stamp.authMode}`];
  if (stamp.tool !== undefined && stamp.tool.length > 0) {
    items.push(`tool=${token(stamp.tool)}`);
  }
  const clientUa = quotedClientUserAgent(stamp.clientUserAgent);
  if (clientUa !== null) {
    items.push(`client_ua=${clientUa}`);
  }
  return items.join(", ");
}

function token(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:/-]/g, "_");
}

/**
 * Quote a caller-controlled User-Agent, or `null` when it carries no
 * attribution. The cap is applied BEFORE escaping so truncation can never
 * split a `\\` pair and leave a trailing lone backslash.
 */
function quotedClientUserAgent(value: string | undefined): string | null {
  if (value === undefined) return null;
  const printableAscii = value
    .replace(/[^\x20-\x7e]/g, " ")
    .slice(0, CLIENT_UA_MAX_CHARS)
    .trim();
  if (printableAscii.length === 0) return null;
  return `"${printableAscii.replace(/(["\\])/g, "\\$1")}"`;
}
