import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// No `.js` suffix — the SDK's package.json `exports` map only exposes
// `./validation/cfworker`, unlike the other server subpaths which do ship
// `.js` entries. Adding the extension here breaks module resolution.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  BearerAuthError,
  bearerAuthErrorToJsonRpc,
  extractBearer,
} from "./auth.js";
import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  DjangoNotFoundError,
  DjangoResponseParseError,
  DjangoTimeoutError,
  DjangoUnauthorizedError,
  extractErrorDetail,
} from "./django.js";
import type { Env } from "./env.js";
import {
  checkFreeTierRateLimit,
  FREE_TIER_TOOL_NAMES,
  type FreeTierConfig,
  freeTierBatchResponse,
  freeTierCreditsToolResult,
  freeTierGlobalLimitResponse,
  freeTierLimitResponse,
  freeTierTooLargeResponse,
  resolveFreeTierConfig,
  type Tier,
} from "./freetier.js";
import { tryResolveOAuthAccessToken } from "./oauth/access.js";
import { parseEnabledOptionalToolNames } from "./tools/_optional.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import {
  authRequiredToolResult,
  securitySchemesForTool,
  withToolSecuritySchemes,
  wwwAuthenticate,
} from "./tools/_security.js";
import {
  isToolOnSurface,
  toolAnnotationsForClient,
} from "./tools/_surface.js";
import type {
  AnyToolModule,
  McpClientKind,
  ToolContext,
} from "./tools/types.js";

/**
 * Server identity. `registry/server.json` is the canonical source — versions are
 * managed by release-please (see release-please-config.json extra-files); do not hand-edit.
 * Clients compare what they read from the registry against what `initialize`
 * returns, so a mismatch surfaces as "wrong server" in tooling.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.14.0"; // x-release-please-version

/**
 * Server-level usage guidance, returned as the MCP `instructions` field on
 * the `initialize` result. Claude hosts (claude.ai, Claude Desktop, Claude
 * Code) inject this into the system prompt as "MCP Server Instructions" —
 * far stronger placement than a tool description buried in the tool list,
 * and the reason models otherwise default to their built-in web search
 * even with Tako connected.
 *
 * Tone is deliberate: steer data/metric questions to `tako_search` and
 * position it as a capable web-search substitute, WITHOUT banning the
 * host's built-in search — over-broad claims erode the model's trust in
 * the whole tool surface and misroute queries Tako can't serve.
 */
export const SERVER_INSTRUCTIONS = [
  "Tako is a live-data search engine returning structured, citation-backed results with inline charts.",
  "",
  "For questions involving data or metrics — finance, markets, company KPIs, economics, website/app traffic, sports, weather, elections, polls, prediction markets, demographics, energy, real estate, health — check `tako_search` before reaching for a generic web search tool: it returns live, chartable, citation-backed data a web search cannot.",
  "",
  '`tako_search` also searches the live web alongside the proprietary data graph (default sources are data + web), so one call can stand in for a separate web search on questions that mix data with context. A built-in web search tool remains the right choice when the query is clearly outside Tako\'s coverage or Tako returned nothing relevant.',
  "",
  "If unsure whether Tako has the data, `tako_available_data` is free and confirms coverage plus the exact metric names to query.",
].join("\n");

/**
 * MCP Apps UI resource MIME type. Hosts (claude.ai, ChatGPT Apps SDK, VS
 * Code Insiders, Goose) gate sandbox-iframe rendering on this exact value
 * — plain `text/html` resources are treated as opaque and not rendered as
 * widgets. Source: MCP Apps standard ("text/html;profile=mcp-app") and
 * the OpenAI Apps SDK "Build your MCP server" guide.
 */
const APP_UI_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The CfWorker schema validator is stateless (it compiles a schema on each
 * `validate` call), so one module-scope instance is reused across warm
 * invocations rather than allocating a fresh one per `/mcp` POST.
 *
 * Default Ajv validator uses `new Function(...)` under the hood and breaks
 * in the Workers runtime (no eval). The @cfworker/json-schema provider ships
 * with the SDK exactly for this case.
 */
const JSON_SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator();

/**
 * Build a fresh `McpServer` with tako-mcp identity and register every tool
 * in `TOOL_REGISTRY` against it. Each handler closes over the per-request
 * `ToolContext` so tools see the right Bearer token + env bindings without
 * having to reach for request state themselves.
 */
/**
 * Detect the calling MCP client from the HTTP `User-Agent` header.
 *
 * Used to gate per-client behavior that we'd otherwise have to ask the
 * LLM to figure out from prose — specifically, routing the chart to
 * the MCP Apps widget for ChatGPT and Claude (the two hosts that render
 * it inline — ChatGPT via the interactive iframe branch, Claude via the
 * image branch, since claude.ai's host-side CSP ignores declared
 * `frameDomains` and the widget's runtime `window.openai` check falls
 * back to the static image there) while unknown clients fall back to
 * the inline PNG `image` content block, and routing ChatGPT through
 * the agent split pair (its Apps SDK doesn't reset tool-call timeouts
 * on progress notifications).
 *
 * The match is intentionally loose: we don't care about exact UA
 * strings, just whether the request smells like one of the major
 * MCP-app hosts. Unknown UAs fall through to the inline-PNG `image`
 * content block, not the widget — that path is the portable fallback
 * that works on the long tail of MCP hosts that don't (yet) implement
 * MCP Apps, so an unrecognized client still gets a chart it can render.
 */
// `McpClientKind` is defined in `tools/types.ts` (re-exported below)
// so tool modules can reference it without a circular import on
// `mcp.ts`. Keep the re-export so existing imports from `./mcp.js`
// continue to work — `index.ts`, `auth.ts`, etc. all read it from
// here.
export type { McpClientKind };

export function detectMcpClient(userAgent: string | null): McpClientKind {
  if (userAgent === null || userAgent === "") return "unknown";
  const ua = userAgent.toLowerCase();
  // Claude Code's HTTP MCP client (and the Agent SDK, which runs Claude
  // Code under the hood) sends `claude-code/<version> (sdk-cli)` —
  // verified empirically 2026-07-27 against claude-code 2.1.220. It is
  // a terminal, not an MCP Apps host: it cannot render the widget, and
  // `"claude"` is widget-only (the widget suppresses the PNG content
  // block via the `ui === undefined` mutual exclusion). Bucket it as
  // `"unknown"` so it keeps the portable inline-PNG path. Must run
  // BEFORE the broad "claude" substring match below.
  if (ua.includes("claude-code")) return "unknown";
  // Claude.ai and Claude Desktop custom connectors are server-to-server
  // from Anthropic's backend (egress 160.79.104.0/21) and identify as
  // `Claude-User` (occasionally `python-httpx`, which falls through to
  // "unknown" → PNG — acceptable, that path renders everywhere). Match
  // on any remaining "claude" / "anthropic" substring. The user's own
  // browser UA never reaches /mcp directly (claude.ai proxies through
  // its backend), so this won't false-positive on user browsers.
  //
  // Known residual risk: the Messages API `mcp_servers` connector also
  // egresses from Anthropic's backend and its UA is not publicly
  // pinned. If it sends `Claude-User` it is indistinguishable from
  // claude.ai here and gets widget `_meta` it cannot render.
  if (ua.includes("claude") || ua.includes("anthropic")) return "claude";
  // ChatGPT's Apps SDK connector typically advertises `ChatGPT-User`,
  // `openai-mcp`, or similar in UA. OpenAI's published crawler/agent UAs
  // (`GPTBot`, `OAI-SearchBot`) contain neither substring, so match them
  // explicitly — and deliberately at the full `chatgpt` classification,
  // not just for annotations: `McpClientKind` also selects the tool set
  // (`isToolOnSurface`), widget registration, and image content blocks,
  // and if OpenAI-family tooling (directory crawler, app review harness)
  // lists our tools it must see the same TOOL SURFACE
  // `chatgpt-app-submission.json` declares, not the `unknown` surface
  // (which swaps the split agent pair for `tako_agent` and drops
  // `tako_visualize`). The extra levers are harmless to a crawler: the
  // widget is inert metadata and image suppression only trims response
  // bytes. Residual risk for a UA outside these families is narrow:
  // `unknown` already serves the Apps-review annotation labels (see
  // `annotationClientFamily` in `tools/_surface.ts`), so only the
  // tool-set difference remains. The actual connector UA should still be
  // confirmed against production request logs rather than the
  // `"ChatGPT/1.0"` stand-in the tests use.
  if (
    ua.includes("chatgpt") ||
    ua.includes("openai") ||
    ua.includes("gptbot") ||
    ua.includes("oai-searchbot")
  ) {
    return "chatgpt";
  }
  return "unknown";
}

