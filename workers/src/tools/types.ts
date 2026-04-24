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
}
