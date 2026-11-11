/**
 * The fields of the company and people list cards that the enrichment tools
 * return.
 *
 * Each tool description is built from these lists, so the description can't
 * disagree with them. The field names and their order come from the enums the
 * OpenAPI spec publishes (`CompanyListField`, `PersonListField` and their
 * preview, card-only and premium subsets), which the Tako monorepo builds from
 * the cards' own constants. Only the labels of the preview table are written
 * here, and each label map is typed against its preview enum: a preview field
 * the API adds or drops fails `npm run typecheck` until its label is added or
 * removed. `scripts/smoke.ts` also fetches one card of each kind after a
 * deploy and fails when the API's columns differ.
 *
 * A spec sync that adds or drops any list field changes the descriptions'
 * field sentences, so `registry:gen` and `registry:check` fail on it and the
 * sync bot commits no regenerated code, unrelated schema changes included.
 * `AGENTS.md` ("Enrichment field lists") has the steps to finish that sync.
 *
 * `_`-prefixed so `gen-registry.ts` skips it: this isn't a tool module.
 */

import {
  CompanyListCardOnlyField,
  CompanyListField,
  CompanyListPremiumField,
  CompanyListPreviewField,
  PersonListCardOnlyField,
  PersonListField,
  PersonListPremiumField,
  PersonListPreviewField,
} from "../generated/schemas.js";

/** A list card's columns, and where each one reaches the model. */
export interface ListCardFields<Key extends string = string> {
  /** One row's noun, as the description names it. */
  readonly record: string;
  /** Every column, in display order. */
  readonly columns: ReadonlyArray<Key>;
  /** The columns of the markdown table in the card's `description`, in order, as `[field key, label]`. */
  readonly preview: ReadonlyArray<readonly [Key, string]>;
  /** Columns the card shows and `tako_contents` rows leave out. */
  readonly cardOnly: ReadonlyArray<Key>;
  /** Columns withheld until `tako_contents` is called with `premium: true`. */
  readonly premium: ReadonlyArray<Key>;
}

/** The header of the table in the card's `description`, one label per preview field. */
const COMPANY_PREVIEW_LABELS: Record<CompanyListPreviewField, string> = {
  name: "Name",
  status: "Status",
  estimated_revenue: "Estimated revenue",
  headcount: "Headcount",
  industry: "Industry",
  funding_stage: "Funding stage",
  total_raised: "Total raised",
  last_funding_date: "Last funding date",
  investors: "Investors",
  location: "Location",
  website: "Website",
  tako_url: "Tako link",
};

export const COMPANY_LIST_FIELDS: ListCardFields<CompanyListField> = {
  record: "company",
  columns: CompanyListField.options,
  preview: CompanyListPreviewField.options.map((key) => [key, COMPANY_PREVIEW_LABELS[key]] as const),
  cardOnly: CompanyListCardOnlyField.options,
  premium: CompanyListPremiumField.options,
};

const PERSON_PREVIEW_LABELS: Record<PersonListPreviewField, string> = {
  name: "Name",
  title: "Title",
  department: "Department",
  employer: "Employer",
  schools: "Schools",
  in_role_since: "In role since",
  location: "Location",
  linkedin_url: "LinkedIn",
  work_email: "Work email",
  phone: "Phone",
  personal_email: "Personal email",
  tako_url: "Tako link",
};

export const PERSON_LIST_FIELDS: ListCardFields<PersonListField> = {
  record: "person",
  columns: PersonListField.options,
  preview: PersonListPreviewField.options.map((key) => [key, PERSON_PREVIEW_LABELS[key]] as const),
  cardOnly: PersonListCardOnlyField.options,
  premium: PersonListPremiumField.options,
};

/** The header of the markdown table in the card's `description`, in order. */
export function previewLabels(fields: ListCardFields): string[] {
  return fields.preview.map(([, label]) => label);
}

/** The `columns` that `tako_contents` returns for the card's rows, in order. */
export function rowColumns(fields: ListCardFields): string[] {
  const cardOnly = new Set<string>(fields.cardOnly);
  return fields.columns.filter((key) => !cardOnly.has(key));
}

/** How a premium field is marked in a description's field list. */
export const PREMIUM_MARK = "*";

const GROUP_MIN = 3;

/**
 * Join field keys with commas, writing a run of at least three neighbours
 * that share a `prefix_` once, as `prefix_{a, b, c}`. A description has a
 * hard character budget, and the people card's eight `employer_` fields
 * would spend a tenth of it on the prefix.
 */
export function joinFieldKeys(keys: readonly string[], mark: (key: string) => string): string {
  const prefixOf = (key: string): string => key.slice(0, key.indexOf("_") + 1);
  const parts: string[] = [];
  let start = 0;
  while (start < keys.length) {
    const prefix = prefixOf(keys[start] ?? "");
    let end = start + 1;
    while (prefix !== "" && end < keys.length && prefixOf(keys[end] ?? "") === prefix) end += 1;
    const run = keys.slice(start, end);
    if (run.length >= GROUP_MIN) {
      parts.push(`${prefix}{${run.map((key) => mark(key).slice(prefix.length)).join(", ")}}`);
    } else {
      parts.push(...run.map(mark));
    }
    start = end;
  }
  return parts.join(", ");
}

/**
 * The sentences of a tool description that say which fields the tool returns:
 * the ones in its own result, the ones `tako_contents` adds, and the premium
 * ones.
 */
export function describeListFields(fields: ListCardFields): string {
  const premium = new Set<string>(fields.premium);
  const preview = new Set<string>(fields.preview.map(([key]) => key));
  const cardOnly = new Set<string>(fields.cardOnly);
  const mark = (key: string): string => (premium.has(key) ? `${key}${PREMIUM_MARK}` : key);
  const keys = fields.columns;
  const previewed = keys.filter((key) => preview.has(key));
  const dropped = previewed.filter((key) => cardOnly.has(key));
  const added = keys.filter((key) => !preview.has(key) && !cardOnly.has(key));
  const except = dropped.length > 0 ? ` except ${dropped.join(" and ")}` : "";
  return [
    `Card \`description\` previews 10 rows: ${joinFieldKeys(previewed, mark)}.`,
    `\`tako_contents\` on its \`url\` returns every row: those fields${except}, plus ${joinFieldKeys(added, mark)}.`,
    `${PREMIUM_MARK} is premium: null unless that call sets \`premium: true\`.`,
  ].join(" ");
}
