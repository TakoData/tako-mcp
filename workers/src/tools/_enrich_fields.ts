/**
 * The fields of the company and people list cards that the enrichment tools
 * return.
 *
 * Each tool description is built from these lists, so the description can't
 * disagree with them. The field names and their order come from the enums the
 * OpenAPI spec publishes (`CompanyListField`, `PersonListField` and their
 * preview, card-only and premium subsets), which the Tako monorepo builds from
 * the cards' own constants. Only the card labels are written here, and each
 * label map is typed against its enum: a field the API adds or drops fails
 * `npm run typecheck` on the spec sync until its label is added or removed.
 * `scripts/smoke.ts` also fetches one card of each kind after a deploy and
 * fails when the API's columns differ.
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
  /** Every column in display order, as `[field key, card label]`. */
  readonly columns: ReadonlyArray<readonly [Key, string]>;
  /** The columns of the markdown table in the card's `description`. */
  readonly preview: ReadonlyArray<Key>;
  /** Columns the card shows and `tako_contents` rows leave out. */
  readonly cardOnly: ReadonlyArray<Key>;
  /** Columns withheld until `tako_contents` is called with `premium: true`. */
  readonly premium: ReadonlyArray<Key>;
}

/** The label each card column carries, in the table of its `description`. */
const COMPANY_LABELS: Record<CompanyListField, string> = {
  name: "Name",
  status: "Status",
  company_type: "Company type",
  estimated_revenue: "Estimated revenue",
  headcount: "Headcount",
  linkedin_followers: "LinkedIn followers",
  industry: "Industry",
  funding_stage: "Funding stage",
  total_raised: "Total raised",
  last_funding_date: "Last funding date",
  investors: "Investors",
  location: "Location",
  website: "Website",
  linkedin_url: "LinkedIn",
  ticker: "Ticker",
  established: "Established",
  parent: "Parent",
  subsidiaries: "Subsidiaries",
  description: "Description",
  headcount_range: "Headcount range",
  tags: "Tags",
  metro: "Metro",
  naics_codes: "NAICS codes",
  postcode: "Postcode",
  funding_round_count: "Funding round count",
  funding_rounds: "Funding rounds",
  sic_codes: "SIC codes",
  also_known_as: "Also known as",
  other_domains: "Other domains",
  street_address: "Street address",
  twitter_url: "X (Twitter)",
  facebook_url: "Facebook",
  sources: "Sources",
  tako_url: "Tako link",
};

export const COMPANY_LIST_FIELDS: ListCardFields<CompanyListField> = {
  record: "company",
  columns: CompanyListField.options.map((key) => [key, COMPANY_LABELS[key]] as const),
  preview: CompanyListPreviewField.options,
  cardOnly: CompanyListCardOnlyField.options,
  premium: CompanyListPremiumField.options,
};

const PERSON_LABELS: Record<PersonListField, string> = {
  name: "Name",
  title: "Title",
  department: "Department",
  seniority: "Seniority",
  employer: "Employer",
  schools: "Schools",
  in_role_since: "In role since",
  location: "Location",
  registry_companies: "Registry companies",
  linkedin_url: "LinkedIn",
  work_email: "Work email",
  phone: "Phone",
  personal_email: "Personal email",
  description: "Description",
  education: "Education",
  experience: "Work history",
  registry_seats: "Registry seats",
  sub_role: "Sub-role",
  business_area: "Business area",
  occupation: "Occupation",
  job_summary: "Job summary",
  skills: "Skills",
  industry: "Industry",
  metro: "Metro",
  job_verified_on: "Job verified on",
  twitter_url: "X (Twitter)",
  github_url: "GitHub",
  all_emails: "All emails",
  all_personal_emails: "All personal emails",
  employer_industry: "Employer industry",
  employer_tako_industries: "Employer Tako industries",
  employer_tags: "Employer tags",
  employer_size: "Employer size",
  employer_funding_stage: "Employer funding stage",
  employer_founded: "Employer founded",
  employer_location: "Employer location",
  employer_listing: "Employer listing",
  sources: "Sources",
  tako_url: "Tako link",
};

export const PERSON_LIST_FIELDS: ListCardFields<PersonListField> = {
  record: "person",
  columns: PersonListField.options.map((key) => [key, PERSON_LABELS[key]] as const),
  preview: PersonListPreviewField.options,
  cardOnly: PersonListCardOnlyField.options,
  premium: PersonListPremiumField.options,
};

/** The header of the markdown table in the card's `description`, in order. */
export function previewLabels(fields: ListCardFields): string[] {
  const shown = new Set<string>(fields.preview);
  return fields.columns.filter(([key]) => shown.has(key)).map(([, label]) => label);
}

/** The `columns` that `tako_contents` returns for the card's rows, in order. */
export function rowColumns(fields: ListCardFields): string[] {
  const cardOnly = new Set<string>(fields.cardOnly);
  return fields.columns.map(([key]) => key).filter((key) => !cardOnly.has(key));
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
  const preview = new Set<string>(fields.preview);
  const cardOnly = new Set<string>(fields.cardOnly);
  const mark = (key: string): string => (premium.has(key) ? `${key}${PREMIUM_MARK}` : key);
  const keys = fields.columns.map(([key]) => key);
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
