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
 * Calling-client kind detected from the request's User-Agent. Used by
 * tools and `mcp.ts` to gate behavior that's known to differ across
 * MCP host implementations (e.g., widget suppression on Claude.ai's
 * cropped iframe; the kickoff/wait deep-search flow on ChatGPT, whose
 * Apps SDK doesn't honor `notifications/progress` for timeout
 * extension). Detection is best-effort by UA substring match — when
 * we can't classify, `"unknown"` keeps the default behavior.
 */
export type McpClientKind = "claude" | "chatgpt" | "unknown";

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
  /**
   * Emit an MCP `notifications/progress` event for the current tool call.
   *
   * Spec'd by the MCP base protocol: when the client included a
   * `progressToken` in the request's `_meta`, we may emit zero or more
   * progress notifications carrying the same token plus a monotonically
   * increasing `progress` value, optional `total`, and optional `message`.
   * Clients that opt into `resetTimeoutOnProgress: true` (the SDK option)
   * reset their per-request tool-call timeout each time a progress event
   * arrives — so a long-running handler can stay under the per-call
   * timeout indefinitely as long as it keeps emitting progress.
   *
   * No-op when the request did not carry a progressToken (the client
   * isn't asking for progress, so we don't send any). No-op when the
   * underlying transport's `sendNotification` throws (best-effort).
   *
   * Tools that don't care about progress can simply not call this.
   */
  sendProgress: (
    progress: number,
    opts?: { total?: number; message?: string },
  ) => Promise<void>;
  /**
   * Detected client kind for the current request — see
   * {@link McpClientKind}. Tools that need to vary behavior across
   * known host quirks read this; everyone else can ignore it.
   *
   * In particular, `knowledge_search` uses it to skip the
   * fast→deep auto-escalation on `"chatgpt"` clients (whose Apps
   * SDK doesn't honor progress notifications for timeout reset),
   * routing the agent toward the `start_deep_knowledge_search` /
   * `wait_for_knowledge_search` pair instead — those tools are only
   * registered when `client === "chatgpt"` (see `mcp.ts`).
   *
   * NB: this is a server-instance-level value (set from User-Agent
   * detection at server creation), NOT a per-request flag. Don't
   * confuse it with the per-request "did this call include a
   * progressToken" signal — Claude.ai sometimes omits the token on
   * specific calls even though it generally supports progress.
   */
  client: McpClientKind;
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
  /**
   * Optional dynamic-resource variant — registered as a `ResourceTemplate`
   * (one URI per per-call substitution). Used when the widget needs to
   * have call-specific data (chart image, dimensions) baked into the HTML
   * at fetch time instead of delivered via `tool-result` postMessage.
   *
   * Why: hosts that read `documentElement.offsetHeight` once on widget
   * mount (claude.ai, per anthropics/claude-ai-mcp#69) ignore later
   * height changes. Baking the image into the resource HTML so it's
   * already in the DOM when the host snapshots gives the correct height
   * on first read.
   *
   * Tool result-side wiring (in `mcp.ts`): when this is present, the
   * per-call `_meta.ui.resourceUri` (read by claude.ai) is set to the
   * specific instance URI for the tool call, while
   * `_meta["openai/outputTemplate"]` (read by ChatGPT) stays on the
   * static `uri` so ChatGPT keeps using the iframe widget. This split
   * is intentional: ChatGPT's CSP allows the cross-origin iframe path
   * for full interactivity; Claude needs the data baked in or it can't
   * render anything.
   */
  dynamic?: {
    /** RFC 6570 URI template, e.g. `"ui://tako/embed/chart/{pub_id}"`. */
    uriPattern: string;
    /** Registration name for the template (distinct from the static `name`). */
    templateName: string;
    /**
     * Generate the full widget HTML for a specific instance. Receives the
     * parsed URI variables (e.g. `{ pub_id: "abc123" }`) and the request
     * `ToolContext` so the renderer can reach Django over `ctx.token`.
     * Failure modes (upstream fetch error, missing data) should still
     * return valid HTML — a placeholder widget that explains the error
     * is better than a 500 from the resource read.
     */
    renderHtml: (
      variables: Record<string, string | string[]>,
      ctx: ToolContext,
    ) => Promise<string>;
    /**
     * Build the resolved URI for a specific tool call. Called by
     * `mcp.ts` per `tools/call` to set `_meta.ui.resourceUri`. The
     * resolver gets both the validated `input` and the handler's
     * resolved `output`, so tools can choose the source: tools whose
     * `pub_id` is part of the input (e.g. `open_chart_ui`) read it
     * from `input`; tools that derive the chart pub_id from a search
     * result (e.g. `knowledge_search` → `output.results[0].card_id`)
     * read it from `output`. Should URL-encode any user-supplied
     * substitution variables.
     *
     * `output` may be `undefined` when the resolver is called outside
     * of a tool result (e.g. during pre-registration validation in
     * tests); resolvers should fall back to a sensible default URI in
     * that case.
     */
    resolveUriFromInput: (input: unknown, output?: unknown) => string;
  };
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
  /**
   * Prompt-facing description — "Use this when the user asks about …".
   * This is the default text every client sees in `tools/list` unless
   * overridden by {@link descriptionByClient} for that client.
   */
  description: string;
  /**
   * Optional per-client description overrides. The Worker selects the
   * entry matching the request's detected `McpClientKind` and falls
   * back to {@link description} when no entry exists. Use this when a
   * tool's instructions diverge meaningfully by host (e.g. claude.ai
   * auto-renders charts inline while ChatGPT requires chaining into
   * `open_chart_ui`) — sending each model only the directive it can
   * act on is more reliable than asking it to self-identify and
   * filter from a single description with conditional clauses.
   */
  descriptionByClient?: Partial<Record<McpClientKind, string>>;
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
   * Optional hook to attach metadata to the tool result's `_meta` field.
   * Per the MCP spec, `_meta` is metadata for hosts/widgets that's NOT
   * forwarded into the LLM's context window — distinct from `content[]`
   * and `structuredContent`. Use this for payloads the widget needs but
   * the LLM shouldn't see.
   *
   * Concrete example: `open_chart_ui` uses this to ship a ~250 KB
   * `data:image/png;base64,...` URI to the widget. Putting that in
   * `structuredContent` causes claude.ai to flag the tool result as
   * "Tool result too large for context", offload it to a file, and
   * skip widget delivery entirely. Routing the data URI through
   * `_meta` keeps it off the LLM's context budget while still reaching
   * the widget via `params._meta` in the `ui/notifications/tool-result`
   * postMessage.
   *
   * Returning `undefined` (or throwing) leaves `_meta` unset.
   */
  extraMeta?: (
    output: Output,
    ctx: ToolContext,
  ) => Promise<Record<string, unknown> | undefined>;
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
  descriptionByClient?: Partial<Record<McpClientKind, string>>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodType<unknown>;
  annotations: ToolAnnotations;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
  extraContentBlocks?: (
    output: unknown,
    ctx: ToolContext,
  ) => Promise<ToolContentBlock[]>;
  extraMeta?: (
    output: unknown,
    ctx: ToolContext,
  ) => Promise<Record<string, unknown> | undefined>;
  appUiResource?: (env: Env) => AppUiResource;
}
