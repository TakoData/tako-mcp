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
import {
  type Env,
  resolvePublicApiBase,
  resolvePublicBase,
  resolvePublicCdnBase,
  resolveWidgetOrigin,
} from "../env.js";
import { EMBED_PROXY_PREFIX } from "../embed_proxy.js";
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

// Tighter bound for the dimensions-only ranged fetch. It reads 64 bytes and is
// on the critical path of every ChatGPT chart call purely to size the iframe,
// so it must not be able to add seconds to a tool call. Losing the dimensions
// costs a correctly-proportioned iframe, not the chart.
export const PNG_HEAD_FETCH_TIMEOUT_MS = 3_000;

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

/**
 * Widget URI for this deployment, optionally suffixed by `WIDGET_URI_SUFFIX`.
 *
 * Exists because hosts cache the widget resource BY URI, and claude.ai's cache
 * outlives removing and re-adding the connector (see the note above). During
 * local development that means every widget change is invisible: the host keeps
 * serving the bundle it first read, and you debug code that is not running.
 * This was not a hypothetical — three rounds of a rendering fix were tested
 * against a stale bundle before the console log gave it away.
 *
 * Set the var to anything (a timestamp works) to mint a fresh URI and force a
 * re-read. UNSET in staging and production, where the URI must stay stable
 * forever — so this is a dev-only escape hatch, not a versioning scheme. If the
 * SHIPPED bundle ever needs cache-busting, register a new URI ALONGSIDE the old
 * one, per the note above.
 */
export function appUiResourceUri(env: Env): string {
  const suffix = env.WIDGET_URI_SUFFIX;
  if (typeof suffix !== "string" || suffix === "") return APP_UI_RESOURCE_URI;
  // Constrain the value: it becomes a URI the host stores and reads back, and
  // a stray `/` or space would make a URI that never resolves.
  const safe = suffix.replace(/[^A-Za-z0-9._-]/g, "");
  return safe === "" ? APP_UI_RESOURCE_URI : `${APP_UI_RESOURCE_URI}-${safe}`;
}
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

/**
 * The per-pub_id template, suffixed by the same dev lever as the static uri.
 *
 * The template self-busts across DIFFERENT charts because `{pub_id}` varies —
 * but not when you re-test the same chart, which is precisely the loop
 * `WIDGET_URI_SUFFIX` exists for. It also serves a different builder
 * (`buildBakedWidgetHtml`) and is the uri written into the per-call
 * `_meta.ui.resourceUri`, so a host that DOES honour that override would
 * otherwise be pinned to a cached bundle with no way out.
 *
 * Registration and resolution both go through here, so the two can never
 * disagree about the string.
 */
export function appUiTemplateUriPattern(env: Env): string {
  const uri = appUiResourceUri(env);
  return `${uri}/{pub_id}`;
}
export const APP_UI_TEMPLATE_NAME = "open_chart_ui_widget_baked";

// Defaults used when a caller doesn't supply chart-options — applied when
// `tako_search` auto-chains the top card into the inline-render widget.
export const DEFAULT_DARK_MODE = true;
export const DEFAULT_WIDTH = 900;
export const DEFAULT_HEIGHT = 720;

/**
 * Whether the widget may probe the interactive `embed_url` iframe behind the
 * PNG on hosts that render via the image branch (i.e. Claude).
 *
 * OFF, and this is the fix for a user-visible bug rather than a tuning knob.
 *
 * The probe navigates a hidden iframe to `https://tako.com/embed/...`. On
 * claude.ai that load is blocked by a hardcoded `frame-src 'self' blob: data:`
 * outer CSP which ignores our declared `frameDomains`
 * (anthropics/claude-ai-mcp#40) — so the probe fires a
 * `securitypolicyviolation` inside the widget document EVERY time a chart
 * renders. The bundle handles it fine (stays on the PNG), but the HOST sees a
 * blocked subresource in the widget frame and surfaces
 * "There was a problem displaying content from tako." to the user — on a chart
 * that rendered perfectly.
 *
 * So the probe's only audience is the one host where it always fails, and its
 * only observable effect there is an error message next to a working chart.
 * ChatGPT never runs it (it takes the committed-iframe branch), and non-widget
 * clients never load the bundle at all. Expected value: negative.
 *
 * Flipping this to `true` re-enables the auto-upgrade the probe was written
 * for — the day claude.ai honors `frameDomains`, Claude users get the live
 * interactive chart with no bundle change, just this constant and a deploy.
 * That was the original design goal (no redeploy); one deploy is a small price
 * for not shipping an error toast on every render.
 */
export const INTERACTIVE_IFRAME_PROBE_ENABLED = false;

/**
 * URL of the CORS-readable embed-page proxy for one chart, or `undefined` when
 * the native-card path is not available.
 *
 * Requires BOTH the `PUBLIC_CDN_URL` binding (it names the CDN whose assets the
 * companion `/cdn-asset/` route proxies — without it the proxied page's
 * `Card.js` has nowhere to load from) and a known request origin (the widget's
 * own origin is opaque, so it cannot resolve a relative path back to this
 * worker).
 *
 * Why this exists at all, recorded because it took a probe to establish: the
 * host's sandbox DOES honour declared `resourceDomains` for `script-src`
 * (claude.ai, measured 2026-08-01 with a control in the same document — an
 * undeclared origin was blocked with a reported CSP violation while a declared
 * one was permitted). CSP was never the obstacle. The obstacle was CORS: the
 * asset CDN reflects `access-control-allow-origin` for `tako.com` alone, and a
 * `type="module"` script is always a CORS fetch, which is why the assets are
 * proxied rather than loaded directly.
 */
export function nativeCardUrl(
  env: Env,
  origin: string | undefined,
  pubId: string | undefined,
): string | undefined {
  if (resolvePublicCdnBase(env) === undefined) return undefined;
  if (pubId === undefined || pubId === "") return undefined;
  const base = resolveWidgetOrigin(env, origin);
  if (base === undefined) return undefined;
  return `${base}${EMBED_PROXY_PREFIX}${encodeURIComponent(pubId)}`;
}

/**
 * The `_meta` payload both chart tools ship for image-branch hosts: the baked
 * PNG plus the probe flag. Shared so `tako_search` and `tako_visualize` cannot
 * disagree about either — they had identical inline copies of the fetch, and
 * the flag would have been a second thing to keep in sync.
 *
 * Returns `undefined` when there is no image URL or the fetch failed, matching
 * the previous per-tool behavior (the hook is best-effort; the widget falls
 * back to the remote `image_url` from `structuredContent`).
 */
export async function buildChartExtraMeta(
  imageUrl: string | undefined,
  opts: {
    bakeImage: boolean;
    env?: Env | undefined;
    /** Request origin — needed to address this worker's embed proxy. */
    origin?: string | undefined;
    /** Chart id, for the per-chart proxy URL. */
    pubId?: string | undefined;
  },
): Promise<Record<string, unknown> | undefined> {
  // Native-card field rides along on whatever else this returns. Empty unless
  // `PUBLIC_CDN_URL` is set — which both deployed envs now do, so this field is
  // present in staging and production alike, and absent only where the binding
  // is (local dev, and tests that don't supply it).
  const probe: Record<string, unknown> = {};
  const native =
    opts.env !== undefined
      ? nativeCardUrl(opts.env, opts.origin, opts.pubId)
      : undefined;
  if (native !== undefined) probe.native_card_url = native;
  if (imageUrl === undefined) {
    return Object.keys(probe).length > 0 ? probe : undefined;
  }
  // Iframe-branch clients (ChatGPT) never read the image bytes — but they DO
  // need the card's aspect ratio to size the cross-origin iframe, and two
  // integers cost a 64-byte ranged read instead of a ~170 KB render.
  if (!opts.bakeImage) {
    const dims = await fetchPngDimensions(imageUrl);
    if (dims === undefined) {
      return Object.keys(probe).length > 0 ? probe : undefined;
    }
    return {
      ...probe,
      image_natural_width: dims.naturalWidth,
      image_natural_height: dims.naturalHeight,
    };
  }
  const fetched = await fetchImageDataUrlAndDims(imageUrl);
  if (fetched === undefined) {
    return Object.keys(probe).length > 0 ? probe : undefined;
  }
  return {
    ...probe,
    image_data_url: fetched.dataUrl,
    image_natural_width: fetched.naturalWidth,
    image_natural_height: fetched.naturalHeight,
    interactive_probe: INTERACTIVE_IFRAME_PROBE_ENABLED,
  };
}

/**
 * Ceiling on the height an inline widget asks its host for.
 *
 * Claude renders MCP Apps cards inline at up to ~500 px and does NOT give the
 * card its own scrollbar, so anything past that is CROPPED, not scrollable —
 * a taller chart silently loses its bottom edge (axis labels, source line).
 * Desktop fullscreen exists for dashboard-style views, but inline is the only
 * mode on mobile and the default everywhere.
 *
 * This bites `tako_visualize` in particular: its `height` input accepts up to
 * 2000, and `DEFAULT_HEIGHT` is 720 — both above the cap. Rather than request
 * a height the host will crop at an unpredictable point, the widget clamps
 * what it notifies and pairs that with `max-height` + `object-fit: contain`
 * on the image, so an over-tall chart scales down whole instead of losing its
 * bottom. Scaled-and-complete beats full-size-and-truncated for a chart whose
 * axis is the point.
 *
 * Note this caps the WIDGET, never the chart: `embed_url` and the PNG keep the
 * requested dimensions, so the click-through and the downloadable image are
 * unaffected.
 */
