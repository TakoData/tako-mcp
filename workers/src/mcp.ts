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
import { logToolRequestId } from "./tools/_log.js";
import { parseEnabledOptionalToolNames } from "./tools/_optional.js";
import { TOOL_REGISTRY } from "./tools/_registry.js";
import {
  authRequiredToolResult,
  securitySchemesForTool,
  withToolSecuritySchemes,
  wwwAuthenticate,
} from "./tools/_security.js";
import {
  annotationClientFamily,
  isChatGptFamilyClient,
  isToolOnSurface,
  isWidgetClient,
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
export const SERVER_VERSION = "0.21.0"; // x-release-please-version

/**
 * Server-level usage guidance, returned as the MCP `instructions` field on
 * the `initialize` result. Claude hosts (claude.ai, Claude Desktop, Claude
 * Code) inject this into the system prompt as "MCP Server Instructions" —
 * far stronger placement than a tool description buried in the tool list,
 * and the reason models otherwise default to their built-in web search
 * even with Tako connected.
 *
 * SCOPE — the rule, and it is a rule rather than a preference: these
 * instructions carry ONLY cross-tool workflow and when-to-choose-this-server
 * knowledge. Anything about how to call one tool belongs in that tool's
 * description, where it is read at the moment it applies.
 *
 * That rule is what removed the pin-form paragraph ("the METRIC node id
 * ALONE, with `strict: true`"). It was the THIRD copy of the same advice —
 * the tool descriptions carry it, and so does every `next_call` the results
 * hand back — and the A/B says the system-level copy does nothing: pinning
 * happened on 12% of runs with it and 11% without. Pinning happens when a
 * tool result hands the model a ready-to-run call, not when the system
 * prompt lectures it about parameters. Restating per-tool mechanics here
 * bought a copy the model pays for on every request, whether or not it ends
 * up calling Tako, and bought no behaviour.
 *
 * Do not re-add it, or the `q` + `metric` split, or response fields, or
 * recovery protocols. If a future edit is tempted, the test is: would this
 * sentence still be true and useful to a model that never calls Tako? Only
 * routing and coverage claims pass.
 *
 * Register is imperative, not expository: state what to do, not what the
 * tool "does". A draft opened a paragraph with "is free and does two
 * jobs", which spends the highest-value tokens on the surface describing
 * the shape of the sentence that follows. Measured against the field:
 * Exa's hosted MCP (mcp.exa.ai, checked 2026-07-31) ships 836 chars of
 * tool description across 2 tools and NO `instructions` at all; its
 * guidance is one imperative per line ("describe the ideal page, not
 * keywords"), never a rationale. We need more than Exa — 4+ tools with
 * non-obvious routing, a proprietary graph whose coverage a model cannot
 * guess, versus their single well-understood job — but not 8x more.
 *
 * Three things ARE load-bearing and must survive future edits:
 *
 *   1. The DOMAIN LIST. It reads like filler and it is the opposite: on a
 *      host with many servers connected, it is the only discovery trigger
 *      Tako has. A tool description cannot do this job, because the model
 *      has to already be looking at Tako's tools to read one. This is the
 *      paragraph that earns the `instructions` field.
 *
 *   2. The web-search claim belongs to TAKO, not to `tako_search`. Both
 *      retrieval tools search the live web, so attaching it to one made
 *      "use tako_search for data questions" the first thing the model
 *      read — which is how these instructions came to contradict every
 *      tool description on the surface.
 *
 *   3. `tako_answer` and `tako_search` are a CHOICE, not a ranking — the
 *      "pick one, don't chain them" phrasing, which is the only line here
 *      with a measured behavioural effect, so keep it verbatim rather than
 *      paraphrased. `tako_available_data` answers coverage questions in its
 *      own right too, not merely as a gate in front of the priced tools:
 *      "what does Tako have on X" is worth asking on its own, and the answer
 *      shapes which metric is worth asking for at all.
 *
 * FRAMED AS SUBSTITUTION, not precedence. The opener used to say "reach for
 * Tako BEFORE a generic web search", which concedes that a generic web search
 * is still a step to take, just a later one, and invites the model to do
 * both in sequence. It now says "instead of a separate web search, not
 * alongside one", and leads with the capability that earns it: Tako searches
 * the live web and the data graph in the SAME call. Reported symptom that
 * motivated this (ChatGPT, Aug 2026): web search fired first even when the
 * user named Tako explicitly.
 *
 * ORDERING, and the one incident this reverses. `tako_available_data` used
 * to be introduced FIRST, ahead of both priced tools, because a version
 * whose opening paragraph routed every data question to `tako_search` and
 * mentioned the free tool once, last, behind "if unsure" produced
 * search-first routing on claude.ai. The fix then was to promote it. The
 * contradiction that caused it is now gone at the source: the opening
 * paragraph names no tool at all, so nothing here competes with the free
 * tool for the first position. It sits last, alongside `tako_contents`, as
 * a capability the model can reach for rather than a step it owes.
 *
 * That also removes a disagreement with its own tool description, which
 * hedged "NOT a required first step" precisely to push back on this
 * paragraph. Instructions outrank descriptions in the host's system prompt,
 * so the two must not argue; the hedge went with the push. If search-first
 * routing returns, promoting this paragraph is the first thing to retry —
 * and the hedge must NOT come back with it, which is the invariant
 * `mcp.test.ts` asserts as a pair rather than as two absences.
 *
 * The same permission lived elsewhere, and review caught that the "it only
 * existed to push back on this paragraph" reasoning above was therefore
 * incomplete: `skills/tako-financial-research/SKILL.md` and
 * `skills/tako-macroeconomics/SKILL.md` each told the model the free tool is
 * "not a warm-up before every lookup" in their own words, neither written
 * against these instructions. Left alone they would have outlived the hedge
 * and disagreed with the description every client reads, so they went too.
 *
 * And then a SECOND review round found the same lines still standing in
 * `README.md`, which embeds all three skills whole for manual claude.ai
 * upload. Do not read a count of surfaces here — an earlier version of this
 * comment claimed "three" and was wrong the moment it was written, because
 * the README copies were never in the count. The count is not the invariant
 * and prose cannot hold it: `workers/scripts/skills.test.ts` now diffs each
 * SKILL.md against its README copy in full, body included, so a routing line
 * changed in one and not the other fails CI instead of shipping.
 *
 * REMOVED DELIBERATELY, not by oversight: the closing hedge "Use a built-in
 * web search when the query is clearly outside Tako's coverage, or Tako
 * returned nothing relevant." The zero-result `guidance` on each tool now
 * says when to pivot off Tako, at the moment it applies and with the actual
 * result in hand, which is strictly better placement than a standing caveat
 * every request pays for. Note the tension this leaves: the paragraph's claim
 * is now unhedged, and the original worry was that over-broad claims erode a
 * model's trust in the whole surface. Watch routing on questions Tako cannot
 * serve; if misrouting shows up, this hedge is the first thing to restore.
 */
const SHARED_INSTRUCTION_PARAGRAPHS = [
  "Tako searches the live web AND a proprietary live-data graph in the same call. Reach for it instead of a separate web search, not alongside one. Default sources are data + web, so one Tako call covers a question that mixes a figure with context: finance, markets, company KPIs, economics, website/app traffic, sports, weather, elections, prediction markets, demographics, energy, real estate, health.",
  "",
  "`tako_answer` and `tako_search` do different jobs, so pick one, don't chain them. `tako_answer` for ONE specific figure. `tako_search` for breadth, or when the chart or embed is the deliverable.",
];

export const SERVER_INSTRUCTIONS = [
  ...SHARED_INSTRUCTION_PARAGRAPHS,
  "",
  "`tako_available_data` is free, and answers what data Tako has on an entity or a metric, including a measure's exact name. `tako_contents` reads one source in full: an exportable card's rows, or a web page's text by url.",
].join("\n");

/**
 * Instructions served to ANONYMOUS (free-tier) connections. Identical to
 * `SERVER_INSTRUCTIONS` except the last paragraph: the authenticated text
 * describes `tako_contents` as if it were callable, but the anonymous
 * surface hides it on most clients — a model given the authenticated
 * paragraph calls a tool that "does not exist" and reads the SDK's
 * unknown-tool error as a server bug. The free variant states the actual
 * toolset and that the rest unlocks with a Tako account, which converts
 * the contradiction into accurate discoverability (and pairs with the
 * pre-dispatch gate in `handleMcpRequest`, which answers such calls with
 * sign-in guidance instead of "tool not found").
 *
 * The shared paragraphs are spread from one array, not copied, so tuning
 * the cross-tool guidance cannot drift the two tiers apart. Authenticated
 * connections keep `SERVER_INSTRUCTIONS` byte-identical — existing
 * integrations see no change.
 */
export const FREE_TIER_SERVER_INSTRUCTIONS = [
  ...SHARED_INSTRUCTION_PARAGRAPHS,
  "",
  // "the tools that run", not "the full toolset": on ChatGPT-family
  // anonymous connections two auth-required tools stay LISTED for the
  // link-account UI (see `CHATGPT_ANONYMOUS_DISCOVERABLE_TOOL_NAMES`), so
  // a toolset-count claim would be false there; what's true on every
  // client is which tools EXECUTE.
  "`tako_available_data` is free, and answers what data Tako has on an entity or a metric, including a measure's exact name. This connection is anonymous: `tako_available_data`, `tako_search`, and `tako_answer` are the tools that run here. Other tools — like `tako_contents`, which reads one source in full (an exportable card's rows, or a web page's text by url) — become available on a connection authenticated with a Tako account.",
].join("\n");

/** The `initialize` instructions for a connection's tier. */
export function serverInstructionsForTier(tier: Tier): string {
  return tier === "free" ? FREE_TIER_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

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
 * the inline PNG `image` content block, and routing the ChatGPT FAMILY
 * (chatgpt.com and the desktop app's codex runtime — see
 * `isChatGptFamilyClient`) through the agent split pair (the Apps SDK
 * doesn't reset tool-call timeouts on progress notifications).
 *
 * INVARIANT: the detected kind is presentation/routing metadata only —
 * it must NEVER feed an authorization decision. The UA is
 * caller-controlled; execution gating keys on tier/token (see the
 * free-tier dispatch gate in `registerTool`), so a spoofed UA can widen
 * what a connection SEES, never what it can EXECUTE.
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
  // The merged ChatGPT desktop app's runtime — one MCP client for desktop
  // Chat/Work threads, Codex tasks, and the headless CLI — sends
  // `codex-mcp-client/<version>` (verified live 2026-08-13 against
  // 0.147.0-alpha.6.6 and 0.148.0-alpha.9; the name is pinned in
  // openai/codex `codex-rs/rmcp-client/src/utils.rs`). Must run BEFORE the
  // ChatGPT block: today's UA contains neither `chatgpt` nor `openai`, but
  // an OpenAI-branded rename (e.g. `openai-codex/…`) would otherwise be
  // swallowed by the `openai` substring match and lose the codex-specific
  // widget handling.
  if (ua.includes("codex")) return "codex";
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

/**
 * May this connection's model-visible errors carry commerce copy (billing
 * remedies, account-management pointers)? An explicit allowlist of
 * POSITIVELY-identified Anthropic clients, deliberately separate from
 * `McpClientKind`: the kind taxonomy is widget/surface routing, and it
 * buckets Claude Code as `"unknown"` on purpose (a terminal renders no
 * widget) — which would strand the flagship raw-Bearer client in the same
 * bucket as OpenAI's crawlers if the commerce gate keyed on
 * `client === "claude"` alone. Reusing a widget-capability signal as a
 * commerce-policy proxy conflates two different populations.
 *
 * Fails CLOSED: `null`, empty, and unrecognized UAs get no commerce copy —
 * an OpenAI reviewer, directory crawler, or a ChatGPT-family UA
 * `detectMcpClient` has not learned yet lands there (the desktop app's
 * `codex-mcp-client` UA did exactly that once), and commerce copy reaching
 * ChatGPT's model violates OpenAI's policy against promoting purchases
 * through an app.
 *
 * Same trust model as `detectMcpClient`: the UA is caller-controlled and
 * this gates COPY only, never execution or spend.
 */
export function commerceCopyAllowedForUa(userAgent: string | null): boolean {
  if (userAgent === null || userAgent === "") return false;
  // Claude Code (and the Agent SDK riding it) — `claude-code/<version>` —
  // is `"unknown"` for widget routing but unambiguously Anthropic here.
  if (userAgent.toLowerCase().includes("claude-code")) return true;
  return detectMcpClient(userAgent) === "claude";
}

/**
 * The client-specific sign-in step appended to `authRequiredToolResult`,
 * or undefined when the client cannot be positively identified as an
 * Anthropic host (fails closed like `commerceCopyAllowedForUa` — an
 * unrecognized UA could be OpenAI's review crawler, and ChatGPT's own
 * link-account UI acts on the `_meta` challenge instead of prose). UA
 * (not `McpClientKind`) is the input because Claude Code deliberately
 * buckets as "unknown" for widget routing yet has a completely different
 * sign-in step (config-file API key) than claude.ai (connector Connect
 * button). No URLs, no UI deep paths beyond the settings pane name —
 * copy rots (see PAYMENT_REQUIRED_REMEDY_FALLBACK).
 */
export function anonymousSignInHint(userAgent: string | null): string | undefined {
  if (userAgent === null || userAgent === "") return undefined;
  if (userAgent.toLowerCase().includes("claude-code")) {
    return "In Claude Code, re-add this Tako server with a Tako API key to enable it.";
  }
  return detectMcpClient(userAgent) === "claude"
    ? "In Claude, open Settings → Connectors and connect Tako, then retry this call."
    : undefined;
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
     * and the free-tier gate in `registerTool`). Resolution order when
     * omitted: `ctx.tier` first, then `"authenticated"` — the fallback
     * to the ToolContext value is deliberate fail-closed behavior, so a
     * caller that declares the tier anywhere engages the dispatch gate
     * (see the resolution + disagreement assertion below). Tests and
     * non-HTTP callers that set neither still get the authenticated
     * full surface.
     */
    tier?: Tier;
    /**
     * Whether model-visible errors may carry commerce copy (billing
     * remedies) — from `commerceCopyAllowedForUa`. Defaults FALSE
     * (fail-closed: tests and non-HTTP callers get the cause-only
     * messages).
     */
    commerceCopyAllowed?: boolean;
    /**
     * Client-specific sign-in step for the free-tier dispatch gate; from
     * `anonymousSignInHint`. Appended to `authRequiredToolResult`'s base
     * text when the calling client is positively identified as an
     * Anthropic host. Omitted (the default) → no hint, byte-identical to
     * today's text — the correct behavior for tests, non-HTTP callers,
     * ChatGPT, and unrecognized UAs.
     */
    signInHint?: string;
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

  // Tier resolution is fail-closed against a future call site that sets
  // the tier only on ToolContext: `options.tier` wins when provided, but
  // an omitted option falls back to `ctx.tier` (NOT straight to
  // "authenticated") — the dispatch gate below is the only execution
  // barrier for auth-required tools, so its input must never silently
  // default permissive when the caller declared a tier anywhere. If both
  // are provided they must agree; a disagreement is a config bug that
  // fails loud rather than picking a side. Resolved BEFORE the server is
  // constructed because the `initialize` instructions are tier-specific.
  if (
    options.tier !== undefined &&
    ctx.tier !== undefined &&
    options.tier !== ctx.tier
  ) {
    throw new Error(
      `createMcpServer: options.tier ("${options.tier}") disagrees with ctx.tier ("${ctx.tier}")`,
    );
  }
  const tier = options.tier ?? ctx.tier ?? "authenticated";

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
      instructions: serverInstructionsForTier(tier),
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
      commerceCopyAllowed: options.commerceCopyAllowed ?? false,
      origin: options.requestOrigin,
      ...(options.signInHint !== undefined
        ? { signInHint: options.signInHint }
        : {}),
      widgetSuppressedForTool:
        isChatGptFamilyClient(client) &&
        CHATGPT_NO_WIDGET_TOOL_NAMES.has(tool.name),
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
 * Keep only the keys the advertised `outputSchema` actually declares.
 *
 * `registerTool` takes a `ZodRawShape`, so the SDK rebuilds our schemas as
 * STRICT `z.object`s and publishes `additionalProperties: false` — the
 * `z.looseObject` looseness we declare them with does not survive
 * registration. Any undeclared key therefore makes a spec-compliant client
 * (the official Python SDK among them) reject the whole result, text block
 * included, on a call the caller has already been billed for.
 */
function pickDeclared(
  schema: AnyToolModule["outputSchema"],
  value: Record<string, unknown>,
): Record<string, unknown> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (shape === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (key in value) out[key] = value[key];
  }
  return out;
}

/**
 * The `structuredContent` for a tool result: the tool's `slimStructured`
 * output when it's declared AND conforms to the advertised `outputSchema`.
 *
 * The conformance parse is what enforces the pairing contract in `types.ts`
 * ("the returned value MUST conform to the tool's advertised
 * `outputSchema`") — five hand-maintained slim/schema pairs across two
 * files, where an unchecked drift ships a result spec-compliant clients
 * reject.
 *
 * DEGRADATION, and why it is not "serve the full output": that fallback was
 * measured to be the worst available option. The full object carries
 * `sources_glossary`, `cards`, `web_results` and more, none of them declared,
 * so against the published `additionalProperties: false` it is guaranteed to
 * be rejected — and a strict client discards the ENTIRE result, including the
 * text block that holds the answer. The failure fires on data-grounded
 * responses (they are the ones with a glossary), so it destroys precisely the
 * good ones.
 *
 * Instead: narrow to the declared keys. That drops the undeclared extras rather
 * than the answer, and it is the ONLY thing standing between a loose slim shape
 * and a published `additionalProperties: false` — which is why it now runs on
 * the success path too, not just on drift.
 *
 * LAST RESORT — narrowing cannot conform (a declared REQUIRED key is missing
 * from the output): the narrowed object ships anyway. This used to omit
 * `structuredContent` on the reasoning that losing the structured channel is
 * cheaper than losing the whole result, and that reasoning was wrong. Both are
 * fatal on a spec-compliant client: the official TS SDK throws
 * "has an output schema but did not return structured content" for a MISSING
 * structuredContent (client/index.js, the `!result.structuredContent` guard)
 * and throws again for a non-conforming one. Omitting therefore buys nothing
 * where it matters, while a PERMISSIVE client gets partial structured data from
 * the narrowed object and nothing at all from omission. Emitting dominates.
 *
 * Unreachable by construction today, and kept only because "unreachable" is a
 * property of the current types rather than of this function: every tool is
 * declared `satisfies ToolModule<…, z.infer<typeof outputSchema>>`, so
 * TypeScript already requires the advertised REQUIRED keys on the handler's
 * return type. Reaching the log line below means a tool's declared shape and
 * its runtime output have drifted apart — a repo bug, not a wire condition.
 * The payload rides in the text channel by design either way. Exported for tests.
 */
export function structuredContentFor(
  tool: Pick<AnyToolModule, "name" | "outputSchema" | "slimStructured">,
  output: unknown,
): Record<string, unknown> {
  const full = output as Record<string, unknown>;
  const narrow = (value: Record<string, unknown>, why: string): Record<string, unknown> => {
    if (tool.outputSchema === undefined) return value;
    const picked = pickDeclared(tool.outputSchema, value);
    if (tool.outputSchema.safeParse(picked).success) return picked;
    console.error(
      `[mcp] ${tool.name}: ${why}, and narrowing to declared keys STILL does not conform — a required declared key is missing from the output. Serving the narrowed object anyway (a spec-compliant client rejects it either way; a permissive one at least gets the fields present). Fix the tool's slim/schema pair.`,
    );
    return picked;
  };

  if (tool.slimStructured === undefined) return narrow(full, "no slimStructured hook");
  let slim: Record<string, unknown>;
  try {
    slim = tool.slimStructured(output);
  } catch (err) {
    console.error(`slimStructured hook failed for ${tool.name}:`, err);
    return narrow(full, "slimStructured threw");
  }
  if (tool.outputSchema !== undefined) {
    const conforms = tool.outputSchema.safeParse(slim);
    if (!conforms.success) {
      console.error(
        `[mcp] slimStructured for ${tool.name} does not conform to its outputSchema:`,
        conforms.error.message,
      );
      return narrow(full, "slim did not conform");
    }
  }
  // A conforming slim can still carry undeclared keys when the tool's OWN
  // output object is passed through (loose zod accepts them); strip them so
  // what ships always matches what was published. Narrowed WITHOUT a re-parse,
  // unlike the degradation paths above: slim has already conformed, and
  // removing keys the schema never declared cannot invalidate it.
  return tool.outputSchema === undefined ? slim : pickDeclared(tool.outputSchema, slim);
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
     * Whether this connection's model-visible errors may carry commerce
     * copy (see `commerceCopyAllowedForUa`). Consumed by the 402 mapping
     * in the catch below.
     */
    commerceCopyAllowed: boolean;
    /**
     * Request origin (e.g. `https://mcp.tako.com`) used to build the
     * `resource_metadata` URL in `_meta["mcp/www_authenticate"]`
     * challenges. `undefined` in tests / non-HTTP contexts — the
     * challenge then omits `resource_metadata` but keeps `error` /
     * `error_description` (the parts ChatGPT's sign-in UI keys on).
     */
    origin: string | undefined;
    /**
     * Client-specific sign-in step appended to `authRequiredToolResult`
     * by the free-tier dispatch gate below (see `anonymousSignInHint`).
     * `undefined` in tests / non-HTTP contexts, on ChatGPT, and on
     * unrecognized UAs — the base text stays byte-identical there.
     */
    signInHint?: string;
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
  // Resolved through `annotationClientFamily` (not the raw kind) so a
  // `chatgpt:` override reaches the whole ChatGPT family — the desktop app
  // (`"codex"`) must see the same descriptions as chatgpt.com, the same way
  // it already resolves the same annotations. Reading `options.client`
  // directly here would silently exempt codex from the first
  // `descriptionByClient` override any tool adds.
  const description =
    tool.descriptionByClient?.[annotationClientFamily(options.client)] ??
    tool.description;
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
    "com.tako/securitySchemes": securitySchemesForTool(tool.name, {
      client: options.client,
      tier: options.tier,
    }),
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
  //         image branch first: the server declares
  //         `csp.frameDomains` identically for every client (see
  //         `buildChartAppUiResource` — it always sets `frameDomains:
  //         [webBase]`), but claude.ai's host-side sandbox currently
  //         restricts third-party iframes regardless of what's
  //         declared there (anthropics/claude-ai-mcp#40, pending
  //         Claude's own MCP Apps security review), so the iframe
  //         never loads on claude.ai today. The bundle's client-side
  //         JS paints the server-fetched `_meta.image_data_url` PNG
  //         (see the `extraMeta` comment below) as the baseline, then
  //         probes the `embed_url` iframe in the background and swaps
  //         it in only if the host's CSP actually lets it load (see
  //         `probeInteractiveIframe` in `_chart_widget.ts`) — so
  //         Claude upgrades to the interactive chart automatically
  //         once Anthropic fixes #40, without a Tako redeploy.
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
  // `isWidgetClient` is the shared definition in `tools/_surface.ts` — the
  // same predicate that decides which clients keep `tako_visualize` on their
  // default surface. Two inlined `client === …` comparisons in two files is
  // how a widget-owning tool ends up registered on a client that never
  // receives widget metadata (or vice versa).
  const widgetSuppressed =
    !isWidgetClient(options.client) || options.widgetSuppressedForTool === true;
  const inlinePngFallbackSuppressed = options.widgetSuppressedForTool === true;
  const ui =
    tool.appUiResource !== undefined && !widgetSuppressed
      ? tool.appUiResource(ctx.env, options.origin)
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
    if (ui.connectDomains && ui.connectDomains.length > 0) {
      csp.connectDomains = ui.connectDomains;
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
        origin: options.origin,
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
        return authRequiredToolResult(options.origin, options.signInHint);
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
          // Log every upstream failure with full routing context BEFORE
          // mapping it into an `isError` result — the mapped result reaches
          // only the client, so this line is the sole server-side record.
          // `err.message` is body-free by construction (log-injection guard
          // in django.ts); the capped body lives in `_meta` client-side only.
          console.error(
            `[mcp] tool error tool=${tool.name} client=${options.client} tier=${callCtx.tier} kind=${djangoErrorKind(err)} status=${err.status ?? "(none)"} method=${err.method} path=${err.path}: ${err.message}`,
          );
          // Credit exhaustion (Django 402) maps per tier. Free tier: the
          // shared account running dry is the tier's expected steady-state
          // failure (the Django-side cap is the fail-open spend backstop),
          // surfaced as the neutral capacity message — the raw billing
          // error would read as a bug to an anonymous user who has no
          // account to top up. Authenticated tier: the caller OWNS the
          // exhausted balance, so the curated message names the cause and
          // the fix instead of the raw "Django returned 402" text (see
          // `paymentRequiredToolResult`). Status 402 is the complete
          // signal (Django's PaymentRequiredError always serves 402);
          // matching on body text would let any 4xx that echoes
          // caller-supplied input masquerade as credit exhaustion.
          if (err instanceof DjangoHttpError && err.status === 402) {
            return callCtx.tier === "free"
              ? freeTierCreditsToolResult(options.commerceCopyAllowed)
              : paymentRequiredToolResult(err, options.commerceCopyAllowed);
          }
          const mapped = djangoErrorToToolResult(err);
          // A 401 from Django on an AUTHENTICATED connection means the
          // caller's own credential was rejected — a stale/revoked OAuth
          // token or a rotated raw API key. Curated text (AUTH_INVALID_MESSAGE)
          // plus the `mcp/www_authenticate` challenge, on EVERY client:
          // ChatGPT keys its re-link UI on the challenge, and hosts that
          // don't understand the `_meta` key ignore it, so attaching it
          // universally costs nothing and future OAuth-capable hosts get it
          // for free. Free-tier connections are excluded: there the
          // rejected credential is the SHARED free-tier key, so "your
          // session expired" would be false for a caller with no session
          // — and funneling anonymous users into (working) sign-in would
          // mask a shared-key outage as a per-user auth failure.
          if (
            options.tier === "authenticated" &&
            err instanceof DjangoUnauthorizedError
          ) {
            return {
              ...mapped,
              content: [{ type: "text" as const, text: AUTH_INVALID_MESSAGE }],
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
        // Non-Django throws (wire-guard drift, handler bugs) re-throw to the
        // SDK, which converts them into client-visible tool text WITHOUT
        // logging — so this line is the only server-side record of them.
        console.error(
          `[mcp] tool error tool=${tool.name} client=${options.client} tier=${callCtx.tier} kind=handler-throw:`,
          err,
        );
        throw err;
      }
      // The upstream correlation id, server-side only. It is deliberately
      // absent from both response channels now (see `_render_markdown.ts`),
      // so this is the sole record that ties a user's complaint about a
      // specific answer to a backend request.
      logToolRequestId(tool.name, options.client ?? "unknown", output);
      // Model-facing text channel: a tool's `renderText` (markdown for
      // prose-heavy results) when declared, else the JSON-stringified
      // output. A throwing renderer degrades to the JSON fallback rather
      // than failing the call.
      let text: string;
      if (tool.renderText !== undefined) {
        try {
          text = tool.renderText(output, callCtx);
        } catch (err) {
          console.error(`renderText hook failed for ${tool.name}:`, err);
          text = JSON.stringify(output, null, 2);
        }
      } else {
        text = JSON.stringify(output, null, 2);
      }
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
          // `undefined` = this call produced nothing to render. Then the
          // result names NO ui resource: pointing at the static bundle
          // regardless (what this used to do) is an instruction to mount a
          // widget for a result that has no chart in it, and on a host with a
          // minimum widget-card height that instruction is exactly the empty
          // grey box users report. A host that decides per RESULT now mounts
          // nothing at all.
          //
          // Hosts that read the URI from `tools/list` registration `_meta`
          // are unaffected — that metadata is static per tool and still
          // declares the widget, because a tool descriptor cannot know
          // whether a future call will have a card. ChatGPT and claude.ai are
          // both in that bucket; their chart-less mount is handled inside the
          // bundle by the labelled empty state in `collapse()`.
          if (resolvedUri !== undefined) {
            resultMeta = {
              ...(resultMeta ?? {}),
              ui: {
                ...((resultMeta?.ui as Record<string, unknown> | undefined) ?? {}),
                resourceUri: resolvedUri,
              },
              "ui/resourceUri": resolvedUri,
            };
          }
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
        // Always present when an outputSchema is advertised: the spec requires
        // it, and the official SDKs throw on its absence just as hard as on a
        // mismatch (see structuredContentFor's LAST RESORT note).
        result.structuredContent = structuredContentFor(tool, output);
      }
      if (resultMeta !== undefined && Object.keys(resultMeta).length > 0) {
        result._meta = resultMeta;
      }
      return result;
    }) as Parameters<McpServer["registerTool"]>[2],
  );
}

