/**
 * Shared code for the four enrichment tools: `tako_company_search`,
 * `tako_people_search`, `tako_company_enrich` and `tako_person_enrich`.
 *
 * Each search and enrich endpoint returns its records as one Tako list card.
 * The tools never inline that card's rows: `tako_contents` on the card's url
 * returns them, and that call is where rows and premium cells are billed. So
 * every tool input is its generated request schema without the three contents
 * fields, and no request body carries them.
 *
 * The text renderers are in `_render_markdown.ts`, beside the other tools'.
 *
 * `_`-prefixed so `gen-registry.ts` skips it: this isn't a tool module.
 */
import { z } from "zod";

import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  djangoPost,
  extractErrorDetail,
} from "../django.js";
import { type CompanyEnrichResult, EnrichInputError, type PersonEnrichResult } from "../generated/schemas.js";
import {
  COMPANY_LIST_FIELDS,
  describeListFields,
  type ListCardFields,
  PERSON_LIST_FIELDS,
} from "./_enrich_fields.js";
import { logWireGuardFailure } from "./_log.js";
import { projectCard, takoCardSchema, withheldCellsGuidance } from "./_search_results.js";
import type { ToolContext } from "./types.js";

/** The request fields that inline a card's rows. No enrichment tool takes or sends them. */
export const CONTENTS_FIELDS = { include_contents: true, max_rows: true, content_format: true } as const;

const ENRICH_TIMEOUT_MS = 90_000;

const UNEXPECTED_SHAPE =
  "Tako's enrichment endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.";

/** The fields the caller set, without the `undefined` ones a parsed input carries. */
export function givenFields<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Each enrichment tool's endpoint. `postEnrich` and the error rewrite both read it. */
export const ENRICH_ENDPOINTS = {
  tako_company_search: "/api/v1/companies/search",
  tako_people_search: "/api/v1/people/search",
  tako_company_enrich: "/api/v1/companies/enrich",
  tako_person_enrich: "/api/v1/people/enrich",
} as const;
export type EnrichTool = keyof typeof ENRICH_ENDPOINTS;

/** The list card each tool returns. Its fields are what the tool's description lists. */
const ENRICH_CARD_FIELDS: Record<EnrichTool, ListCardFields> = {
  tako_company_search: COMPANY_LIST_FIELDS,
  tako_people_search: PERSON_LIST_FIELDS,
  tako_company_enrich: COMPANY_LIST_FIELDS,
  tako_person_enrich: PERSON_LIST_FIELDS,
};

/**
 * The sentences of a tool's description that say which fields it returns.
 * `llms-full.txt` carries the same text for each tool, and `gen-registry.ts`
 * fails when it doesn't.
 */
export function enrichFieldSentences(tool: EnrichTool): string {
  return describeListFields(ENRICH_CARD_FIELDS[tool]);
}

/** The `POST` paths a backend message can name: the four endpoints, and the contents call the cards point to. */
const REST_POST_PATHS = { ...ENRICH_ENDPOINTS, tako_contents: "/api/v1/contents" } as const;

/** What to call each one on a connection that doesn't register its tool. */
const REST_CALL_PHRASES: Record<keyof typeof REST_POST_PATHS, string> = {
  tako_company_search: "a company search",
  tako_people_search: "a people search",
  tako_company_enrich: "a company match",
  tako_person_enrich: "a person match",
  tako_contents: "a contents fetch",
};

const REST_CALLS = Object.entries(REST_POST_PATHS).map(
  ([tool, path]) =>
    [new RegExp(`POST ${path.replace(/[/.]/g, "\\$&")}`, "g"), tool as keyof typeof REST_POST_PATHS] as const,
);

/**
 * A backend message with each REST call it names replaced by the tool that
 * makes it, or by a plain phrase when this connection doesn't register that
 * tool. A model can't call a REST path, and a tool name it can't call is no
 * better.
 */
export function withToolNames(message: string, registered: ReadonlySet<string> | undefined): string {
  return REST_CALLS.reduce(
    (text, [call, tool]) =>
      text.replace(call, registered?.has(tool) === true ? `\`${tool}\`` : REST_CALL_PHRASES[tool]),
    message,
  );
}

const inputErrorBody = EnrichInputError.pick({
  error_message: true,
  code: true,
  field: true,
  suggestions: true,
});

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The model-facing text for the two errors these endpoints make their own, or
 * `undefined` to keep the default mapping in `mcp.ts`, which already carries
 * the backend's `error_message` on a 4xx.
 *
 * A 400 names the `field` to fix, a `code` and `suggestions`, which the
 * default text has no place for. A 403 is an account that can't use the API,
 * so a retry can't clear it.
 */
