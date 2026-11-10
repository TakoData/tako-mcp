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
 * `_`-prefixed so `gen-registry.ts` skips it: this isn't a tool module.
 */
import { z } from "zod";

import {
  DjangoBadRequestError,
  DjangoError,
  DjangoHttpError,
  djangoPost,
} from "../django.js";
import {
  BaseAPIError,
  type CompanyEnrichResult,
  EnrichInputError,
  type PersonEnrichResult,
} from "../generated/schemas.js";
import { oneLine } from "./_available_data.js";
import { logWireGuardFailure } from "./_log.js";
import { looseArray, type LooseArrayOptions } from "./_loose_array.js";
import { fenceRunFor } from "./_render_markdown.js";
import { projectCard, takoCardSchema, withheldCellsGuidance } from "./_search_results.js";
import type { ToolContext } from "./types.js";

/** The request fields that inline a card's rows. No enrichment tool takes or sends them. */
export const CONTENTS_FIELDS = { include_contents: true, max_rows: true, content_format: true } as const;

const ENRICH_TIMEOUT_MS = 90_000;

const UNEXPECTED_SHAPE =
  "Tako's enrichment endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.";

/** How one array input accepts a host's stringified array: see `_loose_array.ts`. */
export type ArrayInputOptions = Omit<LooseArrayOptions, "field">;

/**
 * Make every field of a generated request shape optional and drop the default
 * it carries, so a field the caller omits never reaches the request body.
 * `describes` replaces a field's generated description, and is the only way a
 * field without one gets a description. `arrays` names the tool's array
 * inputs, which `_loose_array.test.ts` requires to accept a stringified array.
 */
export function optionalWithoutDefaults<T extends z.ZodRawShape>(
  tool: string,
  shape: T,
  describes: Partial<Record<keyof T & string, string>>,
  arrays: Partial<Record<keyof T & string, ArrayInputOptions>>,
): { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    const withoutDefault = field instanceof z.ZodDefault ? field.unwrap() : field;
    const bare = withoutDefault instanceof z.ZodOptional ? withoutDefault.unwrap() : withoutDefault;
    const override = describes[key as keyof T & string];
    const optional =
      override === undefined
        ? (bare as z.ZodType).optional()
        : (bare as z.ZodType).describe(override).optional();
    const array = arrays[key as keyof T & string];
    out[key] = array === undefined ? optional : looseArray(optional, { ...array, field: `${tool}.${key}` });
  }
  return out as never;
}

/** The fields the caller set, without the `undefined` ones a parsed input carries. */
export function givenFields<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const inputErrorBody = EnrichInputError.pick({
  error_message: true,
  code: true,
  field: true,
  suggestions: true,
});
const apiErrorBody = BaseAPIError.pick({ error_message: true });

/** The REST calls a backend message can name, and the tool that makes each one. */
const REST_CALL_TOOLS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/POST \/api\/v1\/companies\/search/g, "tako_company_search", "a company search"],
  [/POST \/api\/v1\/people\/search/g, "tako_people_search", "a people search"],
  [/POST \/api\/v1\/companies\/enrich/g, "tako_company_enrich", "a company match"],
  [/POST \/api\/v1\/people\/enrich/g, "tako_person_enrich", "a person match"],
  [/POST \/api\/v1\/contents/g, "tako_contents", "a contents fetch"],
];

/**
 * A backend message with each REST call it names replaced by the tool that
 * makes it, or by a plain phrase when this connection doesn't register that
 * tool. A model can't call a REST path, and a tool name it can't call is no
 * better.
 */
