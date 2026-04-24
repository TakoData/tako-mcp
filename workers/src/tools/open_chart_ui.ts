/**
 * `open_chart_ui` — return everything a client needs to render an interactive
 * Tako chart iframe.
 *
 * Ports `open_chart_ui` from `src/tako_mcp/server.py:691`. Python returns a
 * `list[UIResource]` via the `mcp-ui` library, which renders as an interactive
 * iframe in MCP-UI-aware clients. The TS registry contract serializes tool
 * outputs as JSON text (`mcp.ts:98-115`), so we cannot emit a raw MCP-UI
 * `resource` content block without extending the adapter — out of scope for
 * Phase 2 port.
 *
 * Pragmatic shape: return `embed_url` plus a ready-to-render `iframe_html`
 * string. Clients that understand inline HTML rendering (e.g. some Claude
 * clients with UI extensions) can drop it in; basic clients can fall back to
 * rendering the `embed_url` as a link. Re-introducing full MCP-UI requires a
 * contract extension — park as a follow-up if needed.
 *
 * No Django call — purely a URL + HTML builder.
 */
import { z } from "zod";

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
    .describe("Initial iframe width in pixels."),
  height: z
    .number()
    .int()
    .min(1)
    .default(600)
    .describe("Initial iframe height in pixels."),
});

const outputSchema = z.object({
  pub_id: z.string(),
  embed_url: z.string().url(),
  iframe_html: z.string(),
  dark_mode: z.boolean(),
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
    // `DJANGO_BASE_URL` is the origin the Worker proxies through — in staging
    // and production it also serves `/embed/{pub_id}/`. If/when a separate
    // PUBLIC_BASE_URL is introduced (as the Python MCP has), add an env
    // binding and prefer it over DJANGO_BASE_URL here.
    const base = ctx.env.DJANGO_BASE_URL.replace(/\/+$/, "");
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
