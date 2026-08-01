/**
 * Shared chart-widget plumbing used by `tako_search`.
 *
 * `tako_search` renders the top result's Tako chart card inline by
 * auto-chaining `cards[0].card_id` into the widget. Rather than inline the
 * ~600-line widget HTML, the PNG fetch helpers, and the ChatGPT/claude.ai
 * host quirks into the tool file (where they'd drift the next time a host
 * bug needs a fix), the shared surface lives here:
 *
 *   - URL builders (`buildChartUrls`) — the only place that knows how to
 *     compose `/embed/{pub_id}/` web URLs and `/api/v1/image/{pub_id}/`
 *     PNG URLs from `Env`. Both web and API origins are validated http(s)
 *     and trailing-slash-clean by `resolvePublicBase` / `resolvePublicApiBase`.
 *
 *   - PNG fetch utilities (`fetchImageDataUrlAndDims`,
 *     `fetchPngContentBlock`) — the actual cross-origin reads of Tako's PNG
 *     endpoint, with timeout, content-type validation, oversize bail, and
 *     PNG-IHDR dimension parsing. Each tool's `extraMeta` /
 *     `extraContentBlocks` hook calls these directly.
 *
 *   - Widget bundle (`buildChartAppUiResource`) — the
 *     `ui://tako/embed/chart` resource: static `WIDGET_HTML` for ChatGPT's
 *     iframe path, plus the dynamic `ui://tako/embed/chart/{pub_id}`
 *     template for claude.ai's image-baked variant. `tako_search`
 *     registers this URI; `mcp.ts`'s registration loop dedupes repeat
 *     registrations of the same URI so the SDK doesn't throw on duplicate.
 *
 *   - Default chart-output dimensions (`DEFAULT_DARK_MODE`, …) — the
 *     defaults applied when `tako_search` auto-chains the top card (the
 *     search input has no chart-options field).
 *
 * The widget HTML and its host-quirk code are a verbatim extraction of the
 * original inline chart-rendering implementation.
 */
import { type Env, resolvePublicApiBase, resolvePublicBase } from "../env.js";
import type {
  AppUiResource,
  ToolContext,
  ToolContentBlock,
} from "./types.js";

// Tighter than `z.string().url()` — Zod's URL check accepts `javascript:`,
// `data:`, and other non-web schemes. Both URLs flow to a browser
// (markdown image src / link href), so constrain to http(s).
export const HTTP_URL_REGEX = /^https?:\/\//;

// Cap how big a PNG we'll inline as an `image` content block. Above this
// we skip and rely on the URL-only fallback. Two reasons: (1) base64
// inflates ~33%, so a 5 MB PNG becomes ~7 MB in the response — past the
// practical limit some MCP clients tolerate before truncating or
// stalling; (2) Workers' response size guidance discourages large
// bodies. Tako chart PNGs run 50-300 KB, so 4 MB is generous headroom
// that still trips pathological cases.
export const MAX_INLINE_PNG_BYTES = 4 * 1024 * 1024;

// Cap for inline `image_data_url` in `_meta` — distinct from
// `MAX_INLINE_PNG_BYTES`. Sized to cover the real chart range: Tako
// chart PNGs run 50-300 KB, and this data URI is now Claude's PRIMARY
// chart path (claude.ai's outer CSP blocks the cross-origin `image_url`
// fallback), so a cap below 300 KB silently drops the largest charts to
// a text link there. 400 KB raw (~533 KB encoded) covers the range with
// headroom.
//
// Why the old 250 KB cap is safe to lift: `_meta` is not tokenized by
// the model, and the ~400 KB-encoded silent widget-data failure that
// motivated it was observed on ChatGPT — whose `extraMeta` hook is now
// skipped entirely (see tako_search/tako_visualize), so this field never
// ships there. The remaining ceiling is the host's message-size limit;
// the staging ">250 KB chart renders on claude.ai" check is the
// empirical gate on this number.
// Charts above the cap fall back to `image_url` only, which is fine for
// hosts whose CSP allows cross-origin images but means claude.ai users
// see no chart — keep the cap comfortably above real chart sizes.
export const MAX_INLINE_DATA_URL_BYTES = 400 * 1024;

// Bound how long we'll wait on the PNG endpoint before giving up. The
// content block / data URL is "nice to have" — better to ship the URL
// fallback quickly than block the whole tool call on a slow render.
export const PNG_FETCH_TIMEOUT_MS = 8_000;

/**
 * MCP Apps widget URI. Stable — DO NOT bump.
 *
 * We tried suffixing with `/v2` to bust ChatGPT's sticky resource
 * cache (which doesn't clear on disconnect+reconnect). It didn't help
 * ChatGPT (their data-flow problem is separate from resource caching)
 * AND it broke the Claude desktop app: Claude desktop caches resource
 * URIs at the connector level beyond connector lifecycle, so renaming
 * the URI made every previously-installed Claude desktop session 404
 * with `MCP error -32602: Resource ui://tako/embed/chart not found`.
 * Lesson: once a URI ships, it's effectively permanent. If the bundle
 * needs cache-busting in the future, register a NEW URI alongside the
 * old one rather than replacing it.
 */
export const APP_UI_RESOURCE_URI = "ui://tako/embed/chart";
export const APP_UI_RESOURCE_NAME = "open_chart_ui_widget";

/**
 * URI template (RFC 6570) for the dynamic-resource variant. Each
 * `tools/call` resolves `{pub_id}` to a specific instance like
 * `ui://tako/embed/chart/abc123`, and the host fetches that instance
 * via `resources/read`. The template's read callback in `mcp.ts`
 * fetches the chart PNG, parses dimensions, and bakes everything into
 * the widget HTML so the document height is correct on the host's
 * first `documentElement.offsetHeight` snapshot.
 *
 * Used by claude.ai (read from per-call `_meta.ui.resourceUri`).
 * ChatGPT continues to load the static `APP_UI_RESOURCE_URI` widget
 * via `_meta["openai/outputTemplate"]` so its iframe path stays
 * interactive.
 */
export const APP_UI_TEMPLATE_URI_PATTERN = "ui://tako/embed/chart/{pub_id}";
export const APP_UI_TEMPLATE_NAME = "open_chart_ui_widget_baked";

// Defaults used when a caller doesn't supply chart-options — applied when
// `tako_search` auto-chains the top card into the inline-render widget.
export const DEFAULT_DARK_MODE = true;
export const DEFAULT_WIDTH = 900;
export const DEFAULT_HEIGHT = 720;

// Assumed default chat-widget pixel width when computing the baked
// widget's initial height from PNG dimensions. Real iframe widths vary
// by host (Claude ~700-800, ChatGPT ~600-700, claude.ai mobile ~360);
// 800 is a slight over-estimate so the body height comes out a hair
// taller than the rendered image — small white space below is benign,
// scrollable overflow inside the widget is not.
const ASSUMED_WIDGET_WIDTH_PX = 800;

/**
 * HTML-escape a string for safe interpolation into attribute values
 * or text content. Base64 data URIs and standard URLs don't normally
 * contain unsafe chars, but defensive escaping costs ~nothing and
 * shields against any future upstream change that might inject
 * angle-brackets or quotes into one.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the "baked" widget HTML for one specific chart — image data
 * URI, dimensions, and embed URL all inlined into the markup so the
 * widget mounts with the chart already in the DOM. No handshake, no
 * postMessage data flow, no `_meta` smuggling.
 *
 * Why this path exists: claude.ai's host wraps the widget iframe in
 * a parent container sized once from `documentElement.offsetHeight`
 * at mount and doesn't re-poll (anthropics/claude-ai-mcp#69). Any
 * height set after `tool-result` arrives is too late. Baking the
 * image into the resource HTML so it's already in the DOM when the
 * host snapshots gives the correct height on the first read.
 */
