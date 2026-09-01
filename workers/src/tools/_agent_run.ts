/**
 * Model-facing projection for `tako_agent` (spec:
 * 2026-08-26-model-facing-surface-redesign, "Per-tool shape").
 *
 * The defect this replaces: the tool advertised a LIFECYCLE stub —
 * `{run_id, status, timed_out, thread_id}`, 139 chars measured on staging —
 * and carried the answer, its citations and its cards in the markdown text
 * only. Five measured harnesses (Claude Code, VS Code MCP, Codex CLI,
 * Pydantic AI, ChatGPT-with-widget) feed the model `structuredContent` and
 * DROP `content`, so on all five the answer was invisible and the model read
 * a uuid and the word `completed`.
 *
 * Both channels now carry the same projected result. Every field is mapped on
 * purpose, so an unknown backend key cannot leak; wire-drift protection is the
 * generated-contract guard in `pollAgentRun` plus the conformance test in
 * `_agent_run.test.ts`.
 *
 * What the projection drops, and why (sizes measured on two staging runs,
 * 2026-08-30 — `effort: "medium"`):
 *
 *   - `cards[].methodologies` (3,232 chars on one card): the generated BUILD
 *     record — raw pandas and SQL (`out = df.copy()`, `SELECT f.start_time
 *     …`). `metadata.methodology` states the same thing in prose the agent
 *     wrote for a reader.
 *   - `cards[].metric_definitions` (2,070 chars on one card): an S&P Global
 *     Excel-formula line-item dump (`IQ_REV Revenues [112] … [45911]`).
 *     `metadata.definitions` covers the terms the answer actually uses.
 *     Those two fields alone were 81% of that run's card payload.
 *   - `cards[].content{}`: nulls plus `export_pricing`; `total_rows` is lifted
 *     out of it.
 *   - `citations[].source_name`, `.excerpt`, `.publish_date`, `.content`: the
 *     generated contract states the Answer Agent "populates source_index and
 *     leaves the rest null", and both live runs confirm it.
 *   - `run_id` and `result.request_id`: correlation ids with no model reader
 *     and no poll tool to spend them on. `pollAgentRun` logs `run_id` on the
 *     TERMINAL poll, which is where a support question gets answered — the
 *     same bargain `request_id` makes on the search tools, where `mcp.ts`
 *     logs it. Delete that log and this drop stops being safe: `mcp.ts`
 *     itself never sees `run_id`, so nothing else would record it.
 *   - `status`: the handler polls with `onTimeout: "throw"`, so the only
 *     values that can ship are `completed` and `failed`, and `error` already
 *     distinguishes them. It comes back the day a non-terminal run can be
 *     returned.
 *   - `timed_out`: always `false` for the same reason — the field's own
 *     describe told the model to poll a tool that does not exist.
 *
 * Kept against the drop list: `cards[].image_url` and `cards[].embed_url`
 * (Jay, 2026-08-31). An agent run's cards ARE its deliverable, and unlike
 * `tako_search` this tool mounts no widget and ships no PNG block, so those
 * two urls are the only way a host can render or link the chart it paid for.
 */
import { z } from "zod";

import { withShareOptIn } from "./_chart_widget.js";
import {
  dateOnly,
  nonEmpty,
  sourceNamesOf,
  usageAdvertisedSchema,
  type Usage,
} from "./_search_results.js";

/**
 * One chart card an agent run built.
 *
 * Bare of describes on purpose. The published schema is capped at 2,000 chars
 * (`OUTPUT_SCHEMA_MAX_CHARS`) and this tool's shape spends 1,500 of it on
 * structure, so a describe here has to earn its ~50 bytes against a field name
 * that already says the same thing. `url`, `image_url`, `embed_url`,
 * `total_rows` and `description` do not need one; the fetch path they imply is
 * stated ONCE, on the `cards` array itself.
 *
 * `total_rows` is a plain `number()`, not `.int()`: draft-7 renders `.int()` as
 * a 55-char ±2^53 bound pair, and the projection already lifts the value from
 * a wire field the run-lifecycle guard validated. Same call `tako_contents`
 * made in #275.
 */
