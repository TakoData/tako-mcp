/**
 * Attribution the worker stamps on every upstream Django request so the
 * backend can record which channel, surface, tool, and end client a call
 * came from. Attribution only: Django never authorizes or bills on it.
 *
 * Wire format is an RFC 8941 Structured Field dictionary. Closed-set values
 * travel as bare tokens; the caller-controlled User-Agent travels as a quoted
 * string restricted to printable ASCII, so a hostile UA cannot forge a second
 * item or a second header line.
 */

export type AuthMode = "oauth" | "api_key" | "anonymous";

export interface CallerStamp {
  surface: string;
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
  if (stamp.clientUserAgent !== undefined && stamp.clientUserAgent.length > 0) {
    items.push(`client_ua=${quotedString(stamp.clientUserAgent, CLIENT_UA_MAX_CHARS)}`);
  }
  return items.join(", ");
}

function token(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:/-]/g, "_");
}

function quotedString(value: string, maxChars: number): string {
  const printableAscii = value.replace(/[^\x20-\x7e]/g, " ").slice(0, maxChars);
  return `"${printableAscii.replace(/(["\\])/g, "\\$1")}"`;
}
