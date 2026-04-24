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

// Hint at the field LLMs most care about (`credit_balance`) while staying
// permissive on everything else — billing may add fields (subscription info,
// usage aggregates, expiry) without needing a tool re-ship. Using `.loose()`
// lets Zod accept additional keys; they still reach the LLM via
// `structuredContent` because the adapter stringifies the whole payload.
//
// `credit_balance` is typed as `number | string` because DRF serializes
// `DecimalField` as a string by default (`coerce_to_string=True`). The
// backend payload shape is not catalogued in the audit, so we accept both
// rather than break the tool on the first call if the field is a string.
const detailsSchema = z
  .object({
    credit_balance: z.union([z.number(), z.string()]).optional(),
  })
  .loose();

const outputSchema = z.object({
  details: detailsSchema,
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
    const data = await djangoGet<Record<string, unknown>>(
      ctx.env,
      ctx.token,
      "/api/v1/credit_balance/",
      { timeoutMs: 15_000 },
    );
    // Parse-don't-coerce: run the payload through the loose schema so
    // known fields are typed where present and unknown fields pass
    // through. On failure (e.g. backend returns an array or non-object
    // for some reason), surface a human-readable sentence instead of
    // the raw Zod issue dump — the latter is noisy and gives the LLM no
    // hint that this is a backend contract breach rather than a client
    // bug.
    const parsed = detailsSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        "Tako credit_balance endpoint returned an unexpected shape (not a JSON object). This is likely a backend issue — retry once; if it persists, flag it to the Tako team.",
      );
    }
    return { details: parsed.data };
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof outputSchema>>;

export default get_credit_balance;