export const projectedAgentCardShape = z.looseObject({
  title: z.string().optional(),
  description: z.string().optional(),
  exportable: z.boolean().describe("false → the rows are locked."),
  url: z.string().optional(),
  image_url: z.string().optional(),
  embed_url: z.string().optional(),
  source: z.string().optional(),
  last_updated: z.string().optional().describe("When Tako last refreshed the card."),
  total_rows: z.number().optional(),
});
export type ProjectedAgentCard = {
  title?: string;
  description?: string;
  exportable: boolean;
  url?: string;
  image_url?: string;
  embed_url?: string;
  source?: string;
  last_updated?: string;
  total_rows?: number;
};

/** One indexed source behind the answer. */
export const projectedCitationShape = z.looseObject({
  index: z.number().describe("The number an [n] marker joins to; sparse."),
  title: z.string(),
  url: z.string().optional(),
  source_index: z
    .enum(["data", "web"])
    .optional()
    .describe("`web` → a page `tako_contents` can fetch. `data` → a source's home page."),
});
export type ProjectedCitation = {
  index: number;
  title: string;
  url?: string;
  source_index?: "data" | "web";
};

/** Advertised structuredContent for `tako_agent`: the projected run. One
 *  shape, both surfaces — this tool mounts no widget, so there are no
 *  per-surface widget fields to declare (it is also off the chatgpt surface,
 *  `CHATGPT_TOOL_NAMES` in `_surface.ts`).
 *
 *  Declared HERE, beside `projectAgentRun`, not in `_render_markdown.ts`: the
 *  advertised shape and the projection that fills it drift the moment they
 *  live in different files. `_contents.ts` keeps the same pairing. */