/** Upstream statuses that clear on their own: worth one retry of the same
 *  call, as opposed to a 4xx that needs the request changed. Includes 500
 *  (transient handler crash or proxy error) since 5xx bodies are stripped from
 *  the text channel, making the 500 indistinguishable from permanent failure
 *  without the retry sentence — a 500 clears on retry exactly like a 502. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

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
  const base =
    err.modelGuidance !== undefined
      ? err.modelGuidance
      : is4xx && detailText !== undefined
        ? `${err.message}: ${detailText}`
        : err.message;
  // Retryable = a transient HTTP status OR a timeout. DjangoTimeoutError is
  // constructed without a status (there was no response), which used to
  // exclude the single most retry-worthy failure — the 130s search/answer
  // ceilings — from this guidance. The comment above argues this exact case
  // for 408; a timeout is the same condition observed from our side.
  const retryable =
    err instanceof DjangoTimeoutError ||
    (err.status !== undefined && RETRYABLE_STATUS.has(err.status));
  const text =
    err.modelGuidance === undefined && retryable
      ? `${base} This is a transient upstream condition, not a bad request: retry the SAME call once after a short backoff before changing approach.`
      : base;
  return {
    content: [{ type: "text", text }],
    _meta: { "tako/error": detail },
    isError: true,
  };
}

/**
 * Model-visible message for an AUTHENTICATED caller whose own Tako account
 * is out of credits (Django 402). Before this mapping the caller got the
 * raw `djangoErrorToToolResult` text — "Django returned 402 for POST …" —
 * which names an internal, says nothing about credits, and gives the agent
 * no way to tell "needs credits" from "server bug". Unlike the free tier's
 * `FREE_TIER_CREDITS_MESSAGE` (which deliberately masks the cause, because
 * an anonymous caller has no account to top up), an authenticated caller
 * OWNS the exhausted balance, so naming the cause is the actionable answer.
 *
 * States the cause, the retry semantics, and the surviving free move —
 * and deliberately NO remedy. Two different backends emit this 402 with
 * two different remedies (`subscriptions/decorators.py` in the monorepo):
 * `SubscriptionCreditThrottle` drains MONTHLY plan credits that regrant
 * each cycle (remedy: upgrade the plan, or wait for the reset), while
 * `meters_api_credits` gates the prepaid PAYG balance (remedy: add
 * credits). A hand-written remedy here is wrong for one of the two — the
 * first shipped version said "add credits", which a FREE/PRO subscriber
 * cannot do — so the remedy is spliced from the 402 body's own message
 * instead (see `paymentRequiredRemedy`), and only where commerce copy is
 * allowed. "until the account has credits again" is the reset-safe retry
 * phrasing: true across a monthly regrant, a plan change, and a top-up.
 */
