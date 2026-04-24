/**
 * `get_card_insights` — AI-generated analysis of a chart's data.
 *
 * Ports `get_card_insights` from `src/tako_mcp/server.py:247`. Hits
 * `/api/v1/internal/chart-configs/{pub_id}/chart-insights/?effort=...`.
 * Backend can be slow under deep effort; keep the 90 s timeout from the
 * legacy Python tool.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  pub_id: z
    .string()
    .min(1)
    .describe("The unique chart identifier (pub_id / card_id)."),
  effort: z
    .enum(["low", "medium", "high"])
    .default("medium")
    .describe(
      "Reasoning effort for the insights: `low` (quick summary), `medium` (balanced), `high` (deep).",
    ),
});

const outputSchema = z.object({
  pub_id: z.string(),
  insights: z.string(),
  description: z.string(),
});

type DjangoResponse = {
  insights?: string;
  description?: string;
};

const get_card_insights = {
  name: "get_card_insights",
  description:
    "Use this when you want AI-generated analysis of a chart's data. Returns bullet-point insights and a natural-language description that summarizes trends, outliers, and key takeaways.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Get AI Insights",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const pubId = encodeURIComponent(input.pub_id);
    const data = await djangoGet<DjangoResponse>(
      ctx.env,
      ctx.token,
      `/api/v1/internal/chart-configs/${pubId}/chart-insights/`,
      {
        query: { effort: input.effort },
        timeoutMs: 90_000,
      },
    );
    return {
      pub_id: input.pub_id,
      insights: data.insights ?? "",
      description: data.description ?? "",
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_card_insights;
