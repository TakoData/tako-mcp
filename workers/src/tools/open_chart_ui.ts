/**
 * `open_chart_ui` — return an inlined chart image plus URLs for the static
 * PNG and the interactive embed.
 *
 * Originally ported from `open_chart_ui` in `src/tako_mcp/server.py:691`,
 * which used `mcp-ui`'s `create_ui_resource()` to emit an MCP `resource`
 * content block containing a live iframe. The TS port previously stuffed a
 * ready-to-render `<iframe>` HTML string into a JSON output field; the LLM
 * helpfully echoed it as text and clients displayed `<iframe …></iframe>`
 * verbatim. Iteration two switched to `image_url` + `embed_url` and asked
 * the LLM to render `![chart](image_url)` — better, but claude.ai web gates
 * external markdown images behind a "Show Image" click-to-load.
 *
 * Current shape: emit a native MCP `image` content block with the PNG
 * inlined as base64 (via the `extraContentBlocks` hook). claude.ai renders
 * tool-emitted `image` blocks inline with no click gate — same path
 * built-in image tools use. The structured output still carries `image_url`
 * (for clients that want to fetch the bytes themselves or save the file)
 * and `embed_url` (a markdown link to the fully interactive version with
 * zoom, pan, hover).
 *
 * The `extraContentBlocks` hook fetches the PNG server-side and base64s it.
 * If that fetch fails, the hook returns `[]` and the response degrades to
 * the text + structured payload — the LLM can still surface the URLs as
 * markdown so the user gets *something*. Errors don't fail the tool call.
 *
 * Follow-up work for clients that DO support MCP-UI (Claude Desktop with
 * the MCP-UI extension): emit a `resource` block with a
 * `ui://tako/embed/{pub_id}` URI alongside the inlined image. The hook
 * contract already supports this — just extend `ToolContentBlock` and add
 * a second entry to the returned array. claude.ai web does not render
 * MCP-UI `resource` blocks today, so the inlined image is the most
 * explicit thing we can ship there.
 *
 * Subrequest cost: one extra outbound `fetch` to the PNG endpoint per
 * tool call. Within Workers' 50/1000 cap with plenty of headroom.
 */
import { z } from "zod";

import { resolvePublicApiBase, resolvePublicBase } from "../env.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

const inputSchema = z.object({
  pub_id: z
    .string()
    .min(1)
    .describe("The unique chart identifier (pub_id / card_id)."),
  dark_mode: z
    .boolean()
    .default(true)
    .describe("Render the dark-mode theme."),
  width: z
    .number()
    .int()
    .min(1)
    .default(900)
    .describe(
      "Advisory width in pixels for the rendered chart container. The PNG endpoint ignores it; pass through to the client as a sizing hint only.",
    ),
  height: z
    .number()
    .int()
    .min(1)
    .default(520)
    .describe(
      "Advisory initial height in pixels for the rendered chart container. The PNG endpoint ignores it; pass through to the client as a sizing hint only. Sized for a single-component card by default — tall multi-component charts may briefly under-reserve until the embed page handshakes its true height (forthcoming).",
    ),
});

// Tighter than `z.string().url()` — Zod's URL check accepts `javascript:`,
// `data:`, and other non-web schemes. Both URLs below flow to a browser
// (markdown image src / link href), so constrain to http(s).
const HTTP_URL_REGEX = /^https?:\/\//;

const outputSchema = z.object({
  pub_id: z.string(),
  embed_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "embed_url must be http(s)" }),
  image_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "image_url must be http(s)" }),
  dark_mode: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