export const PAYMENT_REQUIRED_MESSAGE =
  "This Tako account is out of credits, so the call could not run. " +
  "Priced calls will keep failing until the account has credits again; " +
  "`tako_available_data` is free and still works.";

/**
 * Model-visible message for an AUTHENTICATED caller whose Tako credential
 * Django rejected (401) — an expired/revoked OAuth-linked API token, or a
 * raw key the user rotated at tako.com. Before this, only ChatGPT-family
 * clients got recovery guidance (the `mcp/www_authenticate` challenge);
 * everyone else saw the raw "Django returned 401 …" text — internal
 * jargon, no next step, and no host flow triggered because the result is
 * HTTP 200. Names both remedies for the same reason
 * `authRequiredToolResult` does: connector hosts re-link, config-file
 * clients re-key. The free tier NEVER gets this message — there the
 * rejected credential is the shared free-tier key (see the 401 mapping in
 * `registerTool`), and "sign in again" would mask a shared-key outage as
 * a per-user failure.
 */
export const AUTH_INVALID_MESSAGE =
  "This connection's Tako authorization is no longer valid, so the call could not run. " +
  "Calls will keep failing until it is re-authorized: sign in with Tako again " +
  "(reconnect the Tako connector), or update the API key if this connection uses one.";

/**
 * Remedy line appended when the 402 body carries no recognizable message
 * (both real emitters do; this covers shape drift). Bare domain, no path:
 * deep links rot (the `/account/` path the old free-tier upsell used was
 * already stale when it was removed).
 */
