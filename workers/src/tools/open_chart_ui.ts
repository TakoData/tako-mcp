/**
 * `open_chart_ui` — return everything a client needs to render an interactive
 * Tako chart iframe.
 *
 * Ports `open_chart_ui` from `src/tako_mcp/server.py:691`.
 *
 * KNOWN REGRESSION vs the Python reference: the Python tool returns a
 * `list[UIResource]` via the `mcp-ui` library, which MCP-UI-aware clients
 * (e.g. Claude Desktop with the MCP-UI extension) auto-render as a live
 * interactive iframe. The TS registry contract (`mcp.ts:95-117`) currently
 * only emits `type: "text"` content blocks, so we cannot hand back a raw
 * MCP-UI `resource` content block without a `ToolModule` contract
 * extension (e.g. an optional `toContentBlocks(output)` hook). That
 * extension is out of scope for Phase 2 port. Clients that previously saw
 * an auto-rendered chart here will now see a JSON payload containing the
 * iframe HTML — a real UX regression for those clients.
 *
 * Interim shape: return `embed_url` plus a ready-to-render `iframe_html`
 * string. Clients that can inject HTML inline (some Claude clients with UI
 * extensions, some custom inspectors) can render; thin clients can still
 * show the `embed_url` as a clickable link.
 *
 * Follow-up work to re-enable full interactivity: extend `ToolModule` with
 * a content-block emitter, port `create_ui_resource()` equivalent, and
 * update this tool to emit a `resource` block containing the HTML and a
 * `ui://tako/embed/{pub_id}` URI. Track under a dedicated ticket.
 *
 * Additional deliberate omission vs Python: the Python version shipped a
 * `window.addEventListener("message")` handler that reflowed the iframe
 * height in response to `{type: "tako::resize"}` postMessages from the
 * embedded chart. The TS port omits it — even a thin client that drops
 * `iframe_html` into the DOM will lose the auto-resize. Re-add alongside
 * the MCP-UI content-block work above.
 *
 * No Django call — purely a URL + HTML builder.
 */
import { z } from "zod";

import { resolvePublicBase } from "../env.js";
import type { ToolModule } from "./types.js";

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
      'Advisory width in pixels. The returned `iframe_html` pins the iframe to `width="100%"` so it fills its container; consumers should use this value to size the container they render `iframe_html` into. Mirrors the Python reference, which only uses `width` as an MCP-UI `PREFERRED_FRAME_SIZE` hint.',
    ),
  height: z
    .number()
    .int()
    .min(1)
    .default(600)
    .describe(
      "Initial iframe height in pixels. Applied directly in the iframe's CSS (`height` + `min-height`) — no resize handshake.",
    ),
});

// Tighter than `z.string().url()` — Zod's URL check accepts `javascript:`,
// `data:`, and other non-web schemes. Since `embed_url` is handed to a
// browser (possibly inlined into an `<iframe src>`), constrain to http(s).
const HTTP_URL_REGEX = /^https?:\/\//;

const outputSchema = z.object({
  pub_id: z.string(),
  embed_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "embed_url must be http(s)" }),
  iframe_html: z.string(),
  dark_mode: z.boolean(),
  // `width` is advisory — the iframe in `iframe_html` is `width="100%"`,
  // so consumers render at whatever container width they choose and use
  // this value as the suggested target. `height` is authoritative —
  // baked into the iframe's CSS.
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const open_chart_ui = {
  name: "open_chart_ui",
  description:
    "Use this when you want to display a fully interactive chart to the user. Returns the embed URL plus a ready-to-render iframe HTML snippet with zoom, pan, and hover interactions. Prefer this over get_chart_image when the user wants to explore the data interactively.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Open Interactive Chart",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    // `resolvePublicBase` prefers `PUBLIC_BASE_URL` (user-browser origin)
    // and falls back to `DJANGO_BASE_URL`, validating non-empty, http/https
    // scheme, and no trailing slash. The validated value flows directly
    // into the `<iframe src="...">` below, so we rely on the helper's
    // scheme check (not `encodeURIComponent` or `escapeHtml` alone) as the
    // security boundary — a `javascript:` PUBLIC_BASE_URL would otherwise
    // produce an iframe that executes script on render.
    const base = resolvePublicBase(ctx.env);
    const theme = input.dark_mode ? "dark" : "light";
    const pubId = encodeURIComponent(input.pub_id);
    const embedUrl = `${base}/embed/${pubId}/?theme=${theme}`;
    const safeUrl = escapeHtml(embedUrl);

    const iframeHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; }
      /* width: 100% by design — matches the Python reference. input.width is
         advisory only; consumers size the container that wraps this HTML. */
      #tako-embed {
        width: 100% !important;
        height: ${input.height}px !important;
        min-height: ${input.height}px !important;
        border: 0 !important;
        display: block !important;
      }
    </style>
  </head>
  <body>
    <iframe
      id="tako-embed"
      width="100%"
      height="${input.height}"
      src="${safeUrl}"
      scrolling="no"
      frameborder="0"
      allow="fullscreen"
    ></iframe>
  </body>
</html>`;

    return {
      pub_id: input.pub_id,
      embed_url: embedUrl,
      iframe_html: iframeHtml,
      dark_mode: input.dark_mode,
      width: input.width,
      height: input.height,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default open_chart_ui;