// Per-client annotation resolution lives with the tool surface config in
// `tools/_surface.ts` (each tool declares its own `annotationsByClient`
// next to its canonical MCP annotations — see `annotationsByClient` in
// `tools/types.ts` for the MCP-vs-Apps-review semantics).

export function createMcpServer(
  ctx: ToolContext,
  options: {
    iconsBaseUrl?: string;
    /**
     * Origin of the incoming request (e.g. `https://mcp.tako.com`), used
     * to build the `resource_metadata` URL in tool-level
     * `_meta["mcp/www_authenticate"]` challenges. Deliberately a separate
     * option from `iconsBaseUrl` even though `handleMcpRequest` passes the
     * same value to both today: icons may one day move to a CDN base,
     * and the OAuth discovery URL must keep tracking the request origin
     * (it has to match the HTTP 401 `WWW-Authenticate` header, which is
     * built from `new URL(request.url).origin`). Omitted in tests /
     * non-HTTP contexts → challenges omit `resource_metadata`.
     */
    requestOrigin?: string;
    client?: McpClientKind;
    /**
     * Opt-in tool names the caller enabled for this request via the `tools`
     * query param (resolved by `parseEnabledOptionalToolNames`). Tools in
     * `OPTIONAL_TOOL_NAMES` are excluded from the default surface and
     * registered only when their name appears here. Omitted → nothing opted
     * in (the default surface), which is what tests and non-HTTP callers want.
     */
    enabledOptionalToolNames?: Set<string>;
    /**
     * Connection tier. `"free"` (anonymous, no Authorization header)
     * restricts the EXECUTABLE toolset to `FREE_TIER_TOOL_NAMES` — on
     * ChatGPT the auth-required submitted tools stay LISTED for the
     * link-account UI but are blocked at dispatch (see
     * `CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES` in `tools/_surface.ts`
     * and the free-tier gate in `registerTool`). Omitted →
     * `"authenticated"`, the full surface — what every existing caller
     * and test gets.
     */
    tier?: Tier;
  } = {},
): McpServer {
  // Hosts (Claude.ai connector cards, ChatGPT app directory, etc.) pick
  // one entry per the spec's matching rules: theme first, then size.
  // Order entries best-fit-first within each theme so simple hosts that
  // just take `icons[0]` still get a sensible asset.
  //
  // URLs are served by this same worker under `/icons/*` (see
  // `icons.ts`). Going through our own origin keeps the public icon URL
  // stable across Tako frontend deploys — Tako only exposes its brand
  // assets under hashed CDN paths that rotate per deploy, so proxying
  // is the only way to ship a serverInfo.icons array that doesn't rot.
  // `iconsBaseUrl` is omitted in tests / non-HTTP contexts; in that
  // case we just don't advertise icons.
  const icons =
    options.iconsBaseUrl !== undefined
      ? [
          {
            src: `${options.iconsBaseUrl}/icons/favicon.svg`,
            mimeType: "image/svg+xml",
            theme: "light" as const,
          },
          {
            src: `${options.iconsBaseUrl}/icons/favicon-light.svg`,
            mimeType: "image/svg+xml",
            theme: "dark" as const,
          },
          {
            src: `${options.iconsBaseUrl}/icons/apple-touch-icon.png`,
            mimeType: "image/png",
            sizes: ["180x180"],
          },
        ]
      : undefined;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Tako",
      websiteUrl: "https://tako.com",
      description:
        "Proprietary, continuously-updated live data — plus interactive charts and visualizations — for finance, economics, demographics, prediction markets, and more. Covers the latest reported quarter, same-day market prices, and official releases as they publish.",
      ...(icons !== undefined ? { icons } : {}),
    },
    {
      jsonSchemaValidator: JSON_SCHEMA_VALIDATOR,
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Advertise an empty prompt list. We expose no prompts, but capability-probing
  // clients (Smithery's scan, some hosts) call `prompts/list` regardless; without
  // the prompts capability the SDK answers JSON-RPC -32601, which surfaces as a
  // "Failed to list prompts" warning. Returning {prompts: []} is the friendly,
  // spec-clean answer. (tools/resources capabilities are auto-registered by the
  // SDK as those modules are registered below.)
  server.server.registerCapabilities({ prompts: {} });
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));

  // Dedupe state for `appUiResource` registration — `tako_search` is
  // currently the sole chart-widget owner (registers
  // `ui://tako/embed/chart`), but the Sets here guard against future
  // tools re-declaring the same URI/template name. The MCP SDK's
  // `registerResource` throws `Resource <uri> is already registered`
  // on a duplicate URI, and similarly throws on a duplicate template
  // name. The Sets let each tool still get its `_meta.ui.resourceUri`
  // wired into the tool registration while skipping any redundant
  // `registerResource` call after the first.
  const registeredResourceUris = new Set<string>();
  const registeredTemplateNames = new Set<string>();

  // Which tools appear for which client — and the ChatGPT-only /
  // ChatGPT-excluded / ChatGPT-default-on membership sets — live in
  // `tools/_surface.ts`, shared with `gen-registry.ts` so the
  // `chatgpt-app-submission.json` parity check validates the exact
  // surface this loop registers.
  //
  // Tools whose `appUiResource` should NOT ship on ChatGPT (separate
  // from the blanket unknown-client suppression in `widgetSuppressed` —
  // ChatGPT and Claude are the only clients that get the widget at all).
  // The mechanism is kept in place for future per-tool gating, but
  // is currently empty: `tako_search` ships its widget on ChatGPT,
  // and a zero-match search returns a SUCCESS result (with `guidance`,
  // no `pub_id`/`embed_url`) — the widget bundle detects that empty
  // shape by the absence of any chart URL and collapses itself
  // (see `_chart_widget.ts`), so no persistent blank box is left.
  //
  // Add a tool name here only if it has a UI bundle that produces
  // unrenderable / blank widgets on ChatGPT in some legitimate
  // success state.
  const CHATGPT_NO_WIDGET_TOOL_NAMES = new Set<string>();
  const client = options.client ?? "unknown";
  const tier = options.tier ?? "authenticated";
  // Opt-in tools enabled for this request via `?tools=` (see `_optional.ts`).
  // Empty by default → the default surface excludes every optional tool.
  const enabledOptionalToolNames =
    options.enabledOptionalToolNames ?? new Set<string>();

  for (const tool of TOOL_REGISTRY) {
    // Surface membership (free-tier gate + opt-in gate + per-client
    // filters) is decided by `isToolOnSurface` in `tools/_surface.ts` —
    // shared with the codegen parity check so `chatgpt-app-submission.json`
    // can't drift from what this loop actually registers.
    if (!isToolOnSurface(tool.name, client, enabledOptionalToolNames, tier)) {
      continue;
    }
    registerTool(server, tool, ctx, {
      client,
      tier,
      origin: options.requestOrigin,
      widgetSuppressedForTool:
        client === "chatgpt" && CHATGPT_NO_WIDGET_TOOL_NAMES.has(tool.name),
      registeredResourceUris,
      registeredTemplateNames,
    });
  }

  // Resources parity for server instances that registered NO widget
  // resource (unknown clients only — ChatGPT and Claude both register
  // it, and the fallback below only fires when neither did). The SDK
  // only wires the `resources` capability and its request handlers on
  // the first `registerResource` call — without this block,
  // `resources/list` / `resources/read` answer JSON-RPC -32601 on
  // unknown-client instances, which capability-probing clients (Smithery's
  // scan, some hosts) surface as a failure. Same rationale as the empty
  // `prompts` registration above: an empty list is the spec-clean answer.
  // `resources/read` still errors (there is nothing to read) but with the
  // spec's "resource not found" shape instead of "method not found".
  if (registeredResourceUris.size === 0) {
    server.server.registerCapabilities({ resources: {} });
    server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [],
    }));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [],
    }));
    server.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Resource ${request.params.uri} not found`,
      );
    });
  }

  return server;
}

/**
 * Register a single `ToolModule` with an `McpServer`, adapting between our
 * handler signature (`(input, ctx) => Promise<Output>`) and the SDK's
 * expected `CallToolResult` return shape.
 *
 * The SDK's `registerTool` takes `ZodRawShape` (the `.shape` of a z.object),
 * not a full ZodObject — common gotcha. We pull `.shape` out here so tool
 * files don't have to.
 */
function registerTool(
  server: McpServer,
  tool: AnyToolModule,
  ctx: ToolContext,
  options: {
    client: McpClientKind;
    /**
     * Connection tier the server instance was built for — the SAME value
     * that drove `isToolOnSurface`, so the free-tier dispatch gate below
     * can never disagree with the listing decision. `"free"` blocks
     * non-free tools at call time with an auth challenge instead of
     * executing them on the shared free-tier account.
     */
    tier: Tier;
    /**
     * Request origin (e.g. `https://mcp.tako.com`) used to build the
     * `resource_metadata` URL in `_meta["mcp/www_authenticate"]`
     * challenges. `undefined` in tests / non-HTTP contexts — the
     * challenge then omits `resource_metadata` but keeps `error` /
     * `error_description` (the parts ChatGPT's sign-in UI keys on).
     */
    origin: string | undefined;
    /**
     * Set of `appUiResource` URIs already registered with the SDK on
     * this `McpServer` instance. Tools whose `appUiResource.uri`
     * matches an entry here skip the second `server.registerResource`
     * call (the SDK throws on duplicates) but still get their
     * tool-registration `_meta.ui.resourceUri` wired in. Required as
     * soon as more than one tool ships a widget on the same URI.
     */
    registeredResourceUris: Set<string>;
    /**
     * Same idea for the dynamic-resource template — the SDK throws
     * `Resource template <name> is already registered` if two tools
     * share `appUiResource.dynamic.templateName`.
     */
    registeredTemplateNames: Set<string>;
    /**
     * Per-tool widget suppression layered on top of the
     * client-blanket suppression below. Set true to skip
     * `appUiResource` for this specific tool/client combination —
     * see `CHATGPT_NO_WIDGET_TOOL_NAMES` for the rationale.
     */
    widgetSuppressedForTool?: boolean;
  },
): void {
  // SDK's `registerTool` takes `ZodRawShape` (the `.shape` of a z.object),
  // not a full ZodObject — pull `.shape` here so tool files don't have to.
  // Description selection: if the tool defines a per-client override
  // matching the calling client, ship that text; otherwise fall back
  // to the default. Per-client text avoids the failure mode where a
  // single description embeds host-conditional directives ("On
  // Claude.ai…", "On ChatGPT…") and relies on the model
  // self-identifying its host — empirically unreliable, since the
  // model has no first-class signal beyond the description text
  // itself.
  const description =
    tool.descriptionByClient?.[options.client] ?? tool.description;
  const config: Record<string, unknown> = {
    title: tool.annotations.title,
    description,
    inputSchema: tool.inputSchema.shape,
    annotations: toolAnnotationsForClient(tool, options.client),
  };

  // Advertise per-tool auth on every runtime descriptor. This only survives
  // to the client via `_meta` — the SDK's `tools/list` serializer drops
  // unknown top-level descriptor fields, but passes `_meta` through verbatim.
  // Reverse-DNS namespaced (`com.tako/…`) per the MCP `_meta` rules, which
  // reserve unprefixed keys for the protocol and would collide with the field
  // SEP-1488 (still Draft) will standardize at the descriptor top level.
  // ChatGPT reads the TOP-LEVEL `securitySchemes` field instead — injected
  // post-serialization by `withChatGptToolSecuritySchemes` in
  // `handleMcpRequest`, since the SDK can't carry it — from the same
  // `securitySchemesForTool` source, so the two never disagree.
  // The widget block below MERGES into this rather than replacing it.
  config._meta = {
    "com.tako/securitySchemes": securitySchemesForTool(tool.name),
  };

  if (tool.outputSchema !== undefined) {
    // Output schemas are optional — only read tools declare them.
    // In practice every `outputSchema` we ship is `z.object(...)`,
    // so `.shape` is defined; if it isn't, we simply don't pass outputSchema.
    const outputShape = (tool.outputSchema as unknown as { shape?: unknown })
      .shape;
    if (outputShape !== undefined) {
      config.outputSchema = outputShape;
    }
  }

  // MCP Apps: when the tool ships a UI bundle, register it as a separate
  // resource and thread the widget URI into the tool's registration via
  // BOTH the open-spec field and the OpenAI-namespaced field. Clients
  // that support MCP Apps fetch the resource, sandbox it in an iframe,
  // and pipe each `tools/call` result to the widget. Clients without
  // MCP Apps support ignore the metadata and rely on the default
  // text + image content blocks the registry already emits.
  //
  // Two metadata fields, two clients:
  //
  //   - `_meta.ui.resourceUri` — the open MCP Apps standard
  //     (blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps).
  //     claude.ai, VS Code Insiders, and Goose read this field. They
  //     also pass the `tools/call` result to the widget via a JSON-RPC
  //     `postMessage` (`ui/notifications/tool-result`).
  //
  //   - `_meta["openai/outputTemplate"]` — ChatGPT's Apps SDK reads
  //     this exact namespaced key. It controls TWO things on ChatGPT's
  //     side: which widget URI to load AND whether structuredContent
  //     gets piped into `window.openai.toolOutput`. Without it, the
  //     widget loads (because ChatGPT can fall back on `_meta.ui` to
  //     find the URI) but `toolOutput` stays null forever, leaving the
  //     widget stuck on its loading state. Found the hard way: the
  //     debug widget polled `window.openai.toolOutput` 40 times across
  //     10 seconds and watched it never populate, even though
  //     `openai:set_globals` events fired with `detail.globals` set.
  // Hoisted to outer scope so the per-call tool result handler below
  // can read `ui.dynamic` and resolve the per-call widget URI for the
  // dynamic-resource path.
  //
  // Two independent gates control whether the chart shows up inline
  // for this tool call.
  //
  //   - `widgetSuppressed` → skip `appUiResource`. The host won't
  //     get a widget URI in the tool's `_meta`, so it won't load
  //     the chart bundle. Three-way policy, one widget bundle:
  //
  //       - ChatGPT keeps the widget its Apps SDK renders as a fully
  //         interactive iframe (`frameDomains` populated, `embed_url`
  //         loaded live inside the sandbox).
  //       - Claude clients ALSO keep the widget, but render it via the
  //         image branch, not an iframe: the server declares
  //         `csp.frameDomains` identically for every client (see
  //         `buildChartAppUiResource` — it always sets `frameDomains:
  //         [webBase]`), but claude.ai's host-side sandbox currently
  //         restricts third-party iframes regardless of what's
  //         declared there, pending Claude's own MCP Apps security
  //         review, so the iframe never loads on claude.ai. The
  //         bundle's client-side JS feature-detects `window.openai` at
  //         runtime (see `shouldUseInteractiveIframe` in
  //         `_chart_widget.ts`) and falls back to painting the
  //         server-fetched `_meta.image_data_url` PNG (see the
  //         `extraMeta` comment below) instead of embedding
  //         `embed_url` in an `<iframe>`.
  //       - Unknown clients still suppress the widget — the long tail
  //         of MCP hosts (Cursor, Windsurf, Gemini CLI, LibreChat, …)
  //         almost never implements the MCP Apps spec, so shipping
  //         widget metadata there just blocks the far more portable
  //         image content-block fallback below.
  //
  //   - `inlinePngFallbackSuppressed` → skip the
  //     `extraContentBlocks` PNG image content block. Without
  //     suppression, that hook fires on tools that have no
  //     `appUiResource` to provide a "render the chart inline as
  //     an image" fallback for hosts that don't support MCP UI.
  //
  // Net effect: ChatGPT and Claude both render the MCP Apps widget
  // (interactive iframe on ChatGPT, image-branch card on Claude —
  // both render inline in the chat body); unknown clients get the
  // chart as an `image` content block instead, visible to the model
  // while it composes its answer. The `embed_url` in the structured
  // content stays the click-through to the interactive chart
  // everywhere. (Historically both gates fired together on claude —
  // link-only, no widget, no image — and unknown clients got widget
  // metadata they couldn't render; see the 2026-07 note below for why
  // claude.ai gets the widget now instead of the PNG block.)
  //
  // Per-tool ChatGPT suppression (`widgetSuppressedForTool`) still
  // fires both gates. That set exists for tools whose widget renders
  // blank/broken on ChatGPT in some legitimate success state — the
  // intended fallback there is the plain text + markdown-link answer,
  // not a PNG. (The image-block/widget mutual exclusion is separately
  // guaranteed by the `ui === undefined` condition at the call-time
  // `extraContentBlocks` gate.)
  const widgetSuppressed =
    (options.client !== "chatgpt" && options.client !== "claude") ||
    options.widgetSuppressedForTool === true;
  const inlinePngFallbackSuppressed = options.widgetSuppressedForTool === true;
  const ui =
    tool.appUiResource !== undefined && !widgetSuppressed
      ? tool.appUiResource(ctx.env)
      : undefined;

  if (ui !== undefined) {
    const uiMeta: Record<string, unknown> = {};
    const csp: Record<string, unknown> = {};
    if (ui.frameDomains && ui.frameDomains.length > 0) {
      csp.frameDomains = ui.frameDomains;
    }
    if (ui.resourceDomains && ui.resourceDomains.length > 0) {
      csp.resourceDomains = ui.resourceDomains;
    }
    if (Object.keys(csp).length > 0) {
      uiMeta.csp = csp;
    }
    // Resource registration. CSP-allowed iframe domains live on
    // `_meta.ui.csp.frameDomains` (open MCP Apps spec); its sibling
    // `_meta.ui.csp.resourceDomains` allow-lists the origins the
    // remote-image fallback (`<img src=image_url>`) may fetch/embed
    // from — the widget's image branch is what actually renders on
    // Claude, where the iframe branch never gets a chance to load. The
    // bundle's `_meta.ui` is set in TWO places by design (matches the official
    // `@modelcontextprotocol/ext-apps` helper):
    //
    //   1. Resource registration metadata (third arg to
    //      `server.registerResource`) — surfaces in the `resources/list`
    //      response so clients can discover CSP rules without fetching.
    //   2. The content item itself (inside `readCallback`'s
    //      `contents[0]._meta`) — clients reading the bundle read CSP
    //      from here, and per the ext-apps docs the content-item value
    //      "takes precedence" over the registration value. ChatGPT
    //      specifically reads the content-item `_meta` during
    //      `resources/read`; without it, frame-ancestors stays empty
    //      and the inner `<iframe src="https://tako.com/embed/…">` is
    //      blocked even though the registration metadata declared the
    //      domain.
    // Dedupe the static URI registration. The SDK throws on a second
    // `registerResource(name, uri, ...)` call for an already-registered
    // URI, but the per-tool `_meta.ui.resourceUri` wiring further down
    // still needs to happen for every tool that declares the widget —
    // so we just gate the resource registration here.
    if (!options.registeredResourceUris.has(ui.uri)) {
      options.registeredResourceUris.add(ui.uri);
      server.registerResource(
        ui.name,
        ui.uri,
        {
          // Per the MCP Apps spec: the host gates UI rendering on this
          // exact MIME type. Plain "text/html" is treated as a normal
          // resource and won't be sandbox-rendered as a widget.
          mimeType: APP_UI_MIME_TYPE,
          ...(Object.keys(uiMeta).length > 0 ? { _meta: { ui: uiMeta } } : {}),
        },
        // Static bundle — no per-request templating. The widget reads its
        // chart-specific data (pub_id, embed_url, dark_mode, …) from each
        // `tools/call` result via either `window.openai.toolOutput`
        // (ChatGPT) or a `ui/notifications/tool-result` postMessage
        // (claude.ai), so the same bundle serves every chart.
        async (uri) => {
          const contentItem: {
            uri: string;
            mimeType: string;
            text: string;
            _meta?: Record<string, unknown>;
          } = {
            uri: uri.toString(),
            mimeType: APP_UI_MIME_TYPE,
            text: ui.html,
          };
          if (Object.keys(uiMeta).length > 0) {
            contentItem._meta = { ui: uiMeta };
          }
          return { contents: [contentItem] };
        },
      );
    }
    // Optional dynamic-resource variant. When defined, the same widget
    // also gets a `ResourceTemplate` registration so a per-call
    // `_meta.ui.resourceUri` could point at a specific instance of that
    // template (baking the chart's image + dimensions into the widget
    // HTML at fetch time, sidestepping a host's "snapshot offsetHeight
    // once on mount" behavior). claude.ai does NOT use this today — see
    // the "Conclusion" comment below: it ignores per-call resourceUri
    // overrides and stays on the static URI + baked
    // `_meta.image_data_url` from `extraMeta`. The template stays
    // registered for a future host that does honor per-call URIs. See
    // `AppUiResource.dynamic` for the rationale.
    if (
      ui.dynamic !== undefined &&
      !options.registeredTemplateNames.has(ui.dynamic.templateName)
    ) {
      options.registeredTemplateNames.add(ui.dynamic.templateName);
      const dynamic = ui.dynamic;
      server.registerResource(
        dynamic.templateName,
        new ResourceTemplate(dynamic.uriPattern, { list: undefined }),
        {
          mimeType: APP_UI_MIME_TYPE,
          ...(Object.keys(uiMeta).length > 0 ? { _meta: { ui: uiMeta } } : {}),
        },
        async (uri, variables) => {
          const html = await dynamic.renderHtml(variables, ctx);
          const contentItem: {
            uri: string;
            mimeType: string;
            text: string;
            _meta?: Record<string, unknown>;
          } = {
            uri: uri.toString(),
            mimeType: APP_UI_MIME_TYPE,
            text: html,
          };
          if (Object.keys(uiMeta).length > 0) {
            contentItem._meta = { ui: uiMeta };
          }
          return { contents: [contentItem] };
        },
      );
    }
    // Tool-side metadata: set the modern `_meta.ui.resourceUri`, the
    // legacy flat `_meta["ui/resourceUri"]` (the official ext-apps
    // helper auto-mirrors these for backward compat with older host
    // readers — we do the same so a ChatGPT build still reading the
    // legacy key works), and `_meta["openai/outputTemplate"]` (OpenAI
    // namespace alias). All three carry the static URI.
    //
    // We tried two routes to use the dynamic resource template
    // (registered above) on claude.ai for per-chart sizing:
    //
    //   1. Per-call `_meta.ui.resourceUri` overrides on the tool
    //      result. Verified delivered correctly (curl), but
    //      claude.ai loads the widget URI from `tools/list`
    //      registration metadata and ignores per-call overrides.
    //   2. Advertising the URI template (`ui://tako/embed/chart/{pub_id}`)
    //      directly in registration `_meta.ui.resourceUri`. Hosts
    //      that honor RFC 6570 substitution would have resolved
    //      `{pub_id}` from tool output. claude.ai didn't; it
    //      appeared to fetch the literal template URI and rendered
    //      nothing — strictly worse than the static-URI behavior.
    //
    // Conclusion: claude.ai for custom connectors today does not
    // support per-tool-call widget URI variation, so we stay on the
    // static URI for all three keys. The template resource is still
    // registered above for future hosts that may support it.
    //
    // 2026-07: widget re-enabled for Claude clients via the static URI
    // + `ui/notifications/tool-result` data path; per-call dynamic
    // URIs remain registered for hosts that support them.
    config._meta = {
      ...(config._meta as Record<string, unknown>),
      ui: { resourceUri: ui.uri },
      "ui/resourceUri": ui.uri,
      "openai/outputTemplate": ui.uri,
    };
  }

  // Structural type for the slice of `RequestHandlerExtra` we read.
  // We don't import the full SDK type because it requires pulling in
  // `ServerRequest` / `ServerNotification` and the layered generics
  // don't add anything we use; this object literal type is checked
  // structurally against the SDK's actual `extra` at the call site.
  type ToolHandlerExtra = {
    sendNotification: (notification: {
      method: "notifications/progress";
      params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      };
    }) => Promise<void>;
    _meta?: { progressToken?: string | number };
  };
  server.registerTool(
    tool.name,
    config as Parameters<McpServer["registerTool"]>[1],
    (async (input: unknown, extra: ToolHandlerExtra) => {
      // Build a per-call context that layers `sendProgress` over the
      // shared `{ token, env }`. The SDK's `extra._meta.progressToken`
      // is set when the client provided a progressToken on the request
      // (and only then are progress notifications useful — clients
      // ignore notifications whose progressToken they don't recognize,
      // and the protocol forbids sending progress without a token). On
      // requests without a progressToken, `sendProgress` no-ops, so
      // tools can call it unconditionally. `progress` accumulates a
      // monotonic count of polls / steps; `total` and `message` are
      // optional. Errors from the underlying transport are swallowed —
      // a notification failure must NEVER fail the tool call.
      const progressToken = (extra._meta as { progressToken?: string | number } | undefined)
        ?.progressToken;
      // Diagnostic: log whether the client included a progressToken on
      // the request. Lets us confirm via `wrangler tail` whether a
      // given client is asking for progress (Claude.ai's TS SDK does
      // by default; ChatGPT's Apps SDK historically does not). When
      // absent, `sendProgress` no-ops and the client's per-tool-call
      // timeout ticks down without resets — the deep-search path
      // can't survive longer than the client's default (60 s on the
      // TS SDK) on those clients.
      console.log(
        `[mcp] tool=${tool.name} client=${options.client} progressToken=${progressToken ?? "(none)"}`,
      );
      const sendProgress: ToolContext["sendProgress"] = async (
        progress,
        opts,
      ) => {
        if (progressToken === undefined) return;
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              ...(opts?.total !== undefined ? { total: opts.total } : {}),
              ...(opts?.message !== undefined ? { message: opts.message } : {}),
            },
          });
        } catch (err) {
          // Best-effort: log and move on. The polling loop continues
          // without progress reset on this client; if the timeout
          // fires, the client will see a clean cancel rather than
          // an opaque transport error.
          console.error(
            `sendProgress failed for ${tool.name}:`,
            err,
          );
        }
      };
      // `tier` is stamped from the registration-time value — the SAME one
      // that drove `isToolOnSurface` and the dispatch gate below — so the
      // per-call context can never disagree with the surface decision
      // (previously `ctx.tier` was a second, caller-supplied source of
      // truth that had to be kept in sync by hand).
      const callCtx: ToolContext = {
        ...ctx,
        sendProgress,
        client: options.client,
        tier: options.tier,
      };
      // Free-tier dispatch gate: auth-required tools can be LISTED on an
      // anonymous connection (ChatGPT needs the descriptor to offer its
      // link-account UI — see `CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES`
      // in `_surface.ts`) but must never EXECUTE on the shared free-tier
      // account. Gate on the registration-time tier — the same value that
      // decided the surface — before the handler can touch Django. The
      // `_meta["mcp/www_authenticate"]` challenge in the result is what
      // triggers ChatGPT's sign-in prompt (OpenAI Apps SDK auth guide).
      if (options.tier === "free" && !FREE_TIER_TOOL_NAMES.has(tool.name)) {
        console.log(
          `[mcp] auth-required tool blocked on free tier tool=${tool.name} client=${options.client}`,
        );
        return authRequiredToolResult(options.origin);
      }
      let output: unknown;
      try {
        output = await tool.handler(input as unknown, callCtx);
      } catch (err) {
        // Map Django transport failures to a structured `isError: true`
        // result so MCP clients can distinguish "your token was rejected"
        // from "upstream timed out" without string-matching `err.message`.
        // Non-Django throws re-throw to the SDK, which wraps them in a
        // generic tool error (last-resort path for handler bugs).
        if (err instanceof DjangoError) {
          // Free tier: the shared account exhausting its Tako credits is
          // the tier's expected steady-state failure (the Django-side cap
          // is the fail-open spend backstop). Surface it as upsell copy,
          // not the raw billing error — which would read as a bug to an
          // anonymous user who has no account to top up. Status 402 is
          // the complete signal (Django's PaymentRequiredError always
          // serves 402); matching on body text would let any 4xx that
          // echoes caller-supplied input masquerade as credit exhaustion.
          if (
            callCtx.tier === "free" &&
            err instanceof DjangoHttpError &&
            err.status === 402
          ) {
            return freeTierCreditsToolResult();
          }
          const mapped = djangoErrorToToolResult(err);
          // A 401 from Django on an AUTHENTICATED connection means the
          // caller's own credential was rejected — for an OAuth-linked
          // user, a stale or revoked Tako token. Attach the
          // `_meta["mcp/www_authenticate"]` challenge on ChatGPT so its
          // client offers re-linking (the OpenAI Apps SDK keys the reauth
          // UI on this exact field); other clients keep the unchanged
          // error result. Free-tier connections are excluded: there the
          // rejected credential is the SHARED free-tier key, so "your
          // session expired" would be false for a caller with no session
          // — and funneling anonymous users into (working) sign-in would
          // mask a shared-key outage as a per-user auth failure.
          if (
            options.client === "chatgpt" &&
            options.tier === "authenticated" &&
            err instanceof DjangoUnauthorizedError
          ) {
            return {
              ...mapped,
              _meta: {
                ...mapped._meta,
                "mcp/www_authenticate": [
                  wwwAuthenticate(
                    options.origin,
                    "invalid_token",
                    "Your Tako session is no longer valid. Sign in with Tako again to continue.",
                  ),
                ],
              },
            };
          }
          return mapped;
        }
        throw err;
      }
      // When the tool declares an `outputSchema`, report the structured
      // payload alongside a JSON-stringified text fallback. Clients that
      // understand `structuredContent` get the typed value; legacy clients
      // fall back to the text content. When no outputSchema, text-only is
      // sufficient.
      const text = JSON.stringify(output, null, 2);
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text }];
      // Optional per-tool hook to append extra MCP content blocks (image,
      // audio, resource). Best-effort: a thrown hook degrades to the text
      // + structuredContent that's already there rather than failing the
      // call.
      //
      // Fires only when this registration carries no widget
      // (`ui === undefined` — widget-less tools everywhere, and now
      // chart tools on UNKNOWN clients only, where the widget is
      // suppressed) AND the inline PNG fallback hasn't been
      // independently suppressed for this tool. This is how the long
      // tail of MCP hosts (Cursor, Windsurf, Gemini CLI, LibreChat, …)
      // gets the chart inline: the PNG image content block renders as
      // a generic `image` block, with `embed_url` in the structured
      // content as the interactive click-through. Claude clients no
      // longer take this path — they get the MCP Apps widget instead
      // (see `widgetSuppressed` above), so this hook never fires for
      // `client === "claude"`.
      //
      // Pairing image content blocks with widget metadata in the
      // same result silently disabled ChatGPT's widget data flow, so
      // the `ui === undefined` condition keeps content-block image
      // fallbacks and widget metadata mutually exclusive.
      if (
        tool.extraContentBlocks !== undefined &&
        ui === undefined &&
        !inlinePngFallbackSuppressed
      ) {
        try {
          const extra = await tool.extraContentBlocks(output, callCtx);
          content.push(...extra);
        } catch (err) {
          console.error(
            `extraContentBlocks hook failed for ${tool.name}:`,
            err,
          );
        }
      }
      // Optional `_meta` hook. Distinct from `extraContentBlocks` and
      // `structuredContent` because `_meta` is the MCP spec's
      // metadata-only field — hosts MAY forward it to widgets via
      // `ui/notifications/tool-result` (per the MCP Apps spec) but it
      // is NOT part of the LLM's context window. Use this to ship
      // payloads the widget needs but the LLM shouldn't tokenize, e.g.
      // an inline base64 PNG too large to fit in `structuredContent`
      // without tripping claude.ai's "tool result too large for
      // context" guard.
      //
      // Gated on `ui !== undefined` — the inverse of `extraContentBlocks`
      // above. When the widget is suppressed (unknown clients), no
      // widget will consume `_meta`, so running this hook would
      // inflate the JSON-RPC response with a ~330 KB unused data URL.
      //
      // This hook now fires for both widget clients, but each does
      // something different with it: ChatGPT's `extraMeta`
      // implementations bail early on `ctx.client === "chatgpt"` (its
      // iframe widget loads `embed_url` directly and never reads the
      // baked image), while Claude's do not — `image_data_url` is
      // Claude's PRIMARY chart data path. The server declares the same
      // `csp.frameDomains` for both clients, but claude.ai's host-side
      // sandbox currently restricts third-party iframes regardless of
      // that declaration, pending Claude's own MCP Apps security
      // review, so the bundle's runtime `window.openai` feature
      // detection picks the image branch there instead of embedding
      // `embed_url` in an `<iframe>`; it reads this baked
      // `_meta.image_data_url` and paints the PNG directly.
      let resultMeta: Record<string, unknown> | undefined;
      if (tool.extraMeta !== undefined && ui !== undefined) {
        try {
          resultMeta = await tool.extraMeta(output, callCtx);
        } catch (err) {
          console.error(`extraMeta hook failed for ${tool.name}:`, err);
        }
      }
      // Dynamic-resource path: when the tool's `appUiResource` declares
      // a `dynamic` variant, resolve a per-call URI from the tool input
      // and override `_meta.ui.resourceUri` (and the legacy flat
      // `_meta["ui/resourceUri"]`) in the tool result. claude.ai reads
      // these from the result's `_meta`, so per-call routing works
      // even though tool registration metadata is static.
      //
      // Deliberately NOT overriding `_meta["openai/outputTemplate"]`
      // here — that key is read by ChatGPT, which keeps using the
      // static iframe widget (its CSP allows the cross-origin iframe
      // path for full interactivity, so it doesn't need the
      // image-baked dynamic variant).
      if (ui?.dynamic !== undefined) {
        try {
          // Pass both `input` and `output` to the resolver. Currently
          // `tako_search` is the only tool with a dynamic URI resolver;
          // it reads the chart `pub_id` from the search output
          // (`output.pub_id`). Output is `unknown` here because
          // `AnyToolModule` erases handler types at the registry
          // boundary; resolvers narrow it themselves.
          const resolvedUri = ui.dynamic.resolveUriFromInput(input, output);
          resultMeta = {
            ...(resultMeta ?? {}),
            ui: {
              ...((resultMeta?.ui as Record<string, unknown> | undefined) ?? {}),
              resourceUri: resolvedUri,
            },
            "ui/resourceUri": resolvedUri,
          };
        } catch (err) {
          console.error(
            `dynamic.resolveUriFromInput failed for ${tool.name}:`,
            err,
          );
        }
      }
      const result: {
        content: typeof content;
        structuredContent?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      } = { content };
      if (tool.outputSchema !== undefined) {
        result.structuredContent = output as Record<string, unknown>;
      }
      if (resultMeta !== undefined && Object.keys(resultMeta).length > 0) {
        result._meta = resultMeta;
      }
      return result;
    }) as Parameters<McpServer["registerTool"]>[2],
  );
}

