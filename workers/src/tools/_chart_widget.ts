/**
 * Shared chart-widget plumbing used by `open_chart_ui` and `knowledge_search`.
 *
 * Both tools render the same Tako chart card inline — `open_chart_ui` from an
 * explicit `pub_id` input, `knowledge_search` from `results[0].card_id` after
 * an auto-chain. Rather than duplicate the ~600-line widget HTML, the PNG
 * fetch helpers, and the ChatGPT/claude.ai host quirks across both files
 * (and have them drift the next time a host bug needs a fix), the shared
 * surface lives here:
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
 *     template for claude.ai's image-baked variant. Both tools register
 *     the same URI; `mcp.ts`'s registration loop dedupes the second
 *     registration so the SDK doesn't throw on duplicate URI.
 *
 *   - Default chart-output dimensions (`DEFAULT_DARK_MODE`, …) — the
 *     defaults `knowledge_search` uses when auto-chaining (its input has
 *     no chart-options field). Match `open_chart_ui`'s zod defaults so a
 *     re-render via `open_chart_ui` produces a visually identical chart.
 *
 * The widget HTML and its host-quirk code are unchanged from when they
 * lived in `open_chart_ui.ts`; this module is a verbatim extraction.
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
// `MAX_INLINE_PNG_BYTES`. The data URI ends up inside the JSON-RPC tool
// result envelope, which the LLM also tokenizes and some clients have
// observed to silently fail their widget data flow past ~400 KB encoded.
// Cap at 250 KB raw → ~333 KB encoded for a margin under that threshold.
// Charts above the cap fall back to `image_url` only, which is fine for
// hosts whose CSP allows cross-origin images (ChatGPT) but means
// claude.ai users see no chart for the largest charts.
export const MAX_INLINE_DATA_URL_BYTES = 250 * 1024;

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

// Defaults used when a caller doesn't supply chart-options — mirrors the
// zod defaults on `open_chart_ui.inputSchema` so an auto-chained chart
// from `knowledge_search` is visually identical to one rendered via
// an explicit `open_chart_ui` follow-up.
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
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        var h = document.documentElement.offsetHeight;
        if (h > 0) window.openai.notifyIntrinsicHeight(h);
      }
    } catch (e) { /* host gone — nothing to do */ }
  }
  notify();
  window.addEventListener("resize", notify);
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
<div id="tako-placeholder">Loading chart…</div>
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

  // Pick the rendering mode based on host. ChatGPT's Apps SDK runtime
  // exposes \`window.openai\`; its outer sandbox CSP honors our
  // \`frameDomains\` declaration and lets the cross-origin
  // \`<iframe src=https://staging.trytako.com/embed/...>\` load fully
  // interactive. Other hosts (claude.ai for custom connectors most
  // notably) enforce a stricter \`frame-src 'self' blob: data:\` outer
  // CSP that ignores frameDomains entirely, so the iframe ends up
  // showing Chrome's "This content is blocked" placeholder. For those
  // hosts we drop back to the static PNG via \`image_url\` — the
  // \`img-src\` directive is far more commonly permissive than
  // \`frame-src\`, and a non-interactive chart is strictly better than
  // a "blocked" error tile. Confirmed via DevTools (2026-04-29) on
  // claude.ai web: the same widget bundle, same handshake completion,
  // with iframe blocked vs static \`<img>\` allowed.
  function shouldUseInteractiveIframe() {
    try {
      return typeof window.openai !== "undefined";
    } catch (e) {
      return false;
    }
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
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight(h);
      }
    } catch (e) { /* ignore */ }
  }

  function render(structuredContent, meta) {
    if (rendered) return true;
    if (!structuredContent || typeof structuredContent !== "object") return false;
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
    var useIframe = shouldUseInteractiveIframe() && validEmbed;

    if (useIframe) {
      if (frame.src !== url) frame.src = url;
      try { embedOrigin = new URL(url).origin; } catch (e) { embedOrigin = null; }
      frame.style.height = h + "px";
      frame.style.minHeight = h + "px";
      frame.setAttribute("height", String(h));
      frame.classList.remove("hidden");
    } else if (validImage) {
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
      // (\`imgNaturalW\` / \`imgNaturalH\`) are intentionally NOT used as
      // a pre-size hint here — that was the prior approach that
      // caused claude.ai to lock the outer iframe at the wrong height.
      void imgNaturalW;
      void imgNaturalH;

      if (validEmbed) {
        imageLink.setAttribute("href", url);
      } else {
        imageLink.removeAttribute("href");
      }

      image.addEventListener("load", function () {
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
      });
      // Mark rendered BEFORE assigning src so the \`if (rendered) return\`
      // guard at the top of \`render()\` blocks any re-entry from a
      // duplicate tool-result delivery, even if the load event fires
      // synchronously (data: URIs can do that in some browsers).
      rendered = true;
      // Triggers the load event above. Set last so the listener is
      // attached first.
      image.src = imageSrc;
      // Skip the synchronous hide-placeholder / show-anchor / notifyHeight
      // tail below — image.load handles those atomically once the
      // content has actually rendered.
      log("img path queued", { src: validDataImage ? "<data:image>" : imgUrl });
      return true;
    } else if (validEmbed) {
      // No image at all but we have an embed_url — try the iframe even
      // on hosts we'd normally treat as restricted. Worst case the
      // host CSP-blocks it and the user sees the same "blocked" tile
      // they'd otherwise have seen; best case some host without
      // \`window.openai\` actually allows the iframe.
      if (frame.src !== url) frame.src = url;
      try { embedOrigin = new URL(url).origin; } catch (e) { embedOrigin = null; }
      frame.style.height = h + "px";
      frame.style.minHeight = h + "px";
      frame.setAttribute("height", String(h));
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

  notifyHeight(240);

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
    // Init response → send the \`initialized\` notification so the host
    // starts piping tool-result messages. Don't gate on response
    // contents — any matching id (success or error) is sufficient
    // signal that the host saw our \`ui/initialize\`.
    if (
      msg.jsonrpc === "2.0" &&
      msg.id === INIT_REQUEST_ID &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      sendInitializedNotification();
      return;
    }
    if (msg.jsonrpc === "2.0" && msg.method === "ui/notifications/tool-result") {
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
      frame.style.height = n + "px";
      frame.style.minHeight = n + "px";
      frame.setAttribute("height", String(n));
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
 * origin) for one chart. Matches `open_chart_ui.handler`'s URL shape
 * exactly; `knowledge_search`'s auto-chain calls this for the top
 * card so a follow-up `open_chart_ui` produces identical URLs.
 *
 * `dark_mode` flips both the `?theme=` query on the embed URL and the
 * `?dark_mode=` query on the image URL — Tako's embed page reads the
 * former; the PNG endpoint reads the latter.
 */
export function buildChartUrls(
  env: Env,
  pubId: string,
  darkMode: boolean,
): { embed_url: string; image_url: string } {
  const webBase = resolvePublicBase(env);
  const apiBase = resolvePublicApiBase(env);
  const theme = darkMode ? "dark" : "light";
  const encoded = encodeURIComponent(pubId);
  return {
    embed_url: `${webBase}/embed/${encoded}/?theme=${theme}`,
    image_url: `${apiBase}/api/v1/image/${encoded}/?dark_mode=${darkMode ? "true" : "false"}`,
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
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    // Reject anything that's not an image — an upstream redirect to an
    // HTML error page would otherwise let us base64 HTML and ship it
    // as a `data:image/...` URI the client can't render.
    if (!contentType.startsWith("image/")) return undefined;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return undefined;
    if (buffer.byteLength > MAX_INLINE_DATA_URL_BYTES) return undefined;
    const dims = parsePngDimensions(buffer);
    if (dims === undefined) return undefined;
    // `parsePngDimensions` validated the PNG signature (89 50 4E 47…),
    // so the buffer is always `image/png` by here — no need to derive
    // the MIME type from the response header.
    return {
      dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
      naturalWidth: dims.width,
      naturalHeight: dims.height,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the chart PNG and return it as a single MCP `image` content
 * block. Used by both tools' `extraContentBlocks` hook on hosts where
 * the widget bundle is suppressed (claude.ai for custom connectors,
 * which crops the widget iframe to ~200 px tall — strictly worse than
 * an inline image block).
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
    if (!response.ok) return [];
    const contentType = response.headers.get("content-type") ?? "";
    // Defensive: an upstream redirect to an HTML error page would
    // otherwise let us base64 HTML and ship it as `mimeType:
    // "image/png"` — a garbage block the client would try to render.
    if (!contentType.startsWith("image/")) return [];
    const buffer = await response.arrayBuffer();
    // 0-byte 200 is plausible if a renderer returned early; emitting
    // `{ data: "", mimeType: "image/png" }` would have clients try to
    // render an invalid image. Mirror the oversize bail.
    if (buffer.byteLength === 0) return [];
    if (buffer.byteLength > MAX_INLINE_PNG_BYTES) return [];
    return [
      {
        type: "image",
        data: arrayBufferToBase64(buffer),
        mimeType: contentType.split(";")[0]!.trim(),
      },
    ];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the chart widget's `AppUiResource`. Both `open_chart_ui` and
 * `knowledge_search` register the same `ui://tako/embed/chart` URI;
 * `mcp.ts`'s registration loop dedupes the second registration so the
 * SDK doesn't throw `Resource ui://... is already registered`.
 *
 * The static URI loads the iframe widget (used by ChatGPT). The
 * dynamic per-pub_id URI bakes the chart image into the resource HTML
 * (used by claude.ai, where the host snapshots `documentElement.
 * offsetHeight` once on widget mount and ignores later updates).
 *
 * `resolveUriFromInput` differs per tool: `open_chart_ui` reads
 * `input.pub_id` directly; `knowledge_search` reads
 * `output.results[0].card_id` (its input is a query, not a pub_id).
 * The resolver receives both arguments so each tool picks the right
 * source.
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
