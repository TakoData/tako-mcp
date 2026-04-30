/**
 * `open_chart_ui` — render a Tako chart inline from an explicit `pub_id`.
 *
 * Originally ported from `open_chart_ui` in `src/tako_mcp/server.py:691`.
 * The widget bundle, PNG fetch helpers, and host-quirk code now live in
 * `./_chart_widget.ts` because `knowledge_search` also auto-renders a
 * chart on the same widget URI; both tools share that plumbing instead
 * of duplicating ~600 lines of carefully-tuned host code.
 *
 * This file is now a thin tool module: input schema (the `pub_id` and
 * advisory dimensions), output schema (URLs the widget reads), and the
 * three hooks (`extraContentBlocks`, `extraMeta`, `appUiResource`) that
 * each delegate to `_chart_widget.ts` helpers.
 *
 * Use `open_chart_ui` for explicit re-renders — when the user wants a
 * chart they already know the `pub_id` of, when `create_chart` returns
 * a fresh `card_id`, or when the user asks to chart a non-top result
 * from a previous `knowledge_search` call. For first-time chart
 * requests, prefer `knowledge_search`: it auto-renders the top result
 * inline as part of the same tool call, so the model doesn't need to
 * chain.
 *
 * Subrequest cost: one extra outbound `fetch` to the PNG endpoint per
 * tool call (via `extraMeta`'s `fetchImageDataUrlAndDims` and, on
 * widget-suppressed hosts, `extraContentBlocks`'s `fetchPngContentBlock`
 * — they're mutually exclusive). Within Workers' 50/1000 cap with
 * plenty of headroom.
 */
import { z } from "zod";

import {
  HTTP_URL_REGEX,
  APP_UI_RESOURCE_URI,
  APP_UI_TEMPLATE_URI_PATTERN,
  buildChartAppUiResource,
  buildChartUrls,
  fetchImageDataUrlAndDims,
  fetchPngContentBlock,
} from "./_chart_widget.js";
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
    .default(720)
    .describe(
      "Advisory initial height in pixels for the rendered chart container. The PNG endpoint ignores it; pass through to the client as a sizing hint only. Sized for tall multi-component cards (with tabs / sub-tabs) so they don't get cropped — single-component cards leave unused footer space until the embed page handshakes its true height (forthcoming).",
    ),
});

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

const open_chart_ui = {
  name: "open_chart_ui",
  description:
    "Render a Tako chart inline given its `pub_id`. Use this for explicit re-renders: (a) after `create_chart` returns a fresh `card_id`, (b) when the user asks to chart a non-top result from a previous `knowledge_search` (e.g. \"show me the GDP per capita chart instead\"), or (c) when the user references a `pub_id` from a prior turn (\"chart that AAPL one again\"). For first-time data + chart requests, prefer `knowledge_search` — it now auto-renders the top result inline in the same tool call, so chaining `open_chart_ui` is unnecessary. The chart's PNG is returned as a native MCP image content block — clients (claude.ai etc.) render it inline automatically; do NOT echo `![…](image_url)` markdown for it (that would re-display the chart behind a click-to-load gate). Also returns `embed_url` for a fully interactive version with zoom, pan, hover — surface it as a markdown link, e.g. `[Open interactive chart](embed_url)`. Never paste raw HTML or `<iframe>` markup; chat clients render markdown, not arbitrary HTML.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Open Interactive Chart",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    // `buildChartUrls` is the only place that knows the public web /
    // API origins and the URL shape for `/embed/{pub_id}/` and
    // `/api/v1/image/{pub_id}/`. Both helpers validate non-empty +
    // http(s) + no trailing slash and throw loud on bad config —
    // these URLs go straight to user browsers, so they're a security
    // boundary.
    const { embed_url, image_url } = buildChartUrls(
      ctx.env,
      input.pub_id,
      input.dark_mode,
    );
    return {
      pub_id: input.pub_id,
      embed_url,
      image_url,
      dark_mode: input.dark_mode,
      width: input.width,
      height: input.height,
    };
  },
  async extraMeta(output, _ctx): Promise<Record<string, unknown> | undefined> {
    // Inline the chart PNG as a `data:image/...;base64,...` URI for
    // the widget, plus the source PNG's natural pixel dimensions.
    // Routed through `_meta` (not `structuredContent`) because the
    // data URI is large (~70-330 KB encoded) and putting it in
    // `structuredContent` blows past claude.ai's per-tool-result
    // context budget — Claude then offloads the whole result to a
    // file and skips widget delivery.
    void _ctx;
    const fetched = await fetchImageDataUrlAndDims(output.image_url);
    if (fetched === undefined) return undefined;
    return {
      image_data_url: fetched.dataUrl,
      image_natural_width: fetched.naturalWidth,
      image_natural_height: fetched.naturalHeight,
    };
  },
  appUiResource(env): AppUiResource {
    return buildChartAppUiResource(env, (input) => {
      // `open_chart_ui`'s pub_id comes from input directly. URI-encode
      // it so non-alphanumeric characters in the input don't break
      // URI parsing (rare in practice, since Tako pub_ids are
      // URL-safe slugs, but defensive). Empty / non-string input
      // falls back to the static URI so a malformed call still
      // resolves to a registered resource.
      const pubId =
        typeof (input as { pub_id?: unknown })?.pub_id === "string"
          ? (input as { pub_id: string }).pub_id
          : "";
      if (pubId === "") return APP_UI_RESOURCE_URI;
      return APP_UI_TEMPLATE_URI_PATTERN.replace(
        "{pub_id}",
        encodeURIComponent(pubId),
      );
    });
  },
  async extraContentBlocks(output, _ctx): Promise<ToolContentBlock[]> {
    // On hosts where the widget is suppressed (claude.ai), we still
    // want the chart visible — fall back to inlining the PNG as a
    // native MCP image content block. claude.ai renders these inline
    // without the click-to-load gate that markdown image URLs
    // trigger. All failure modes degrade to `[]` so the tool call
    // still resolves with the text + structuredContent fallback; the
    // LLM can surface `embed_url` as a link from there.
    void _ctx;
    return fetchPngContentBlock(output.image_url);
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default open_chart_ui;