// Cap how big a PNG we'll inline. Above this we skip the image block and
// let the URL-only fallback take over. Two reasons: (1) the encoded base64
// adds ~33% to wire weight on top of the JSON-RPC envelope, so a 5 MB PNG
// becomes ~7 MB in the response — past the practical limit some MCP
// clients tolerate before truncating or stalling; (2) Workers' default
// response size guidance discourages large bodies. Tako chart PNGs run
// 50-300 KB in practice, so 4 MB is generous headroom that still trips on
// pathological cases.
const MAX_INLINE_PNG_BYTES = 4 * 1024 * 1024;

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
const APP_UI_RESOURCE_URI = "ui://tako/embed/chart";
const APP_UI_RESOURCE_NAME = "open_chart_ui_widget";

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
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; color: #8b8f95; font: 14px system-ui, -apple-system, sans-serif; }
  #tako-embed { width: 100% !important; border: 0 !important; display: block !important; background: transparent; }
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
<script>
(function () {
  "use strict";
  var frame = document.getElementById("tako-embed");
  var placeholder = document.getElementById("tako-placeholder");
  var rendered = false;
  // Origin of the iframe we loaded — used to gate the height handshake
  // listener below so we only honor resize messages from the actual
  // embed page, not arbitrary cross-frame senders.
  var embedOrigin = null;

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

  function render(structuredContent) {
    if (rendered) return true;
    if (!structuredContent || typeof structuredContent !== "object") return false;
    var url = structuredContent.embed_url;
    // Defense-in-depth: re-validate http(s) before assigning to
    // \`iframe.src\`. The handler validates server-side too, but the
    // widget is the last hop before the DOM, so a hostile MCP server
    // shipping \`javascript:\` would otherwise execute in the widget
    // origin once dropped into \`src\`.
    if (typeof url !== "string" || !/^https?:\\/\\//.test(url)) return false;
    if (frame.src !== url) frame.src = url;
    try { embedOrigin = new URL(url).origin; } catch (e) { embedOrigin = null; }
    var h =
      typeof structuredContent.height === "number" && structuredContent.height > 0
        ? structuredContent.height
        : 600;
    frame.style.height = h + "px";
    frame.style.minHeight = h + "px";
    frame.setAttribute("height", String(h));
    frame.classList.remove("hidden");
    placeholder.classList.add("hidden");
    rendered = true;
    notifyHeight(h);
    log("rendered", { src: url, height: h });
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

  // MCP Apps open-spec bridge — \`ui/notifications/tool-result\`
  // JSON-RPC over postMessage. claude.ai, VS Code Insiders, and Goose
  // follow this; ChatGPT uses the \`window.openai\` path above.
  //
  // Also handles a \`tako-embed-height\` resize handshake from the inner
  // embed iframe, gated to that iframe's origin. The Tako web app does
  // not emit this message yet — when it ships, the widget will start
  // self-correcting chart heights without a worker redeploy. Sanity
  // bounds (positive integer < 4000 px) keep a hostile or buggy embed
  // from blowing the iframe up to nonsensical sizes.
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.jsonrpc === "2.0" && msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      render(params.structuredContent);
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

  log("listener attached", {
    hasOpenAiGlobal: typeof window.openai !== "undefined",
  });
})();
</script>
</body>
</html>`;
// Bound how long we'll wait on the PNG endpoint before giving up. The
// content block is "nice to have" — better to ship the URL fallback
// quickly than block the whole tool call on a slow render.
const PNG_FETCH_TIMEOUT_MS = 8_000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // `Buffer` is available because `nodejs_compat` is enabled in
  // wrangler.jsonc. Avoids the `String.fromCharCode(...spread)` pattern
  // which can blow the call stack on multi-megabyte inputs.
  return Buffer.from(buffer).toString("base64");
}

const open_chart_ui = {
  name: "open_chart_ui",
  description:
    "Use this when you want to show a chart to the user. The chart's PNG is returned as a native MCP image content block — clients (claude.ai etc.) render it inline automatically; do NOT echo `![…](image_url)` markdown for it (that would re-display the chart behind a click-to-load gate). Also returns `embed_url` for a fully interactive version with zoom, pan, hover — surface it as a markdown link, e.g. `[Open interactive chart](embed_url)`. Never paste raw HTML or `<iframe>` markup; chat clients render markdown, not arbitrary HTML.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Open Interactive Chart",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    // `resolvePublicBase` (web origin, e.g. `tako.com`) and
    // `resolvePublicApiBase` (API origin, e.g. `api.tako.com`) are kept
    // distinct because production splits them; both fall back to
    // `DJANGO_BASE_URL` when the dedicated bindings aren't set. Each
    // helper validates non-empty + http/https + no trailing slash and
    // throws loud on bad config — these URLs go straight to user
    // browsers, so they're a security boundary.
    const webBase = resolvePublicBase(ctx.env);
    const apiBase = resolvePublicApiBase(ctx.env);
    const theme = input.dark_mode ? "dark" : "light";
    const pubId = encodeURIComponent(input.pub_id);
    const embed_url = `${webBase}/embed/${pubId}/?theme=${theme}`;
    const image_url = `${apiBase}/api/v1/image/${pubId}/?dark_mode=${input.dark_mode ? "true" : "false"}`;

    return {
      pub_id: input.pub_id,
      embed_url,
      image_url,
      dark_mode: input.dark_mode,
      width: input.width,
      height: input.height,
    };
  },
  appUiResource(env): AppUiResource {
    // `frameDomains` is the host CSP's allow-list for nested iframes —
    // without the widget's parent origin in here, the host blocks
    // `<iframe src="https://tako.com/embed/...">`. We pin to exactly the
    // public web origin (e.g. `tako.com` / `staging.trytako.com`) the
    // tool also writes into `embed_url`, so the two move together. No
    // wildcards: the widget only ever embeds Tako's own embed page.
    const webBase = resolvePublicBase(env);
    return {
      uri: APP_UI_RESOURCE_URI,
      name: APP_UI_RESOURCE_NAME,
      html: WIDGET_HTML,
      frameDomains: [webBase],
    };
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    // Fetch the PNG so we can inline it as a base64 image content block —
    // claude.ai renders tool-emitted images inline (no click-to-load gate
    // that markdown image URLs trigger). All failure modes here degrade
    // silently to `[]`: the tool's text + structuredContent already carry
    // a working response, and the LLM can fall back to surfacing
    // `embed_url` as a link. We don't fail the whole tool call over a
    // presentation hiccup.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PNG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(output.image_url, {
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const contentType = response.headers.get("content-type") ?? "";
      // Defensive: the PNG endpoint should always return image/png, but
      // an upstream redirect to an HTML error page would otherwise let us
      // base64 the HTML and ship it as `mimeType: "image/png"` — a
      // garbage block the client would try to render. Reject anything
      // that doesn't look like an image.
      if (!contentType.startsWith("image/")) return [];
      const buffer = await response.arrayBuffer();
      // 0-byte 200 is plausible if a renderer returned early; emitting a
      // `{ data: "", mimeType: "image/png" }` block would have clients try
      // to render an invalid image. Mirror the oversize bail.
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
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default open_chart_ui;
