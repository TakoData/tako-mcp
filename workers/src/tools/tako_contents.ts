/**
 * `tako_contents` — fetch the downloadable content behind a result URL.
 * Wraps `POST /api/v1/contents`. A Tako card URL resolves to a CSV of the
 * card's data; any other URL resolves to the page's extracted text. One URL
 * per call. Returns a short-lived presigned download URL; for web-text we also
 * inline the text so the model can read it directly.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Fetch the underlying content behind a result URL. A Tako card URL returns a CSV of the card's data; any other URL returns the page's extracted full text. Pass a single `url` (a TakoCard.webpage_url or a web result URL). Returns a short-lived `download_url`; for web pages the extracted `text` is also inlined so you can read it directly.";

const MAX_INLINE_CHARS = 200_000; // cap inlined web text to keep responses sane
const CONTENTS_FETCH_TIMEOUT_MS = 15_000;

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe("The result URL to fetch content for (a Tako card URL → CSV; any other URL → page text)."),
});

const outputSchema = z.object({
  format: z.string(),
  download_url: z.string(),
  expires_at: z.string(),
  source_url: z.string(),
  // USD charged for this artifact (web text is metered ~$1/1k pages; Tako-card
  // CSV is free → 0). Surfaced so the agent can report what the call cost.
  cost: z.number(),
  text: z.string().nullable(),
});

type Output = z.infer<typeof outputSchema>;

type ContentItem = { format?: string; url?: string; expires_at?: string; cost?: number; source_url?: string };
type ContentsPostResponse = { contents?: ContentItem[]; request_id?: string };

const takoContents = {
  name: "tako_contents",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Fetch Contents",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const data = await djangoPost<ContentsPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/contents/",
      { url: input.url },
      { timeoutMs: 60_000 },
    );
    const item = data.contents?.[0];
    if (!item || !item.url) {
      throw new Error(
        "Tako contents endpoint returned no downloadable content for that URL.",
      );
    }
    const isText = (item.format ?? "").toLowerCase() === "text";
    let text: string | null = null;
    if (isText) {
      // Inline the extracted web text so the model can read it without a
      // second tool call. Best-effort: a fetch failure still returns the URL.
      try {
        const resp = await fetch(item.url, { signal: AbortSignal.timeout(CONTENTS_FETCH_TIMEOUT_MS) });
        if (resp.ok) {
          const body = await resp.text();
          text = body.length > MAX_INLINE_CHARS ? body.slice(0, MAX_INLINE_CHARS) + "\n...[truncated]" : body;
        }
      } catch {
        text = null;
      }
    }
    const parsed = outputSchema.safeParse({
      format: item.format ?? "",
      download_url: item.url,
      expires_at: item.expires_at ?? "",
      source_url: item.source_url ?? input.url,
      cost: item.cost ?? 0,
      text,
    });
    if (!parsed.success) {
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
