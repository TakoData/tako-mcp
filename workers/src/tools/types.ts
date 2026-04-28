/**
 * Tool module contract.
 *
 * Every Phase 2 tool ships as a single file under `workers/src/tools/` whose
 * default export `satisfies ToolModule<typeof inputSchema, Output>`. The
 * generated `workers/src/tools/_registry.ts` barrel lists every such file,
 * and `mcp.ts` loops it to register each tool with the MCP SDK. The same
 * scan produces `registry/server.json` — so the barrel, the registry, and
 * the runtime-registered tool list can never drift.
 *
 * Input schemas are always `z.object({...})` (the MCP SDK and JSON-Schema
 * codegen both expect an object at the tool's input root). Handlers receive
 * the parsed, typed input plus a `ToolContext` carrying the Bearer token
 * and env bindings.
 */

import type { z } from "zod";

import type { Env } from "../env.js";

/**
 * Execution context handed to every tool `handler`. Built in `mcp.ts` once
 * per request, after `extractBearer` succeeds. Tools should never touch
 * `request.headers` themselves — the token is already lifted into `token`
 * for them, and `env` is the only other thing they need to reach Django
 * via `djangoGet` / `djangoPost`.
 */
export interface ToolContext {
  /** Validated Bearer token from the incoming `Authorization` header. */
  token: string;
  /** Cloudflare Workers env bindings (`DJANGO_BASE_URL` etc.). */
  env: Env;
}

/**
 * MCP tool annotations. Shape matches the `annotations` block in
 * `registry/server.json` 1:1; the registry codegen serializes this
 * object directly.
 */
export interface ToolAnnotations {
  /** Human-readable display name shown in MCP clients. */
  title: string;
  /** Tool does not mutate server-side state. */
  readOnlyHint: boolean;
  /** Tool can delete or irrecoverably change state. */
  destructiveHint: boolean;
  /** Tool's effects are observable outside Tako (e.g. creates a public URL). */
  openWorldHint?: boolean;
}

/**
 * Extra content blocks a tool can append to its result alongside the default
 * JSON-stringified text block. Only the shapes we currently use are typed
 * here — extend as new block types are needed (audio, resource, …). Mirrors
 * the relevant subset of the MCP SDK's `ContentBlockSchema`.
 */
export type ToolContentBlock =
  | { type: "image"; data: string; mimeType: string };

/**
 * MCP Apps UI bundle attached to a tool. When a tool declares this, the
 * registry registers the bundle as an MCP resource at `uri` and threads
 * `_meta.ui.resourceUri = uri` into the tool's MCP registration. Clients
 * that support MCP Apps (claude.ai web/desktop, ChatGPT via Apps SDK, VS
 * Code Insiders, Goose) fetch the bundle, sandbox it in an iframe, and
 * forward each `tools/call` result to the widget over a JSON-RPC
 * `postMessage` bridge (`ui/notifications/tool-result`). Clients without
 * MCP Apps support ignore `_meta.ui` and the resource registration; the
 * default text + image content blocks remain a working fallback.
 *
 * The factory is called once per `McpServer` instance (one per `/mcp`
 * request) and receives the request's env, so per-environment values
 * (e.g. `frameDomains` derived from `PUBLIC_BASE_URL`) can be baked into
 * the registration without leaking env-specific strings into a static
 * declaration.
 *
 * Spec references:
 *  - MIME type and `_meta.ui.resourceUri` shape: OpenAI Apps SDK,
 *    "Build your MCP server" / MCP Apps standard.
 *  - `_meta.ui.csp.frameDomains`: required by the host sandbox so the
 *    widget can embed an `<iframe src="https://tako.com/embed/...">`.
 */
export interface AppUiResource {
  /** Unique resource URI, e.g. `"ui://tako/embed/chart"`. */
  uri: string;
  /** Stable resource name used in the SDK registration. */
  name: string;
  /** Bundled HTML (CSS+JS inline) the host loads into the sandbox iframe. */
  html: string;
  /**
   * Hosts the widget may embed as nested iframes. Required for the chart
   * embed: without this the host's CSP blocks the inner `<iframe src=
   * "https://tako.com/embed/...">`.
   */
  frameDomains?: string[];
}

/**
 * The shape every tool file default-exports.
 *
 * Typical usage:
 *
 *     const inputSchema = z.object({ q: z.string() });
 *     const tool = {
 *       name: "...",
 *       inputSchema,
 *       async handler(input, ctx) { ... }  // input is z.infer<typeof inputSchema>
 *     } satisfies ToolModule<typeof inputSchema>;
 *     export default tool;
 *
 * Using `satisfies` (instead of `: ToolModule<...>`) keeps the literal
 * inferred types — callers get autocomplete on `tool.name`, `tool.handler`
 * return type, etc.
 */
export interface ToolModule<
  InputSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  Output = unknown,
> {
  /** Wire name, e.g. `"knowledge_search"`. Must be unique across all tools. */
  name: string;
  /** Prompt-facing description — "Use this when the user asks about …". */
  description: string;
  inputSchema: InputSchema;
  outputSchema?: z.ZodType<Output>;
  annotations: ToolAnnotations;
  handler: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<Output>;
  /**
   * Optional hook to append extra MCP content blocks (image, audio, resource)
   * after the default JSON-stringified text block. Called once per
   * `tools/call`, after `handler` resolves. Tools should treat this as
   * best-effort presentation: if the hook throws or returns `[]`, the text +
   * `structuredContent` pair already provides a working response.
   *
   * Example: `open_chart_ui` uses this to inline a base64 PNG so MCP clients
   * (claude.ai etc.) render the chart without a click-to-load gate.
   *
   * Skipped when `appUiResource` is also set on the same tool — see `mcp.ts`
   * for the wiring. Rationale: combining a widget bundle with a large inline
   * image trips ChatGPT's ~150K-token response guard and silently disables
   * widget data flow, and the image is redundant when the widget renders the
   * chart interactively anyway.
   */
  extraContentBlocks?: (
    output: Output,
    ctx: ToolContext,
  ) => Promise<ToolContentBlock[]>;
  /**
   * Optional MCP Apps UI bundle. Declared as a factory so values that
   * depend on env (e.g. `frameDomains` from `PUBLIC_BASE_URL`) can be
   * baked in at registration time. See {@link AppUiResource}.
   */
  appUiResource?: (env: Env) => AppUiResource;
}

/**
 * Type-erased view of a `ToolModule` used at the registry boundary
 * (`_registry.ts` barrel, `mcp.ts` register loop). TypeScript function
 * parameters are invariant, so a specifically-typed `ToolModule<typeof
 * mySchema, MyOutput>` is NOT assignable to the default-parameterized
 * `ToolModule` — each tool's handler expects its narrow input shape and
 * won't accept the wider `unknown`.
 *
 * `AnyToolModule` erases the input/output types entirely: handlers take
 * `unknown` and return `unknown`. Runtime narrowing happens inside the SDK
 * (via the `inputSchema` we pass to `registerTool`), not at the TS boundary.
 * Tool *files* keep full types via `satisfies ToolModule<typeof
 * inputSchema, Output>`; only the barrel loses them.
 */
export interface AnyToolModule {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodType<unknown>;
  annotations: ToolAnnotations;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
  extraContentBlocks?: (
    output: unknown,
    ctx: ToolContext,
  ) => Promise<ToolContentBlock[]>;
  appUiResource?: (env: Env) => AppUiResource;
}