function buildBakedWidgetHtml(opts: {
  embedUrl: string;
  imageDataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
}): string {
  const initialHeight = Math.round(
    (ASSUMED_WIDGET_WIDTH_PX / opts.naturalWidth) * opts.naturalHeight,
  );
  const safeEmbedUrl = htmlEscape(opts.embedUrl);
  const safeDataUrl = htmlEscape(opts.imageDataUrl);
  // Sizing strategy: declare the PNG's intrinsic `width`/`height` on the
  // <img> so the browser reserves the correct aspect-ratio space at
  // layout time (before bytes decode), then let `<body>` size to its
  // content. `documentElement.offsetHeight` then returns the image's
  // *actual* rendered height at whatever width claude.ai gave the
  // iframe — instead of a hardcoded estimate that assumed an 800px
  // iframe and clipped the bottom on wider claude.ai columns.
  //
  // `min-height: ${initialHeight}px` is a safety floor: if claude.ai
  // measures while the iframe is still at zero width, the image would
  // be 0×0 and body would collapse — the floor keeps the snapshot in
  // the right ballpark for that case (slight over-size at narrow
  // widths is benign; cropping at wide widths is not). Body background
  // pinned to a Tako-card-ish dark gray so the rounded corners on the
  // chart card image don't show iframe-default white through.
  return `<!doctype html>
<html lang="en" style="min-height: ${initialHeight}px;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-tako-widget" content="open_chart_ui_baked/v1" />
<title>Tako chart</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: #0f1115; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
  #tako-embed-link { display: block; cursor: pointer; text-decoration: none; }
  #tako-embed-link:hover #tako-embed-img { opacity: 0.95; }
  #tako-embed-img { width: 100%; height: auto; display: block; background: transparent; transition: opacity 120ms ease-out; }
</style>
</head>
<body style="min-height: ${initialHeight}px;">
<a
  id="tako-embed-link"
  target="_blank"
  rel="noopener noreferrer"
  title="Open interactive chart"
  href="${safeEmbedUrl}"
><img id="tako-embed-img" alt="Tako chart" width="${opts.naturalWidth}" height="${opts.naturalHeight}" src="${safeDataUrl}" /></a>
<script>
(function(){
  "use strict";
  function notify(){
    var h = document.documentElement.offsetHeight;
    // ChatGPT Apps SDK mechanism.
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        if (h > 0) window.openai.notifyIntrinsicHeight(h);
      }
    } catch (e) { /* host gone — nothing to do */ }
    // MCP Apps open-spec mechanism (claude.ai, VS Code Insiders, Goose):
    // the static widget's notifyHeight sends this same notification —
    // mirrored here so open-spec hosts get sizing info from the baked
    // per-pub_id variant too, not just the static iframe/img bundle.
    // Hosts that don't implement it (ChatGPT) ignore unknown messages.
    try {
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: {
          width: (document.documentElement && document.documentElement.clientWidth) || 0,
          height: h,
        },
      }, "*");
    } catch (e) { /* host gone — nothing to do */ }
  }
  notify();
  window.addEventListener("resize", notify);
  // The script runs before the <img> has necessarily loaded, so the
  // initial notify() can measure a pre-layout height (the explicit
  // width/height attributes reserve layout in most cases, but not when
  // width:100% shrinks the image in a narrow container). Re-notify once
  // the image has real dimensions — mirrors the static variant's load
  // listener.
  var img = document.getElementById("tako-embed-img");
  if (img) img.addEventListener("load", notify);
})();
</script>
</body>
</html>`;
}

/**
 * Render a fallback widget when we couldn't fetch the chart image.
 * Shows a "click to open" link so the user has at least one path to
 * the chart, instead of a blank widget.
 */
function buildFallbackWidgetHtml(embedUrl: string, message: string): string {
  const safeEmbedUrl = htmlEscape(embedUrl);
  const safeMessage = htmlEscape(message);
  return `<!doctype html>
<html lang="en" style="height: 240px;">
<head>
<meta charset="utf-8" />
<meta name="x-tako-widget" content="open_chart_ui_baked_fallback/v1" />
<title>Tako chart</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: #0f1115; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
  .wrap { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; height: 100%; padding: 24px; box-sizing: border-box; text-align: center; }
  a { color: #4aa9ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body style="height: 240px;">
<div class="wrap">
  <p>${safeMessage}</p>
  <a href="${safeEmbedUrl}" target="_blank" rel="noopener noreferrer">Open interactive chart →</a>
</div>
</body>
</html>`;
}

/**
 * Bundle the host loads into a sandboxed iframe. One thin `<iframe>`
 * pointing at Tako's existing `/embed/{pub_id}` page — we delegate
 * rendering, zoom/pan/hover, and resize to that page rather than
 * reimplementing chart UI inside the widget.
 *
 * Wire protocol: the host posts JSON-RPC `ui/notifications/tool-result`
 * messages whose `params` contain `structuredContent` from the most
 * recent `tools/call`. We read `embed_url` (already validated http(s) by
 * the tool's output schema) and update `iframe.src`. `embed_url` carries
 * the theme query and pub_id encoding the handler computed, so the
 * widget never builds URLs itself — the security boundary stays
 * server-side.
 *
 * Defense-in-depth: re-validate `embed_url` is http(s) before assigning
 * to `iframe.src`. A hostile MCP server could ship a `javascript:` URL
 * that, without this check, would execute in the widget origin once
 * dropped into `src`. The handler validates too, but the widget is the
 * last hop before the DOM, so duplication is justified.
 */
const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-tako-widget" content="open_chart_ui/v1" />
<title>Tako chart</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: transparent; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
  #tako-embed { width: 100% !important; border: 0 !important; display: block; background: transparent; }
  #tako-embed-link { display: block; cursor: pointer; text-decoration: none; }
  #tako-embed-link:hover #tako-embed-img { opacity: 0.95; }
  #tako-embed-img { width: 100%; height: auto; display: block; background: transparent; transition: opacity 120ms ease-out; }
  #tako-placeholder {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 240px;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<!-- Placeholder is hidden by default — the widget starts at zero
     height and only grows once a chart actually arrives. Reason:
     ChatGPT's widget container appears to pin the initial intrinsic
     height as a floor and ignore later shrink notifications, so any
     visible-by-default placeholder leaves a persistent empty box for
     tool calls that never deliver chart data (e.g. a search that
     returns zero cards). Trade-off: brief blank window
     between widget mount and chart data arrival on hosts with slow
     postMessage delivery (~200 ms on claude.ai); ChatGPT's
     window.openai.toolOutput is synchronous so no visible flash.
     The chart-rendering paths (iframe / img.load / iframe-fallback)
     un-hide the relevant element AND notifyHeight(actual height) in
     lockstep, so the widget grows naturally on success. -->
<div id="tako-placeholder" class="hidden">Loading chart…</div>
<iframe
  id="tako-embed"
  class="hidden"
  scrolling="no"
  frameborder="0"
  allow="fullscreen"
  title="Tako chart"
></iframe>
<a
  id="tako-embed-link"
  class="hidden"
  target="_blank"
  rel="noopener noreferrer"
  title="Open interactive chart"
