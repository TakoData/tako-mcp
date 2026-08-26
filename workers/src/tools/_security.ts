/**
 * Per-tool security-scheme metadata + OAuth challenge helpers.
 *
 * ChatGPT's Apps SDK decides whether to show the sign-in / link-account UI
 * from two signals (developers.openai.com/apps-sdk/build/auth):
 *
 *   1. A top-level `securitySchemes` array on each tool descriptor in
 *      `tools/list` — `{ type: "noauth" }` marks anonymous use allowed,
 *      `{ type: "oauth2", scopes: [...] }` marks OAuth-linked behavior.
 *      Declaring both tells ChatGPT it can start anonymous and that
 *      linking unlocks privileged behavior; declaring only `oauth2`
 *      requires linking before the tool can run.
 *   2. A tool-call error result carrying `_meta["mcp/www_authenticate"]`
 *      (an array of RFC 6750 challenge strings with `error` and
 *      `error_description`) when a call needs authentication.
 *
 * The installed MCP SDK cannot serialize (1): `registerTool` destructures a
 * fixed key list from its config and the `tools/list` handler rebuilds each
 * descriptor from fixed fields, so unknown top-level fields are dropped
 * (verified against 1.29.0 and 1.30.0). `mcp.ts` therefore injects the
 * field into the already-buffered JSON response on the chatgpt surface via
 * {@link withToolSecuritySchemes} — a post-serialization adapter, not an
 * SDK fork.
 *
 * The leading underscore keeps this file out of the tool-module scan in
 * `gen-registry.ts` (it is NOT a `ToolModule`).
 */
import { type Tier } from "../freetier.js";
import { FREE_TIER_TOOL_NAMES } from "./_surface.js";
import type { Surface } from "../surface.js";

/** OAuth scope every Worker-issued access token carries — see `oauth/`. */
export const OAUTH_TOOL_SCOPE = "mcp";

/**
 * The two scheme shapes ChatGPT reads. `noauth` = the tool works without
 * a linked account; `oauth2` = the tool works (or works better) with one.
 */
export type SecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes: string[] };

/**
 * Connection facts the scheme derivation needs: which path surface is
 * listing, and which tier the connection actually runs at.
 */
export interface SecuritySchemeContext {
  surface: Surface;
  tier: Tier;
}

/**
 * Security schemes for a tool, scoped to the CONNECTION rather than
 * declared statically:
 *
 * - `noauth` + `oauth2` — only on an ANONYMOUS (`tier: "free"`) listing
 *   on the GENERIC surface (the only surface that serves the free tier —
 *   /mcp/chatgpt 401s anonymous requests before any listing exists), and
 *   only for tools anonymous connections may EXECUTE
 *   (`FREE_TIER_TOOL_NAMES`). Deriving from the same set that gates
 *   execution keeps the advertised schemes and the enforced behavior
 *   from drifting.
 * - `oauth2` only — everything else: auth-required tools and
 *   authenticated connections (the caller is already linked; advertising
 *   `noauth` there could invite a host to route a linked user's calls
 *   onto the shared free-tier account).
 *
 * The free-tier kill switch (`wrangler secret delete FREE_TIER_API_KEY`)
 * stays complete for free: without the bindings, anonymous requests 401
 * before any listing exists, so `tier: "free"` — and with it `noauth` —
 * can never be served. Metadata is never what AUTHORIZES a call; the
 * server-side tier/token checks are.
 */
export function securitySchemesForTool(
  name: string,
  ctx: SecuritySchemeContext,
): SecurityScheme[] {
  const oauth2: SecurityScheme = {
    type: "oauth2",
    scopes: [OAUTH_TOOL_SCOPE],
  };
  return ctx.surface === "generic" &&
    ctx.tier === "free" &&
    FREE_TIER_TOOL_NAMES.has(name)
    ? [{ type: "noauth" }, oauth2]
    : [oauth2];
}

/**
 * Build the RFC 6750 / RFC 9728 `WWW-Authenticate: Bearer` challenge value.
 * Carries `resource_metadata` when the request origin is known (so an MCP
 * host can bootstrap OAuth from a bare 401) and `scope`; `error` /
 * `error_description` are added when known. Shared by the HTTP 401/403
 * responses in `mcp.ts` and the tool-level `_meta["mcp/www_authenticate"]`
 * challenges below — one formatter, one wire format.
 */