export const PAYMENT_REQUIRED_REMEDY_FALLBACK =
  "The account's credits can be managed on tako.com.";

/**
 * The remedy sentence for a 402, taken from Django's OWN response body —
 * `message` (SubscriptionCreditThrottle's `insufficient_credits` shape) or
 * `error_message` (the PAYG `PAYMENT_REQUIRED` shape). The backend knows
 * which ledger ran dry and names the matching remedy ("Upgrade your plan
 * for more credits." / "Add credits to continue."), so splicing beats
 * hand-maintaining a remedy that is wrong for one account type. Callers
 * gate WHERE this appears (commerce-allowed clients only — the backend
 * remedies are promotional copy under OpenAI's policy).
 */
export function paymentRequiredRemedy(body: string | undefined): string {
  if (body !== undefined) {
    try {
      const parsed = JSON.parse(body) as {
        message?: unknown;
        error_message?: unknown;
      };
      for (const candidate of [parsed.message, parsed.error_message]) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
    } catch {
      // Non-JSON body → fallback.
    }
  }
  return PAYMENT_REQUIRED_REMEDY_FALLBACK;
}

/**
 * Convert an authenticated-tier Django 402 into a curated payment-required
 * tool result. Same envelope as `djangoErrorToToolResult` (`isError: true`,
 * text content, `_meta["tako/error"]` detail with the upstream body kept
 * for debugging) with the model-visible text replaced by actionable
 * out-of-credits guidance. The free tier never reaches this — its 402s map
 * to `freeTierCreditsToolResult` first (see the catch in `registerTool`).
 *
 * `commerceCopyAllowed` (from `commerceCopyAllowedForUa`) gates the remedy
 * sentence: Django's own remedies name plan upgrades and credit purchases,
 * which is exactly the copy OpenAI's commerce policy bans from an app —
 * so ChatGPT-family and unrecognized clients get the cause-only message,
 * and positively-identified Anthropic clients get the backend's remedy.
 */
