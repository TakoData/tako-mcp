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
import type { Tier } from "../freetier.js";

/**
 * Calling-client kind detected from the request's User-Agent. Used by
 * tools and `mcp.ts` to gate behavior that's known to differ across
 * MCP host implementations (e.g., routing the MCP Apps chart widget
 * to ChatGPT and Claude — interactive iframe on ChatGPT, static image
 * branch on Claude, since claude.ai's host-side CSP ignores declared
 * `frameDomains` — while unknown clients fall back to an inline PNG;
 * the kickoff/wait deep-search flow on ChatGPT, whose Apps SDK doesn't
 * honor `notifications/progress` for timeout extension). Detection is
 * best-effort by UA substring match — when we can't classify,
 * `"unknown"` keeps the default (PNG) behavior.
 *
 * `"codex"` is the merged ChatGPT desktop app (its Codex runtime connects
 * as `codex-mcp-client/<version>`, one shared MCP client for desktop
 * Chat/Work threads, Codex tasks, and the headless CLI). It is the
 * ChatGPT product family for tool-surface purposes (see
 * `isChatGptFamilyClient` in `_surface.ts`) AND a widget client — its
 * widget sandbox is a custom `codex-sandbox://` scheme origin, which
 * tako.com's `frame-ancestors` admits since TakoData/tako#29218; on a
 * backend without that header the card iframe is blocked and the app
 * shows a grey tile (see `isWidgetClient` in `_surface.ts`).
 */
