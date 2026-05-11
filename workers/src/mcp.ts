import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// No `.js` suffix — the SDK's package.json `exports` map only exposes
// `./validation/cfworker`, unlike the other server subpaths which do ship
// `.js` entries. Adding the extension here breaks module resolution.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

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
} from "./django.js";
import type { Env } from "./env.js";
import { tryResolveOAuthAccessToken } from "./oauth/access.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import type { AnyToolModule, McpClientKind, ToolContext } from "./tools/types.js";

/**
 * Server identity. `registry/server.json` is the canonical source — keep this
 * constant and `workers/package.json#version` aligned with it when bumping.
 * Clients compare what they read from the registry against what `initialize`
 * returns, so a mismatch surfaces as "wrong server" in tooling.
 */
export const SERVER_NAME = "tako-mcp";
export const SERVER_VERSION = "0.1.0";

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
 * routing ChatGPT through the deep-search kickoff/wait pair (its
 * Apps SDK doesn't reset tool-call timeouts on progress
 * notifications).
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
  options: { iconsBaseUrl?: string; client?: McpClientKind } = {},
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
        "Interactive charts and live-data visualizations for finance, economics, demographics, prediction markets, and more.",
      ...(icons !== undefined ? { icons } : {}),
    },
    {
      jsonSchemaValidator: JSON_SCHEMA_VALIDATOR,
    },
  );

  // Dedupe state for `appUiResource` registration — multiple tools can
  // declare the same widget URI (e.g. `open_chart_ui` and
  // `knowledge_search` both register `ui://tako/embed/chart` so they
  // share one bundle). The MCP SDK's `registerResource` throws
  // `Resource <uri> is already registered` on a duplicate URI, and
  // similarly throws on a duplicate template name. The Sets here let
  // each tool still get its `_meta.ui.resourceUri` wired into the
  // tool registration while skipping the redundant `registerResource`
  // call after the first.
  const registeredResourceUris = new Set<string>();
  const registeredTemplateNames = new Set<string>();

  // Tools that should ONLY appear on ChatGPT-class clients. The deep
  // (Orca) async path needs a kickoff/wait pattern on hosts that
  // don't honor MCP `notifications/progress` for tool-call timeout
  // extension (verified for ChatGPT — its Apps SDK doesn't include a
  // progressToken in tools/call requests, so any single-tool deep
  // call dies at the host's default timeout). Claude.ai uses the
  // single-tool `knowledge_search` auto-escalation with progress
  // notifications and never needs these.
  //
  // Hosting them only on the clients that need them keeps the
  // Claude.ai tool surface minimal (no risk of the agent there
  // accidentally choosing the slower kickoff/wait flow over the
  // single-call deep path) and keeps the registry codegen unchanged
  // (registry/server.json still lists everything for discovery; the
  // runtime just filters per request).
  const CHATGPT_ONLY_TOOL_NAMES = new Set([
    "start_deep_knowledge_search",
    "wait_for_knowledge_search",
  ]);
  // Tools whose `appUiResource` should NOT ship on ChatGPT (separate
  // from the blanket claude.ai suppression in `widgetSuppressed`).
  // The mechanism is kept in place for future per-tool gating, but
  // is currently empty:
  //
  //   - `knowledge_search` USED to live here to avoid the empty-fast
  //     widget gap (ChatGPT pins widget container height at the
  //     highest ever notified and ignores later shrinks, so a 0-card
  //     result rendered as an empty container that never collapsed).
  //     The empty path now throws an actionable tool-call error
  //     instead of returning a clean `count: 0`, and ChatGPT does
  //     NOT reserve a widget container for tool errors — so the
  //     inline auto-render works on the success path AND the empty
  //     path no longer leaves a gap. Net win: the gap is fixed
  //     without losing inline charts on success.
  //
  // Add a tool name here only if it has a UI bundle that produces
  // unrenderable / blank widgets on ChatGPT in some legitimate
  // success state. Most chart-conditional tools should rely on the
  // throw-on-empty pattern instead.
  const CHATGPT_NO_WIDGET_TOOL_NAMES = new Set<string>();
  const client = options.client ?? "unknown";

  for (const tool of TOOL_REGISTRY) {
    if (CHATGPT_ONLY_TOOL_NAMES.has(tool.name) && client !== "chatgpt") {
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

  if (tool.outputSchema !== undefined) {
    // Output schemas are optional — only read tools + `create_chart` declare
    // them. In practice every `outputSchema` we ship is `z.object(...)`,
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
  // for this tool call. They're computed identically today (both
  // fire when the client is claude.ai OR a per-tool ChatGPT
  // suppression is set), but kept as separate variables so a future
  // case that wants one without the other (e.g. "ship the widget
  // but no PNG fallback" or "ship the PNG but no widget") becomes
  // a one-line gate change rather than a refactor.
  //
  //   - `widgetSuppressed` → skip `appUiResource`. The host won't
  //     get a widget URI in the tool's `_meta`, so it won't load
  //     the chart bundle. Used on claude.ai (constrained iframe
  //     container clips the chart and exposes an awkward
  //     scrollbar — markdown-link UX is strictly better) and on
  //     `knowledge_search` for ChatGPT (its host pins widget
  //     container height and ignores shrink notifications, so an
  //     empty fast result leaves a persistent gap; render via
  //     `open_chart_ui` instead).
  //
  //   - `inlinePngFallbackSuppressed` → skip the
  //     `extraContentBlocks` PNG image content block. Without
  //     suppression, that hook fires on tools that have no
  //     `appUiResource` to provide a "render the chart inline as
  //     an image" fallback for hosts that don't support MCP UI.
  //     Today we always couple PNG suppression to widget
  //     suppression because the markdown-link directive in the
  //     chart-bearing tool descriptions is the agreed
  //     fallback — shipping a PNG too is redundant and (on
  //     claude.ai) renders cropped the same way the widget
  //     does.
  const widgetSuppressed =
    options.client === "claude" || options.widgetSuppressedForTool === true;
  const inlinePngFallbackSuppressed = widgetSuppressed;
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
      // Fires only when the tool genuinely doesn't define a widget
      // (`appUiResource === undefined`) AND inline PNG fallback
      // hasn't been independently suppressed for this client/tool.
      // On claude.ai (and on `knowledge_search` for ChatGPT) the PNG
      // content-block fallback also rendered cropped / awkward, and
      // the LLM's `[Open in Tako](embed_url)` link is a strictly
      // cleaner answer; we don't want a redundant PNG the user can't
      // really interact with. `inlinePngFallbackSuppressed` is the
      // explicit, separate gate for that — kept distinct from
      // `widgetSuppressed` (the gate above) so a future case that
      // wants one without the other is a one-line change.
      //
      // Pairing image content blocks with widget metadata in the
      // same result also silently disabled ChatGPT's widget data
      // flow, so the gate keeps content-block image fallbacks and
      // widget metadata mutually exclusive.
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
      // above. Both chart-bearing tools (`open_chart_ui`,
      // `knowledge_search`) use `extraMeta` exclusively to ship
      // `image_data_url` for the widget to read via `params._meta`.
      // When the widget is suppressed (claude.ai), no widget will
      // consume `_meta`, so running this hook would inflate the
      // JSON-RPC response with a ~330 KB unused data URL.
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
          // Pass both `input` and `output` to the resolver — tools
          // whose `pub_id` is part of the input (e.g. `open_chart_ui`)
          // ignore `output`; tools that derive the chart pub_id from
          // a search result (e.g. `knowledge_search` →
          // `output.results[0].card_id`, lifted to `output.pub_id`)
          // read it from `output`. Output is `unknown` here because
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
 * Convert a `DjangoError` into a structured MCP `CallToolResult` with
 * `isError: true`. Each subtype maps to a distinct `kind` discriminator so
 * clients can branch on `structuredContent.kind` (e.g. "unauthorized" vs
 * "timeout") instead of parsing `err.message`. Per-subtype fields
 * (`timeoutMs`, `body`) are only attached where they exist on the error.
 *
 * Exported for unit testing — the wire contract is stable enough that
 * Phase 2 tests can rely on the `kind` strings here.
 */
export function djangoErrorToToolResult(err: DjangoError): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const structured: Record<string, unknown> = {
    kind: djangoErrorKind(err),
    path: err.path,
    method: err.method,
  };
  if (err.status !== undefined) structured.status = err.status;
  if (err instanceof DjangoTimeoutError) structured.timeoutMs = err.timeoutMs;
  if (err instanceof DjangoBadRequestError || err instanceof DjangoHttpError) {
    structured.body = err.body;
  }
  // For 400s, splice the response body into the text content. DRF
  // validation errors (missing fields, invalid enum values, bad
  // component config) carry the guidance the LLM needs to retry;
  // keeping it in `structuredContent.body` alone isn't enough because
  // not every MCP client surfaces structured content to the model.
  // Intentionally scoped to `DjangoBadRequestError` — other subtypes
  // (404/401/5xx/timeout) don't carry LLM-actionable detail, so their
  // text stays body-free to keep Workers Logs greppable. `err.message`
  // stays body-free by construction (log-injection guard in
  // `django.ts`); the splice happens here at the MCP boundary.
  const text =
    err instanceof DjangoBadRequestError
      ? `${err.message}: ${err.body}`
      : err.message;
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: true,
  };
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
  const oauthMappedToken = await tryResolveOAuthAccessToken(bearer, env);
  const token = oauthMappedToken ?? bearer;

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
    const requestOrigin = new URL(request.url).origin;
    // Detect calling client from User-Agent so we can suppress the
    // chart widget on claude.ai (constrained iframe container) and
    // route ChatGPT through the deep-search kickoff/wait pair. See
    // `detectMcpClient` for the matching rules.
    const client = detectMcpClient(request.headers.get("user-agent"));
    const server = createMcpServer(ctx, {
      iconsBaseUrl: requestOrigin,
      client,
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
function bearerAuthResponse(request: Request, err: BearerAuthError): Response {
  const origin = new URL(request.url).origin;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
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
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );
}
