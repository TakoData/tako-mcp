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

const outputSchema = z.object({
  image_url: z.string().url(),
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
    // `DJANGO_BASE_URL` points at the internal origin this Worker proxies
    // through; the image URL is the public one the user's browser will load.
    // We keep them aligned in staging/prod via wrangler.jsonc env.
    const base = ctx.env.DJANGO_BASE_URL.replace(/\/+$/, "");
    const image_url = `${base}/api/v1/image/${pubId}/?dark_mode=${darkMode}`;
    return {
      image_url,
      pub_id: input.pub_id,
      dark_mode: input.dark_mode,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_chart_image;