export function enrichErrorGuidance(
  err: DjangoError,
  registered: ReadonlySet<string> | undefined,
): string | undefined {
  if (err instanceof DjangoBadRequestError) {
    const parsed = inputErrorBody.safeParse(parseJson(err.body));
    if (!parsed.success) return undefined;
    const { error_message, code, field, suggestions } = parsed.data;
    const subject = field === "" ? "this request" : `\`${field}\``;
    const parts = [`Tako can't run ${subject} (${code}): ${sentence(withToolNames(error_message, registered))}`];
    if (suggestions.length > 0) parts.push(`Closest values: ${suggestions.join(", ")}.`);
    parts.push("Fix the input and call again.");
    return parts.join(" ");
  }
  if (err instanceof DjangoHttpError && err.status === 403) {
    const detail = extractErrorDetail(err.body);
    if (detail === undefined) return undefined;
    return `${sentence(detail)} This connection can't use the tool, so don't retry it; tell the user.`;
  }
  return undefined;
}

async function withEnrichErrors<T>(call: () => Promise<T>, ctx: ToolContext): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof DjangoError) {
      const guidance = enrichErrorGuidance(err, ctx.registeredTools);
      if (guidance !== undefined) err.modelGuidance = guidance;
    }
    throw err;
  }
}

function guardWire<S extends z.ZodType>(tool: string, stage: string, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    logWireGuardFailure(tool, stage, parsed.error, data);
    throw new Error(UNEXPECTED_SHAPE);
  }
  return parsed.data;
}

