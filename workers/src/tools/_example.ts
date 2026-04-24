/**
 * Placeholder tool demonstrating the `ToolModule` contract.
 *
 * Exists purely so the codegen and auto-register have something to operate
 * on before Phase 2 ports land. The first real tool PR (TAKO-2602
 * `knowledge_search`) should delete this file — the codegen will drop it
 * from the registry automatically on the next run.
 *
 * Does not call Django. Real Phase 2 tools will call
 * `djangoGet(ctx.env, ctx.token, "/api/v1/...")` /
 * `djangoPost(ctx.env, ctx.token, "/api/v1/...", body)`.
 */

import { z } from "zod";

import type { ToolModule } from "./types.js";

const inputSchema = z.object({
  message: z.string().describe("Anything to echo back."),
});

const outputSchema = z.object({
  echoed: z.string(),
  /** Token presence, not value — never leak tokens into tool output. */
  authenticated: z.boolean(),
});

const _example = {
  name: "_example",
  description:
    "Internal placeholder — echoes back its input. Do not use; will be removed when the first real tool lands.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Example (Placeholder)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    return {
      echoed: input.message,
      authenticated: ctx.token.length > 0,
    };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default _example;
