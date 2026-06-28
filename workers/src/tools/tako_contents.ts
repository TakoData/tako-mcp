/**
 * `tako_contents` — fetch the downloadable content behind a result URL.
 * Wraps `POST /api/v1/contents`. A Tako card URL resolves to a CSV of the
 * card's data; any other URL resolves to the page's extracted text. One URL
 * per call. `mode` controls delivery: "inline" (default) returns the content
 * in the response body (CSV capped at 1000 rows, with total_rows/truncated; or
 * web text) so the model can read it directly; "url" returns a short-lived
 * presigned download URL instead. The "inline" default is an intentional
 * MCP-ergonomics divergence from the backend default ("url") — an agent almost
 * always wants to read the data, not hand back a link.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import { ContentsDeliveryMode, ContentsRequest } from "../generated/schemas.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Fetch the underlying data behind a result URL — a Tako card URL yields a CSV of the card's data; any other URL yields the page's extracted full text. Pass a single `url` (a TakoCard.webpage_url or a web-result URL). `mode` controls delivery: `inline` (default) returns the content directly in the response so you can read and reason over it — CSV is capped at 1000 rows, so check `total_rows` / `truncated` to know if it's partial; `url` instead returns a short-lived presigned `download_url` (no row cap), for handing the user a download/embed link or for large datasets you don't need to read yourself. Use `inline` when you need the numbers; use `url` when the user just wants the file.";

// Generated contract, with the one documented MCP divergence: default mode → inline.
const inputSchema = ContentsRequest.extend({
  mode: ContentsDeliveryMode.default("inline"),
});

// NOTE: The generated ContentsResponse wraps items in a nested `contents` array
// and uses `url` for the presigned download URL, while the current tool output
// presents a single flat item with `download_url`. These shapes are incompatible,
// so we keep the hand-written output schema to preserve the shipped API contract
// for MCP consumers. See task-A3-report.md for details.
const outputSchema = z.object({
  format: z.string(),
  // Presigned download URL + expiry — populated in "url" mode, null in "inline" mode.
  download_url: z.string().nullable(),
  expires_at: z.string().nullable(),
  source_url: z.string(),
  // USD charged for this artifact (web text is metered ~$1/1k pages; Tako-card
  // CSV is free → 0). Surfaced so the agent can report what the call cost.
  cost: z.number(),
  // Inline content — populated in "inline" mode (CSV text capped at 1000 rows, or
  // web page text), null in "url" mode. total_rows/truncated describe CSV truncation.
  data: z.string().nullable(),
  total_rows: z.number().nullable(),
  truncated: z.boolean(),
});

type Output = z.infer<typeof outputSchema>;

type ContentItem = {
  format?: string;
  url?: string | null;
  expires_at?: string | null;
  cost?: number;
  source_url?: string;
  data?: string | null;
  total_rows?: number | null;
  truncated?: boolean;
};
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
    openWorldHint: true,
  },
  async handler(input, ctx): Promise<Output> {
    // input conforms to the generated ContentsRequest contract (url + mode).
    const body = input satisfies z.input<typeof ContentsRequest>;
    const data = await djangoPost<ContentsPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/contents/",
      body,
      { timeoutMs: 60_000 },
    );
    const item = data.contents?.[0];
    if (!item) {
      throw new Error(
        "Tako contents endpoint returned no downloadable content for that URL.",
      );
    }
    // inline mode → backend populates `data` (+ total_rows/truncated) and leaves
    // url/expires_at null; url mode → backend returns a presigned url/expires_at
    // and leaves the inline fields null. Pass both shapes through as-is.
    const parsed = outputSchema.safeParse({
      format: item.format ?? "",
      download_url: item.url ?? null,
      expires_at: item.expires_at ?? null,
      source_url: item.source_url ?? input.url,
      cost: item.cost ?? 0,
      data: item.data ?? null,
      total_rows: item.total_rows ?? null,
      truncated: item.truncated ?? false,
    });
    if (!parsed.success) {
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
