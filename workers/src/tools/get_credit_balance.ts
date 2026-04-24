/**
 * `get_credit_balance` — fetch the current user's remaining Tako credits.
 *
 * Wraps `GET /api/v1/credit_balance/`. Cheap + sync. Useful for Claude to
 * answer "how many credits do I have?" and to gate expensive operations
 * (e.g. `create_report`, deep `knowledge_search`, future `ask_tako`) with a
 * pre-flight check so users don't get surprised by 402-style rejections.
 *
 * Response shape is whatever the backend returns today (currently a credit
 * balance number plus subscription metadata); we pass it through verbatim as
 * an `unknown` payload rather than over-typing. The audit (TAKO-2599) did not
 * catalogue the exact fields, so keeping the type loose here avoids coupling
 * to an undocumented contract. LLMs can still reason about the balance field
 * because it reaches them via `structuredContent`.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import type { ToolModule } from "./types.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  // Pass the backend payload through as `details`. Kept as `unknown` so this
  // tool doesn't need re-shipping every time billing adds a field.
  details: z.unknown(),
});

const get_credit_balance = {
  name: "get_credit_balance",
  description:
    "Use this to check how many Tako credits the current user has remaining. Cheap and fast — good to call before kicking off expensive operations (create_report, deep knowledge_search) so you can warn the user about cost.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Get Credit Balance",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(_input, ctx) {
    const data = await djangoGet<unknown>(
      ctx.env,
      ctx.token,
      "/api/v1/credit_balance/",
      { timeoutMs: 15_000 },
    );
    return { details: data };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_credit_balance;