export function paymentRequiredToolResult(
  err: DjangoHttpError,
  commerceCopyAllowed: boolean,
): {
  content: Array<{ type: "text"; text: string }>;
  _meta: Record<string, unknown>;
  isError: true;
} {
  const detail: Record<string, unknown> = {
    kind: "payment_required",
    path: err.path,
    method: err.method,
    status: err.status,
  };
  const body = errorResponseBody(err);
  if (body !== undefined) detail.body = body;
  const text = commerceCopyAllowed
    ? `${PAYMENT_REQUIRED_MESSAGE} ${paymentRequiredRemedy(body)}`
    : PAYMENT_REQUIRED_MESSAGE;
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
 * Every tool name the registry knows, regardless of surface. Built once at
 * module scope — the registry is static.
 */
const REGISTRY_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((tool) => tool.name),
);

/**
 * Pre-SDK gate for anonymous `tools/call`s naming a KNOWN tool that the
 * free tier cannot execute but authentication WOULD unlock. Returns the
 * sign-in guidance as a JSON-RPC tool result, or `null` when the request
 * is not that shape (let the SDK handle it).
 *
 * Why this exists: on non-ChatGPT clients, auth-required tools are hidden
 * from the anonymous surface entirely (see `isToolOnSurface`), so a call
 * to one — typically a model acting on the server instructions or on stale
 * conversation memory of an authenticated session — got the SDK's bare
 * "tool not found". That reads as "this tool does not exist", when the
 * truth is "sign in and it works", a dead end the model cannot correct.
 * This gate answers with the SAME `authRequiredToolResult` the ChatGPT
 * dispatch gate in `registerTool` uses, so every client gets readable,
 * actionable text (the `_meta["mcp/www_authenticate"]` challenge it
 * carries is what ChatGPT's link UI keys on; other hosts ignore unknown
 * `_meta`). The tools stay UNLISTED on non-ChatGPT anonymous surfaces —
 * the original anti-turn-waste rationale was about listing, not about
 * answering an explicit call helpfully.
 *
 * Scope guards, in order:
 * - only single `jsonrpc: "2.0"` `tools/call` bodies (other methods,
 *   batches, envelope-less shapes: not ours — the SDK rejects those with
 *   the right error itself);
 * - only names outside `FREE_TIER_TOOL_NAMES` (free tools proceed);
 * - only names the registry KNOWS (a typo'd name falls through to the
 *   SDK's genuine unknown-tool error — claiming a nonexistent tool needs
 *   auth would send the caller on a pointless sign-in);
 * - only names on THIS connection's AUTHENTICATED surface (same client,
 *   same `?tools=` opt-ins, tier flipped) — the sign-in promise must be
 *   true. `tako_agent` without `?tools=agent`, or the ChatGPT-only split
 *   pair on a Claude client, would still be "tool not found" after
 *   signing in, so promising auth there just moves the dead end one
 *   sign-in later; those fall through to the SDK's accurate not-found.
 * - only well-formed ids (without one, no valid result can be addressed;
 *   the SDK rejects the shape itself).
 *
 * Probing note: this gate lets an anonymous caller distinguish known
 * from unknown tool names, which discloses nothing — the full tool list
 * is published in `registry/server.json` and anonymous `tools/list`
 * already works.
 *
 * Metering note: these calls were never per-IP metered (see
 * `isMeteredJsonRpcBody`) and still aren't — the global ceiling already
 * counted the request before admission returned.
 */