/** `POST` a tool's endpoint and check the response against its generated schema. */
export async function postEnrich<S extends z.ZodType>(
  tool: EnrichTool,
  body: unknown,
  response: S,
  ctx: ToolContext,
): Promise<z.output<S>> {
  const path = ENRICH_ENDPOINTS[tool];
  const data = await withEnrichErrors(
    () => djangoPost<unknown>(ctx.env, ctx.token, path, body, { timeoutMs: ENRICH_TIMEOUT_MS, caller: ctx.caller }),
    ctx,
  );
  return guardWire(tool, path, response, data);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export const enrichCardShape = z.looseObject({
  title: z.string().optional(),
  description: z.string().optional().describe("A markdown table of the first 10 rows. 🔒 marks a premium cell."),
  url: z.string().optional().describe("Pass it to tako_contents for the rows."),
  exportable: z.boolean().describe("true → tako_contents returns the rows."),
  total_rows: z.number().int().optional(),
  source: z.string().optional(),
});
export type EnrichCard = z.infer<typeof enrichCardShape>;

const GUIDANCE_DESCRIBE = "What to do about premium cells the card withholds.";

export interface CardProjection {
  card: EnrichCard | null;
  guidance?: string;
}

/**
 * Project a response's card the way `tako_search` projects one, keeping the
 * fields a list card carries. A null card stays null: nothing matched.
 */
export function projectEnrichCard(tool: string, wireCard: unknown, ctx: ToolContext): CardProjection {
  if (wireCard === null || wireCard === undefined) return { card: null };
  const raw = guardWire(tool, "card", takoCardSchema, wireCard);
  const projected = projectCard(raw, null);
  const card: EnrichCard = { exportable: projected.exportable };
  if (projected.title !== undefined) card.title = projected.title;
  if (projected.description !== undefined) card.description = projected.description;
  if (projected.url !== undefined) card.url = projected.url;
  if (projected.total_rows !== undefined) card.total_rows = projected.total_rows;
  if (projected.source !== undefined) card.source = projected.source;
  const guidance =
    ctx.registeredTools?.has("tako_contents") === true ? withheldCellsGuidance([raw]) : undefined;
  return guidance === undefined ? { card } : { card, guidance };
}

// ---------------------------------------------------------------------------
// Search output
// ---------------------------------------------------------------------------

const searchCoreFields = {
  total: z.number().int().describe("Matching records. It stops at 500."),
  total_is_lower_bound: z
    .boolean()
    .describe("true → `total` is the 500 cap, not an exact count. The card's rows go past it."),
  applied: z.array(z.string()).describe("The filters the search ran, with their resolved values."),
  notes: z.array(z.string()),
};

const searchTailFields = {
  card: enrichCardShape.nullable().describe("The list as one card. null → nothing matched."),
  guidance: z.string().optional().describe(GUIDANCE_DESCRIBE),
};

export const companySearchOutputShape = z.looseObject({ ...searchCoreFields, ...searchTailFields });

export const peopleSearchOutputShape = z.looseObject({
  ...searchCoreFields,
  unresolved: z.array(z.string()).describe("Inputs that named nothing, as field=value."),
  failed: z
    .array(z.string())
    .describe("Inputs whose lookup failed, as field=value. Retry them; they aren't misses."),
  ...searchTailFields,
});

export type ListSearchOutput = z.infer<typeof companySearchOutputShape> &
  Partial<Pick<z.infer<typeof peopleSearchOutputShape>, "unresolved" | "failed">>;

// ---------------------------------------------------------------------------
// Enrich output
// ---------------------------------------------------------------------------

export const ENRICH_STATUSES = ["matched", "no_match", "failed"] as const;
export const ENRICH_CONFIDENCES = ["exact", "high", "ambiguous"] as const;

type GeneratedResult = CompanyEnrichResult | PersonEnrichResult;
type Unlisted =
  | Exclude<GeneratedResult["status"], (typeof ENRICH_STATUSES)[number]>
  | Exclude<NonNullable<GeneratedResult["confidence"]>, (typeof ENRICH_CONFIDENCES)[number]>;
// Fails to compile when the API adds a status or a confidence the descriptions don't name.
const vocabularyIsComplete: [Unlisted] extends [never] ? true : never = true;
void vocabularyIsComplete;
ENRICH_STATUSES satisfies ReadonlyArray<GeneratedResult["status"]>;
ENRICH_CONFIDENCES satisfies ReadonlyArray<NonNullable<GeneratedResult["confidence"]>>;

const enrichResultShape = z.looseObject({
  index: z.number().int().describe("The item's position in `items`, from 0."),
  input: z.record(z.string(), z.string()).describe("The item as sent."),
  status: z.string().describe("matched, no_match (an answer, not an error) or failed (retry the item)."),
  match_id: z.string().optional(),
  confidence: z.string().optional().describe("exact, high, or ambiguous: others match nearly as well."),
  matched_on: z.string().optional(),
  alternates: z.number().int().describe("Other near matches, up to 3."),
  unresolved: z.array(z.string()).describe("Inputs that named nothing, as field=value."),
  failed: z.array(z.string()).describe("Inputs whose lookup failed. Retry them."),
});
export type EnrichResultRow = z.infer<typeof enrichResultShape>;

export const enrichOutputShape = z.looseObject({
  results: z.array(enrichResultShape).describe("One result per item, in `items` order."),
  card: enrichCardShape
    .nullable()
    .describe("The matches as one card, in `items` order. null → nothing matched."),
  guidance: z.string().optional().describe(GUIDANCE_DESCRIBE),
});
export type EnrichOutput = z.infer<typeof enrichOutputShape>;

/** One wire result, as both enrich endpoints return it. */
export interface WireEnrichResult {
  status: string;
  match_id?: string | null | undefined;
  confidence?: string | null | undefined;
  matched_on?: string | null | undefined;
  alternates: number;
  unresolved: string[];
  failed: string[];
}

/**
 * Line each result up with the item that asked for it. The endpoint returns
 * one result per item in request order, so a different count means the
 * positions can't be trusted and the call fails instead of mislabelling rows.
 */
export function alignEnrichResults(
  tool: string,
  items: ReadonlyArray<Record<string, unknown>>,
  results: ReadonlyArray<WireEnrichResult>,
): EnrichResultRow[] {
  if (items.length !== results.length) {
    logWireGuardFailure(tool, `results count ${String(results.length)} for ${String(items.length)} items`);
    throw new Error(UNEXPECTED_SHAPE);
  }
  return results.map((result, index) => {
    const input: Record<string, string> = {};
    for (const [key, value] of Object.entries(items[index] ?? {})) {
      if (typeof value === "string" && value.trim() !== "") input[key] = value;
    }
    const row: EnrichResultRow = {
      index,
      input,
      status: result.status,
      alternates: result.alternates,
      unresolved: result.unresolved,
      failed: result.failed,
    };
    if (result.match_id != null) row.match_id = result.match_id;
    if (result.confidence != null) row.confidence = result.confidence;
    if (result.matched_on != null) row.matched_on = result.matched_on;
    return row;
  });
}

/** The sentence of an enrich description that names what each result carries. */
export const ENRICH_RESULT_SENTENCE = `\`results\` has one entry per item, in order: status (${ENRICH_STATUSES.join(", ")}), match_id, confidence (${ENRICH_CONFIDENCES.join(", ")}), matched_on, alternates, unresolved, failed.`;