export const agentRunOutputShape = z.looseObject({
  answer: z.string().optional().describe("Its [n] markers join to `citations`."),
  guidance: z.string().optional().describe("Rejected queries only."),
  cards: z
    .array(projectedAgentCardShape)
    .describe("Pass an exportable card's `url` to tako_contents for its rows."),
  citations: z.array(projectedCitationShape),
  // The three reference maps carry no describe, and `catchall` rather than
  // `z.record`: draft-7 gives a record a `propertyNames` clause worth 18 chars
  // per map and nothing else, the names already say which prose each holds, and
  // the published cap (OUTPUT_SCHEMA_MAX_CHARS) is better spent where a rule
  // would otherwise go unstated. The text channel labels them as sections.
  definitions: z.object({}).catchall(z.string()).optional(),
  assumptions: z.object({}).catchall(z.string()).optional(),
  methodology: z.object({}).catchall(z.string()).optional(),
  thread_id: z.string().optional().describe("Send back as `thread_id` for a follow-up."),
  // Nullable, unlike tako_contents' always-present `usage`: agent runs over
  // MCP are not metered for every org yet (TAKO-3245), so null is a real state.
  usage: usageAdvertisedSchema.nullable().describe("Null when not metered."),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

/** The projected agent run: what both channels carry. */
export type AgentRunOutput = {
  answer?: string;
  /** Refusal only — see `refusalGuidance`. */
  guidance?: string;
  cards: ProjectedAgentCard[];
  citations: ProjectedCitation[];
  definitions?: Record<string, string>;
  assumptions?: Record<string, string>;
  methodology?: Record<string, string>;
  thread_id?: string;
  usage: Usage | null;
  error?: { code: string; message: string };
};

/**
 * The one `guidance` branch this tool has: Tako rejected the query before the
 * agent ran, so a `completed` run carries no answer and no cards. Without it
 * the result reads as an empty success — the renderer's old wording for this
 * state was "Agent run completed with no answer text", and `refusal_code`
 * never reached either channel to say why.
 *
 * Two sentences, verdict then one action, per the spec's guidance rule.
 */
export function refusalGuidance(code: string): string {
  return `Tako rejected this query before the agent ran (${code}), so nothing was researched. Rephrase it as a question about specific entities and metrics, or call \`tako_search\` for a direct lookup.`;
}

/** The wire fields the projection reads. A superset arrives; nothing else is kept. */
export type AgentRunWireLike = {
  thread_id?: string | null | undefined;
  usage?: Usage | null | undefined;
  result?:
    | {
        answer?: string | null | undefined;
        cards?: unknown;
        citations?: unknown;
        metadata?:
          | {
              definitions?: unknown;
              assumptions?: unknown;
              methodology?: unknown;
            }
          | null
          | undefined;
        refusal_code?: string | null | undefined;
      }
    | null
    | undefined;
  error?: { code: string; message: string } | null | undefined;
  // Read ONLY to tell a failed run from a legitimately prose-free one when the
  // backend leaves `error` null. It is never projected — `status` had two
  // reachable values and `error` carries the distinction the model acts on.
  status?: string | undefined;
};

/** Project one card an agent run built. */
export function projectAgentCard(card: unknown): ProjectedAgentCard | undefined {
  if (card === null || typeof card !== "object") return undefined;
  const rec = card as Record<string, unknown>;
  const content = rec.content as Record<string, unknown> | null | undefined;
  const out: ProjectedAgentCard = {
    exportable: typeof rec.exportable === "boolean" ? rec.exportable : content != null,
  };
  const title = nonEmpty(rec.title);
  if (title !== undefined) out.title = title;
  const description = nonEmpty(rec.description);
  if (description !== undefined) out.description = description;
  const url = nonEmpty(rec.webpage_url);
  if (url !== undefined) out.url = url;
  const imageUrl = nonEmpty(rec.image_url);
  if (imageUrl !== undefined) out.image_url = imageUrl;
  const embedUrl = nonEmpty(rec.embed_url);
  // Share opt-in HERE, not in the poll loop, so the url an agent quotes into
  // its answer matches the one every other surface serves for the same card.
  // Agent cards are passthrough, unlike search's, which get `showShare=true`
  // baked in by `buildChartUrls`. While the opt-in lived in `pollAgentRun` the
  // three consumers that call this projection directly — the doc generator,
  // `_agent_run.test.ts`, and the channel-parity test — all missed it, and
  // `docs/TOOLS.md` shipped an embed url production never returns.
  if (embedUrl !== undefined) out.embed_url = withShareOptIn(embedUrl);
  const sources = sourceNamesOf(rec);
  if (sources.length > 0) out.source = sources.join(", ");
  const freshness = rec.data_freshness;
  if (freshness !== null && typeof freshness === "object") {
    // `last_updated` only, the same field `tako_search` projects. Agent cards
    // are built per run and often leave it null while carrying `coverage_end`;
    // reading that instead would put the DATA's period under a key that means
    // Tako's refresh time. The period stays in `description`, where the agent
    // already writes it.
    const updated = dateOnly((freshness as Record<string, unknown>).last_updated);
    if (updated !== undefined) out.last_updated = updated;
  }
  // Lifted out of `content` so the count survives that field's drop. A locked
  // card ships `content: null`, so no count exists to report — a fabricated 0
  // would read as "no data exists" when the truth is "data you can't have".
  if (content != null) {
    // No `content.dataset` fallback, unlike the search projection this was
    // copied from: `dataset` is an inline payload group, and the Answer Agent
    // contract is frozen against inline data ("no inline data — ever",
    // AnswerAgentRunRequest / AnswerAgentResult). Only the metadata count can
    // arrive on this path.
    const totalRows = typeof content.total_rows === "number" ? content.total_rows : undefined;
    // GATED ON `exportable`, like the search projection: the text channel
    // renders the count only in the exportable arm, so an ungated count would
    // sit in structuredContent and nowhere else — a channel-equivalence hole.
    // The backend's shared export gate ships `content: null` on a locked card
    // today, so nothing reaches here; the guard is what keeps the two channels
    // agreeing if that changes.
    if (totalRows !== undefined && out.exportable) out.total_rows = totalRows;
  }
  return out;
}

/** Project one citation. Drops any entry without the join key the answer needs. */
export function projectCitation(citation: unknown): ProjectedCitation | undefined {
  if (citation === null || typeof citation !== "object") return undefined;
  const rec = citation as Record<string, unknown>;
  const title = nonEmpty(rec.title);
  if (typeof rec.index !== "number" || !Number.isInteger(rec.index) || title === undefined) {
    return undefined;
  }
  const out: ProjectedCitation = { index: rec.index, title };
  const url = nonEmpty(rec.url);
  if (url !== undefined) out.url = url;
  if (rec.source_index === "data" || rec.source_index === "web") {
    out.source_index = rec.source_index;
  }
  return out;
}

/**
 * Flatten one `metadata` list into a `{name: text}` map, deduped by name.
 *
 * The list form carries `category` and `source_ref` alongside; both are
 * dropped. The map form is the shape the search tools' reference prose already
 * uses (`metric_definitions`, `source_notes`), so one rendering helper serves
 * both tools and a truncating host loses the same thing last on either.
 *
 * A duplicate name with DIFFERENT text keeps both, disambiguated with a
 * counter, for the reason `buildReferenceMaps` does the same: dropping text is
 * worse than an ugly key.
 */
export function noteMap(
  entries: unknown,
  nameKey: "term" | "title",
  textKey: "definition" | "description",
): Record<string, string> | undefined {
  if (!Array.isArray(entries)) return undefined;
  // NULL-PROTOTYPE, for the reason `buildReferenceMaps` uses one: every key is a
  // model-written `term` or `title`, so a term of `toString` reads back
  // Object.prototype's member instead of undefined and publishes to the model as
  // `toString (2)` — a duplicate the payload does not contain.
  const out: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = nonEmpty(rec[nameKey]);
    const text = nonEmpty(rec[textKey]);
    if (name === undefined || text === undefined) continue;
    if (out[name] === undefined || out[name] === text) {
      out[name] = text;
      continue;
    }
    let i = 2;
    while (out[`${name} (${i})`] !== undefined && out[`${name} (${i})`] !== text) i += 1;
    out[`${name} (${i})`] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Project a terminal agent run into the shape both channels carry. */
export function projectAgentRun(run: AgentRunWireLike): AgentRunOutput {
  const result = run.result;
  const out: AgentRunOutput = {
    cards: [],
    citations: [],
    usage: run.usage ?? null,
  };
  const answer = nonEmpty(result?.answer);
  if (answer !== undefined) out.answer = answer;
  const refusal = nonEmpty(result?.refusal_code);
  if (refusal !== undefined) out.guidance = refusalGuidance(refusal);
  if (Array.isArray(result?.cards)) {
    out.cards = result.cards
      .map(projectAgentCard)
      .filter((c): c is ProjectedAgentCard => c !== undefined);
  }
  if (Array.isArray(result?.citations)) {
    out.citations = result.citations
      .map(projectCitation)
      .filter((c): c is ProjectedCitation => c !== undefined);
  }
  const md = result?.metadata;
  const definitions = noteMap(md?.definitions, "term", "definition");
  if (definitions !== undefined) out.definitions = definitions;
  const assumptions = noteMap(md?.assumptions, "title", "description");
  if (assumptions !== undefined) out.assumptions = assumptions;
  const methodology = noteMap(md?.methodology, "title", "description");
  if (methodology !== undefined) out.methodology = methodology;
  const threadId = nonEmpty(run.thread_id);
  if (threadId !== undefined) out.thread_id = threadId;
  if (run.error != null) out.error = { code: run.error.code, message: run.error.message };
  // A failed run whose `error` the backend left null would otherwise reach the
  // model as "The agent returned no answer." — a WRONG statement, not a missing
  // one, and a prose-only run with no cards is legitimate so the renderer
  // cannot tell them apart on its own.
  else if (run.status === "failed") {
    out.error = { code: "agent_run_failed", message: "The agent run failed without a reason." };
  }
  // NON-TERMINAL, and the renderer cannot tell it from a prose-free completed
  // run: both project to no answer and no error, so the text channel states
  // "The agent returned no answer." about a run that is still going.
  // `pollAgentRun`'s `onTimeout: "return"` arm produces exactly this shape
  // (`status: "running"`, `timed_out: true`) and has no production caller —
  // the handler passes `onTimeout: "throw"`. This guard is what keeps the
  // statement true if one appears. `queued` reaches it too, which a
  // `timed_out` check would not.
  else if (run.status !== undefined && run.status !== "completed") {
    out.error = {
      code: "agent_run_incomplete",
      message: `The agent run ended while still ${run.status}.`,
    };
  }
  return out;
}
