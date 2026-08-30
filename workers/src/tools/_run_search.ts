/**
 * Issue a search and shape the response. Shared by `tako_search` and
 * `tako_search_advanced`, which hit DIFFERENT endpoints — `include_answer`
 * routes the advanced tool to /api/v1/answer/ — so a slimming or output fix
 * lands on both at once while the wire guard stays per-endpoint.
 *
 * `_`-prefixed so `gen-registry.ts` skips it — this is not a tool module.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import { AnswerRequest, AnswerResponse, SearchRequest, SearchResponse } from "../generated/schemas.js";
import { logWireGuardFailure } from "./_log.js";
import {
  buildSearchOutput,
  type SearchOutputExtras,
  takoCardSchema,
  webResultSchema,
  type SearchedSources,
  type SearchOutput,
} from "./_search_results.js";
import type { ToolContext } from "./types.js";

/** Which endpoint a call goes to. `include_answer` is the only thing that picks. */
export type SearchEndpoint = "search" | "answer";

/**
 * An endpoint and the body that belongs to it, as ONE value.
 *
 * They travel together so a caller cannot pass a mismatched pair by getting the
 * argument order right and the meaning wrong. Note what the TYPE does not do:
 * `z.input<typeof SearchRequest>` is a plain object type, so an answer body
 * carrying `output_schema` is assignable to it and no union can reject that at
 * compile time — `.strict()` is a RUNTIME rule. The assertion in `runSearch` is
 * what actually catches it, before the backend 400s on the unknown key.
 */
export type SearchCall =
  | { endpoint: "search"; body: z.input<typeof SearchRequest> }
  | { endpoint: "answer"; body: z.input<typeof AnswerRequest> };

/**
 * Issue the search and shape the response.
 *
 * Split out of the handler so `tako_search_advanced` reuses it: the two tools
 * hit different endpoints and the response shapes differ by three fields, so
 * the wire guard branches — but the slimming, the widget lift and the
 * zero-card guidance are one copy, and a fix there lands on both at once.
 *
 * `rowCap` is the per-card inline row budget: `null` drops every row (what the
 * simple tool passes — it never inlines), "all" keeps what the backend sent
 * (what tako_search_advanced passes — it sends its own max_rows on the wire),
 * a number caps to the N most-recent.
 */
export async function runSearch(
  call: SearchCall,
  sources: SearchedSources,
  rowCap: number | "all" | null,
  ctx: ToolContext,
  // The CALLER's own name, for the wire-guard log only. Required, and not
  // derived from `endpoint`: `endpointFor` returns "search" for every
  // `tako_search_advanced` call that omits `include_answer`, so deriving it
  // logged `tool=tako_search` for a tool that sends fields the simple one
  // cannot (`mode`, `content_format: "card_json"`, `node_ids`) — pointing an
  // on-call at the wrong surface with the one signal they get.
  toolName: string,
): Promise<SearchOutput> {
  const { endpoint, body } = call;
  // The pairing the type cannot enforce (see `SearchCall`). `SearchRequest` is
  // `.strict()`, so an `output_schema` on the search branch is a 400 at the
  // backend with a paid round trip in front of it — fail here instead, where the
  // stack names the caller.
  if (endpoint === "search" && "output_schema" in body) {
    throw new Error("runSearch: output_schema rides the answer endpoint only");
  }
  // Both endpoints are synchronous (~120s sync ceiling). No async/202, no
  // polling. Zero matches come back as 200 with empty `cards`.
  const path = endpoint === "answer" ? "/api/v1/answer/" : "/api/v3/search/";
  const data = await djangoPost<unknown>(ctx.env, ctx.token, path, body, { timeoutMs: 130_000 });

  // Wire-contract guard, PER ENDPOINT. `SearchResponse` is a bare `z.object`
  // and STRIPS unknown keys: guarding an /v1/answer payload with it would drop
  // `answer`, `structured_output` and `structured_output_error` in silence and
  // return a working search response with the synthesis gone. `_run_search.test.ts`
  // fails if this is ever collapsed back to one schema.
  const guardName = endpoint === "answer" ? "AnswerResponse" : "SearchResponse";
  const wireCheck =
    endpoint === "answer" ? AnswerResponse.safeParse(data) : SearchResponse.safeParse(data);
  if (!wireCheck.success) {
    logWireGuardFailure(toolName, guardName, wireCheck.error, data);
    throw new Error(
      "Tako search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
    );
  }
  const wire = wireCheck.data as z.infer<typeof SearchResponse> &
    Partial<z.infer<typeof AnswerResponse>>;

  const cards = z.array(takoCardSchema).safeParse(wire.cards ?? []);
  const webResults = z.array(webResultSchema).safeParse(wire.web_results ?? []);
  if (!cards.success || !webResults.success) {
    logWireGuardFailure(
      toolName,
      cards.success ? "web_results" : "cards",
      cards.success ? (webResults.success ? undefined : webResults.error) : cards.error,
      data,
    );
    throw new Error(
      "Tako search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
    );
  }
  // Slim the model-facing payload, which shrinks BOTH channels the model sees
  // (content.text + structuredContent in mcp.ts are both derived from this).
  //
  // Web page text is kept only when the REQUEST asked for it. Derived from the
  // body rather than passed by the caller, so the two tools cannot disagree with
  // what went on the wire: tako_search never sets sources.web.include_contents,
  // so it always drops; tako_search_advanced exposes the field, so a caller who
  // sets it gets what the generated description promises. On /v3/search that
  // text is free (see slimWebResult), so context is the only cost and the caller
  // has already accepted it.
  const keepWebText = body.sources?.web?.include_contents === true;
  // DERIVED from the wire body for the same reason `keepWebText` is: the two
  // search tools then cannot disagree with what was actually requested, and
  // `tako_search` — which takes no pin — gets `false` without naming the concept.
  // Both halves are required: `strict: true` with an empty `node_ids` is a 400 at
  // the backend, and a pin without `strict` only boosts, so neither alone makes
  // zero cards a filter artefact.
  const strictPin =
    body.sources?.data?.strict === true && (body.sources?.data?.node_ids?.length ?? 0) > 0;
  // Every field is guarded by `!= null` rather than assumed present: on the
  // search endpoint all four are absent, and `AnswerResponse` types three of
  // them as nullable.
  const extras: SearchOutputExtras = {
    ...(wire.related != null ? { related: wire.related } : {}),
    ...(typeof wire.answer === "string" ? { answer: wire.answer } : {}),
    ...(wire.structured_output != null ? { structured_output: wire.structured_output } : {}),
    ...(wire.structured_output_error != null
      ? { structured_output_error: wire.structured_output_error }
      : {}),
  };
  // The projection (projectCard/projectWebResult inside buildSearchOutput)
  // replaced slimCard + hoistSourceGlossary here: raw wire arrays go in, the
  // nine-field cards, five-field web results and the two deduped reference
  // maps come out (spec: 2026-08-26-model-facing-surface-redesign).
  return buildSearchOutput(
    cards.data,
    webResults.data,
    wire.request_id,
    wire.usage ?? null,
    ctx.env,
    sources,
    strictPin,
    // The zero-result protocol routes through tools an anonymous caller does
    // not have; `buildZeroResultGuidance` branches on this (#272).
    ctx.tier ?? "authenticated",
    { rowCap, keepWebText },
    extras,
  );
}