><img id="tako-embed-img" alt="Tako chart" /></a>
<script>
(function () {
  "use strict";
  var frame = document.getElementById("tako-embed");
  var image = document.getElementById("tako-embed-img");
  var imageLink = document.getElementById("tako-embed-link");
  var placeholder = document.getElementById("tako-placeholder");
  var rendered = false;
  // Origin of the iframe we loaded — used to gate the height handshake
  // listener below so we only honor resize messages from the actual
  // embed page, not arbitrary cross-frame senders.
  var embedOrigin = null;

  // How long an embed iframe gets to fire \`load\` before we decide it never
  // will. Shared by both directions — \`probeInteractiveIframe\` (does this
  // host allow the iframe at all?) and \`watchCommittedIframe\` (did the
  // iframe we already showed actually render?) — so the two can't drift.
  // A CSP block reports itself almost immediately via
  // \`securitypolicyviolation\`, so this bound only governs the slow cases:
  // suppressed violation events, network stalls, an endpoint that hangs.
  var IFRAME_SETTLE_MS = 8000;

  // Pin the embed/probe iframe to an explicit pixel height. Hosts vary in
  // which of the three they read (inline \`style.height\`, the
  // \`min-height\` floor, and the \`height\` attribute), so set all three
  // together. One helper so the next height gotcha is a one-line fix
  // instead of the four separate inlined call sites this replaces.
  function setFrameHeight(n) {
    frame.style.height = n + "px";
    frame.style.minHeight = n + "px";
    frame.setAttribute("height", String(n));
  }

  // Record the embed iframe's origin so the \`tako-embed-height\` resize
  // handler will honor messages from it. Only arm this once the embed is
  // the VISIBLE surface (an immediate iframe render, or a probe that has
  // upgraded) — arming it while a probe frame is still hidden behind the
  // PNG would let a background embed resize the widget under a chart the
  // user is looking at.
  function armEmbedOrigin(url) {
    try { embedOrigin = new URL(url).origin; } catch (e) { embedOrigin = null; }
  }

  // Pick the rendering mode by CAPABILITY, not host identity.
  //
  // ChatGPT's Apps SDK runtime exposes \`window.openai\`; its outer
  // sandbox CSP honors our \`frameDomains\` declaration and lets the
  // cross-origin \`<iframe src=https://staging.trytako.com/embed/...>\`
  // load fully interactive — commit to the iframe immediately there.
  //
  // Every other host renders the static PNG first (the baseline that
  // always works) and then PROBES the embed iframe in the background
  // via \`probeInteractiveIframe\`, swapping it in only if the embed
  // actually loads. Rationale: claude.ai today enforces a hardcoded
  // \`frame-src 'self' blob: data:\` outer CSP that ignores declared
  // \`csp.frameDomains\` (anthropics/claude-ai-mcp#40 — spec violation,
  // acknowledged, pending their MCP Apps security review), so the
  // iframe shows Chrome's "This content is blocked" placeholder
  // (confirmed via DevTools 2026-04-29 on claude.ai web). But that's a
  // host bug with a pending fix: keying the branch on "is this
  // ChatGPT" would keep Claude on the static PNG even after Anthropic
  // ships it. Probing means the interactive path lights up on any
  // host the moment its CSP allows it, with no Tako redeploy — and the
  // CSP violation event fires ~immediately on blocking hosts, so
  // today's PNG experience is unchanged.
  function hasOpenAiRuntime() {
    try {
      return typeof window.openai !== "undefined";
    } catch (e) {
      return false;
    }
  }

  // One probe per widget lifetime. \`render()\` is one-shot via the
  // \`rendered\` flag, but guard independently so a duplicate
  // tool-result delivery racing the flag can't double-assign
  // \`frame.src\`.
  var probeStarted = false;
  // Flips true once the probe has swapped the interactive iframe in over
  // the PNG. The image \`load\`/\`error\` handlers check it and no-op after
  // an upgrade so a stray duplicate image event can't re-reveal the PNG
  // on top of the live iframe.
  var probeUpgraded = false;

  // Try to load \`url\` in the (still hidden) chart iframe and swap it
  // in over the already-rendered PNG if it genuinely loads.
  //
  // Success signal: the iframe \`load\` event. A cross-origin frame's
  // content is unreadable, but \`load\` only fires when a document
  // actually loaded — CSP-blocked loads never make the request, so
  // they never fire it.
  //
  // Failure signals, either of:
  //  - \`securitypolicyviolation\` for \`frame-src\` on this document —
  //    the definitive "host sandbox blocked it" signal.
  //  - No \`load\` within the timeout — covers hosts that suppress
  //    violation events and plain network stalls.
  //
  // On failure the widget stays on the PNG it already painted; the
  // probe frame is unloaded so nothing can later surface a blocked
  // tile.
  function probeInteractiveIframe(url, fallbackHeight) {
    if (probeStarted) return;
    probeStarted = true;
    var settled = false;
    var timer = null;
    // Flips true the instant we navigate the probe frame to \`url\`, and
    // back to false before \`fail()\` sends it to about:blank. \`onLoad\`
    // gates on this rather than \`frame.src === url\`: \`frame.src\` reads
    // back the browser-NORMALIZED URL (\`https://tako.com:443\` collapses
    // to \`https://tako.com\`, the host lowercases), so a raw-string
    // compare against \`url\` can silently never match — stranding every
    // render on the 8 s timeout on any host whose \`embed_url\` origin
    // isn't already normalized.
    var probeNavigated = false;
    function cleanup() {
      settled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      frame.removeEventListener("load", onLoad);
    }
    function fail(reason) {
      if (settled) return;
      cleanup();
      embedOrigin = null;
      probeNavigated = false;
      frame.src = "about:blank";
      log("iframe probe failed, staying on image", { reason: reason });
    }
    function succeed() {
      if (settled) return;
      cleanup();
      probeUpgraded = true;
      // Swap at the image's CURRENT rendered height, not the tool's
      // requested height: claude.ai sizes its outer container once
      // (anthropics/claude-ai-mcp#69) from the PNG's footprint, so
      // growing the frame past it would clip. The probe only starts
      // AFTER the image has loaded (see the image \`load\` handler), so
      // \`getBoundingClientRect().height\` here is the real laid-out
      // height — not 0 falling through to \`fallbackHeight\`.
      var rectH = image.getBoundingClientRect().height;
      var offsetH = image.offsetHeight;
      var h = Math.round(rectH || offsetH || 0) || fallbackHeight;
      setFrameHeight(h);
      // Arm the embed-height handshake only NOW: the embed has become the
      // visible surface, so honoring its resize messages is finally safe.
      armEmbedOrigin(url);
      imageLink.classList.add("hidden");
      placeholder.classList.add("hidden");
      frame.classList.remove("hidden");
      notifyHeight(h);
      log("iframe probe succeeded, upgraded to interactive", { height: h });
    }
    function onViolation(event) {
      var directive =
        event && (event.effectiveDirective || event.violatedDirective);
      if (typeof directive === "string" && directive.indexOf("frame-src") === 0) {
        fail("csp:" + directive);
      }
    }
    function onLoad() {
      // \`fail()\` navigates the frame to about:blank, which fires its own
      // \`load\`; \`probeNavigated\` is false by then so we don't count it.
      //
      // KNOWN GAP (bare-load success signal): \`load\` fires for ANY
      // document the embed endpoint returns — including a Tako 404/5xx
      // error page. On a host whose CSP allows \`frame-src\`, an embed-page
      // outage would swap the known-good PNG for an error page. Accepted
      // for now: the only positive signal from the cross-origin embed is
      // the \`tako-embed-height\` message, which the Tako web app does not
      // emit yet (see the handler comment near the bottom). Once it does,
      // gate \`succeed()\` on that message instead of the bare \`load\`.
      if (probeNavigated) succeed();
    }
    document.addEventListener("securitypolicyviolation", onViolation);
    frame.addEventListener("load", onLoad);
    // Deliberately do NOT arm \`embedOrigin\` here — the probe frame is
    // still hidden behind the PNG, so honoring its \`tako-embed-height\`
    // messages would resize the widget under a chart the user is looking
    // at. \`succeed()\` arms it after the swap.
    frame.src = url;
    probeNavigated = true;
    timer = setTimeout(function () { fail("timeout"); }, IFRAME_SETTLE_MS);
    log("iframe probe started", { src: url });
  }

  // One watchdog per widget lifetime, same reasoning as \`probeStarted\`.
  var watchStarted = false;

  // Watch an iframe we have ALREADY shown the user, and downgrade to the PNG
  // if it never loads. Used only on the \`window.openai\` path, which commits
  // to the iframe up front instead of probing behind a PNG.
  //
  // Settle signals, mirroring the probe's:
  //  - \`load\` on the frame → the embed rendered; stand down.
  //  - \`securitypolicyviolation\` for \`frame-src\` → definitive host block.
  //  - no \`load\` within the timeout → covers suppressed violation events,
  //    network stalls, and an embed endpoint that never finishes.
  //
  // Same KNOWN GAP as the probe, in the opposite direction: \`load\` fires for
  // any document the endpoint returns, so a Tako error page counts as a
  // successful load and keeps the iframe. Closing that needs a positive
  // signal from the embed page itself (the \`tako-embed-height\` message it
  // does not emit yet), at which point BOTH this and \`onLoad\` in the probe
  // should gate on it instead.
  function watchCommittedIframe(url, imageOpts) {
    if (watchStarted) return;
    watchStarted = true;
    var settled = false;
    var timer = null;
    function cleanup() {
      settled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      frame.removeEventListener("load", onLoad);
    }
    function downgrade(reason) {
      if (settled) return;
      cleanup();
      // Unload and hide the frame before painting, so a late-arriving embed
      // cannot appear on top of the PNG, and stop honoring its height
      // messages.
      embedOrigin = null;
      frame.classList.add("hidden");
      frame.src = "about:blank";
      log("iframe never loaded, falling back to image", { reason: reason });
      // No image to fall back to (ChatGPT skips the server-side PNG prefetch,
      // so \`image_data_url\` is absent there — but \`image_url\` is present in
      // structuredContent, which is what makes this path work). Surface the
      // click-through rather than a silent empty frame.
      if (imageOpts.imageSrc === null) {
        placeholder.innerHTML = "";
        placeholder.classList.remove("hidden");
        if (imageOpts.validEmbed) {
          var anchor = document.createElement("a");
          anchor.href = url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = "Open interactive chart →";
          anchor.style.color = "#4aa9ff";
          anchor.style.textDecoration = "none";
          placeholder.appendChild(anchor);
        } else {
          placeholder.textContent = "Couldn't load chart.";
        }
        notifyHeight(240);
        return;
      }
      paintImage({
        embedUrl: url,
        imageSrc: imageOpts.imageSrc,
        validEmbed: imageOpts.validEmbed,
        height: imageOpts.height,
        isDataUrl: imageOpts.isDataUrl,
        imageUrl: imageOpts.imageUrl,
        // The iframe just failed. Do not go looking for it again.
        allowProbe: false,
      });
    }
    function onViolation(event) {
      var directive =
        event && (event.effectiveDirective || event.violatedDirective);
      if (typeof directive === "string" && directive.indexOf("frame-src") === 0) {
        downgrade("csp:" + directive);
      }
    }
    function onLoad() {
      if (settled) return;
      cleanup();
      log("committed iframe loaded", { src: url });
    }
    document.addEventListener("securitypolicyviolation", onViolation);
    frame.addEventListener("load", onLoad);
    timer = setTimeout(function () { downgrade("timeout"); }, IFRAME_SETTLE_MS);
    log("iframe watchdog armed", { src: url });
  }

  function log(label, payload) {
    try { console.log("[tako-widget]", label, payload); } catch (e) {}
  }

  // \`structuredContent\` is the tool's output dict (pub_id, embed_url,
  // image_url, dark_mode, width, height). Two arrival paths in practice:
  //
  //  - ChatGPT Apps SDK: \`window.openai\` exposes a few candidate keys
  //    (\`toolOutput\` is documented but null in dev-mode custom
  //    connectors as of 2026-04; the data lands under \`widget.*\` or
  //    \`toolResponseMetadata.structuredContent\` for our case).
  //    Updates arrive via the \`openai:set_globals\` CustomEvent.
  //
  //  - MCP Apps open spec (claude.ai web/desktop, VS Code Insiders,
  //    Goose): \`ui/notifications/tool-result\` JSON-RPC over postMessage
  //    with \`params.structuredContent\`.
  //
  // We try every key path so one bundle works on every host without a
  // user-agent sniff. Cost of the extra checks is negligible.

  // Some hosts gate widget data delivery on the iframe signaling its
  // intrinsic height. We notify on load (placeholder height) and again
  // after rendering. No-op on hosts that don't expose the function.
  function notifyHeight(h) {
    // ChatGPT Apps SDK mechanism.
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight(h);
      }
    } catch (e) { /* ignore */ }
    // MCP Apps open-spec mechanism (claude.ai, VS Code Insiders, Goose):
    // JSON-RPC notification over postMessage. Hosts that don't implement
    // it (ChatGPT) ignore unknown messages — same pattern as the
    // ui/initialize handshake below. Sent best-effort even before the
    // handshake completes; render() re-notifies after data arrives, so a
    // pre-handshake miss self-corrects.
    try {
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: {
          width: (document.documentElement && document.documentElement.clientWidth) || 0,
          height: h,
        },
      }, "*");
    } catch (e) { /* host gone — nothing to do */ }
  }

  // Paint the static PNG baseline (and, when allowed, probe for an
  // interactive upgrade behind it). Extracted verbatim from render()'s image
  // branch so the ChatGPT iframe watchdog can fall BACK to it after render()
  // has already committed — render() is one-shot via the \`rendered\` flag, so
  // calling render() a second time could not do this.
  //
  // \`allowProbe\` is false on that downgrade path: the iframe has just been
  // proven not to load, so probing it again would either fail twice or, worse,
  // "succeed" on a Tako error page and swap the working PNG back out.
  function paintImage(opts) {
    var url = opts.embedUrl;
    var imageSrc = opts.imageSrc;
    var validEmbed = opts.validEmbed;
    var h = opts.height;
    var validDataImage = opts.isDataUrl;
    var imgUrl = opts.imageUrl;
    var allowProbe = opts.allowProbe !== false;
      // Per anthropics/claude-ai-mcp#69 workaround:
      //   "After the MCP App renders content, explicitly measure the
      //    content and set it on <html>."
      //
      // The whole sequence must happen ATOMICALLY in \`image.load\` —
      // not at \`render()\` time — to avoid claude.ai snapshotting an
      // intermediate layout state with the wrong height. Sequence
      // here:
      //
      //   1. Set image.src (starts the data: URI decode).
      //   2. Wait for \`load\` (image is laid out).
      //   3. In one tick: hide placeholder + show anchor + measure
      //      content scrollHeight + set documentElement.style.height.
      //
      // \`scrollHeight\` of the anchor wrapper over \`offsetHeight\` of
      // the image because that's the pattern from the issue thread
      // that's reported to work; \`offsetHeight\` fallbacks cover hosts
      // where \`scrollHeight\` returns 0. The PNG-natural dimensions
      // (\`imgNaturalW\` / \`imgNaturalH\`, read in render()) are intentionally
      // NOT used as a pre-size hint here — that was the prior approach that
      // caused claude.ai to lock the outer iframe at the wrong height, and
      // it is why they are not threaded into this function's \`opts\`.

      if (validEmbed) {
        imageLink.setAttribute("href", url);
      } else {
        imageLink.removeAttribute("href");
      }

      image.addEventListener("load", function () {
        // No-op after an upgrade: if the probe already swapped the
        // interactive iframe in, a stray duplicate \`load\` must not
        // re-reveal the PNG on top of it.
        if (probeUpgraded) return;
        imageLink.classList.remove("hidden");
        placeholder.classList.add("hidden");
        // Defer measurement one frame so layout settles after the
        // visibility change. Use the rendered height only — using the
        // source PNG's \`naturalHeight\` to upsize the iframe (a thing
        // we tried) yields ~1100 px tall iframes for retina-2x
        // renders, claude.ai then visibly clips the iframe to its own
        // smaller container leaving a "black ribbon" of empty body
        // below the chart. Match the iframe to what the image
        // actually renders at and accept the chart aspect (~3.5:1 →
        // ~200 px tall at chat-column widths) as the natural ceiling
        // for height without cross-repo Tako changes.
        requestAnimationFrame(function () {
          var rectH = image.getBoundingClientRect().height;
          var offsetH = image.offsetHeight;
          var renderedH = Math.round(rectH || offsetH || 0);
          if (renderedH > 0) {
            document.documentElement.style.height = renderedH + "px";
            document.body.style.height = renderedH + "px";
            notifyHeight(renderedH);
            log("img resized after load", { height: renderedH });
          }
        });
        // Capability probe, sequenced AFTER the PNG baseline has loaded.
        // Starting it here rather than at render() time guarantees the
        // image is laid out before the probe can \`succeed()\`, so the swap
        // measures the image's real rendered height (not 0 falling through
        // to the requested height), and this \`load\` handler has already
        // run so it can't re-reveal the PNG over the swapped-in iframe.
        // The PNG is the guaranteed baseline; if this host's CSP lets the
        // embed iframe load (it doesn't on claude.ai until
        // anthropics/claude-ai-mcp#40 is fixed), the probe upgrades to the
        // interactive chart once it does.
        if (validEmbed && allowProbe) probeInteractiveIframe(url, h);
      });
      // CSP / network error fallback. The most common trigger is
      // claude.ai's outer-document CSP (\`img-src 'self' blob: data:\`)
      // blocking the cross-origin \`image_url\` when we couldn't inline
      // a \`data:\` URI — \`fetchImageDataUrlAndDims\` returns undefined
      // for PNG > 250 KB, fetch timeout, or non-PNG content type, and
      // the widget falls through to \`validHttpImage\`. Without this
      // listener the \`load\` event never fires, leaving the placeholder
      // stuck at "Loading chart…" with no path to the chart. Repurpose
      // the placeholder into a click-through link so the user can
      // still reach the interactive embed.
      image.addEventListener("error", function () {
        image.classList.add("hidden");
        imageLink.classList.add("hidden");
        if (validEmbed) {
          placeholder.innerHTML = "";
          var fallbackAnchor = document.createElement("a");
          fallbackAnchor.href = url;
          fallbackAnchor.target = "_blank";
          fallbackAnchor.rel = "noopener noreferrer";
          fallbackAnchor.textContent = "Open interactive chart →";
          fallbackAnchor.style.color = "#4aa9ff";
          fallbackAnchor.style.textDecoration = "none";
          placeholder.appendChild(fallbackAnchor);
        } else {
          placeholder.textContent = "Couldn't load chart.";
        }
        log("img errored, showing click-through fallback");
        // Even with no visible PNG, still probe: a host that blocks
        // cross-origin \`img-src\` but allows \`frame-src\` can upgrade to
        // the interactive embed. \`probeStarted\` dedupes against the load
        // path — only one of load/error fires per image.
        if (validEmbed && allowProbe) probeInteractiveIframe(url, h);
      });
      // Mark rendered BEFORE assigning src so the \`if (rendered) return\`
      // guard at the top of \`render()\` blocks any re-entry from a
      // duplicate tool-result delivery, even if the load event fires
      // synchronously (data: URIs can do that in some browsers).
      rendered = true;
      // Triggers the load event above. Set last so the listener is
      // attached first. The capability probe is kicked off from inside the
      // load/error handlers (above) so it's sequenced after the image.
      image.src = imageSrc;
      // Skip the synchronous hide-placeholder / show-anchor / notifyHeight
      // tail below — image.load handles those atomically once the
      // content has actually rendered.
      log("img path queued", { src: validDataImage ? "<data:image>" : imgUrl });
      return true;
  }

  function render(structuredContent, meta) {
    if (rendered) return true;
    if (!structuredContent || typeof structuredContent !== "object") return false;
    // No-chart short-circuit: structured content arrived but contains
    // no chart fields at all. \`tako_search\` produces this shape when it
    // returns zero cards (a clean empty result) or when the top card has
    // no \`card_id\` — either way there is no top card to render, so
    // \`buildSearchOutput\` omits the widget URLs.
    //
    // Without this guard, the placeholder sits at "Loading chart…"
    // forever and stacks a 240-px-tall empty widget box in the chat.
    // Detect the empty shape by the absence of any chart URL:
    // \`embed_url\` and \`image_url\` are mutually present-or-absent on the
    // handler side (see \`buildSearchOutput\` in \`_search_results.ts\`),
    // and \`image_data_url\` is derived from \`image_url\` server-side
    // (\`extraMeta\` only runs when \`image_url\` is present), so the
    // \`!image_url && !embed_url\` check covers all three.
    if (
      typeof structuredContent.embed_url !== "string" &&
      typeof structuredContent.image_url !== "string"
    ) {
      placeholder.classList.add("hidden");
      document.documentElement.style.height = "0px";
      document.body.style.height = "0px";
      notifyHeight(0);
      rendered = true;
      log("no-chart payload, collapsed widget");
      return true;
    }
    var url = structuredContent.embed_url;
    var imgUrl = structuredContent.image_url;
    // \`image_data_url\` and PNG natural dimensions live on \`_meta\`
    // (not on \`structuredContent\`) so the ~250 KB data URI doesn't
    // get tokenized into the LLM's context window — claude.ai
    // otherwise rejects the tool result as too large. Hosts using the
    // \`window.openai\` path (ChatGPT) ignore \`_meta\` entirely; they
    // don't need the data URI because their CSP allows cross-origin
    // \`<img src>\`.
    var imgDataUrl = meta && typeof meta === "object" ? meta.image_data_url : undefined;
    var imgNaturalW = meta && typeof meta === "object" && typeof meta.image_natural_width === "number"
      ? meta.image_natural_width : 0;
    var imgNaturalH = meta && typeof meta === "object" && typeof meta.image_natural_height === "number"
      ? meta.image_natural_height : 0;
    // Read but deliberately unused for sizing — see the note in paintImage.
    // Kept parsed so the shape stays documented at the point of arrival.
    void imgNaturalW;
    void imgNaturalH;
    // Defense-in-depth: re-validate URL/DataURL schemes before
    // assigning to \`iframe.src\` / \`img.src\`. The handler validates
    // server-side too, but the widget is the last hop before the DOM,
    // so a hostile MCP server shipping \`javascript:\` would otherwise
    // execute in the widget origin once dropped into \`src\`.
    var validEmbed = typeof url === "string" && /^https?:\\/\\//.test(url);
    var validDataImage = typeof imgDataUrl === "string" && imgDataUrl.indexOf("data:image/") === 0;
    var validHttpImage = typeof imgUrl === "string" && /^https?:\\/\\//.test(imgUrl);
    // Prefer the inlined \`data:\` URI over the cross-origin URL — the
    // data URI works under restrictive \`img-src\` CSPs (claude.ai for
    // custom connectors), while the http URL only renders on hosts
    // with permissive img-src (ChatGPT and most others). Fall back to
    // the http URL when the worker couldn't inline (size cap or fetch
    // failure).
    var imageSrc = validDataImage ? imgDataUrl : validHttpImage ? imgUrl : null;
    var validImage = imageSrc !== null;
    var h =
      typeof structuredContent.height === "number" && structuredContent.height > 0
        ? structuredContent.height
        : 600;
    var useIframe = hasOpenAiRuntime() && validEmbed;

    if (useIframe) {
      if (frame.src !== url) frame.src = url;
      armEmbedOrigin(url);
      setFrameHeight(h);
      frame.classList.remove("hidden");
      // Watchdog on the committed iframe — the mirror image of
      // \`probeInteractiveIframe\`. That one starts from the PNG and upgrades
      // to the iframe if the host allows it; this one starts from the iframe
      // and falls back to the PNG if it never loads.
      //
      // Only this path lacked a fallback, and it is the path ChatGPT takes.
      // \`hasOpenAiRuntime()\` says the host's CSP is *expected* to permit
      // \`frameDomains\`, which is not the same as the embed actually
      // rendering: a Tako embed outage, a slow render, or an OpenAI sandbox
      // CSP change all left the widget showing an empty or blocked frame
      // forever — while \`image_url\` sat unused in the same
      // \`structuredContent\`, and would have rendered fine under ChatGPT's
      // permissive \`img-src\`. Losing interactivity is a far cheaper failure
      // than losing the chart.
      watchCommittedIframe(url, {
        imageSrc: imageSrc,
        validEmbed: validEmbed,
        height: h,
        isDataUrl: validDataImage,
        imageUrl: imgUrl,
      });
    } else if (validImage) {
      return paintImage({
        embedUrl: url,
        imageSrc: imageSrc,
        validEmbed: validEmbed,
        height: h,
        isDataUrl: validDataImage,
        imageUrl: imgUrl,
        allowProbe: true,
      });
    } else if (validEmbed) {
      // No image at all but we have an embed_url — try the iframe even
      // on hosts we'd normally treat as restricted. Worst case the
      // host CSP-blocks it and the user sees the same "blocked" tile
      // they'd otherwise have seen; best case some host without
      // \`window.openai\` actually allows the iframe.
      if (frame.src !== url) frame.src = url;
      armEmbedOrigin(url);
      setFrameHeight(h);
      frame.classList.remove("hidden");
    } else {
      // Nothing usable; leave the placeholder visible.
      return false;
    }

    // Reached only by the iframe paths (\`useIframe\` or the no-image
    // \`validEmbed\` fallback) — the \`validImage\` branch returns early
    // above so its load/error listeners can manage placeholder/height
    // atomically. \`h\` matches the height we just pinned on the iframe.
    placeholder.classList.add("hidden");
    rendered = true;
    notifyHeight(h);
    log("rendered", {
      mode: useIframe ? "iframe" : "iframe-fallback",
      src: url,
      height: h,
    });
    return true;
  }

  function pickFromOpenAi() {
    var w = window;
    if (!w || !w.openai || typeof w.openai !== "object") return null;
    return (
      w.openai.toolOutput ||
      (w.openai.widget && w.openai.widget.toolOutput) ||
      (w.openai.widget && w.openai.widget.structuredContent) ||
      (w.openai.widget && w.openai.widget.payload) ||
      (w.openai.toolResponseMetadata && w.openai.toolResponseMetadata.structuredContent) ||
      null
    );
  }
  function pickFromGlobals(globals) {
    if (!globals || typeof globals !== "object") return null;
    return (
      globals.toolOutput ||
      globals.structuredContent ||
      (globals.widget && globals.widget.toolOutput) ||
      (globals.widget && globals.widget.structuredContent) ||
      (globals.widget && globals.widget.payload) ||
      null
    );
  }

  // Initial intrinsic-height notification — 1 px (effectively invisible)
  // instead of the previous 240 px. Reasoning: ChatGPT's widget host
  // pins the highest height ever notified and ignores later shrinks,
  // so a 240 px initial floor produces a persistent empty box for any
  // tool call that doesn't deliver chart data (e.g. a search returning
  // zero cards). Starting at 1 keeps the host's
  // floor minimal; render()'s chart-rendering paths grow the widget
  // to the chart's actual height when data arrives. The no-chart
  // guard inside render() also notifies 0 so hosts that DO honor
  // shrink notifications collapse fully.
  notifyHeight(1);

  // Synchronous probe wins when the host injects data before our script
  // runs; otherwise we fall through to a 10s polling window because
  // ChatGPT populates the global at unpredictable times. Cost: one
  // property read every 250 ms.
  if (!render(pickFromOpenAi())) {
    var attempts = 0;
    var handle = setInterval(function () {
      attempts += 1;
      if (render(pickFromOpenAi()) || attempts >= 40) {
        clearInterval(handle);
      }
    }, 250);
  }

  // Subscribe to host updates. Multiple event-name candidates because
  // OpenAI's emitted name has drifted across SDK releases. Bind on both
  // \`window\` and \`document\` because some hosts dispatch on one and not
  // the other. Prevents duplicate renders from redundant events within a
  // single tool call (\`render()\` is one-shot via the \`rendered\` flag).
  var EVENT_NAMES = [
    "openai:set_globals",
    "openai:tool_result",
    "openai:tool_response",
    "openai:globals_set",
    "openai:update",
    "openai:state",
  ];
  var handler = function (event) {
    var detail = event && event.detail;
    var globals = detail && detail.globals;
    render(pickFromGlobals(globals) || pickFromOpenAi());
  };
  EVENT_NAMES.forEach(function (name) {
    window.addEventListener(name, handler);
    document.addEventListener(name, handler);
  });

  // MCP Apps handshake — REQUIRED for claude.ai (and any spec-compliant
  // host) to deliver tool results. Per the MCP Apps spec (2026-01-26):
  //
  //   "The Host MUST NOT send any request or notification to the View
  //    before it receives an \`initialized\` notification."
  //
  // Sequence:
  //   1. View → Host: \`ui/initialize\` request (declares appInfo +
  //      protocolVersion).
  //   2. Host → View: response with hostInfo / hostCapabilities.
  //   3. View → Host: \`ui/notifications/initialized\` notification.
  //   4. Host → View: starts sending \`ui/notifications/tool-result\`
  //      (and \`ui/notifications/tool-input\`) for every tool call.
  //
  // Without steps 1 and 3 Claude correctly withholds tool-result; the
  // widget then sits on its placeholder forever. Symptom of skipping
  // the handshake matched exactly: \`[tako-widget] listener attached\`
  // logs but \`rendered\` never does. Sources:
  // \`@modelcontextprotocol/ext-apps@1.7.x\` \`dist/src/app.js::connect()\`
  // and the spec at modelcontextprotocol/ext-apps/specification/
  // 2026-01-26/apps.mdx.
  //
  // ChatGPT's data path (\`window.openai.toolOutput\` /
  // \`openai:set_globals\`) is independent of this handshake — these
  // messages are silently ignored on its side, so ChatGPT keeps working
  // unchanged.
  var INIT_REQUEST_ID = "tako-ui-init";
  var initRequestSent = false;
  var initializedSent = false;

  function sendInitRequest() {
    if (initRequestSent) return;
    initRequestSent = true;
    try {
      window.parent.postMessage({
        jsonrpc: "2.0",
        id: INIT_REQUEST_ID,
        method: "ui/initialize",
        params: {
          appInfo: { name: "tako-open-chart-ui", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
      }, "*");
      log("ui/initialize sent");
    } catch (e) { /* host gone — nothing to do */ }
  }

  function sendInitializedNotification() {
    if (initializedSent) return;
    initializedSent = true;
    try {
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/initialized",
        params: {},
      }, "*");
      log("ui/notifications/initialized sent");
    } catch (e) { /* host gone — nothing to do */ }
  }

  // MCP Apps open-spec bridge — \`ui/notifications/tool-result\`
  // JSON-RPC over postMessage, plus the response side of the handshake
  // above. claude.ai, VS Code Insiders, and Goose follow this; ChatGPT
  // uses the \`window.openai\` path further up.
  //
  // Also handles a \`tako-embed-height\` resize message from the inner
  // embed iframe, gated to that iframe's origin. The Tako web app does
  // not emit it yet — when it ships, the widget will start
  // self-correcting chart heights without a worker redeploy. Sanity
  // bounds (positive integer < 4000 px) keep a hostile or buggy embed
  // from blowing the iframe up to nonsensical sizes.
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    // MCP Apps host messages (handshake + tool-result) come from the
    // host's own browsing context — \`window.parent\`, or \`window.top\`
    // if the host nests the widget inside a wrapper frame. Reject
    // anything else — a co-installed sibling connector's iframe can
    // postMessage to us via parent.frames[] and would otherwise be able
    // to inject a spoofed tool-result (fake chart image + arbitrary
    // click-through URL; render() is one-shot). A sibling's
    // \`event.source\` is the sibling's own window, never parent or top,
    // so widening to \`top\` keeps the injection blocked. The
    // \`tako-embed-height\` branch below is separately origin-gated to the
    // embed iframe, so leave it reachable regardless.
    var fromHost = event.source === window.parent || event.source === window.top;
    // This gate guards Claude's only chart data path. If a host ever
    // delivers JSON-RPC from a context we don't trust, dropping it
    // silently would strand the widget on "Loading chart…" with no
    // signal — warn so devtools / host logs show the drop.
    if (!fromHost && msg.jsonrpc === "2.0") {
      console.warn("[tako-widget] dropped JSON-RPC message from untrusted source", msg.method || msg.id);
    }
    // Init response → send the \`initialized\` notification so the host
    // starts piping tool-result messages. Don't gate on response
    // contents — any matching id (success or error) is sufficient
    // signal that the host saw our \`ui/initialize\`.
    if (
      fromHost &&
      msg.jsonrpc === "2.0" &&
      msg.id === INIT_REQUEST_ID &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      sendInitializedNotification();
      return;
    }
    if (fromHost && msg.jsonrpc === "2.0" && msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      // Forward both \`structuredContent\` (LLM-visible payload) and
      // \`_meta\` (metadata-only payload, where \`image_data_url\` lives).
      // Per the MCP Apps spec §"Wire protocol — Host → View
      // notification", \`params._meta\` is part of the tool-result
      // notification.
      render(params.structuredContent, params._meta);
      return;
    }
    if (msg.type === "tako-embed-height" && embedOrigin && event.origin === embedOrigin) {
      var h = msg.height;
      if (typeof h !== "number" || !isFinite(h) || h <= 0 || h > 4000) return;
      var n = Math.round(h);
      setFrameHeight(n);
      notifyHeight(n);
      log("resized via embed handshake", { height: n });
    }
  });

  // Kick the handshake off. Listener is already attached above so the
  // response can come in immediately. Fallback: send \`initialized\`
  // 200 ms after the request regardless of whether the host responded
  // to \`ui/initialize\`. Reasons for the short window:
  //
  //   - Hosts that don't implement the handshake (ChatGPT via
  //     \`window.openai\`) never respond, so we'd block their other
  //     listeners forever without a timeout.
  //   - Hosts that DO implement it (claude.ai) appear to start
  //     attempting tool-result delivery within ~hundreds of ms of
  //     widget mount; the previous 2 s window left enough room for
  //     that delivery to fire-and-fail before we sent \`initialized\`,
  //     causing the FIRST tool call in a session to drop while
  //     subsequent calls (after handshake completes) worked. Shortening
  //     to 200 ms tightens the race; sending an unsolicited
  //     \`initialized\` to a non-handshake host is harmless (they
  //     ignore unknown JSON-RPC notifications).
  sendInitRequest();
  setTimeout(sendInitializedNotification, 200);

  log("listener attached", {
    hasOpenAiGlobal: typeof window.openai !== "undefined",
  });
})();
</script>
</body>
</html>`;

/**
 * Convert an `ArrayBuffer` to base64 — used by both the data-URI
 * inliner and the image-content-block emitter. Uses Node's `Buffer`
 * (available in Workers via `nodejs_compat`) so multi-megabyte inputs
 * don't blow the call stack the way `String.fromCharCode(...spread)`
 * does.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

/**
 * Parse PNG width / height from the IHDR chunk. PNGs are required to
 * have IHDR as the first chunk, immediately after the 8-byte signature,
 * so width and height are at byte offsets 16 and 20 respectively
 * (each a 4-byte big-endian uint). Returns `undefined` for anything
 * that doesn't pass the signature check — small JPEG/GIF/HTML error
 * pages would otherwise read garbage dimensions.
 */
function parsePngDimensions(
  buffer: ArrayBuffer,
): { width: number; height: number } | undefined {
  if (buffer.byteLength < 24) return undefined;
  const view = new DataView(buffer);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A — first 4 bytes are enough.
  if (view.getUint32(0) !== 0x89504e47) return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * Build the public `embed_url` (web origin) and `image_url` (API
 * origin) for one chart. `tako_search`'s auto-chain calls this for the
 * top card to populate the inline-render widget fields.
 *
 * `embed_url` always carries `?dark_mode=auto` — the embed page runs
 * in the user's browser and resolves "auto" via
 * `matchMedia('(prefers-color-scheme: dark)')`, so the chart picks up
 * the user's actual OS theme regardless of whether MCP or the calling
 * host knows it. `image_url` is a server-rendered PNG, where the
 * backend can't read browser preferences, so it stays
 * `true`/`false` driven by the `darkMode` arg.
 */
export function buildChartUrls(
  env: Env,
  pubId: string,
  darkMode: boolean,
): { embed_url: string; image_url: string } {
  const webBase = resolvePublicBase(env);
  const apiBase = resolvePublicApiBase(env);
  const imageFlag = darkMode ? "true" : "false";
  const encoded = encodeURIComponent(pubId);
  return {
    embed_url: `${webBase}/embed/${encoded}/?dark_mode=auto`,
    image_url: `${apiBase}/api/v1/image/${encoded}/?dark_mode=${imageFlag}`,
  };
}

/**
 * Fetch the chart PNG and return its `data:image/...;base64,...` URI
 * along with the source PNG's natural pixel dimensions. The dimensions
 * let the widget pre-size its document height (so claude.ai's outer
 * iframe ends up matching the rendered chart instead of the
 * 720-px-tall iframe-path default — Claude reads
 * `documentElement.offsetHeight` early and apparently doesn't re-poll
 * after image load, so any post-load resize is lost).
 *
 * All failure modes (timeout, !ok, wrong content-type, oversize, bad
 * PNG header) degrade to `undefined`. `image_url` is always in the
 * response, so hosts that allow cross-origin images still render fine.
 */
export async function fetchImageDataUrlAndDims(
  url: string,
): Promise<
  { dataUrl: string; naturalWidth: number; naturalHeight: number } | undefined
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PNG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(
        `[tako] chart image_data_url fetch failed: HTTP ${response.status} from ${url}`,
      );
      return undefined;
    }
    const contentType = response.headers.get("content-type") ?? "";
    // Reject anything that's not an image — an upstream redirect to an
    // HTML error page would otherwise let us base64 HTML and ship it
    // as a `data:image/...` URI the client can't render.
    if (!contentType.startsWith("image/")) {
      console.warn(
        `[tako] chart image_data_url fetch failed: unexpected content-type "${contentType}" from ${url}`,
      );
      return undefined;
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      console.warn(`[tako] chart image_data_url fetch failed: empty body from ${url}`);
      return undefined;
    }
    if (buffer.byteLength > MAX_INLINE_DATA_URL_BYTES) {
      console.warn(
        `[tako] chart image_data_url fetch failed: oversize body (${buffer.byteLength} bytes) from ${url}`,
      );
      return undefined;
    }
    const dims = parsePngDimensions(buffer);
    if (dims === undefined) {
      console.warn(`[tako] chart image_data_url fetch failed: invalid PNG header from ${url}`);
      return undefined;
    }
    // `parsePngDimensions` validated the PNG signature (89 50 4E 47…),
    // so the buffer is always `image/png` by here — no need to derive
    // the MIME type from the response header.
    return {
      dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
      naturalWidth: dims.width,
      naturalHeight: dims.height,
    };
  } catch (e) {
    console.warn(`[tako] chart image_data_url fetch failed: ${String(e)} for ${url}`);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the chart PNG and return it as a single MCP `image` content
 * block. Used by both tools' `extraContentBlocks` hook on unknown
 * clients — the one bucket where the widget bundle is suppressed
 * entirely (ChatGPT and Claude both get the widget; see
 * `widgetSuppressed` in mcp.ts).
 *
 * All failure modes (timeout, !ok, wrong content-type, 0-byte body,
 * oversize, network error) return `[]` so the tool call still resolves
 * with the text + structuredContent fallback. The LLM can surface
 * `embed_url` as a markdown link from the structured content if the
 * inline image was dropped.
 */
export async function fetchPngContentBlock(
  url: string,
): Promise<ToolContentBlock[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PNG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    // Each degrade logs a `[tako-widget]` line (mirroring
    // `fetchImageDataUrlAndDims`): this path serves UNKNOWN clients (Cursor,
    // Windsurf, Gemini CLI, …), so a silent `[]` here is "the chart never
    // shows up" with nothing to tail.
    if (!response.ok) {
      console.warn(`[tako-widget] png content block: status=${response.status} url=${url}`);
      return [];
    }
    const contentType = response.headers.get("content-type") ?? "";
    // Defensive: an upstream redirect to an HTML error page would
    // otherwise let us base64 HTML and ship it as `mimeType:
    // "image/png"` — a garbage block the client would try to render.
    if (!contentType.startsWith("image/")) {
      console.warn(`[tako-widget] png content block: non-image content-type=${contentType} url=${url}`);
      return [];
    }
    const buffer = await response.arrayBuffer();
    // 0-byte 200 is plausible if a renderer returned early; emitting
    // `{ data: "", mimeType: "image/png" }` would have clients try to
    // render an invalid image. Mirror the oversize bail.
    if (buffer.byteLength === 0) {
      console.warn(`[tako-widget] png content block: empty body url=${url}`);
      return [];
    }
    if (buffer.byteLength > MAX_INLINE_PNG_BYTES) {
      console.warn(
        `[tako-widget] png content block: oversize bytes=${buffer.byteLength} url=${url}`,
      );
      return [];
    }
    return [
      {
        type: "image",
        data: arrayBufferToBase64(buffer),
        mimeType: contentType.split(";")[0]!.trim(),
      },
    ];
  } catch (err) {
    console.warn(`[tako-widget] png content block: fetch failed url=${url}:`, err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the chart widget's `AppUiResource`. `tako_search` registers the
 * `ui://tako/embed/chart` URI; `mcp.ts`'s registration loop dedupes
 * repeat registrations of the same URI so the SDK doesn't throw
 * `Resource ui://... is already registered`.
 *
 * The static URI loads the iframe widget (used by ChatGPT, and by
 * claude.ai today — see the "Conclusion" comment in `mcp.ts` near the
 * dynamic ResourceTemplate registration). The dynamic per-pub_id URI
 * bakes the chart image into the resource HTML instead; it's retained
 * for a future host that honors per-call `resourceUri` overrides (the
 * host would snapshot `documentElement.offsetHeight` once on widget
 * mount, so baking the image in up front avoids a missed resize), but
 * claude.ai currently ignores per-call overrides and stays on the
 * static URI + baked `_meta.image_data_url` from `extraMeta`.
 *
 * `resolveUriFromInput` reads the top card's `pub_id` from the tool
 * output (the search input is a query, not a pub_id) and falls back to
 * the static URI when there's no renderable top card.
 */
export function buildChartAppUiResource(
  env: Env,
  resolveUriFromInput: (input: unknown, output?: unknown) => string,
): AppUiResource {
  const webBase = resolvePublicBase(env);
  return {
    // Static URI — registered as before, used by ChatGPT (which reads
    // the widget URI from `_meta["openai/outputTemplate"]`) for its
    // interactive iframe path. Also serves any host that doesn't honor
    // per-call URI overrides.
    uri: APP_UI_RESOURCE_URI,
    name: APP_UI_RESOURCE_NAME,
    html: WIDGET_HTML,
    // `frameDomains` is the host CSP's allow-list for nested iframes —
    // without the widget's parent origin in here, the host blocks
    // `<iframe src="https://tako.com/embed/...">`. Pin to exactly the
    // public web origin (e.g. `tako.com` / `staging.trytako.com`) the
    // tool also writes into `embed_url`, so the two move together. No
    // wildcards: the widget only ever embeds Tako's own embed page.
    frameDomains: [webBase],
    // Remote-image fallback (`<img src=image_url>`) loads from the API
    // base; the primary data-URI path needs no CSP. webBase covers any
    // future web-hosted asset. Deduped — staging/prod use one host for
    // both.
    resourceDomains: [...new Set([webBase, resolvePublicApiBase(env)])],
    // Dynamic-resource variant — registered as a `ResourceTemplate`,
    // one URI per pub_id. Per-call tool result overrides
    // `_meta.ui.resourceUri` to point claude.ai at a specific
    // instance, where the widget HTML has the chart's image and
    // dimensions baked in at fetch time. See `AppUiResource.dynamic`
    // and `buildBakedWidgetHtml` for the why.
    dynamic: {
      uriPattern: APP_UI_TEMPLATE_URI_PATTERN,
      templateName: APP_UI_TEMPLATE_NAME,
      async renderHtml(variables, ctx) {
        // `variables.pub_id` is the URI-template substitution; for
        // `{pub_id}` it arrives already URL-decoded. Build the image
        // and embed URLs the same way the tool handlers do.
        const pubIdRaw = variables.pub_id;
        const pubId =
          typeof pubIdRaw === "string"
            ? pubIdRaw
            : Array.isArray(pubIdRaw)
              ? (pubIdRaw[0] ?? "")
              : "";
        if (pubId === "") {
          return buildFallbackWidgetHtml(webBase, "Missing chart identifier.");
        }
        const { embed_url, image_url } = buildChartUrls(env, pubId, true);
        // The resource read happens with a valid request-context
        // `ctx.token`, so authenticated PNG endpoints (if any) would
        // work — currently the image endpoint is public, so only the
        // URL matters.
        void ctx;
        const fetched = await fetchImageDataUrlAndDims(image_url);
        if (fetched === undefined) {
          return buildFallbackWidgetHtml(
            embed_url,
            "Couldn't load chart preview.",
          );
        }
        return buildBakedWidgetHtml({
          embedUrl: embed_url,
          imageDataUrl: fetched.dataUrl,
          naturalWidth: fetched.naturalWidth,
          naturalHeight: fetched.naturalHeight,
        });
      },
      resolveUriFromInput,
    },
  };
}

/**
 * `appUiResource` variant that derives the per-call widget URI from the top
 * card's `pub_id` on the tool OUTPUT (the input is a query/spec, not a pub_id).
 * Falls back to the static URI when there's no renderable top card. Shared by
 * tako_search and tako_visualize, which both render a chart widget this way.
 */
export function buildChartAppUiResourceFromOutputPubId(env: Env): AppUiResource {
  return buildChartAppUiResource(env, (_input, output) => {
    const pubId =
      typeof (output as { pub_id?: unknown } | undefined)?.pub_id === "string"
        ? (output as { pub_id: string }).pub_id
        : "";
    if (pubId === "") return APP_UI_RESOURCE_URI;
    return APP_UI_TEMPLATE_URI_PATTERN.replace("{pub_id}", encodeURIComponent(pubId));
  });
}

// Re-export for tests that want to assert the widget HTML contains
// specific substrings (handshake method, scheme guard, etc.). The HTML
// itself is module-private; `_chart_widget_test_only__` is the only
// public handle.
export const __chart_widget_test_only__ = {
  WIDGET_HTML,
  buildBakedWidgetHtml,
  buildFallbackWidgetHtml,
  parsePngDimensions,
};

// Re-exported types so tool files don't have to import from `./types.js`
// AND `./_chart_widget.js` for the same widget plumbing.
export type { AppUiResource, ToolContentBlock, ToolContext } from "./types.js";