/**
 * Convert a `DjangoError` into an MCP `CallToolResult` with `isError: true`.
 * Each subtype maps to a distinct `kind` discriminator so clients can branch
 * on `_meta["tako/error"].kind` (e.g. "unauthorized" vs "timeout") instead of
 * parsing `err.message`. Per-subtype fields (`timeoutMs`, `body`) are only
 * attached where they exist on the error.
 *
 * The discriminant rides on `_meta`, NOT `structuredContent`: read tools
 * (`tako_search`, `tako_answer`, `tako_contents`) declare an `outputSchema`,
 * and spec-compliant MCP clients validate ANY `structuredContent` present on
 * a result against that schema — even when `isError: true` (the SDK's
 * "skip on error" comment notwithstanding; it only skips the *missing*-content
 * check, not validation). Carrying the error shape as `structuredContent`
 * therefore got every Django error rejected with a generic `-32602`, masking
 * the real failure (e.g. the post-deploy smoke saw "data must have required
 * property 'cards'" instead of the upstream error). `_meta` is forwarded to
 * clients but never schema-validated, so it's the correct channel.
 *
 * Exported for unit testing — the wire contract is stable enough that
 * Phase 2 tests can rely on the `kind` strings here.
 */
export function djangoErrorToToolResult(err: DjangoError): {
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
  isError: true;
} {
  const detail: Record<string, unknown> = {
    kind: djangoErrorKind(err),
    path: err.path,
    method: err.method,
  };
  if (err.status !== undefined) detail.status = err.status;
  if (err instanceof DjangoTimeoutError) detail.timeoutMs = err.timeoutMs;
  // Surface the upstream response body on `_meta` untouched for EVERY subtype
  // that captured one (400/401/404/catch-all), regardless of status — clients
  // that read structured detail always get the full envelope for debugging.
  const body = errorResponseBody(err);
  if (body !== undefined) detail.body = body;

  // Splice the body into the model-visible text for CLIENT errors (any 4xx).
  // These carry the guidance the LLM needs to act on or relay to the user:
  //   - 400: DRF validation errors (missing fields, invalid enum, bad config).
  //   - 401: the auth-failure reason (bad/expired key vs. wrong environment).
  //   - 403: the refusal reason — e.g. "Data export is not available for this
  //     card (protected source)".
  //   - 404: the not-found reason (a real routing/resource 404).
  //   - 409/429/…: conflict / rate-limit detail.
  // Keeping it in `_meta` alone isn't enough — not every MCP client surfaces
  // structured detail to the model.
  //
  // SERVER errors (5xx) and transport errors (timeout — no status) stay
  // body-free: no LLM-actionable detail, and 5xx bodies are often noisy HTML
  // error pages that would flood the text channel.
  //
  // The splice is ALSO gated on `extractErrorDetail` recognising a structured
  // message: a 4xx can still carry a raw HTML page (a Cloudflare/edge WAF 403
  // or rate-limit 429) or a bare discriminator JSON, and we don't want that
  // flooding the text channel either — same failure mode as a 5xx HTML body,
  // just on a 4xx. Only DRF-shaped detail reaches the model; everything else
  // stays on `_meta.body` only. `err.message` stays body-free by construction
  // (log-injection guard in `django.ts`), so the splice happens only here at
  // the MCP boundary.
  const is4xx =
    err.status !== undefined && err.status >= 400 && err.status < 500;
  const detailText = body !== undefined ? extractErrorDetail(body) : undefined;
  // A handler-supplied `modelGuidance` (e.g. tako_contents' self-correcting
  // 403/404 text) wins and is used verbatim — it already folds in any backend
  // detail, so it must NOT be re-spliced. Otherwise fall back to `err.message`,
  // splicing the recognised 4xx detail as usual.
  const text =
    err.modelGuidance !== undefined
      ? err.modelGuidance
      : is4xx && detailText !== undefined
        ? `${err.message}: ${detailText}`
        : err.message;
  return {
    content: [{ type: "text", text }],
    _meta: { "tako/error": detail },
    isError: true,
  };
}

