/**
 * `get_chart_image` — return a public PNG URL for a chart.
 *
 * Ports `get_chart_image` from `src/tako_mcp/server.py:186`. The image endpoint
 * returns a binary PNG (not JSON), so we do not call it — the URL is
 * deterministic from `pub_id` and `dark_mode`. The legacy Python tool pinged
 * the endpoint just to verify 200/404; we skip that to halve latency and let
 * the client discover 404 on fetch.
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
    .describe("Render the dark-mode variant of the PNG."),
});

// Constrain to http(s) — this URL is handed to a browser (via the LLM
// rendering it as an `<img src>` or link), so schemes like `javascript:`
// or `data:` must be rejected at the tool boundary.
const HTTP_URL_REGEX = /^https?:\/\//;

const outputSchema = z.object({
  image_url: z
    .string()
    .regex(HTTP_URL_REGEX, { message: "image_url must be http(s)" }),
  pub_id: z.string(),
  dark_mode: z.boolean(),
});

const get_chart_image = {
  name: "get_chart_image",
  description:
    "Use this when you need a static preview image URL of a chart to display or embed. Returns a direct URL to a PNG. Useful for including chart previews in responses or documents.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Get Chart Image",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const pubId = encodeURIComponent(input.pub_id);
    const darkMode = input.dark_mode ? "true" : "false";
    // `resolvePublicBase` prefers `PUBLIC_BASE_URL` when set (this is the
    // URL the user's browser will load), falls back to `DJANGO_BASE_URL`,
    // and enforces the same invariants `buildUrl` does for the Django
    // origin (non-empty, http/https scheme, no trailing slash). Throws
    // loud on config drift — this URL flows to user browsers, so it's a
    // security boundary, not a soft fallback.
    const base = resolvePublicBase(ctx.env);
    const image_url = `${base}/api/v1/image/${pubId}/?dark_mode=${darkMode}`;
    return {
      image_url,
      pub_id: input.pub_id,
      dark_mode: input.dark_mode,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_chart_image;