export type McpClientKind = "claude" | "chatgpt" | "codex" | "unknown";

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
   * For example, `tako_search` reads it in `extraMeta` to skip the
   * chart-PNG prefetch on `"chatgpt"` clients (whose widget renders
   * `embed_url` directly and never reads the baked-in image), and
   * `mcp.ts` uses it to gate which tools each host sees — the
   * `tako_agent_start` / `tako_agent_wait` pair is registered only
   * for the ChatGPT family (`isChatGptFamilyClient`: chatgpt.com and
   * the desktop app's codex runtime).
   *
   * NB: this is a server-instance-level value (set from User-Agent
   * detection at server creation), NOT a per-request flag. Don't
   * confuse it with the per-request "did this call include a
   * progressToken" signal — Claude.ai sometimes omits the token on
   * specific calls even though it generally supports progress.
   */
  client: McpClientKind;
  /**
   * Connection tier — `"free"` for anonymous (no `Authorization` header)
   * requests served on the shared free-tier account, `"authenticated"`
   * otherwise. Optional; absent means `"authenticated"` (the default for
   * tests and non-HTTP callers). Two consumers in `mcp.ts`:
   *
   * 1. SECURITY INPUT: `createMcpServer` resolves its tier as
   *    `options.tier ?? ctx.tier ?? "authenticated"`, and that resolved
   *    value drives both the tool surface and the free-tier dispatch
   *    gate — the only execution barrier keeping anonymous connections
   *    off auth-required tools. Setting `tier: "free"` here engages the
   *    gate even if the `createMcpServer` option is omitted (the two
   *    must agree when both are set; disagreement throws).
   * 2. The Django error mapping, which swaps raw billing errors for
   *    free-tier capacity copy when the SHARED account runs out of
   *    credits. (Inside a tool call, handlers see the REGISTRATION-time
   *    tier stamped over this field — see `callCtx` in `registerTool`.)
   */
  tier?: Tier;
  /**
   * Origin of the incoming request (e.g. `https://mcp.tako.com`), stamped by
   * `registerTool` from the same value that builds OAuth challenge URLs.
   *
   * Needed because some widget payloads have to reference THIS worker by
   * absolute URL — the widget runs in a sandboxed iframe whose own origin is
   * opaque, so it cannot resolve a relative path back to us. `extraMeta` uses
   * it to hand the widget the native-card proxy URL.
   *
   * `undefined` outside an HTTP context (tests, non-HTTP callers). Consumers
   * must degrade rather than assume.
   */
  origin?: string | undefined;
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
  /**
   * MCP spec: the tool may interact with an "open world" of external
   * entities; false means its domain of interaction is closed. Per the spec's
   * own example, a web search tool is open-world (true) and a memory tool is
   * closed (false). Required so every tool declares it explicitly — this is a
   * statement about the domain of interaction, NOT about externally observable
   * side effects, so `tako_visualize` (creates a public card but only from
   * caller-supplied data) is closed/false while the retrieval tools are true.
   */
  openWorldHint: boolean;
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
   * Origins the widget may load subresources (images, media) from —
   * surfaces as `_meta.ui.csp.resourceDomains`. Data URIs are always
   * allowed; this is only needed for remote `<img src>` fallbacks.
   */
  resourceDomains?: string[];
  /**
   * Origins the widget may make runtime network requests to (`fetch`,
   * XHR, WebSocket) — surfaces as `_meta.ui.csp.connectDomains` and maps to
   * the CSP `connect-src` directive.
   *
   * Distinct from {@link resourceDomains}, which covers statically loaded
   * assets (`script-src` / `style-src` / `font-src` / `img-src` /
   * `media-src`). A CDN script goes in `resourceDomains`; an API the widget
   * calls goes here. Measured on claude.ai 2026-08-01: declared
   * `connectDomains` DO appear in the enforced `connect-src`, and declared
   * `resourceDomains` DO reach `script-src` (an undeclared origin in the same
   * document was blocked with a reported violation while the declared one was
   * permitted). Only `frame-src` is hardcoded there.
   */
  connectDomains?: string[];
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
     * `pub_id` is part of the input read it from `input`; tools that
     * derive the chart pub_id from a search result (e.g.
     * `tako_search` → `output.results[0].card_id`) read it from
     * `output`. Should URL-encode any user-supplied substitution
     * variables.
     *
     * `output` may be `undefined` when the resolver is called outside
     * of a tool result (e.g. during pre-registration validation in
     * tests). That is not a special case: a resolver with no output has
     * nothing to render either, so it takes the same branch as a call
     * that produced no chart — `undefined`.
     *
     * Return `undefined` to say "this call produced nothing to render".
     * `mcp.ts` then omits the result-level `ui` keys entirely rather
     * than falling back to the static URI, so a host that decides per
     * RESULT mounts no widget at all. Hosts that read the URI from
     * `tools/list` registration `_meta` (ChatGPT, claude.ai) mount
     * regardless — for them the bundle's own empty state is what keeps
     * a chart-less call from looking broken (see `collapse()`).
     */
    resolveUriFromInput: (input: unknown, output?: unknown) => string | undefined;
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
   * Optional per-client description overrides, resolved by ANNOTATION
   * FAMILY, not raw detected kind: `claude` clients read the `claude`
   * entry; everything else — chatgpt, codex, AND `unknown` — reads the
   * `chatgpt` entry (see `annotationClientFamily` in `_surface.ts` for
   * why `unknown` resolves chatgpt: an OpenAI reviewer or crawler whose
   * UA the classifier misses must never see text that contradicts
   * `chatgpt-app-submission.json`). Falls back to {@link description}
   * when no entry exists. Use this when a tool's instructions diverge
   * meaningfully by host (e.g. claude.ai auto-renders charts inline
   * with server-side escalation while ChatGPT must redirect to the Tako
   * agent on empty results) — sending each model only the directive it
   * can act on is more reliable than asking it to self-identify and
   * filter from a single description with conditional clauses.
   *
   * The key type is the two FAMILY names, not `McpClientKind`: a
   * `codex:`/`unknown:` entry could never be resolved, so allowing the
   * keys would only create dead config that still typechecks.
   */
  descriptionByClient?: Partial<Record<"claude" | "chatgpt", string>>;
  inputSchema: InputSchema;
  outputSchema?: z.ZodType<Output>;
  annotations: ToolAnnotations;
  /**
   * Optional per-surface annotation overrides, merged over
   * {@link annotations} on the chatgpt surface (see
   * `toolAnnotationsForSurface` in `_surface.ts`). The canonical
   * `annotations` follow the MCP spec's readings; they are what the
   * generic surface and the generated registry see.
   *
   * Exists because OpenAI's ChatGPT Apps review reads `openWorldHint`
   * differently from the MCP protocol. MCP: domain of interaction (web
   * search is the spec's canonical open-world example). Apps review:
   * "does this call publish or mutate publicly visible / third-party
   * state?" Retrieval tools are therefore open-world under MCP but
   * closed-world under Apps review, and `tako_visualize` (mints public
   * chart URLs) is the reverse.
   *
   * `readOnlyHint` needs NO per-surface override — its meaning is the
   * same in both ecosystems ("does not modify its environment"), and the
   * write line is drawn once, for every surface: a call is a WRITE when
   * it creates a durable, user-addressable resource — an agent run
   * reachable later via `run_id`/`thread_id` (`tako_agent`,
   * `tako_agent_start`), a chart card with public URLs
   * (`tako_visualize`). Those tools declare canonical
   * `readOnlyHint: false`. Metering side effects do NOT flip the hint:
   * every Tako tool, including pure reads, debits a credit balance, so
   * counting billing as a write would make `readOnlyHint` vacuously
   * false everywhere.
   */
  annotationsBySurface?: { chatgpt?: Partial<ToolAnnotations> };
  handler: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<Output>;
  /**
   * Optional model-facing text renderer. When present, `mcp.ts` uses its
   * return value as the result's `content.text` INSTEAD of the
   * JSON-stringified output — e.g. markdown for prose-heavy results, which
   * reads better and costs fewer tokens than escaped JSON. Pure and
   * synchronous; a throwing renderer degrades to the JSON text.
   */
  renderText?: (output: Output, ctx: ToolContext) => string;
  /**
   * Optional `structuredContent` slimmer. When present, its return value is
   * reported as the result's `structuredContent` instead of the full output.
   * Pair it with `renderText`: hosts count `structuredContent` toward model
   * context, so once the text channel carries the full content (as markdown),
   * the structured channel must shrink to machine essentials (widget fields,
   * ids, usage) or the response pays for everything twice. The returned value
   * MUST conform to the tool's advertised `outputSchema`.
   */
  slimStructured?: (output: Output) => Record<string, unknown>;
  /**
   * Optional hook to append extra MCP content blocks (image, audio, resource)
   * after the default JSON-stringified text block. Called once per
   * `tools/call`, after `handler` resolves. Tools should treat this as
   * best-effort presentation: if the hook throws or returns `[]`, the text +
   * `structuredContent` pair already provides a working response.
   *
   * Example: `tako_search` uses this to inline a base64 PNG so MCP clients
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
   * Concrete example: `tako_search` uses this to ship a ~250 KB
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
  appUiResource?: (env: Env, requestOrigin?: string) => AppUiResource;
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
  descriptionByClient?: Partial<Record<"claude" | "chatgpt", string>>;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodType<unknown>;
  annotations: ToolAnnotations;
  /** Per-surface annotation overrides — see {@link ToolModule.annotationsBySurface}. */
  annotationsBySurface?: { chatgpt?: Partial<ToolAnnotations> };
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
  renderText?: (output: unknown, ctx: ToolContext) => string;
  slimStructured?: (output: unknown) => Record<string, unknown>;
  extraContentBlocks?: (
    output: unknown,
    ctx: ToolContext,
  ) => Promise<ToolContentBlock[]>;
  extraMeta?: (
    output: unknown,
    ctx: ToolContext,
  ) => Promise<Record<string, unknown> | undefined>;
  appUiResource?: (env: Env, requestOrigin?: string) => AppUiResource;
}