/**
 * The upstream response body captured on the error, or `undefined` for
 * subtypes that carry none (timeout, unparseable-2xx). Every body-bearing
 * subtype exposes it as `.body`; centralising the `instanceof` fan-out here
 * keeps `_meta` population and the 4xx text-splice reading from one source.
 */
function errorResponseBody(err: DjangoError): string | undefined {
  if (
    err instanceof DjangoBadRequestError ||
    err instanceof DjangoUnauthorizedError ||
    err instanceof DjangoNotFoundError ||
    err instanceof DjangoHttpError
  ) {
    // Treat an empty body as absent so it's omitted from `_meta` (no noisy
    // `body: ""`) and never triggers the text splice.
    return err.body === "" ? undefined : err.body;
  }
  return undefined;
}

function djangoErrorKind(err: DjangoError): string {
  if (err instanceof DjangoUnauthorizedError) return "unauthorized";
  if (err instanceof DjangoTimeoutError) return "timeout";
  if (err instanceof DjangoNotFoundError) return "not_found";
  if (err instanceof DjangoBadRequestError) return "bad_request";
  if (err instanceof DjangoResponseParseError) return "response_parse";
  if (err instanceof DjangoHttpError) return "http";
  return "unknown";
}

/**
 * Handle a POST /mcp request using a stateless Streamable HTTP transport.
 *
 * We spin up a fresh `McpServer` + transport per request. Cloudflare Workers
 * have no persistent in-process state across requests, so stateless mode is
 * the right fit: no `Mcp-Session-Id`, no cross-request bookkeeping. Each
 * request carries all the state it needs (client sends `initialize` and
 * subsequent calls independently; re-negotiation is cheap).
 *
 * Auth gate: `extractBearer` runs BEFORE the SDK sees the request. A
 * malformed or empty `Authorization` header short-circuits here with a
 * uniform JSON-RPC 401 response. A fully ABSENT header is served as the
 * anonymous free tier — restricted toolset, rate-limited, on the shared
 * `FREE_TIER_API_KEY` account — but ONLY in environments where all three
 * free-tier bindings are configured (see `resolveFreeTierConfig`);
 * everywhere else the missing-header case 401s exactly as it always did,
 * and `initialize` requires auth.
 *
 * `enableJsonResponse: true` makes the transport return a single JSON-RPC
 * response body instead of an SSE stream, which keeps the wire format simple
 * for the common request/response case.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // Gate the endpoint behind Bearer auth — with one carve-out. A request
  // whose Authorization header is fully ABSENT (kind="missing") is served
  // as the anonymous free tier when the env has opted in (both free-tier
  // bindings configured, see `resolveFreeTierConfig`). A malformed or
  // empty header is a client *trying* to authenticate — that stays a loud
  // 401 and is never silently downgraded to the free tier.
  let bearer: string | null = null;
  let freeTier: FreeTierConfig | null = null;
  try {
    bearer = extractBearer(request);
  } catch (err) {
    if (!(err instanceof BearerAuthError)) throw err;
    freeTier = err.kind === "missing" ? resolveFreeTierConfig(env) : null;
    if (freeTier === null) {
      return bearerAuthResponse(request, err);
    }
  }

  const origin = new URL(request.url).origin;
  let token: string;
  let tier: Tier;
  if (bearer === null && freeTier !== null) {
    // Anonymous free tier: admission checks BEFORE any SDK work (global
    // ceiling → body-size bound → batch rejection → per-IP metering of
    // free-tool calls), then act as the shared free-tier account
    // downstream. See `checkFreeTierRateLimit` for the ordering rationale.
    const meterResult = await checkFreeTierRateLimit(request, freeTier);
    switch (meterResult.kind) {
      case "global_limited":
        return freeTierGlobalLimitResponse(meterResult.requestId);
      case "too_large":
        return freeTierTooLargeResponse();
      case "batch":
        return freeTierBatchResponse();
      case "limited":
        return freeTierLimitResponse(meterResult.requestId);
      case "allowed":
        break;
    }
    token = freeTier.apiKey;
    tier = "free";
  } else if (bearer !== null) {
    // Two-mode bearer handling:
    // - OAuth access JWT issued by /token: verify signature, decrypt the
    //   per-user Tako API token from the `enc_tako_token` claim, forward
    //   that token downstream as `X-API-Key`. Each user authenticates as
    //   themselves to Django.
    // - Raw Tako API token (the existing Claude Code path): non-JWT shape,
    //   `tryResolveOAuthAccessToken` returns null, we forward the bearer
    //   verbatim. Backwards-compatible with every Claude Code install in
    //   the wild.
    const oauth = await tryResolveOAuthAccessToken(bearer, env, origin);
    if (oauth.kind === "reject") {
      // The bearer IS a Worker-issued JWT but failed a binding check
      // (wrong audience/issuer/scope/type). Return a clean 401 rather than
      // forwarding it to Django as a raw API key.
      return oauthChallengeResponse(request, oauth.error, oauth.errorDescription);
    }
    token = oauth.kind === "ok" ? oauth.takoToken : bearer;
    tier = "authenticated";
  } else {
    // Unreachable: `bearer === null` implies the catch above ran, and it
    // either set `freeTier` or returned. Kept as a hard failure so a
    // future refactor can't silently serve an unauthenticated request.
    throw new Error("unreachable: no bearer and no free-tier config");
  }

  // Base ctx — `sendProgress` here is a placeholder overridden per
  // tool call inside `registerTool`'s SDK callback (where the
  // request's `progressToken` and the SDK's `sendNotification` are
  // available). Outside of a tool-call scope, no client is listening.
  // `client` defaults to `"unknown"` and is overridden by the
  // request-handler before tool dispatch.
  const ctx: ToolContext = {
    token,
    env,
    sendProgress: async () => {
      /* no-op outside tool-call scope */
    },
    client: "unknown",
    tier,
  };

  try {
    // Use the request's own origin as the icon base, so each deployed
    // env (mcp.tako.com, mcp.staging.tako.com, *.workers.dev) advertises
    // icons it itself serves under `/icons/*`. Prevents staging
    // connectors from referencing prod URLs and vice versa.
    const url = new URL(request.url);
    const requestOrigin = url.origin;
    // Detect calling client from User-Agent so we can route the chart
    // widget to ChatGPT and Claude (unknown clients fall back to the
    // inline PNG) and route ChatGPT through the agent split pair. See
    // `detectMcpClient` for the matching rules.
    const client = detectMcpClient(request.headers.get("user-agent"));
    // Opt-in tools: the agent is off by default and enabled per-connection
    // via `?tools=agent` (see `_optional.ts`). Parsing is tolerant — unknown
    // tokens are ignored, never fatal. Log the raw value and resolved set so
    // `wrangler tail` shows what a given connector asked for.
    const rawToolsParam = url.searchParams.get("tools");
    const enabledOptionalToolNames = parseEnabledOptionalToolNames(rawToolsParam);
    if (rawToolsParam !== null) {
      console.log(
        `[mcp] tools param=${JSON.stringify(rawToolsParam)} enabled=${
          [...enabledOptionalToolNames].join(",") || "(none)"
        }`,
      );
    }
    const server = createMcpServer(ctx, {
      iconsBaseUrl: requestOrigin,
      requestOrigin,
      client,
      enabledOptionalToolNames,
      tier,
    });
    // Omitting `sessionIdGenerator` puts the transport in stateless mode — no
    // `Mcp-Session-Id` header is issued or validated. This matches the Worker
    // model (no persistent per-session state) and keeps each request
    // self-contained.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    await server.connect(transport);
    // Cloned before the transport consumes the body so the observability tap
    // below can re-read the call when the SDK rejects it.
    const requestForLogging = request.clone();
    try {
      const response = await transport.handleRequest(request);
      await logSdkValidationRejections(requestForLogging, response);
      // ChatGPT-only compatibility adapter: rewrite the buffered
      // `tools/list` response to carry the top-level `securitySchemes`
      // field its Apps SDK reads (the MCP SDK cannot serialize unknown
      // descriptor fields — see `tools/_security.ts`). Every other
      // client gets the SDK's response untouched.
      return client === "chatgpt"
        ? await withChatGptToolSecuritySchemes(response)
        : response;
    } finally {
      // TODO(Phase 2): revisit this unconditional close.
      //
      // Safe today ONLY because `enableJsonResponse: true` buffers the full
      // response before `handleRequest` resolves — there is no in-flight SSE
      // stream for `transport.close()` to truncate.
      //
      // When Phase 2 introduces tools that stream results over SSE, this
      // `finally` will clear `_streamMapping` and abort the stream before
      // the client has read it. Likely fix: move to on-error close only and
      // rely on Workers GC at request completion to release resources.
      await transport.close();
      await server.close();
    }
  } catch (err) {
    // The SDK handles JSON-RPC validation errors internally. This outer
    // catch is a last-resort safety net for unexpected throws from
    // `server.connect(transport)` or tool handler bugs — we don't want to
    // leak a generic Worker 500 (or the exception message) to clients.
    // Log to Workers Logs (observability is enabled in wrangler.jsonc) so
    // production incidents still produce a signal.
    console.error("mcp handler error:", err);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
}