export function withToolNames(message: string, registered: ReadonlySet<string> | undefined): string {
  return REST_CALL_TOOLS.reduce(
    (text, [call, tool, phrase]) =>
      text.replace(call, registered?.has(tool) === true ? `\`${tool}\`` : phrase),
    message,
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The model-facing text for an enrichment endpoint's error, or `undefined`
 * to keep the default mapping in `mcp.ts`.
 *
 * The default mapping reads `detail`, `error` and `message`, and these
 * endpoints answer with `error_message`, so it would drop the reason. A 400
 * also names the `field` to fix, a `code` and `suggestions`.
 */
export function enrichErrorGuidance(
  err: DjangoError,
  registered: ReadonlySet<string> | undefined,
): string | undefined {
  if (!(err instanceof DjangoBadRequestError) && !(err instanceof DjangoHttpError)) return undefined;
  const body = parseJson(err.body);
  if (err.status === 400) {
    const parsed = inputErrorBody.safeParse(body);
    if (!parsed.success) return undefined;
    const { error_message, code, field, suggestions } = parsed.data;
    const subject = field === "" ? "this request" : `\`${field}\``;
    const parts = [`Tako can't run ${subject} (${code}): ${sentence(withToolNames(error_message, registered))}`];
    if (suggestions.length > 0) parts.push(`Closest values: ${suggestions.join(", ")}.`);
    parts.push("Fix the input and call again.");
    return parts.join(" ");
  }
  if (err.status === 403 || err.status === 503) {
    const parsed = apiErrorBody.safeParse(body);
    if (!parsed.success || parsed.data.error_message.trim() === "") return undefined;
    const message = sentence(withToolNames(parsed.data.error_message, registered));
    return err.status === 403
      ? `${message} This connection can't use the tool, so don't retry it; tell the user.`
      : message;
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

/** `POST` one enrichment endpoint and check the response against its generated schema. */
export async function postEnrich<S extends z.ZodType>(
  tool: string,
  path: string,
  body: unknown,
  response: S,
  ctx: ToolContext,
): Promise<z.output<S>> {
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

function renderCard(card: EnrichCard): string {
  const lines = [`### ${oneLine(card.title ?? "Untitled list")}`];
  const access: string[] = [];
  if (card.url !== undefined) access.push(`url: ${card.url}`);
  access.push(
    card.exportable
      ? card.total_rows !== undefined
        ? `exportable, ${String(card.total_rows)} rows`
        : "exportable"
      : "rows locked",
  );
  if (card.source !== undefined) access.push(`source: ${oneLine(card.source)}`);
  lines.push(`- ${access.join(" · ")}`);
  if (card.description !== undefined) {
    const fence = fenceRunFor(card.description);
    lines.push(`${fence}\n${card.description}\n${fence}`);
  }
  return lines.join("\n");
}

const listLine = (label: string, values: readonly string[]): string =>
  `- ${label}: ${values.map(oneLine).join(" · ")}`;

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

/** The text channel of a search: the count, what ran, then the card. */
export function renderListSearchMarkdown(output: ListSearchOutput, noun: string): string {
  const blocks: string[] = [];
  const facts: string[] = [];
  if (output.applied.length > 0) facts.push(listLine("applied", output.applied));
  if (output.notes.length > 0) facts.push(listLine("notes", output.notes));
  if (output.unresolved !== undefined && output.unresolved.length > 0) {
    facts.push(listLine("unresolved (named nothing)", output.unresolved));
  }
  if (output.failed !== undefined && output.failed.length > 0) {
    facts.push(listLine("failed (lookup failed, retry these)", output.failed));
  }
  if (output.card === null) {
    blocks.push(`## No ${noun} match`);
    blocks.push(
      `The search ran and matched no ${noun} (total: ${String(output.total)}). That's an answer, not an error. Loosen or drop a filter to widen it.`,
    );
    if (facts.length > 0) blocks.push(facts.join("\n"));
    return blocks.join("\n\n");
  }
  const count = output.total_is_lower_bound
    ? `at least ${String(output.total)} (the count stops there; the card's rows go past it)`
    : String(output.total);
  blocks.push(`## ${noun}: ${count}`);
  if (facts.length > 0) blocks.push(facts.join("\n"));
  blocks.push(renderCard(output.card));
  if (output.guidance !== undefined) blocks.push(`> ${output.guidance}`);
  return blocks.join("\n\n");
}

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

function renderEnrichResult(row: EnrichResultRow): string {
  const input = Object.entries(row.input)
    .map(([key, value]) => `${key}=${oneLine(value)}`)
    .join(", ");
  const facts: string[] = [oneLine(row.status)];
  if (row.confidence !== undefined) facts.push(`confidence ${oneLine(row.confidence)}`);
  if (row.matched_on !== undefined) facts.push(`matched on ${oneLine(row.matched_on)}`);
  if (row.match_id !== undefined) facts.push(`match_id \`${oneLine(row.match_id)}\``);
  if (row.alternates > 0) facts.push(`${String(row.alternates)} alternates`);
  if (row.unresolved.length > 0) facts.push(`unresolved: ${row.unresolved.map(oneLine).join(", ")}`);
  if (row.failed.length > 0) facts.push(`failed, retry: ${row.failed.map(oneLine).join(", ")}`);
  return `${String(row.index)}. ${input} → ${facts.join(" · ")}`;
}

/** The text channel of an enrich call: one line per item, then the card. */
export function renderEnrichMarkdown(output: EnrichOutput, noun: string): string {
  const matched = output.results.filter((row) => row.status === "matched").length;
  const blocks = [
    `## Results: ${String(matched)} of ${String(output.results.length)} matched`,
    output.results.map(renderEnrichResult).join("\n"),
  ];
  if (output.card === null) {
    blocks.push(`No ${noun} matched, so there's no card. That's an answer, not an error.`);
    return blocks.join("\n\n");
  }
  blocks.push(renderCard(output.card));
  if (output.guidance !== undefined) blocks.push(`> ${output.guidance}`);
  return blocks.join("\n\n");
}

/** The sentence of an enrich description that names what each result carries. */
export const ENRICH_RESULT_SENTENCE = `\`results\` has one entry per item, in order: status (${ENRICH_STATUSES.join(", ")}), match_id, confidence (${ENRICH_CONFIDENCES.join(", ")}), matched_on, alternates, unresolved, failed.`;