/**
 * Make a value safe to embed in a quoted-string challenge parameter:
 * double quotes become single quotes (readable, can't close the quoted
 * string), and backslash/CR/LF/control characters become spaces — a
 * trailing `\` would consume the closing quote as an RFC 7230
 * quoted-pair, and CR/LF would make the `Headers` constructor throw when
 * the same string is used as a real HTTP header value. Every current
 * caller passes literals, but the formatter is shared across the HTTP
 * 401/403 headers and tool-level `_meta` challenges, so it must stay
 * safe for future dynamic inputs.
 */
function quotedStringSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/"/g, "'").replace(/[\\\r\n\x00-\x1f\x7f]/g, " ");
}

export function wwwAuthenticate(
  origin: string | undefined,
  error?: string,
  errorDescription?: string,
): string {
  const parts: string[] = [];
  if (origin !== undefined) {
    parts.push(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
  }
  parts.push(`scope="${OAUTH_TOOL_SCOPE}"`);
  if (error !== undefined) parts.unshift(`error="${quotedStringSafe(error)}"`);
  if (errorDescription !== undefined) {
    parts.push(`error_description="${quotedStringSafe(errorDescription)}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

/**
 * Tool result returned when an anonymous (free-tier) call reaches a tool
 * that requires a linked account. Per the OpenAI Apps SDK auth guide, the
 * `_meta["mcp/www_authenticate"]` challenge (with both `error` and
 * `error_description`) is what triggers ChatGPT's sign-in UI; the text
 * content is the fallback every other client shows the model.
 *
 * `error="insufficient_scope"` mirrors OpenAI's own login example — the
 * anonymous grant lacks the access this tool needs.
 */
export function authRequiredToolResult(
  origin: string | undefined,
  recoveryHint?: string,
  /**
   * Replaces the default lead sentence.
   *
   * The default asserts THE TOOL needs an account. That is false when a FREE
   * tool refuses one INPUT: an anonymous `tako_search` runs fine, it just
   * cannot inline billed rows, so leading with "this tool requires a Tako
   * account" tells the model the opposite of what happened and invites it to
   * abandon a call that would succeed without `include_contents`. Google
   * style: what happened, then why, then what to do — the caller that knows
   * the real what-happened passes it here.
   */
  lead?: string,
): {
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
  isError: true;
} {
  const base =
    lead ??
    "This tool requires a Tako account. Sign in with Tako, or connect with a Tako API key, to continue.";
  return {
    content: [
      {
        type: "text",
        // Both remedies, because this text reaches every client (the
        // pre-dispatch gate in `mcp.ts` answers anonymous calls to gated
        // tools on the generic surface): hosts with a linking UI
        // (OAuth-capable clients like claude.ai and Claude Code) sign
        // in, config-file clients (Cursor et al.) connect with an API
        // key. "Sign in" alone told a config-file user to do something
        // their host has no flow for. `recoveryHint` (the
        // GENERIC_SIGN_IN_HINT in mcp.ts, or a tool's own rejection
        // reason) appends after the base text.
        text: recoveryHint === undefined ? base : `${base} ${recoveryHint}`,
      },
    ],
    _meta: {
      "mcp/www_authenticate": [
        wwwAuthenticate(
          origin,
          "insufficient_scope",
          "You need to sign in with Tako to use this tool",
        ),
      ],
      "tako/error": { kind: "auth_required" },
    },
    isError: true,
  };
}

/**
 * Pure transform: add a top-level `securitySchemes` to every tool
 * descriptor in a (possibly batched) JSON-RPC `tools/list` response body,
 * resolved for the given connection context. Returns the ORIGINAL
 * reference when nothing matched, so callers can cheaply skip
 * re-serialization. Never mutates its input.
 */
export function withToolSecuritySchemes(
  body: unknown,
  ctx: SecuritySchemeContext,
): unknown {
  if (Array.isArray(body)) {
    let changed = false;
    const mapped = body.map((message) => {
      const next = withToolSecuritySchemes(message, ctx);
      if (next !== message) changed = true;
      return next;
    });
    return changed ? mapped : body;
  }
  if (typeof body !== "object" || body === null) return body;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return body;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return body;
  let changedTool = false;
  const nextTools = tools.map((tool) => {
    if (typeof tool !== "object" || tool === null) return tool;
    const name = (tool as { name?: unknown }).name;
    if (typeof name !== "string") return tool;
    changedTool = true;
    return {
      ...(tool as Record<string, unknown>),
      securitySchemes: securitySchemesForTool(name, ctx),
    };
  });
  // An empty (or all-malformed) tools array gains nothing — keep the
  // original reference so callers skip the re-serialization.
  if (!changedTool) return body;
  return {
    ...(body as Record<string, unknown>),
    result: { ...(result as Record<string, unknown>), tools: nextTools },
  };
}