/**
 * ChatGPT compatibility adapter: add the top-level `securitySchemes` field
 * to every tool descriptor in a buffered `tools/list` JSON response.
 *
 * OpenAI's Apps SDK reads `securitySchemes` at the descriptor TOP LEVEL
 * (developers.openai.com/apps-sdk/build/auth) to decide which tools work
 * anonymously vs. need a linked account — but the MCP SDK's `tools/list`
 * serializer rebuilds each descriptor from a fixed field list and drops
 * unknown fields (verified on 1.29.0 and 1.30.0), so the field cannot be
 * threaded through `registerTool`. `enableJsonResponse: true` guarantees
 * the response is fully buffered, so rewriting it here cannot truncate a
 * stream — the same invariant `logSdkValidationRejections` relies on.
 *
 * Best-effort: any parse failure returns the original response unchanged.
 * Non-`tools/list` bodies pass through untouched (the transform only
 * matches messages with a `result.tools` array).
 */
export async function withChatGptToolSecuritySchemes(
  response: Response,
): Promise<Response> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return response;
    const body = (await response.clone().json()) as unknown;
    const transformed = withToolSecuritySchemes(body);
    if (transformed === body) return response;
    const headers = new Headers(response.headers);
    // The rewritten body has a different byte length; let the runtime
    // recompute rather than serving a stale header.
    headers.delete("content-length");
    return new Response(JSON.stringify(transformed), {
      status: response.status,
      headers,
    });
  } catch (err) {
    // Degrading is correct (the un-augmented response is still valid MCP),
    // but never silently: without securitySchemes ChatGPT's link-account
    // UI quietly stops working, and this log line is the only signal.
    console.error("[mcp] securitySchemes injection failed:", err);
    return response;
  }
}

