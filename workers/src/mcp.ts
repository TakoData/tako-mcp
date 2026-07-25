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
import { tryResolveOAuthAccessToken } from "./oauth/access.js";
import {
  OPTIONAL_TOOL_NAMES,
  parseEnabledOptionalToolNames,
} from "./tools/_optional.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import type { AnyToolModule, McpClientKind, ToolContext } from "./tools/types.js";

/**
 * Server identity. `registry/server.json` is the canonical source — versions are
 * managed by release-please (see release-please-config.json extra-files); do not hand-edit.
 * Clients compare what they read from the registry against what `initialize`
 * returns, so a mismatch surfaces as "wrong server" in tooling.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.13.0"; // x-release-please-version

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
 * LLM to figure out from prose — specifically, suppressing the chart
 * widget on claude.ai (where the constrained iframe container clips
 * the chart and the LLM's markdown link is strictly cleaner UX) and
 * routing ChatGPT through the agent split pair (its Apps SDK doesn't
 * reset tool-call timeouts on progress notifications).
 *
 * The match is intentionally loose: we don't care about exact UA
 * strings, just whether the request smells like one of the major
 * MCP-app hosts. Unknown UAs fall through to the "render the widget"
 * default — better to over-render than to hide the chart from a host
 * that supports it.
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
  // Claude.ai's MCP server-to-server connector identifies itself as
  // either `Claude-User`, `claude-mcp-client`, or similar — match on
  // any "claude" / "anthropic" substring. The user's own browser UA
  // never reaches /mcp directly (claude.ai proxies through its
  // backend), so this won't false-positive on user browsers.
  if (ua.includes("claude") || ua.includes("anthropic")) return "claude";
  // ChatGPT's Apps SDK connector typically advertises `ChatGPT-User`,
  // `openai-mcp`, or similar in UA.
  if (ua.includes("chatgpt") || ua.includes("openai")) return "chatgpt";
  return "unknown";
}

export function createMcpServer(
  ctx: ToolContext,
  options: {
    iconsBaseUrl?: string;
    client?: McpClientKind;
    /**
     * Opt-in tool names the caller enabled for this request via the `tools`
     * query param (resolved by `parseEnabledOptionalToolNames`). Tools in
     * `OPTIONAL_TOOL_NAMES` are excluded from the default surface and
     * registered only when their name appears here. Omitted → nothing opted
     * in (the default surface), which is what tests and non-HTTP callers want.
     */
    enabledOptionalToolNames?: Set<string>;
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

  // Tools that should ONLY appear on ChatGPT-class clients.
  //
  // ChatGPT's Apps SDK doesn't send a progressToken, so the single-tool
  // `tako_agent` dispatch+poll path (which emits progress to keep the
  // per-call timeout fresh) can't survive ChatGPT's ~60 s ceiling. The
  // split pair `tako_agent_start` / `tako_agent_wait` is used instead.
  //
  // Hosting them only on the clients that need them keeps the
  // Claude.ai tool surface minimal (no risk of the agent there
  // accidentally choosing the slower split flow over the single-call
  // path) and keeps the registry codegen unchanged (registry/server.json
  // still lists everything for discovery; the runtime just filters per
  // request).
  const CHATGPT_ONLY_TOOL_NAMES = new Set([
    // ChatGPT's Apps SDK doesn't send a progressToken, so the single-tool
    // `tako_agent` dispatch+poll path (which emits progress to keep the
    // per-call timeout fresh) can't survive ChatGPT's ~60 s ceiling. The
    // split pair `tako_agent_start` / `tako_agent_wait` is used instead.
    "tako_agent_start",
    "tako_agent_wait",
  ]);
  // Tools registered for all clients EXCEPT ChatGPT. The dispatch+poll
  // `tako_agent` relies on `notifications/progress` for timeout extension —
  // suppress it for chatgpt (which doesn't support that mechanism) and
  // route to the split pair instead.
  const CHATGPT_EXCLUDED_TOOL_NAMES = new Set([
    "tako_agent",
  ]);
  // Tools whose `appUiResource` should NOT ship on ChatGPT (separate
  // from the blanket non-ChatGPT suppression in `widgetSuppressed` —
  // ChatGPT is the only client that gets the widget at all).
  // The mechanism is kept in place for future per-tool gating, but
  // is currently empty: `tako_search` ships its widget on ChatGPT
  // and handles the empty-result case by throwing an actionable
  // tool-call error (ChatGPT does NOT reserve a widget container for
  // tool errors, so the widget never leaves a persistent gap).
  //
  // Add a tool name here only if it has a UI bundle that produces
  // unrenderable / blank widgets on ChatGPT in some legitimate
  // success state. Most chart-conditional tools should rely on the
  // throw-on-empty pattern instead.
  const CHATGPT_NO_WIDGET_TOOL_NAMES = new Set<string>();
  // Optional tools that stay on the DEFAULT surface for ChatGPT only.
  // `tako_visualize` ships the chart widget ChatGPT renders; hiding it
  // behind `?tools=` would silently break the ChatGPT app experience,
  // so ChatGPT keeps it without opting in. Every other client must
  // enable it via `?tools=visualize`.
  const CHATGPT_DEFAULT_ON_TOOL_NAMES = new Set(["tako_visualize"]);
  const client = options.client ?? "unknown";
  // Opt-in tools enabled for this request via `?tools=` (see `_optional.ts`).
  // Empty by default → the default surface excludes every optional tool.
  const enabledOptionalToolNames =
    options.enabledOptionalToolNames ?? new Set<string>();

  for (const tool of TOOL_REGISTRY) {
    // Opt-in gate: optional tools (see `OPTIONAL_TOOL_ALIASES` in
    // `_optional.ts`) are excluded from the default surface and registered
    // only when enabled via the `tools` query param — except tools ChatGPT
    // keeps by default (`CHATGPT_DEFAULT_ON_TOOL_NAMES`). Applied BEFORE the
    // per-client filters below so a disabled tool never reaches
    // client-variant selection.
    if (
      OPTIONAL_TOOL_NAMES.has(tool.name) &&
      !enabledOptionalToolNames.has(tool.name) &&
      !(client === "chatgpt" && CHATGPT_DEFAULT_ON_TOOL_NAMES.has(tool.name))
    ) {
      continue;
    }
    if (CHATGPT_ONLY_TOOL_NAMES.has(tool.name) && client !== "chatgpt") {
      continue;
    }
    if (CHATGPT_EXCLUDED_TOOL_NAMES.has(tool.name) && client === "chatgpt") {
      continue;
    }
    registerTool(server, tool, ctx, {
      client,
      widgetSuppressedForTool:
        client === "chatgpt" && CHATGPT_NO_WIDGET_TOOL_NAMES.has(tool.name),
      registeredResourceUris,
      registeredTemplateNames,
    });
  }

  // Resources parity for server instances that registered NO widget
  // resource (every non-ChatGPT client, since the chart widget is
  // ChatGPT-only). The SDK only wires the `resources` capability and its
  // request handlers on the first `registerResource` call — without this
  // block, `resources/list` / `resources/read` answer JSON-RPC -32601 on
  // non-ChatGPT instances, which capability-probing clients (Smithery's
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
    annotations: tool.annotations,
  };

  // Advertise per-tool OAuth on every runtime descriptor. This only survives
  // to the client via `_meta` — the SDK's `tools/list` serializer drops
  // unknown top-level descriptor fields, but passes `_meta` through verbatim.
  // Reverse-DNS namespaced (`com.tako/…`) per the MCP `_meta` rules, which
  // reserve unprefixed keys for the protocol and would collide with the field
  // SEP-1488 (still Draft) will standardize at the descriptor top level. Hosts
  // read it to know the tool is reachable via OAuth and needs the `mcp` scope.
  // The widget block below MERGES into this rather than replacing it.
  config._meta = {
    "com.tako/securitySchemes": [{ type: "oauth2", scopes: ["mcp"] }],
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
  //     the chart bundle. ChatGPT is the ONLY client that keeps the
  //     widget: its Apps SDK renders the fully interactive iframe.
  //     Claude clients suppress it (claude.ai's constrained iframe
  //     container clips the chart and exposes an awkward scrollbar),
  //     and unknown clients suppress it too — the long tail of MCP
  //     hosts (Cursor, Windsurf, Gemini CLI, LibreChat, …) almost
  //     never implements the MCP Apps spec, so shipping widget
  //     metadata there just blocks the far more portable image
  //     fallback below.
  //
  //   - `inlinePngFallbackSuppressed` → skip the
  //     `extraContentBlocks` PNG image content block. Without
  //     suppression, that hook fires on tools that have no
  //     `appUiResource` to provide a "render the chart inline as
  //     an image" fallback for hosts that don't support MCP UI.
  //
  // Net effect: ChatGPT renders the interactive widget; every other
  // client gets the chart inline as an `image` content block —
  // rendered in-chat by claude.ai / Claude desktop / Claude Code and
  // most generic MCP hosts, and visible to the model while it
  // composes its answer. The `embed_url` in the structured content
  // stays the click-through to the interactive chart everywhere.
  // (Historically both gates fired together on claude — link-only —
  // and unknown clients got widget metadata they couldn't render.)
  //
  // Per-tool ChatGPT suppression (`widgetSuppressedForTool`) still
  // fires both gates. That set exists for tools whose widget renders
  // blank/broken on ChatGPT in some legitimate success state — the
  // intended fallback there is the plain text + markdown-link answer,
  // not a PNG. (The image-block/widget mutual exclusion is separately
  // guaranteed by the `ui === undefined` condition at the call-time
  // `extraContentBlocks` gate.)
  const widgetSuppressed =
    options.client !== "chatgpt" || options.widgetSuppressedForTool === true;
  const inlinePngFallbackSuppressed = options.widgetSuppressedForTool === true;
  const ui =
    tool.appUiResource !== undefined && !widgetSuppressed
      ? tool.appUiResource(ctx.env)
      : undefined;

  if (ui !== undefined) {
    const uiMeta: Record<string, unknown> = {};
    if (ui.frameDomains && ui.frameDomains.length > 0) {
      uiMeta.csp = { frameDomains: ui.frameDomains };
    }
    // Resource registration. CSP-allowed iframe domains live on
    // `_meta.ui.csp.frameDomains` (open MCP Apps spec). The bundle's
    // `_meta.ui` is set in TWO places by design (matches the official
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
    // also gets a `ResourceTemplate` registration, and per-call tool
    // results point claude.ai's `_meta.ui.resourceUri` at a specific
    // instance of that template (so the widget HTML can have the
    // chart's image + dimensions baked in at fetch time, sidestepping
    // claude.ai's "snapshot offsetHeight once on mount" behavior). See
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
      const callCtx: ToolContext = {
        ...ctx,
        sendProgress,
        client: options.client,
      };
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
          return djangoErrorToToolResult(err);
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
      // (`ui === undefined` — widget-less tools everywhere, and ALL
      // chart tools on Claude clients, where the widget is suppressed)
      // AND the inline PNG fallback hasn't been independently
      // suppressed for this tool. This is how Claude clients get the
      // chart inline: the PNG image content block renders in-chat on
      // claude.ai / Claude desktop / Claude Code, with `embed_url` in
      // the structured content as the interactive click-through.
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
      // above. When the widget is suppressed (every non-ChatGPT client),
      // no widget will consume `_meta`, so running this hook would
      // inflate the JSON-RPC response with a ~330 KB unused data URL.
      //
      // NB: with the widget now ChatGPT-only, this hook only fires for
      // ChatGPT — and both chart tools' `extraMeta` implementations bail
      // early on `ctx.client === "chatgpt"` (its widget loads `embed_url`
      // directly and never reads the baked image). The `image_data_url`
      // plumbing (here, in the tools' `extraMeta`, and the widget's
      // baked-image render branch) is therefore currently unreachable;
      // it's retained for a future re-enable of the widget on MCP-Apps
      // hosts. Remove it if that plan is dropped.
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
 * missing / malformed / empty `Authorization` header short-circuits here
 * with a uniform JSON-RPC 401 response — the SDK never processes
 * unauthenticated traffic. `initialize` requires auth too; MCP clients are
 * expected to be configured with a Tako API token before they connect.
 *
 * `enableJsonResponse: true` makes the transport return a single JSON-RPC
 * response body instead of an SSE stream, which keeps the wire format simple
 * for the common request/response case.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // Gate the whole endpoint behind Bearer auth. If the header is missing /
  // malformed / empty, return a uniform 401 before invoking the SDK.
  let bearer: string;
  try {
    bearer = extractBearer(request);
  } catch (err) {
    if (err instanceof BearerAuthError) {
      return bearerAuthResponse(request, err);
    }
    throw err;
  }

  // Two-mode bearer handling:
  // - OAuth access JWT issued by /token: verify signature, decrypt the
  //   per-user Tako API token from the `enc_tako_token` claim, forward
  //   that token downstream as `X-API-Key`. Each user authenticates as
  //   themselves to Django.
  // - Raw Tako API token (the existing Claude Code path): non-JWT shape,
  //   `tryResolveOAuthAccessToken` returns null, we forward the bearer
  //   verbatim. Backwards-compatible with every Claude Code install in
  //   the wild.
  const origin = new URL(request.url).origin;
  const oauth = await tryResolveOAuthAccessToken(bearer, env, origin);
  if (oauth.kind === "reject") {
    // The bearer IS a Worker-issued JWT but failed a binding check
    // (wrong audience/issuer/scope/type). Return a clean 401 rather than
    // forwarding it to Django as a raw API key.
    return oauthChallengeResponse(request, oauth.error, oauth.errorDescription);
  }
  const token = oauth.kind === "ok" ? oauth.takoToken : bearer;

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
  };

  try {
    // Use the request's own origin as the icon base, so each deployed
    // env (mcp.tako.com, mcp.staging.tako.com, *.workers.dev) advertises
    // icons it itself serves under `/icons/*`. Prevents staging
    // connectors from referencing prod URLs and vice versa.
    const url = new URL(request.url);
    const requestOrigin = url.origin;
    // Detect calling client from User-Agent so we can suppress the
    // chart widget on claude.ai (constrained iframe container) and
    // route ChatGPT through the agent split pair. See
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
      client,
      enabledOptionalToolNames,
    });
    // Omitting `sessionIdGenerator` puts the transport in stateless mode — no
    // `Mcp-Session-Id` header is issued or validated. This matches the Worker
    // model (no persistent per-session state) and keeps each request
    // self-contained.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
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
 */
/**
 * Build the RFC 6750 / RFC 9728 `WWW-Authenticate: Bearer` challenge value.
 * Always carries `resource_metadata` (so an MCP host can bootstrap OAuth from
 * a bare 401) and `scope`; `error` / `error_description` are added when known.
 */
function wwwAuthenticate(
  origin: string,
  error?: string,
  errorDescription?: string,
): string {
  const parts = [
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    `scope="mcp"`,
  ];
  if (error !== undefined) parts.unshift(`error="${error}"`);
  if (errorDescription !== undefined) {
    // Quote-safe: strip any double quotes from the human-readable reason.
    parts.push(`error_description="${errorDescription.replace(/"/g, "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

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