export function freeTierHiddenToolResponse(
  body: unknown,
  origin: string,
  client: McpClientKind,
  enabledOptionalToolNames: ReadonlySet<string>,
  signInHint?: string,
): Response | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { jsonrpc, method, params, id } = body as {
    jsonrpc?: unknown;
    method?: unknown;
    params?: unknown;
    id?: unknown;
  };
  if (jsonrpc !== "2.0") return null;
  if (method !== "tools/call") return null;
  if (typeof params !== "object" || params === null) return null;
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  if (FREE_TIER_TOOL_NAMES.has(name)) return null;
  if (!REGISTRY_TOOL_NAMES.has(name)) return null;
  if (!isToolOnSurface(name, client, enabledOptionalToolNames, "authenticated")) {
    return null;
  }
  if (typeof id !== "string" && typeof id !== "number") return null;
  // Same greppable signal as the dispatch gate in `registerTool`, with a
  // marker for which layer answered.
  console.log(
    `[mcp] auth-required tool blocked on free tier tool=${name} client=${client} layer=pre-dispatch`,
  );
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: authRequiredToolResult(origin, signInHint),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
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
    //
    // The commerce flag gates the account-upsell suffix on the two limit
    // messages (see `FREE_TIER_COMMERCE_UPSELL`). Computed here AND at
    // `createMcpServer` below; `commerceCopyAllowedForUa` is pure, so the
    // double call cannot disagree (same reasoning as `detectMcpClient`).
    const commerceCopyAllowed = commerceCopyAllowedForUa(
      request.headers.get("user-agent"),
    );
    const meterResult = await checkFreeTierRateLimit(request, freeTier);
    switch (meterResult.kind) {
      case "global_limited":
        return freeTierGlobalLimitResponse(
          meterResult.requestId,
          commerceCopyAllowed,
        );
      case "too_large":
        return freeTierTooLargeResponse();
      case "batch":
        return freeTierBatchResponse();
      case "limited":
        return freeTierLimitResponse(meterResult.requestId, commerceCopyAllowed);
      case "allowed": {
        // Known-but-auth-required tool called anonymously: answer with
        // sign-in guidance instead of letting the SDK say "tool not
        // found" (see `freeTierHiddenToolResponse`). Client detection and
        // `?tools=` parsing are re-run later on the SDK path with logging;
        // both are pure, so the double call cannot disagree.
        const gated = freeTierHiddenToolResponse(
          meterResult.body,
          origin,
          detectMcpClient(request.headers.get("user-agent")),
          parseEnabledOptionalToolNames(
            new URL(request.url).searchParams.get("tools"),
          ),
          anonymousSignInHint(request.headers.get("user-agent")),
        );
        if (gated !== null) return gated;
        break;
      }
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
    // widget to widget clients (see `isWidgetClient`; unknown clients
    // fall back to the inline PNG) and route the ChatGPT family — both
    // chatgpt.com and the desktop app — through the agent split pair.
    // See `detectMcpClient` for the matching rules.
    const userAgent = request.headers.get("user-agent");
    const client = detectMcpClient(userAgent);
    // Log the RAW User-Agent next to the kind it resolved to, once per
    // request. The UA is the only per-request client-identity signal we have
    // (stateless transport: `initialize`'s `clientInfo` does not ride along on
    // the later `tools/list` / `tools/call` POSTs), and `McpClientKind` decides
    // the tool SET, widget registration, image content blocks, annotation
    // labels, and the ChatGPT `securitySchemes` injection. A UA that
    // `detectMcpClient` fails to recognize therefore degrades all five at once
    // — silently, and to a surface that still works, which is exactly why it
    // can go unnoticed.
    //
    // Until now nothing logged the UA itself: `detectMcpClient`'s own docblock
    // asks for the real ChatGPT connector UA to be "confirmed against
    // production request logs", and no such confirmation was possible, because
    // the only ChatGPT-linked log line (`securitySchemes injected`) proves a
    // match and says nothing when the match FAILS. One `wrangler tail` while a
    // client connects now answers it.
    //
    // JSON.stringify, not raw interpolation: the UA is caller-controlled, and
    // an embedded newline would otherwise forge a second log line (same
    // log-injection reasoning as `django.ts`). Capped because a UA is
    // untrusted length, not because any real one is long.
    console.log(
      `[mcp] request client=${client} ua=${JSON.stringify(
        (userAgent ?? "(absent)").slice(0, 200),
      )}`,
    );
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
    const signInHint = anonymousSignInHint(userAgent);
    const server = createMcpServer(ctx, {
      iconsBaseUrl: requestOrigin,
      requestOrigin,
      client,
      enabledOptionalToolNames,
      tier,
      commerceCopyAllowed: commerceCopyAllowedForUa(userAgent),
      ...(signInHint !== undefined ? { signInHint } : {}),
    });
    // Omitting `sessionIdGenerator` puts the transport in stateless mode — no
    // `Mcp-Session-Id` header is issued or validated. This matches the Worker
    // model (no persistent per-session state) and keeps each request
    // self-contained.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    // The SDK's default error sink is a no-op (`this.onerror?.(error)`), so
    // protocol- and transport-level failures — failed response sends, unknown
    // message types, notification enqueue errors — vanish without these.
    server.server.onerror = (error) => {
      console.error("[mcp] protocol error:", error);
    };
    transport.onerror = (error) => {
      console.error("[mcp] transport error:", error);
    };

    await server.connect(transport);
    // Cloned before the transport consumes the body so the observability tap
    // below can re-read the call when the SDK rejects it.
    const requestForLogging = request.clone();
    try {
      const response = await transport.handleRequest(request);
      await logSdkValidationRejections(requestForLogging, response);
      // ChatGPT-family compatibility adapter: rewrite the buffered
      // `tools/list` response to carry the top-level `securitySchemes`
      // field the Apps SDK reads (the MCP SDK cannot serialize unknown
      // descriptor fields — see `tools/_security.ts`). The desktop app
      // (`"codex"`) reads the same field for its connector link-account
      // flow. Every other client gets the SDK's response untouched.
      return isChatGptFamilyClient(client)
        ? await withChatGptToolSecuritySchemes(response, tier, client)
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
  tier: Tier,
  // The DETECTED client, threaded through so the scheme derivation and the
  // log line below carry the real kind. Hardcoding "chatgpt" here was
  // functionally identical (the caller already gates on the ChatGPT
  // family, and `securitySchemesForTool` branches on the same predicate)
  // but it made codex traffic log as chatgpt — hiding codex adoption and
  // codex UA drift from `wrangler tail` — and would silently misroute the
  // day the two family members diverge in `securitySchemesForTool`.
  // REQUIRED (no `= "chatgpt"` default): the schemes body is byte-identical
  // for the two family members today, so nothing asserts this argument —
  // a default would let a revert to a hardcoded kind pass the whole suite
  // while silently flattening the log line's client dimension.
  client: McpClientKind,
): Promise<Response> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return response;
    const body = (await response.clone().json()) as unknown;
    const transformed = withToolSecuritySchemes(body, {
      client,
      tier,
    });
    if (transformed === body) return response;
    // Positive rollout/observability signal: this line appearing in
    // `wrangler tail` proves the UA resolved to a ChatGPT-family client
    // AND the injection ran. Its ABSENCE while ChatGPT sign-in misbehaves
    // points straight at `detectMcpClient` (e.g. a connector UA change) —
    // without it, a UA miss is indistinguishable from "ChatGPT changed
    // something" (review finding on PR #183).
    console.log(
      `[mcp] tools/list securitySchemes injected client=${client} tier=${tier}`,
    );
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