/**
 * Observability tap for SDK-internal tool-argument rejections. The SDK
 * validates `tools/call` arguments against the registered input schema
 * BEFORE the tool callback runs, so an input the schema rejects becomes a
 * JSON-RPC `-32602` to the client with no Worker-side signal — the outer
 * catch in `handleMcpRequest` never sees it, and neither does any tool
 * handler. That blind spot matters whenever a schema is tightened (e.g.
 * `tako_visualize`'s typed configs): traffic the new schema rejects would
 * otherwise surface only as user complaints. Peeking at the buffered
 * response (`enableJsonResponse: true` guarantees it is fully buffered, so
 * no stream can be truncated) logs each rejection with its tool name to
 * Workers Logs.
 *
 * `request` must be a clone whose body has not been consumed. Never throws:
 * a malformed body here must not break serving the already-built response.
 */
export async function logSdkValidationRejections(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    if (request.method !== "POST") return;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return;
    const responseBody = (await response.clone().json()) as unknown;
    const responseMessages = Array.isArray(responseBody)
      ? responseBody
      : [responseBody];
    const rejections = responseMessages.filter(
      (m): m is { id?: unknown; error: { code: number; message?: string } } => {
        if (typeof m !== "object" || m === null) return false;
        const error = (m as { error?: unknown }).error;
        return (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === -32602
        );
      },
    );
    if (rejections.length === 0) return;
    const requestBody = (await request.json()) as unknown;
    const requestMessages = Array.isArray(requestBody)
      ? requestBody
      : [requestBody];
    for (const rejection of rejections) {
      const call = requestMessages.find(
        (m): m is { id?: unknown; method?: unknown; params?: unknown } =>
          typeof m === "object" &&
          m !== null &&
          (m as { id?: unknown }).id === rejection.id,
      );
      const method = typeof call?.method === "string" ? call.method : "unknown";
      const params = call?.params as { name?: unknown } | undefined;
      const toolName = typeof params?.name === "string" ? params.name : "unknown";
      console.error(
        `[mcp] invalid params (-32602): method=${method} tool=${toolName} error=${
          rejection.error.message ?? ""
        }`,
      );
    }
  } catch {
    // Best-effort tap — swallowing is deliberate; see the doc comment.
  }
}