const MAX_INLINE_WIDGET_HEIGHT_PX = 500;

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
  // widths is benign; cropping at wide widths is not).
  //
  // Background is TRANSPARENT, not a Tako-ish dark gray as it once was.
  // The dark fill was chosen so iframe-default white would not show through
  // the chart card's rounded corners, but it solved that by painting an
  // opaque rectangle — which on a light-themed host is a dark box with square
  // corners sitting inside the host's rounded container. Transparent lets the
  // host's own surface show through instead, so the only corners visible are
  // the card's, in either theme.
  return `<!doctype html>
<html lang="en" style="min-height: ${initialHeight}px;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-tako-widget" content="open_chart_ui_baked/v1" />
<title>Tako chart</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: transparent; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
  #tako-embed-link { display: block; cursor: pointer; text-decoration: none; }
  #tako-embed-link:hover #tako-embed-img { opacity: 0.95; }
  #tako-embed-img { width: 100%; height: auto; max-height: ${MAX_INLINE_WIDGET_HEIGHT_PX}px; object-fit: contain; display: block; background: transparent; transition: opacity 120ms ease-out; }
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
  html, body { margin: 0; padding: 0; width: 100%; background: transparent; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
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
 * Height reporter injected into the proxied embed page during a native upgrade.
 *
 * Lives here, as its own constant, because it is a `<script>` body nested
 * inside the widget template which is itself a `<script>` body.
 *
 * The runtime value MUST contain a real `</script>`, since it is injected into
 * a fetched HTML document. So the escaping cannot live in this constant — it
 * happens where the value is interpolated into the widget template, which
 * rewrites `</script` to `<\/script`. The HTML parser then no longer sees a
 * closing tag, while JS still reads the string as `</script>`. Skipping that
 * step truncates the entire widget bundle at this line, which is how it was
 * found: every executing widget test failed at once.
 *
 * `__FALLBACK_HEIGHT__` is substituted at upgrade time. It covers the window
 * where Card.js has mounted but not laid out, so `offsetHeight` reads 0 and the
 * host would otherwise collapse the card to nothing.
 *
 * It honors {@link MAX_INLINE_WIDGET_HEIGHT_PX} the same way the PNG path does,
 * and it has to: that ceiling is a host constraint, not a preference — Claude
 * crops past it rather than scrolling, so an over-tall card silently loses its
 * bottom edge. The native card carries strictly MORE than the PNG (range
 * selectors, the chart/table toggle, the source line), so it is the likelier of
 * the two to exceed it, and `document.open()` has already discarded the CSS that
 * enforced the ceiling for the image.
 *
 * The PNG scales down whole via `object-fit: contain`; a document cannot, so the
 * equivalent here is an explicit `transform: scale()`. Each pass clears the
 * previous fit before measuring, so the reading is always the card's natural
 * height at the real frame width and the result cannot oscillate.
 *
 * The ceiling is not a one-time measurement, and treating it as one was the
 * second half of the 2026-08-07 claude.ai report. The native card is
 * INTERACTIVE: switching tab and pressing `Show more` both relayout it, and
 * neither fires `resize` or `load`. Measured on the real Nvidia card at a
 * 762 px frame — 527 px on open, 619 px after a tab switch, 641 px after
 * `Show more` — against a document whose own CSS sets `:root{overflow-y:hidden}`.
 * So growth past the last reported height is not scrolled and not scaled, it is
 * simply gone, which is the card being "weirdly cut off" partway through a row.
 * The ladder below cannot cover it: the click happens whenever the user clicks.
 *
 * Hence the `ResizeObserver`. Two details make it safe rather than a layout loop:
 *
 *   - It observes `document.body`, not `documentElement`. The fit is applied to
 *     `documentElement`, so observing that would mean every correction observed
 *     itself.
 *   - Applying the fit still changes body's width, which the observer DOES see.
 *     `last` therefore records body's `scrollHeight` as it stands AFTER the fit,
 *     and a pass whose reading matches it returns before touching a single
 *     style. That is what terminates the sequence: correction, one confirming
 *     callback, quiet — instead of clear/measure/re-apply every frame forever.
 */
const NATIVE_HEIGHT_REPORTER = [
  "<script>(function(){",
  "var CAP=" + String(MAX_INLINE_WIDGET_HEIGHT_PX) + ";",
  // Body's scrollHeight as of the end of the last pass that did work — the
  // reentrancy guard described above. -1 so the first pass always runs.
  "var last=-1;",
  "function raw(){return document.body?document.body.scrollHeight:0;}",
  "function n(force){",
  "var d=document.documentElement;if(!d)return;",
  // Nothing has moved since we last fitted the document, so re-fitting it would
  // only be the observer answering itself. The `force` flag exists for the
  // triggers that know something changed out-of-band (the frame resized) or that
  // must report regardless of layout (the initial pass and the mount ladder).
  "if(!force&&raw()===last)return;",
  // Measure UNSCALED: clear any fit applied on an earlier pass so `offsetHeight`
  // reports the card's natural height rather than a previously scaled one.
  "d.style.transform='';d.style.transformOrigin='';d.style.width='';",
  "var h=d.offsetHeight||0;",
  "if(h<=0)h=__FALLBACK_HEIGHT__;",
  // Over the host's inline ceiling: scale the whole document down to fit
  // instead of letting the host crop the axis and source line off the bottom.
  // Widening to `100/s`% first means the content still fills the frame after
  // the transform shrinks it.
  "if(h>CAP){var s=CAP/h;",
  "d.style.transformOrigin='top left';",
  "d.style.width=(100/s)+'%';",
  "d.style.transform='scale('+s+')';",
  "h=CAP;}",
  "last=raw();",
  "try{if(window.openai&&typeof window.openai.notifyIntrinsicHeight==='function')",
  "window.openai.notifyIntrinsicHeight(h);}catch(e){}",
  "try{window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',",
  "params:{width:(document.documentElement&&document.documentElement.clientWidth)||0,height:h}},'*');}catch(e){}",
  "}",
  "function f(){n(true);}",
  "f();",
  "window.addEventListener('resize',f);",
  "window.addEventListener('load',f);",
  // Card.js mounts asynchronously and lazily imports its view chunks, so the
  // first few reads land before the card has its real height. Re-report on a
  // short ladder rather than once.
  "setTimeout(f,400);setTimeout(f,1200);setTimeout(f,3000);",
  // Everything after that ladder — a tab switch, `Show more`, a chart that
  // finishes drawing late. Feature-detected because a failure to observe must
  // leave the ladder's behaviour intact, not throw and lose it too.
  "try{if(typeof ResizeObserver!=='undefined'&&document.body){",
  "new ResizeObserver(function(){n(false);}).observe(document.body);",
  "}}catch(e){}",
  "})();<\/script>",
].join("");

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
  #tako-embed-img { width: 100%; height: auto; max-height: ${MAX_INLINE_WIDGET_HEIGHT_PX}px; object-fit: contain; display: block; background: transparent; transition: opacity 120ms ease-out; }
  #tako-placeholder {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 240px;
  }
  /* The empty state — see \`collapse()\`. Three declarations here are
     load-bearing, not cosmetic:
       - \`position: fixed\` + offsets: fills the host's reserved viewport
         (whatever it kept after we asked for zero) while staying OUT of flow,
         so a host that sizes the frame from content still measures a
         zero-height document. Written long rather than as \`inset\` only
         because the four sides read plainly next to the \`100vh\` below; the
         shorthand would be equally safe.
       - \`height: 100vh\`: redundant wherever fixed positioning resolves against
         the viewport (every current engine), and the reason this does not
         depend on that. The widget renders inside an iframe on hosts we do not
         control, and WebKit has historically resolved fixed positioning inside
         a frame against the DOCUMENT instead — where \`top/bottom: 0\` on a
         zero-height document collapses the label to nothing. \`100vh\` is the
         frame's own viewport either way, so the label fills the visible box on
         both readings, and equals 0 when the host honoured the shrink, so it
         still cannot make a collapsed widget visible or measurable.
       - transparent background: \`applyHostSurface\` paints the canvas in the
         host's own colour, and a second surface here would put a visible
         rectangle inside the very box this label exists to explain.
     The colour is the SILENT-HOST case only — \`collapse()\` overrides it inline
     whenever the host declared a theme, which is the signal that actually
     matches the backdrop. Base is the light value because an unstyled frame
     composites to an opaque white base (measured; see \`applyHostSurface\`), and
     the dark override uses the one signal an iframe gets for free. 4.83:1 on
     white and 5.4:1 on a dark host, against 3.25:1 for any single grey that
     tries to hedge both. */
  #tako-empty {
    position: fixed; top: 0; right: 0; bottom: 0; left: 0;
    height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 0 16px; box-sizing: border-box;
    font-size: 13px; text-align: center; color: #6b7280;
    pointer-events: none; background: transparent;
  }
  @media (prefers-color-scheme: dark) {
    #tako-empty { color: #b4b8bd; }
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
<!-- Shown only by \`collapse()\`, i.e. only once we know there is no chart to
     draw. Never a loading state: on a host that honours the shrink this sits
     inside a zero-height viewport and is invisible, which is the outcome we
     prefer and must not spoil with a flash of text. -->
<div id="tako-empty" class="hidden">No chart for this result</div>
<iframe
  id="tako-embed"
  class="hidden"
  scrolling="no"
  frameborder="0"
  allow="fullscreen; clipboard-write"
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
  var empty = document.getElementById("tako-empty");
  var rendered = false;
  // Origin of the iframe we loaded — used to gate the height handshake
  // listener below so we only honor resize messages from the actual
  // embed page, not arbitrary cross-frame senders.
  var embedOrigin = null;
  // Has the embed page told us its own content height (\`tako-embed-height\`)?
  //
  // Once it has, that number is AUTHORITATIVE and nothing derived may overwrite
  // it. The embed knows what it is rendering; every other height here is an
  // estimate of that. This matters because the estimate and the report disagree
  // by design on responsive cards: \`aspectHeight\` extrapolates from the chart
  // PNG's fixed 2400 px-wide render, but the live page REFLOWS at the widget's
  // real column width — a schedule or ranked table grows rows and pagination
  // that the flat image never had. Measured on the MLB schedule card at a
  // 634 px column: aspect says 525 px, the page reports 732 px, and 525 px
  // cuts the card off mid-row.
  var embedReportedHeight = false;

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

  // Height for the embed iframe, derived from the CARD's real aspect ratio.
  //
  // A cross-origin iframe never sizes itself to its content, and the Tako embed
  // page does not report its height, so this height is the only thing deciding
  // the box. It used to be \`structuredContent.height\` — a flat 720 — against a
  // chat column around 700 px wide. That is a near-square frame holding a card
  // whose real aspect is 2.18:1 for a plain chart, so the card painted ~320 px
  // tall and left ~400 px of empty background beneath it. Ranked/list cards run
  // 1.30:1 and Stock Overviews 1.91:1, so no single constant fits any of them.
  //
  // \`image_natural_width/height\` carry the true per-card aspect (the server
  // reads them off the chart PNG's header). Multiply by the live container
  // width and the frame matches the card at any column width, mobile included.
  //
  // Returns null when we have no dimensions, so callers keep the old behavior
  // rather than guessing.
  function aspectHeight(naturalW, naturalH) {
    if (!(naturalW > 0) || !(naturalH > 0)) return null;
    var cw =
      (document.documentElement && document.documentElement.clientWidth) ||
      (document.body && document.body.clientWidth) ||
      0;
    if (!(cw > 0)) return null;
    return Math.round((cw * naturalH) / naturalW);
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

  // The host's declared theme, or null when it does not say.
  //
  // Both chart urls carry \`dark_mode=auto\`, which the embed page resolves from
  // \`prefers-color-scheme\` INSIDE this iframe — i.e. from the OS. That is right
  // whenever the host follows the OS and wrong whenever the user has themed the
  // host itself: a dark ChatGPT on a light Mac renders a light card on a dark
  // surface. Hosts that expose their theme are believed over the OS; the rest
  // keep \`auto\`, which is still the best available guess.
  //
  // Two sources, because the two host families expose the theme differently:
  //
  //   - ChatGPT: \`window.openai.theme\`, readable synchronously at any time.
  //   - MCP Apps (claude.ai): \`hostContext.theme\` on the \`ui/initialize\`
  //     RESPONSE, with \`ui/notifications/host-context-changed\` for updates
  //     (spec 2026-01-26). Asynchronous — it arrives with the handshake.
  //
  // ChatGPT's runtime wins when both are present: it is the authority on its
  // own host, and a stale \`hostContext\` must not override it.
  //
  // An earlier revision of this comment asserted the spec defined no theme and
  // left claude.ai on \`dark_mode=auto\` — i.e. on the OS. That was wrong, and
  // the bug it caused was exactly the one you would predict: a light Claude on
  // a dark machine rendering a dark card on a light surface (TAKO-3781).
  //
  // Ordering is what makes reading it asynchronously safe. A spec-compliant
  // host MUST NOT send notifications before our \`initialized\`, which we only
  // send once the \`ui/initialize\` response lands — so \`hostContext\` is
  // already known by the time any \`tool-result\` arrives. Hosts that never
  // answer the handshake fall through to \`auto\` via the 200 ms fallback,
  // which is the same OS-derived guess as before.
  var mcpHostTheme = null;

  // The host's own page background, when it sends one. This is the EXACT fix
  // for the card's exposed corners: painting the widget canvas in the host's
  // surface colour makes the square canvas invisible AND gives the corners the
  // right backdrop, where \`color-scheme\` can only get close.
  var mcpHostSurface = null;

  // Spec: "Views merge received fields with their current context state rather
  // than replacing it entirely." So a partial update that omits \`theme\` must
  // leave the known theme alone rather than clearing it.
  function mergeHostContext(hostContext) {
    if (!hostContext || typeof hostContext !== "object") return;
    var t = normalizeTheme(hostContext.theme);
    var surface = readHostSurface(hostContext);
    // Merge semantics differ between these two fields, and the spec's "merge,
    // don't replace" rule is why. A theme value is self-describing, so keeping
    // a known one across an update that omits it is right. A SURFACE COLOUR is
    // theme-DEPENDENT: a host that flips dark to light and sends the
    // spec-legal \`{theme:"light"}\` with no \`styles\` would otherwise leave the
    // dark colour in place, and because it stays truthy tier 1 returns early
    // and paints it under a light card — this PR's own bug, mirrored, and
    // confidently wrong rather than merely stale. So a theme CHANGE that
    // carries no replacement surface drops the stale one and lets tier 2 run.
    if (t !== null && t !== mcpHostTheme && surface === null) {
      mcpHostSurface = null;
    }
    if (t !== null) mcpHostTheme = t;
    if (surface !== null) mcpHostSurface = surface;
  }

  // The MCP Apps standardized background tokens, best first. Same list in both
  // readers below, because a host may deliver them either way.
  var SURFACE_TOKENS = ["--color-background-primary", "--color-background-secondary"];

  // Chrome's own Canvas colours, as literals. \`background: Canvas\` cannot be
  // used for this: the root element's background propagates to the canvas, and
  // when that background IS the canvas colour Chrome treats it as nothing to
  // paint — measured, the frame stayed transparent and the white below still
  // showed. The literals paint.
  // The card's own corner radius, mirrored so our backdrop is clipped to the
  // same shape it sits behind. A square backdrop behind a rounded card leaves a
  // crescent at each corner, and that crescent is visible on any host whose
  // real background differs from the backdrop colour — which is every host,
  // since the colour is a claim from \`hostContext\` and not a measurement.
  // Sourced from the embed page's card (8px); if that changes, this follows.
  var CARD_CORNER_RADIUS = "8px";
  var CANVAS_DARK = "#121212";
  var CANVAS_LIGHT = "#ffffff";

  // Per the MCP Apps spec, \`hostContext.styles.variables\` carries standardized
  // CSS custom properties. Take the primary background; fall back to the
  // surface variant if a host ships only that one.
  function readHostSurface(hostContext) {
    var styles = hostContext.styles;
    if (!styles || typeof styles !== "object") return null;
    var vars = styles.variables;
    if (!vars || typeof vars !== "object") return null;
    for (var i = 0; i < SURFACE_TOKENS.length; i++) {
      var v = vars[SURFACE_TOKENS[i]];
      if (safeCssColor(v)) return v;
    }
    return null;
  }

  // The same tokens, read off OUR OWN root instead of the handshake.
  //
  // \`hostContext.styles.variables\` is how the MCP Apps spec transports them,
  // but a host is equally free to just set the custom properties on the widget
  // document — and ChatGPT, which never sends \`hostContext\` at all, is exactly
  // the host that would have to. Neither OpenAI's Apps SDK reference nor its
  // custom-UX guide documents any surface token today, so this reads as null
  // there and the theme fallback takes over. It costs one \`getComputedStyle\`
  // and turns "ChatGPT ships tokens" from a code change into a no-op.
  function readSurfaceTokens() {
    try {
      var cs = window.getComputedStyle(document.documentElement);
      for (var i = 0; i < SURFACE_TOKENS.length; i++) {
        var v = (cs.getPropertyValue(SURFACE_TOKENS[i]) || "").trim();
        if (safeCssColor(v)) return v;
      }
    } catch (e) { /* no computed style — fall through to the theme */ }
    return null;
  }

  // The colour to put BEHIND the chart, best source first. Null means every
  // source came up empty, which is the one case where painting would be a
  // guess rather than a fix.
  function chartBackdrop() {
    if (mcpHostSurface) return mcpHostSurface;
    var token = readSurfaceTokens();
    if (token) return token;
    var t = hostTheme();
    if (t === null) t = mediaTheme();
    if (t === "dark") return CANVAS_DARK;
    if (t === "light") return CANVAS_LIGHT;
    return null;
  }

  // Last-resort theme source: this frame's own \`prefers-color-scheme\`.
  //
  // Why it belongs here, and why its absence was the bug. Every chart url
  // carries \`dark_mode=auto\`, which the embed page resolves from
  // \`prefers-color-scheme\` INSIDE this iframe. So on a host that exposes no
  // theme at all — no \`window.openai\`, no MCP \`hostContext\`, no
  // \`--color-background-*\` tokens — the CARD still renders themed, from the
  // media query, while \`chartBackdrop()\` returned null and painted nothing.
  // The card came out dark, its rounded corners fell through to the host's own
  // layer, and that layer is white. That asymmetry IS the white-corner report:
  // the card knew it was dark and the backdrop did not.
  //
  // Reading the same signal the card reads makes the two agree by construction,
  // which is the property that actually matters — a backdrop that disagrees
  // with the card is worse than none.
  //
  // Deliberately NOT folded into \`hostTheme()\`: that also drives
  // \`withHostTheme()\`, which rewrites \`dark_mode\` on the chart urls. Feeding a
  // media-query value there would turn \`auto\` into an explicit \`true\`/\`false\` —
  // the same result by a longer road, but it would stop the embed page from
  // resolving the theme itself, which is the behaviour every other host relies
  // on. Backdrop only.
  //
  // Returns null when the media query is unavailable or has no preference, so
  // "no source names a colour" still means paint nothing.
  function mediaTheme() {
    try {
      if (!window.matchMedia) return null;
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch (e) { /* no matchMedia in this frame */ }
    return null;
  }

  // This value arrives over postMessage and is interpolated into a \`<style>\`
  // block injected into the native card document, so it is an injection sink.
  // Allow-list a colour grammar instead of trying to escape one: hex, and the
  // functional notations, with no semicolons, braces, quotes, or \`url(\`.
  // Anything else is dropped and we fall back to \`color-scheme\`.
  function safeCssColor(v) {
    return allowListedColorShape(v) && paintsAsColor(v);
  }

  // Gate 1 — the INJECTION guard, and the only reason a grammar is enumerated
  // here at all: this value is interpolated into a \`<style>\` block written into
  // the native card document. No braces, semicolons, quotes, angle brackets or
  // parens inside the body, so nothing can close the block or smuggle
  // \`url(\`/\`expression(\`. Length-capped. Hex spellings are the four CSS
  // actually defines (3/4/6/8) — \`{3,8}\` also matched 5 and 7, which are not
  // colours.
  function allowListedColorShape(v) {
    if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
    return /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\\(\\s*[0-9a-zA-Z.,%\\/\\s+-]+\\)$/.test(v);
  }

  // Gate 2 — does it actually PAINT? The shape check enumerates spellings, and
  // the enumeration kept leaking: \`rgb()\`, then \`rgb( )\`, \`rgb(url)\`,
  // \`lab(image-set)\`, \`#12345\`. Each passed, assigned as nothing, left
  // \`mcpHostSurface\` truthy so tier 1 returned early, and made the log report
  // a surface that never rendered. Asking the CSS parser closes the whole class
  // instead of the next spelling. Runs SECOND so the injection gate is never
  // skipped, and the parser only ever sees an already-allow-listed string.
  function paintsAsColor(v) {
    try {
      if (window.CSS && window.CSS.supports &&
          window.CSS.supports("background-color", v)) {
        return true;
      }
    } catch (e) { /* fall through to the round-trip */ }
    try {
      var probe = document.createElement("span");
      probe.style.backgroundColor = v;
      return probe.style.backgroundColor !== "";
    } catch (e) {
      return false;
    }
  }

  // Substring, not equality: hosts have shipped values like
  // \`dark-high-contrast\`. Anything unrecognised reads as "host said nothing",
  // which leaves \`auto\` in place rather than guessing.
  function normalizeTheme(value) {
    if (typeof value !== "string" || !value) return null;
    var v = value.toLowerCase();
    if (v.indexOf("dark") !== -1) return "dark";
    if (v.indexOf("light") !== -1) return "light";
    return null;
  }

  function hostTheme() {
    try {
      var t = normalizeTheme(window.openai && window.openai.theme);
      if (t !== null) return t;
    } catch (e) { /* no host runtime */ }
    return mcpHostTheme;
  }

  // Give the card's exposed corners the right backdrop.
  //
  // Every chart surface we render — baked PNG, committed iframe, native card —
  // is a rounded rectangle (8px) over a TRANSPARENT html/body, so its four
  // corner arcs fall through to whatever is behind. Measured in Chrome, on a
  // page that paints white behind the widget frame:
  //
  //   - transparent html/body, no \`color-scheme\` -> the frame composites
  //     through and the corners show the white. Same-origin, cross-origin,
  //     sandboxed, and nested two frames deep all behave identically: the
  //     nesting is not what produces the white, the host's own layer is.
  //   - \`:root{color-scheme:dark}\` on the widget document -> did NOT cover it
  //     in any of those configurations. It paints Chrome's #121212 base in some
  //     frame setups and not others, so it cannot be relied on for this.
  //   - \`background: Canvas\` on the widget root -> also did not cover it. The
  //     root's background propagates to the canvas, and when that background IS
  //     the canvas colour there is nothing left to paint.
  //   - a CONCRETE colour on the chart element -> covers it, every time. The
  //     iframe's own box background paints beneath the frame's content, so it
  //     shows exactly where the card is transparent: the corners.
  //
  // Hence: put the backdrop on the CHART ELEMENTS, not on the canvas. It covers
  // the only pixels that were ever wrong, and a host that reserves more space
  // than the chart fills still shows its own surface there — no opaque box
  // where none existed, which is what kept the earlier fix off ChatGPT.
  //
  // The canvas paint stays for tier 1 alone, where the colour IS the host's own
  // and so cannot read as a box.
  //
  // All of it is a no-op when no source names a colour. With nothing to key on,
  // painting is a guess, and a wrong guess is a black corner on a light host.
  function applyHostSurface() {
    try {
      var root = document.documentElement;
      var backdrop = chartBackdrop();
      // Behind the chart, on every path. \`frame\` is the committed/probed embed
      // iframe, \`image\` the baked PNG — both rounded, both transparent at the
      // corners.
      // Cleared, not just skipped, when nothing names a colour any more —
      // otherwise a theme flip that drops its surface leaves the previous
      // theme's backdrop painted behind the corners.
      // Rounded to the CARD's radius, not left square.
      //
      // This is the whole bug, measured from inside the frame: the card paints
      // its own surface with an 8px radius, our backdrop was a SQUARE rectangle
      // behind it, and the crescent where the two disagree is a visible ring on
      // every host whose real background differs from the colour we picked.
      //
      // And it always differs eventually, because the colour is not knowable.
      // The reporting host DECLARED \`#212121\` over MCP \`hostContext\` while
      // rendering the page behind the widget black — so the backdrop was doing
      // exactly what it was told and still drawing a grey outline on black.
      // Matching the radius removes the dependency: the paint now lies entirely
      // under the card, the corners fall through to whatever the host actually
      // renders, and the card reads as a floating rounded card on the host's
      // own surface — which is what it is.
      //
      // The paint is kept rather than dropped: it still covers the card's
      // interior against a transparent embed document (the case the baked-PNG
      // and native-card paths rely on) and costs nothing where the card is
      // opaque.
      // SCOPED TO THE ChatGPT PATH. Everything below the radius clip is a fix
      // for a bug measured on that host, and claude.ai renders correctly in
      // production today with the ORIGINAL behaviour — so the safe change is
      // the narrow one. \`hasOpenAiRuntime()\` is the same predicate that already
      // decides the committed-iframe branch, so this cannot disagree with the
      // path actually taken.
      var chatgpt = hasOpenAiRuntime();
      if (frame) {
        frame.style.background = backdrop || "";
        // Clip only on ChatGPT: a square backdrop behind a rounded card leaves
        // a crescent at each corner, which is the reported ring there.
        frame.style.borderRadius = chatgpt && backdrop ? CARD_CORNER_RADIUS : "";
      }
      if (image) {
        image.style.background = backdrop || "";
        image.style.borderRadius = chatgpt && backdrop ? CARD_CORNER_RADIUS : "";
      }
      // Tier 1 — the host's exact surface, so painting the whole canvas is safe:
      // it becomes indistinguishable from the host's own page.
      // Tier 1 — the host's exact surface. RETAINED for every host except
      // ChatGPT, unchanged from the behaviour claude.ai renders correctly in
      // production.
      //
      // Suppressed on ChatGPT because that host disproved the tier's premise:
      // it declared \`#212121\` over \`hostContext\` while rendering the page
      // behind the widget BLACK, so painting the canvas laid a full-bleed grey
      // rectangle under a rounded card — an outline around the whole card
      // rather than merely wrong corners. A declared surface is a claim about
      // the host's theme, not a measurement of the pixels behind this frame,
      // and nothing here can verify it. Where the claim is good the paint is
      // invisible; where it is wrong it is a ring. Only ChatGPT has been
      // measured wrong, so only ChatGPT stops trusting it.
      if (mcpHostSurface && !chatgpt) {
        root.style.background = mcpHostSurface;
        if (document.body) document.body.style.background = mcpHostSurface;
        var t1 = hostTheme();
        if (t1) root.style.colorScheme = t1;
        return;
      }
      // No exact colour, or ChatGPT: undo any canvas paint a previous call left
      // behind. Clearing \`mcpHostSurface\` on a theme flip is only half of that
      // — if the old colour stays on the element, the canvas keeps painting the
      // previous theme's surface no matter what this call decides.
      root.style.background = "";
      if (document.body) document.body.style.background = "";
      // \`color-scheme\` is still worth declaring: it is what form controls,
      // scrollbars and the UA stylesheet inside this document key off. It is
      // just not load-bearing for the corners any more. \`hostTheme()\` reads
      // \`window.openai.theme\` first, so ChatGPT is covered here too — the gate
      // that used to exclude it came off when its dark mode was measured
      // (Aug 12 2026) showing the same white corners claude.ai had.
      var t2 = hostTheme();
      if (t2 !== null) root.style.colorScheme = t2;
    } catch (e) { /* pre-body or hostile host — cosmetic, never fatal */ }
  }

  // Suppress the embed page's analytics for any load THIS widget performs.
  //
  // \`disable_tracking\` is an existing, supported flag on Tako's embed route:
  // it gates the Google Tag Manager bootstrap out of the page
  // (\`templates/embed/Card.html\`) and excludes the load from Tako's own
  // impression counters (\`embed_impressions.should_track_impression\`).
  //
  // Required rather than cosmetic. OpenAI's iframe policy singles out
  // analytics and tracking inside an app's embedded frame, and the ChatGPT
  // path commits to a real cross-origin iframe of \`tako.com/embed/…\` — so
  // without this the reviewed surface loads a third-party beacon. Losing the
  // impression count for widget renders is the accepted cost; a chart drawn
  // by an agent was never the same signal as a person opening the page, and
  // the shareable \`embed_url\` a user actually clicks is unaffected.
  //
  // Idempotent, and it never rewrites an existing value — a caller (or a
  // future \`?disable_tracking=false\`) is left alone rather than silently
  // overridden.
  function withoutTracking(url) {
    if (!url || typeof url !== "string") return url;
    if (url.indexOf("disable_tracking=") !== -1) return url;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "disable_tracking=true";
  }

  // Rewrite \`dark_mode\` on a chart url to match the host. Leaves the url alone
  // when the host is silent, so \`auto\` survives rather than being guessed at.
  //
  // The \`!url\` bail is load-bearing, not defensive noise. \`nativeCardUrl\` is
  // \`""\` whenever \`_meta.native_card_url\` is absent. No longer the deployed
  // default, but still reachable three ways: an env without \`PUBLIC_CDN_URL\`, a
  // resolve that fails, and any cached tool result from before the field
  // existed. And \`""\` IS a string, so without this it fell past the
  // \`typeof\` check into
  // the append branch and returned \`"?dark_mode=true"\`. That cleared
  // \`upgradeToNativeCard\`'s own \`nativeUrl === ""\` guard (it sees the
  // transformed value, not the original) and reached
  // \`fetch("?dark_mode=true")\`, resolved against the widget document — a
  // request in nobody's \`connect-src\`, which is the same blocked-subresource
  // class the retired iframe probe was costing us.
  function withHostTheme(url) {
    if (!url || typeof url !== "string") return url;
    var theme = hostTheme();
    if (theme === null) return url;
    var want = theme === "dark" ? "true" : "false";
    return url.indexOf("dark_mode=") !== -1
      ? url.replace(/dark_mode=[^&]*/, "dark_mode=" + want)
      : url + (url.indexOf("?") === -1 ? "?" : "&") + "dark_mode=" + want;
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
    // The url we actually navigate to: analytics-free, like every other iframe
    // load this widget performs (see \`withoutTracking\`). \`url\` itself stays
    // untouched so the click-through anchor keeps the plain shareable link.
    var probeUrl = withoutTracking(url);
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
      armEmbedOrigin(probeUrl);
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
    frame.src = probeUrl;
    probeNavigated = true;
    timer = setTimeout(function () { fail("timeout"); }, IFRAME_SETTLE_MS);
    log("iframe probe started", { src: probeUrl });
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

  // Native-card upgrade. Replace the PNG with Tako's REAL card — the same
  // interactive document ChatGPT renders — by fetching the embed page through
  // our CORS-enabled proxy and letting its own scripts run here.
  //
  // Shaped as an UPGRADE, never a first paint, and that is the whole safety
  // story: the PNG is painted first and stays until this has the markup in
  // hand. A slow proxy, a 502, a CSP surprise, or an upstream redesign all cost
  // an upgrade and nothing else — the chart on screen is untouched. It is also
  // why the fetch completes BEFORE \`document.open()\` is called: opening the
  // document blanks it, so doing that speculatively would trade a working chart
  // for a white box.
  //
  // Why the whole page rather than mounting Card.js ourselves: the page carries
  // its config and theme as inline JSON islands and bootstraps from them.
  // Writing the document verbatim means Tako's own bootstrap runs, so there is
  // no mount contract to reverse-engineer and no second copy to keep in sync.
  // \`document.write\` executes inserted scripts, including the
  // \`type="module"\` Card.js tag and the chunks it imports.
  var nativeStarted = false;
  function upgradeToNativeCard(nativeUrl, fallbackHeight) {
    if (nativeStarted || typeof nativeUrl !== "string" || nativeUrl === "") return;
    nativeStarted = true;
    // Snapshot the theme HERE, next to the url whose \`dark_mode\` was already
    // fixed from it by the caller's \`withHostTheme\`. Reading it again inside
    // the \`.then()\` — up to 7 s later — let a \`host-context-changed\` arriving
    // mid-fetch write a document whose CARD was rendered for the old theme
    // wrapped in a \`:root{background;color-scheme}\` block for the new one. And
    // \`nativeStarted\` means there is no second fetch to reconcile it, so the
    // inconsistency would be permanent for that card.
    var snapBackdrop = chartBackdrop();
    var snapScheme = hostTheme();
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      log("native card fetch timed out, staying on image", { url: nativeUrl });
    }, 7000);
    fetch(nativeUrl, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof html !== "string" || html.indexOf("<html") === -1) {
          throw new Error("not an html document");
        }
        // Height reporting must survive the swap: \`document.open()\` discards
        // this script's document, listeners included. Injecting a reporter into
        // the markup keeps the host sized correctly — the same
        // size-changed / notifyIntrinsicHeight pair the baked variant sends.
        var reporter = ${JSON.stringify(NATIVE_HEIGHT_REPORTER).replace(/<\/script/gi, "<\\/script")}.replace(
          "__FALLBACK_HEIGHT__",
          String(fallbackHeight || 0),
        );
        // The card paints its own surface with an 8px radius over a TRANSPARENT
        // html/body, so its corners fall through to the document's backdrop —
        // which behind claude.ai's widget frame is opaque WHITE. Those were the
        // white triangles under the card's corners.
        //
        // Same backdrop \`applyHostSurface\` resolves, but it has to go on the
        // CANVAS here: this path replaces the whole document with the card, so
        // there is no chart element left to hang a background on. That also
        // means the canvas is covered by the card everywhere except the corners
        // and whatever the host reserved beyond it, which is what makes an
        // approximate colour acceptable here too.
        //
        // Injected LAST so it wins over the page's own rules.
        var scheme = snapScheme;
        var schemeStyle = "";
        // \`color-scheme\` only — the backdrop is deliberately NOT painted here.
        //
        // This path replaces the whole document with the card, so
        // \`:root,body{background:…}\` paints a FULL-BLEED rectangle behind a card
        // that has 8px rounded corners: the same square-behind-rounded mismatch
        // that drew a visible outline on the iframe path, in the one place
        // claude.ai actually renders. And the colour is no more knowable here —
        // it comes from the same \`hostContext\` claim, which the reporting host
        // got wrong (declared \`#212121\`, rendered black).
        //
        // Leaving the canvas transparent lets the host's real background show
        // through the card's corners, which is correct on every host without
        // trusting anyone's colour. \`color-scheme\` stays: it themes the
        // UA-drawn surfaces inside the card (scrollbars, form controls) and
        // paints nothing itself.
        // Same scoping as \`applyHostSurface\`: the backdrop still rides into the
        // native document on every host EXCEPT ChatGPT, unchanged from what
        // claude.ai renders correctly in production today. This path replaces
        // the document with the card, so on ChatGPT the paint would be the same
        // full-bleed rectangle under a rounded card that the canvas tier was
        // suppressed for — and ChatGPT is the only host measured to declare a
        // surface that does not match what it renders.
        var backdrop = hasOpenAiRuntime() ? null : snapBackdrop;
        if (backdrop) {
          schemeStyle =
            '<style id="tako-host-scheme">:root,body{background:' + backdrop + '}' +
            (scheme ? ':root{color-scheme:' + scheme + '}' : "") + '</style>';
        } else if (scheme) {
          schemeStyle =
            '<style id="tako-host-scheme">:root{color-scheme:' + scheme + '}</style>';
        }
        var injected = schemeStyle + reporter;
        var patched =
          html.indexOf("</body>") !== -1
            ? html.replace("</body>", injected + "</body>")
            : html + injected;
        log("native card upgrading", { bytes: patched.length, scheme: scheme || "(host silent)", backdrop: backdrop || "(none)" });
        document.open();
        document.write(patched);
        document.close();
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log("native card fetch failed, staying on image", {
          error: String(err && err.message ? err.message : err),
        });
      });
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
    // Two independent permissions, both required. \`opts.allowProbe\` is the
    // caller's (false on an iframe downgrade); \`probeEnabled\` is the SERVER's
    // — \`interactive_probe\` in \`_meta\`, default false. See
    // \`INTERACTIVE_IFRAME_PROBE_ENABLED\`: on claude.ai the probe is
    // guaranteed to trip \`frame-src\` CSP, and the host reports that blocked
    // subresource to the user as "There was a problem displaying content from
    // tako." next to a chart that rendered fine. Off until claude.ai honors
    // \`frameDomains\`.
    var allowProbe = opts.allowProbe !== false && opts.probeEnabled === true;
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
          // Clamped: the host crops rather than scrolls past its inline
          // ceiling, and \`max-height\` + \`object-fit: contain\` above has
          // already scaled the image to fit, so asking for more would reserve
          // empty space at best and lose the axis at worst.
          var renderedH = Math.min(
            Math.round(rectH || offsetH || 0),
            ${MAX_INLINE_WIDGET_HEIGHT_PX}
          );
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
        upgradeToNativeCard(withHostTheme(opts.nativeCardUrl), h);
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
        upgradeToNativeCard(withHostTheme(opts.nativeCardUrl), h);
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

  // Take the widget to zero height, label whatever the host refuses to give
  // back, and mark it done. Used by the no-chart guard in render() and by the
  // no-data watchdog at the bottom of the file.
  //
  // Asking for zero is not enough, and that is the whole reason the label
  // exists. The host mounts this widget from STATIC tool-registration metadata
  // (\`openai/outputTemplate\` / \`ui.resourceUri\` in \`tools/list\`), which cannot
  // know whether a given call produced a chart — so every chart-less call gets
  // a mounted widget, and a host with a minimum card height (ChatGPT, reported
  // 2026-08 on a zero-card search) keeps that card visible after the shrink to
  // zero. What the user then sees is an unexplained grey void next to an answer
  // that worked.
  //
  // So: paint a quiet line into the space instead. Painting is free in the good
  // case — a host that honoured the zero is showing a zero-height viewport, and
  // \`#tako-empty\` is \`position: fixed\`, so it neither renders nor adds to the
  // document's measurable height there. And no height is notified after the
  // zero: the label dresses a box the host chose to keep, and must never be a
  // reason to reserve one that was already given up.
  function collapse(labelled) {
    placeholder.classList.add("hidden");
    // \`labelled\` is only true where the emptiness is a FACT: structured content
    // arrived and carried no chart. The watchdog path passes false, because
    // "nothing arrived within 10 s" is not the same claim — a failed call and a
    // merely slow delivery are indistinguishable from in here, and this
    // function discards whatever lands afterwards (\`rendered = true\`). Saying
    // "No chart for this result" there would be an affirmative statement that
    // is wrong exactly when the chart was late rather than absent. Blank keeps
    // that path's pre-existing behaviour, and hosts show their own error for
    // the failed call.
    if (empty && labelled) {
      // Contrast, not decoration. The body's placeholder grey lands around
      // 2:1 against a light host — legible to whoever wrote it and to nobody
      // else. When the host DECLARED a theme, use its value: ~4.8:1 on light,
      // ~5:1 on dark, and it beats any OS signal because the host's theme and
      // the machine's can disagree (TAKO-3781).
      //
      // When it declared none, leave the CSS alone. The stylesheet's base is
      // the light value with a \`prefers-color-scheme\` dark override, which is
      // strictly better than a compromise grey: a silent host is also one
      // \`applyHostSurface\` leaves untouched, and per the measured note above
      // that is the same-origin case where the canvas composites over the
      // host's own page — so the OS signal tracks the backdrop. Residual risk,
      // accepted: a CROSS-origin host that sends no theme composites to an
      // opaque white base regardless of the OS, so a dark-mode machine there
      // reads ~1.9:1. No host we know of is in that intersection (claude.ai
      // and ChatGPT both declare a theme), and it is not detectable from in
      // here — the white is the compositor's base, not a style we can read.
      var t = hostTheme();
      if (t === "light" || t === "dark") {
        empty.style.color = t === "light" ? "#6b7280" : "#b4b8bd";
      }
      empty.classList.remove("hidden");
    }
    document.documentElement.style.height = "0px";
    document.body.style.height = "0px";
    notifyHeight(0);
    rendered = true;
  }

  function render(structuredContent, meta) {
    if (rendered) return true;
    if (!structuredContent || typeof structuredContent !== "object") return false;
    // Also here, not just on the MCP handshake: ChatGPT never sends
    // \`hostContext\`, so \`window.openai.theme\` is only readable on this path.
    applyHostSurface();
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
      collapse(true);
      log("no-chart payload, collapsed widget");
      return true;
    }
    // Past the no-chart guard, so this payload has a chart in it. Persist the
    // identity NOW rather than at one of render()'s several success exits:
    // what we are protecting against is losing the payload, and every branch
    // below renders the same card from the same two URLs.
    persistWidgetState(structuredContent);
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
    // Server-controlled probe opt-in. Absent/false → never probe.
    var probeEnabled =
      meta && typeof meta === "object" && meta.interactive_probe === true;
    // Proxied embed-page URL for the native upgrade. Absent → PNG only.
    var nativeCardUrl =
      meta && typeof meta === "object" && typeof meta.native_card_url === "string"
        ? meta.native_card_url
        : "";
    var imgNaturalW = meta && typeof meta === "object" && typeof meta.image_natural_width === "number"
      ? meta.image_natural_width : 0;
    var imgNaturalH = meta && typeof meta === "object" && typeof meta.image_natural_height === "number"
      ? meta.image_natural_height : 0;
    // The height actually pinned on the iframe, which the tail notifies. Starts
    // as the requested height and is replaced by the aspect-derived one when
    // the card's PNG dimensions are known.
    var committedHeight = null;
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
      // Tracking-free, then themed. This is the ChatGPT path: a committed
      // cross-origin iframe of the embed page, and the surface OpenAI's iframe
      // policy reviews — so it must not load a third-party beacon. See
      // \`withoutTracking\`.
      var themedUrl = withHostTheme(withoutTracking(url));
      if (frame.src !== themedUrl) frame.src = themedUrl;
      armEmbedOrigin(themedUrl);
      // Aspect-derived when the server supplied the card's PNG dimensions,
      // otherwise the requested height as before.
      var fitted = aspectHeight(imgNaturalW, imgNaturalH);
      committedHeight = fitted !== null ? fitted : h;
      setFrameHeight(committedHeight);
      frame.classList.remove("hidden");
      // Reflow on column changes (host sidebar toggle, window resize, mobile
      // rotation). Without this the frame keeps its mount-time height and the
      // empty band comes back at the new width. Skipped once a downgrade has
      // hidden the frame, and after an embed-reported height has taken over.
      //
      // Registered UNCONDITIONALLY, and that matters. Gating on
      // \`fitted !== null\` looked equivalent but \`fitted\` is computed once, at
      // delivery time, and \`aspectHeight\` returns null when \`clientWidth\` is 0 —
      // the normal pre-layout state of a freshly mounted iframe. So a widget
      // whose tool-result arrived before layout settled got NO listener at all
      // and stayed on the \`structuredContent.height\` fallback for the rest of
      // its life, even once the column width became known. That is the exact
      // failure this block exists to prevent, reached by a different route.
      // \`aspectHeight\` already declines per-event, so let it.
      window.addEventListener("resize", function () {
        if (frame.classList.contains("hidden")) return;
        // The embed's own report outranks anything derived from the PNG — see
        // \`embedReportedHeight\`. The comment above always claimed this listener
        // stood down "after an embed-reported height has taken over", but no
        // guard implemented it; the clause was true only by accident, because
        // \`aspectHeight\` returned null on the one host that reaches here and
        // the whole body was dead code. Giving it real dimensions woke it up,
        // and it re-derived 525 px over the embed's 732 px on every resize.
        // The embed re-reports on its own reflow, so standing down here loses
        // nothing.
        if (embedReportedHeight) return;
        var next = aspectHeight(imgNaturalW, imgNaturalH);
        if (next === null) return;
        committedHeight = next;
        setFrameHeight(next);
        notifyHeight(next);
      });
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
        probeEnabled: probeEnabled,
        nativeCardUrl: nativeCardUrl,
      });
    } else if (validEmbed) {
      // No image at all but we have an embed_url — try the iframe even
      // on hosts we'd normally treat as restricted. Worst case the
      // host CSP-blocks it and the user sees the same "blocked" tile
      // they'd otherwise have seen; best case some host without
      // \`window.openai\` actually allows the iframe.
      //
      // Stripped of tracking like every other iframe load — see
      // \`withoutTracking\`. This branch needs a non-http(s) \`image_url\`
      // alongside a valid \`embed_url\`, which the server does not currently
      // emit, so it is unreachable today. It is cleaned anyway: the invariant
      // documented in \`docs/chatgpt-app-review.md\` §4 is "every iframe load
      // the widget performs", and holding that by construction beats holding
      // it because two fields happen to always ship together. \`withoutTracking\`
      // is idempotent and allocation-cheap, so there is nothing to trade off.
      var untrackedUrl = withoutTracking(url);
      if (frame.src !== untrackedUrl) frame.src = untrackedUrl;
      armEmbedOrigin(untrackedUrl);
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
    var finalHeight = committedHeight !== null ? committedHeight : h;
    notifyHeight(finalHeight);
    log("rendered", {
      mode: useIframe ? "iframe" : "iframe-fallback",
      src: url,
      height: finalHeight,
      fitted: committedHeight !== null,
    });
    return true;
  }

  // Mirror of what the widget last rendered, kept in ChatGPT's widget state so
  // a reloaded conversation can repaint without \`toolOutput\`.
  //
  // The bug: ChatGPT rehydrates a reloaded conversation with a STRIPPED
  // \`toolOutput\`. Observed in the wild as \`{"width":900,"height":720}\` — the
  // two \`topCardChartFields\` defaults and nothing else, no \`embed_url\`, no
  // \`image_url\`. render()'s no-chart guard reads that as "this call produced
  // no card" and collapses, so a working chart turns into an empty box on
  // reload. The server is not at fault: a repeat \`tako_answer\` call returns
  // all ten declared keys (verified against prod), and \`topCardChartFields\`
  // emits its six widget fields all-or-nothing, so no server path produces
  // that pair alone.
  //
  // Claude does not have this failure mode — it gets a per-call dynamic
  // \`ui/resourceUri\` carrying the \`pub_id\`, so the URI itself identifies the
  // card. ChatGPT reads its template URI from static \`tools/list\` registration
  // metadata (see the \`ui?.dynamic\` block in mcp.ts, which deliberately does
  // NOT override \`openai/outputTemplate\`), so the widget has no identity of
  // its own and \`toolOutput\` is its only source. Widget state is the Apps
  // SDK's own answer to exactly this: \`setWidgetState\` is synchronous, and
  // \`window.openai.widgetState\` is restored on reload.
  //
  // Only the structuredContent half is mirrored. \`_meta\` (the baked
  // \`image_data_url\`) is deliberately NOT persisted: it is up to 400 KB
  // against a store the SDK documents as ephemeral and widget-scoped, and the
  // ChatGPT path never reads it anyway — that host's permissive \`img-src\`
  // renders the cross-origin \`image_url\` directly. A restored render on
  // ChatGPT therefore takes the same branch it took the first time.
  var lastPersistedKey = null;
  function persistWidgetState(structuredContent) {
    var w = window;
    if (!w || !w.openai || typeof w.openai.setWidgetState !== "function") return;
    var embedUrl = typeof structuredContent.embed_url === "string" ? structuredContent.embed_url : "";
    var imageUrl = typeof structuredContent.image_url === "string" ? structuredContent.image_url : "";
    if (!embedUrl && !imageUrl) return;
    // Write-once per card. \`setWidgetState\` re-renders the widget on some
    // hosts, and render() is reachable from a 250 ms poll, so an unguarded
    // write is a loop — the same hazard the height notifier guards against.
    var key = embedUrl + "|" + imageUrl;
    if (key === lastPersistedKey) return;
    lastPersistedKey = key;
    try {
      w.openai.setWidgetState({
        pub_id: structuredContent.pub_id,
        embed_url: structuredContent.embed_url,
        image_url: structuredContent.image_url,
        width: structuredContent.width,
        height: structuredContent.height,
        dark_mode: structuredContent.dark_mode,
      });
    } catch (e) {
      // Best-effort: a host without the API, or one that rejects the payload,
      // must not take down the render that is already in progress.
      log("widget-state persist failed", { error: String(e) });
    }
  }

  // Does this object look like the tool result's \`_meta\` — the one the chart
  // path actually consumes? Keyed on the fields render() reads rather than on
  // "is an object", because every candidate below is an object and only some
  // of them are ours.
  function hasWidgetMeta(o) {
    if (!o || typeof o !== "object") return false;
    return (
      typeof o.image_natural_width === "number" ||
      typeof o.image_data_url === "string" ||
      typeof o.native_card_url === "string"
    );
  }
  // The \`_meta\` half of the tool result, on the \`window.openai\` path.
  //
  // render() takes \`(structuredContent, meta)\`, but all three ChatGPT call
  // sites used to pass one argument, so \`meta\` was \`undefined\` on every
  // ChatGPT delivery and \`image_natural_width\`/\`image_natural_height\` were
  // read as 0. \`aspectHeight\` then declined and the frame fell back to
  // \`structuredContent.height\` — a number the server sends as a REQUEST, not
  // a measurement, so a wide card got a tall frame and rendered inside a band
  // of empty space. The server was already paying a ranged PNG read on every
  // ChatGPT call to ship those exact dimensions; nothing was reading them.
  //
  // Per the Apps SDK reference, \`window.openai.toolResponseMetadata\` is
  // "canonical widget-only tool result metadata … preserving the full MCP
  // result envelope, including hidden \`_meta\`". The envelope's internal shape
  // (\`call_tool_result\` / \`mcp_tool_result\`) is ChatGPT's, not the MCP spec's,
  // so probe the documented spellings best-first instead of committing to one
  // — the same reason \`pickFromOpenAi\` reads a list of candidates.
  //
  // Returns undefined, never null: this is forwarded as render()'s second
  // argument, where the reads are all \`meta && typeof meta === "object"\`
  // guarded, so a miss degrades to exactly the old behaviour.
  function pickMetaFromOpenAi() {
    var w = window;
    if (!w || !w.openai || typeof w.openai !== "object") return undefined;
    var trm = w.openai.toolResponseMetadata;
    var candidates = [
      trm,
      trm && trm._meta,
      trm && trm.mcp_tool_result && trm.mcp_tool_result._meta,
      trm && trm.call_tool_result && trm.call_tool_result._meta,
      w.openai.widget && w.openai.widget._meta,
    ];
    var i;
    for (i = 0; i < candidates.length; i++) {
      if (hasWidgetMeta(candidates[i])) return candidates[i];
    }
    return undefined;
  }

  // Does this payload actually carry a chart? Same two fields render()'s
  // no-chart guard tests, and it has to be the same test: a candidate that
  // would only collapse the widget must not count as having satisfied the
  // search for one that would paint.
  function hasChart(o) {
    if (!o || typeof o !== "object") return false;
    return typeof o.embed_url === "string" || typeof o.image_url === "string";
  }

  // Does this payload look like a WHOLE tool result, as opposed to the
  // remains of one? A real result carries its result-shaped keys even when it
  // found nothing — a zero-card search still ships \`cards: []\`. ChatGPT's
  // stripped reload payload carries none of them, only the two dimension
  // defaults. That difference is what lets a legitimate empty result be told
  // apart from a lost one, and it is the ONLY thing standing between a stale
  // chart and a genuine "no results" — on BOTH routes to it: the mirror
  // restore, and a stale sibling channel outranking a fresh \`toolOutput\`.
  function looksComplete(o) {
    if (!o || typeof o !== "object") return false;
    return "cards" in o || "answer" in o || "web_results" in o;
  }

  // Best-first over ordered candidates, plus the widget-state mirror as the
  // last thing tried. Truthiness is NOT the selector: ChatGPT's stripped
  // reload payload (\`{width, height}\`) is a perfectly truthy object, so a
  // plain \`a || b\` chain picks it, hands it to render(), and collapses —
  // which IS the reported bug, with a healthier channel sitting unread
  // further down.
  //
  // Nor is "carries a chart" the selector on its own, which is the subtler
  // half. Preferring ANY chart-bearing candidate over list order means a
  // stale chart in a low-priority channel outranks a fresh, whole,
  // chart-less result in a high-priority one — and a zero-card search IS a
  // whole result. That repaints the previous card over a question that
  // returned nothing, the same harm the mirror is gated against, reached
  // from the other direction. So completeness is checked BEFORE the chart
  // preference, and the chart preference never crosses a whole result.
  //
  // Order of preference, and each tier exists for a case seen or reasoned
  // about rather than for symmetry:
  //
  //   1. First WHOLE result, in list order, chart or not. Completeness is the
  //      question "did a real tool result reach us", and list order is the
  //      only freshness proxy we have — \`toolOutput\` is the canonical channel
  //      and the rest are compatibility fallbacks. A whole result with no
  //      chart is still authoritative: a zero-card search is a complete answer
  //      that has nothing to draw, and render()'s no-chart guard should
  //      collapse for it.
  //
  //      Note what this tier deliberately does NOT do: reach past a whole
  //      chart-less result for a whole one that has a chart. A stale card
  //      sitting in \`widget.structuredContent\` carries its own \`cards\` key
  //      and so is every bit as "complete" as the fresh zero-card
  //      \`toolOutput\` ahead of it — scanning for the chart across tiers picks
  //      the stale one and paints a chart for a question that returned
  //      nothing. Among whole results, order decides.
  //   2. Fragment carrying a chart. No whole result reached us at all, so
  //      something was lost in transit; a fragment that can still paint beats
  //      one that cannot. This is the tier that steps over ChatGPT's stripped
  //      \`{width, height}\` to a sibling channel that kept the URLs.
  //   3. The mirror. Nothing live can paint and nothing live claims to be
  //      whole, which is exactly the reload signature. Restore.
  //   4. First truthy. Keeps a chart-less fragment reaching render() for the
  //      labelled empty state instead of being mistaken for "nothing has
  //      arrived yet" and hanging the poll.
  function selectPayload(candidates, mirror) {
    var i;
    for (i = 0; i < candidates.length; i++) {
      if (looksComplete(candidates[i])) return candidates[i];
    }
    for (i = 0; i < candidates.length; i++) {
      if (hasChart(candidates[i])) return candidates[i];
    }
    if (hasChart(mirror)) return mirror;
    for (i = 0; i < candidates.length; i++) {
      if (candidates[i]) return candidates[i];
    }
    return null;
  }

  // ONE selection over ONE ordered candidate list, whichever way the payload
  // arrived. Globals first (an \`openai:set_globals\` event just delivered
  // them, so they are the freshest thing we have), then the \`window.openai\`
  // channels, then the mirror inside \`selectPayload\`.
  //
  // Unified deliberately. These used to be two functions joined by
  // \`pickFromGlobals(globals) || pickFromOpenAi()\`, and that \`||\` was a hole:
  // a stripped-but-truthy \`toolOutput\` arriving on the event path satisfied
  // the left side, short-circuited the right, and collapsed the widget with
  // \`rendered = true\` before the mirror was ever read. The justification was
  // that \`set_globals\` fires only on live calls, never on rehydration — an
  // assumption we cannot check from in here, and the 250 ms poll below exists
  // precisely because ChatGPT's delivery timing is not knowable. One list
  // means the question does not have to be answered: the same precedence
  // applies no matter which channel the payload came through.
  function pickPayload(globals) {
    var w = window;
    var oa = w && w.openai && typeof w.openai === "object" ? w.openai : null;
    var candidates = [];
    if (globals && typeof globals === "object") {
      candidates.push(
        globals.toolOutput,
        globals.structuredContent,
        globals.widget && globals.widget.toolOutput,
        globals.widget && globals.widget.structuredContent,
        globals.widget && globals.widget.payload
      );
    }
    if (oa) {
      candidates.push(
        oa.toolOutput,
        oa.widget && oa.widget.toolOutput,
        oa.widget && oa.widget.structuredContent,
        oa.widget && oa.widget.payload,
        oa.toolResponseMetadata && oa.toolResponseMetadata.structuredContent
      );
    }
    return selectPayload(candidates, oa ? oa.widgetState : null);
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
  if (!render(pickPayload(null), pickMetaFromOpenAi())) {
    var attempts = 0;
    var handle = setInterval(function () {
      attempts += 1;
      // Re-read the meta each tick, not once before the loop: the payload and
      // its \`_meta\` can land on different ticks, and pinning a stale
      // \`undefined\` here would reintroduce the exact bug this fixes.
      if (render(pickPayload(null), pickMetaFromOpenAi()) || attempts >= 40) {
        clearInterval(handle);
      }
    }, 250);
  }

  // No-data watchdog. If nothing renderable has arrived by the time the
  // \`window.openai\` polling window closes, collapse to zero height.
  //
  // The case this covers is a tool call that FAILED. An \`isError\` result
  // carries no \`structuredContent\`, but the host has already mounted the
  // widget for that call — so \`render()\` returns false, nothing paints, and
  // the widget is left as an indeterminate ~1 px sliver (the initial
  // \`notifyHeight(1)\`) with a hidden placeholder inside it, forever. Hosts
  // reasonably read a mounted-but-never-painted frame as a display failure.
  //
  // Collapsing is the same thing the no-chart guard in \`render()\` already
  // does for a SUCCESSFUL zero-card result; a failed call deserves the same
  // treatment rather than a different one. \`rendered\` makes this a no-op once
  // any chart has painted, and the 10 s bound matches the polling window so it
  // cannot race a slow-but-arriving delivery.
  //
  // Collapsed WITHOUT the label, deliberately: from in here a failed call and a
  // delivery that is merely late look identical, so "No chart for this result"
  // would be an affirmative claim that is wrong in the second case. See
  // \`collapse()\`.
  setTimeout(function () {
    if (rendered) return;
    collapse(false);
    log("no data arrived, collapsed widget");
  }, 10000);

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
    // One list, not \`globals || openai\` — see \`pickPayload\`. The event's own
    // globals are the freshest candidates, but they do not get to short-circuit
    // the search when what they carry is a stripped payload.
    //
    // Meta comes from the globals when the event carries it, else from the
    // \`window.openai\` snapshot — the payload can arrive on the event while
    // \`_meta\` is only ever readable off the global, so neither source alone
    // covers both hosts' timing.
    var eventMeta =
      globals && hasWidgetMeta(globals._meta) ? globals._meta : undefined;
    render(pickPayload(globals), eventMeta || pickMetaFromOpenAi());
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

  // ---- First-render hold: the handshake-ordering race ----
  //
  // \`initialized\` goes out on a 200 ms timer whether or not the init RESPONSE
  // landed, so "the host is spec-compliant" never guaranteed the theme was
  // known by the first \`tool-result\` — only "the host answered within 200 ms"
  // did. A host answering in ~350 ms is legitimate and loses: we post
  // \`initialized\` at 200, it posts \`tool-result\` at 210, its response arrives
  // at 350. postMessage preserves per-source order, so the tool-result is
  // dispatched first and \`render()\` latches with \`mcpHostTheme === null\` — the
  // card themed from the OS, unrecoverably (\`rendered\` latches, and
  // \`nativeStarted\` blocks the retry). That is the bug this file exists to fix,
  // reappearing on exactly the first-mount timing the 200 ms window was chosen
  // for.
  //
  // Note the 200 ms timer is NOT the deadline to hold against — it fires BEFORE
  // the tool-result in that scenario. So the hold gets its own, later grace
  // window: keep the first tool-result until the init response arrives or this
  // expires, whichever is first.
  //
  // Cost of holding is bounded and small: only the MCP wire reaches this branch
  // (ChatGPT drives \`render()\` through \`window.openai\`), so the worst case is
  // an MCP host that sends a tool-result and never answers \`ui/initialize\` —
  // which pays this once, not per call.
  var RENDER_HOLD_MS = 400;
  var initResponseSeen = false;
  var renderHoldExpired = false;
  var heldToolResult = null;
  var renderHoldTimer = null;

  function releaseRenderHold(why) {
    renderHoldExpired = true;
    if (renderHoldTimer !== null) {
      clearTimeout(renderHoldTimer);
      renderHoldTimer = null;
    }
    if (heldToolResult === null) return;
    var held = heldToolResult;
    // Cleared BEFORE rendering: \`render()\` is one-shot and re-entrant-guarded,
    // but a second release must not be able to replay the same payload.
    heldToolResult = null;
    log("released held tool-result", { why: why, theme: mcpHostTheme });
    render(held.structuredContent, held._meta);
  }

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
    // Init response → record the host's declared context, then send the
    // \`initialized\` notification so the host starts piping tool-result
    // messages. Don't gate on response contents — any matching id (success
    // or error) is sufficient signal that the host saw our
    // \`ui/initialize\`. \`hostContext\` is read opportunistically: an error
    // response carries none, and a host that declares no theme leaves
    // \`dark_mode=auto\` in place.
    if (
      fromHost &&
      msg.jsonrpc === "2.0" &&
      msg.id === INIT_REQUEST_ID &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      if (msg.result && typeof msg.result === "object") {
        mergeHostContext(msg.result.hostContext);
        applyHostSurface();
        // Log the SURFACE too, not just the theme. Whether any host ships
        // \`styles.variables\` is the open question gating tier 1, and the theme
        // half was already known — so this line is what turns that question
        // into something one session answers.
        var styles = msg.result.hostContext && msg.result.hostContext.styles;
        var varNames = [];
        try {
          if (styles && styles.variables) varNames = Object.keys(styles.variables);
        } catch (e) { /* hostile shape — the count is diagnostic only */ }
        log("host context at initialize", {
          theme: mcpHostTheme,
          surface: mcpHostSurface || "(none)",
          styleVarCount: varNames.length,
          hasPrimary: varNames.indexOf("--color-background-primary") !== -1,
          hasSecondary: varNames.indexOf("--color-background-secondary") !== -1,
        });
      }
      sendInitializedNotification();
      // The theme is now known — release anything held for it.
      initResponseSeen = true;
      releaseRenderHold("init response");
      return;
    }
    // Theme (or display mode) changed after initialize. Merging keeps the
    // next chart correct.
    //
    // What this does NOT do: re-theme a chart already on screen. The native
    // upgrade replaces this document via \`document.open()\`, which discards
    // this script and its listeners, and the baked PNG is a single
    // pre-rendered \`data:\` URI with no light twin to swap to. So a mid-
    // conversation toggle re-themes from the next tool call onward, and
    // already-rendered cards keep the theme they were drawn with.
    if (
      fromHost &&
      msg.jsonrpc === "2.0" &&
      msg.method === "ui/notifications/host-context-changed"
    ) {
      mergeHostContext((msg.params || {}).hostContext);
      // Re-apply: a theme toggle mid-conversation cannot re-theme the chart
      // itself, but the corners must not stay wrong.
      applyHostSurface();
      log("host context changed", { theme: mcpHostTheme });
      return;
    }
    if (fromHost && msg.jsonrpc === "2.0" && msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      // Hold the FIRST tool-result until the host's context is known — see the
      // race note on RENDER_HOLD_MS. Later tool-results are never held: by then
      // either the response landed or the grace expired.
      //
      // \`initializedSent\` is part of the gate on purpose. The spec says a host
      // MUST NOT send notifications before our \`initialized\`, so a tool-result
      // that arrives first comes from a host not following the handshake —
      // holding it to wait for a response that may never come would only delay
      // a chart for no theme. The race being closed is the other order: we sent
      // \`initialized\` on the 200 ms timer, the host replied to THAT before
      // replying to \`ui/initialize\`.
      if (initializedSent && !initResponseSeen && !renderHoldExpired) {
        heldToolResult = params;
        if (renderHoldTimer === null) {
          renderHoldTimer = setTimeout(function () {
            releaseRenderHold("hold expired");
          }, RENDER_HOLD_MS);
        }
        log("holding first tool-result for the init response", {
          graceMs: RENDER_HOLD_MS,
        });
        return;
      }
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
      // Latch BEFORE resizing: \`notifyHeight\` can reenter through the host,
      // and a resize that lands between the two calls would still be reading
      // the pre-latch value and could re-derive over what we just set.
      embedReportedHeight = true;
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
 * Fetch ONLY a chart PNG's pixel dimensions, via a ranged request for the
 * first 64 bytes.
 *
 * Exists because a Tako card's aspect ratio is per-card and not otherwise
 * knowable server-side. Measured on production (2026-07-31): the render canvas
 * is a fixed 2400 px WIDE but its height varies by card type — a plain chart
 * comes back 2400x1101 (2.18:1), a Stock Overview 2400x1257 (1.91:1), a ranked
 * top-sites card 2400x1845 (1.30:1). So the PNG header is a reliable read on
 * how tall the card actually is.
 *
 * The widget needs that to size the cross-origin `embed_url` iframe. It cannot
 * measure the iframe's content itself (cross-origin), and the embed page does
 * not report its own height, so without this the only options are a fixed
 * guess — which is what produced near-square iframes with a band of empty
 * background under a 2.18:1 chart — or nothing.
 *
 * Ranged, not a full GET: dimensions live in the first 24 bytes, and the
 * clients that need this (ChatGPT) never use the image bytes, so paying to
 * TRANSFER a ~170 KB body to learn two integers is pure waste. A server that
 * ignores `Range` answers 200 with the whole body; the parser only reads the
 * head either way, so that degrades to correct-but-slower rather than broken.
 *
 * What the `Range` does NOT save is the render. `image_url` points at
 * `/api/v1/image/{pub}/`, which renders the chart on demand, and no byte range
 * can be served before the bytes exist. So the number that governs this call's
 * worst case is {@link PNG_HEAD_FETCH_TIMEOUT_MS}, not the body size — size
 * that timeout against chart-render latency, never against 64 bytes of
 * transfer.
 *
 * That cost is on the critical path of every ChatGPT chart call, and is NOT
 * behind `PUBLIC_CDN_URL`: this replaced an unconditional
 * `if (ctx.client === "chatgpt") return undefined;`. Deliberate — ChatGPT
 * renders `embed_url` in a cross-origin iframe it cannot measure, so without
 * the card's true aspect its frame falls back to a fixed height and leaves the
 * empty band under a wide chart that this branch exists to remove.
 *
 * Best-effort: `undefined` on any failure, and the widget falls back to the
 * requested height.
 */
export async function fetchPngDimensions(
  url: string,
): Promise<{ naturalWidth: number; naturalHeight: number } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PNG_HEAD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Range: "bytes=0-63" },
    });
    // 206 (ranged) and 200 (server ignored Range) are both usable.
    if (!response.ok && response.status !== 206) {
      console.warn(
        `[tako] chart PNG header fetch failed: HTTP ${response.status} from ${url}`,
      );
      return undefined;
    }
    const dims = parsePngDimensions(await response.arrayBuffer());
    if (dims === undefined) {
      console.warn(`[tako] chart PNG header was not a parseable PNG: ${url}`);
      return undefined;
    }
    return { naturalWidth: dims.width, naturalHeight: dims.height };
  } catch (err) {
    console.warn(`[tako] chart PNG header fetch threw for ${url}:`, err);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
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
 *
 * `embed_url` also carries `showShare=true` — the embed page's card share
 * control is opt-in per host (tako PR #28735) and renders nothing without
 * it. The page still hard-suppresses the control where a share affordance
 * would be wrong (auth-gated cards, glanceable tiles, white-label,
 * postMessage shells, `?screenshot=true`), so this opt-in is safe to carry
 * unconditionally. `withHostTheme` only rewrites the `dark_mode=` segment,
 * so the param survives theme rewrites.
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
    embed_url: `${webBase}/embed/${encoded}/?dark_mode=auto&showShare=true`,
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
 * output (the search input is a query, not a pub_id) and returns
 * `undefined` when there's no renderable top card — see
 * `buildChartAppUiResourceFromOutputPubId` for why declining beats
 * naming the static bundle there.
 */
export function buildChartAppUiResource(
  env: Env,
  requestOrigin: string | undefined,
  resolveUriFromInput: (input: unknown, output?: unknown) => string | undefined,
): AppUiResource {
  const webBase = resolvePublicBase(env);
  return {
    // Static URI — registered as before, used by ChatGPT (which reads
    // the widget URI from `_meta["openai/outputTemplate"]`) for its
    // interactive iframe path. Also serves any host that doesn't honor
    // per-call URI overrides.
    uri: appUiResourceUri(env),
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
    // Plus, when the `PUBLIC_CDN_URL` experiment is armed, the front-end
    // asset CDN — the origin that serves Tako's real `Card.js`, its lazily
    // imported chunks, and the Geist/Inter fonts. Declaring it is what the
    // `script-src` capability probe below actually measures: per the MCP Apps
    // spec `resourceDomains` must reach script-src/style-src/font-src, and
    // whether claude.ai honors that is the single unknown gating native
    // interactive cards there. Unset in production → this array is unchanged.
    // Runtime fetches the widget makes — just this worker's own origin, for the
    // native-card proxy. Empty when the experiment is off or the origin is
    // unknown, and `mcp.ts` omits the key entirely then. Never tako.com: the
    // widget always goes through our proxy, because the embed route itself
    // serves no CORS header.
    connectDomains: (() => {
      if (resolvePublicCdnBase(env) === undefined) return [];
      // Same resolver the native-card URL uses, so the origin we DECLARE and
      // the origin the widget FETCHES can never disagree — a mismatch there is
      // a CSP block that looks like a broken proxy.
      const widgetOrigin = resolveWidgetOrigin(env, requestOrigin);
      return widgetOrigin === undefined ? [] : [widgetOrigin];
    })(),
    resourceDomains: [
      ...new Set(
        [
          webBase,
          resolvePublicApiBase(env),
          // Our OWN origin, not the CDN: the native path serves Card.js, its
          // chunks and the fonts through this worker's `/cdn-asset/` route,
          // because the CDN answers CORS for tako.com alone and a module script
          // is always a CORS fetch. Declaring the CDN here would be dead weight
          // — nothing loads from it in the widget any more.
          resolvePublicCdnBase(env) !== undefined
            ? resolveWidgetOrigin(env, requestOrigin)
            : undefined,
        ].filter((origin): origin is string => origin !== undefined),
      ),
    ],
    // Dynamic-resource variant — registered as a `ResourceTemplate`,
    // one URI per pub_id. Per-call tool result overrides
    // `_meta.ui.resourceUri` to point claude.ai at a specific
    // instance, where the widget HTML has the chart's image and
    // dimensions baked in at fetch time. See `AppUiResource.dynamic`
    // and `buildBakedWidgetHtml` for the why.
    dynamic: {
      uriPattern: appUiTemplateUriPattern(env),
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
 * Shared by tako_search, tako_answer and tako_visualize, which all render a
 * chart widget this way.
 *
 * No top card → `undefined`, NOT the static URI. A chart-less result has
 * nothing for a widget to draw, and naming a resource anyway is what asks a
 * host to mount one; declining is the only way the empty card disappears
 * rather than merely getting labelled. It changes nothing on ChatGPT or
 * claude.ai (both mount from `tools/list` registration `_meta`, which is
 * static per tool) — see `collapse()` in the bundle for what covers those.
 */
export function buildChartAppUiResourceFromOutputPubId(
  env: Env,
  requestOrigin?: string,
): AppUiResource {
  return buildChartAppUiResource(env, requestOrigin, (_input, output) => {
    const pubId =
      typeof (output as { pub_id?: unknown } | undefined)?.pub_id === "string"
        ? (output as { pub_id: string }).pub_id
        : "";
    if (pubId === "") return undefined;
    return appUiTemplateUriPattern(env).replace(
      "{pub_id}",
      encodeURIComponent(pubId),
    );
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