/**
 * Build the HTTP 401 response for a bearer auth failure. The body is a
 * JSON-RPC 2.0 error envelope with `id: null` (auth failures happen before
 * the SDK sees the request id). The `code` / `data.kind` pair comes from
 * {@link bearerAuthErrorToJsonRpc}; see `auth.ts`.
 *
 * Emits `WWW-Authenticate: Bearer` per RFC 6750 §3 so clients know to
 * supply a Bearer token on retry. The `resource_metadata` parameter
 * (RFC 9728) points the client at our OAuth protected-resource discovery
 * doc — that is how MCP hosts (Claude.ai, ChatGPT) bootstrap an OAuth
 * flow when they have only the MCP URL and got a 401.
 *
 * The `WWW-Authenticate: Bearer` challenge formatter (`wwwAuthenticate`)
 * lives in `tools/_security.ts`, shared with the tool-level
 * `_meta["mcp/www_authenticate"]` challenges so both wire formats come
 * from one builder.
 */
function bearerAuthResponse(request: Request, err: BearerAuthError): Response {
  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: bearerAuthErrorToJsonRpc(err),
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": wwwAuthenticate(origin, "invalid_token"),
      },
    },
  );
}

/**
 * 401 for an OAuth access token that verified as ours but failed a binding
 * check (audience / issuer / scope / type). Distinct from `bearerAuthResponse`
 * (missing / malformed header) so the `error` / `error_description` reflect the
 * specific OAuth failure and ChatGPT/Claude can decide whether to re-link.
 */
function oauthChallengeResponse(
  request: Request,
  error: string,
  errorDescription: string,
): Response {
  const origin = new URL(request.url).origin;
  // RFC 6750 §3.1: insufficient_scope → 403 (the grant is wrong; a
  // re-auth would re-present the same scope and loop). Everything else →
  // 401 (re-authenticate).
  const status = error === "insufficient_scope" ? 403 : 401;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: errorDescription,
        data: { kind: error },
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": wwwAuthenticate(origin, error, errorDescription),
      },
    },
  );
}
