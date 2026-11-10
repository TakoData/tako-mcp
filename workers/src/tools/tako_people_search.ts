/**
 * `tako_people_search`: screen employees by role, place and employer, behind
 * `?tools=people_search` on `/mcp`.
 *
 * Wraps `POST /api/v1/people/search`. The input is the generated
 * `PersonSearchRequest` without the contents fields (see `_enrich.ts`), and
 * the description's field list is built from `_enrich_fields.ts`.
 */
import { z } from "zod";

import { PersonSearchRequest, PersonSearchResponse } from "../generated/schemas.js";
import {
  CONTENTS_FIELDS,
  givenFields,
  optionalWithoutDefaults,
  peopleSearchOutputShape,
  postEnrich,
  projectEnrichCard,
  renderListSearchMarkdown,
} from "./_enrich.js";
import { describeListFields, PERSON_LIST_FIELDS } from "./_enrich_fields.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Screen employees by role, place and employer. Returns `total`, the filters `applied`, `notes`, `unresolved`, `failed` and one list card.",
  "",
  "Use to build a list of people from filters, such as heads of sales at Series B startups in Texas.",
  "",
  `${describeListFields(PERSON_LIST_FIELDS)} \`total\` stops at 500, and \`total_is_lower_bound\` says when.`,
].join("\n");

const requestShape = PersonSearchRequest.omit(CONTENTS_FIELDS).shape;

const CONTACT_RULE = "It narrows a search, so set another filter beside it.";

const DESCRIBES = {
  company_ids: "Employer ids, such as the `match_id` of a matched company.",
  person_country: "Where the person is: ISO 3166-1 alpha-2 code or English name.",
  person_region: "Where the person is: state or province.",
  person_metro: "Where the person is: metropolitan area.",
  person_town: "Where the person is: town. Needs person_country or person_region beside it.",
  company_industry: "The employer's industry: a name, alias or id, such as fintech. `applied` shows what it was read as.",
  company_min_employees: "The employer's fewest employees.",
  company_max_employees: "The employer's most employees.",
  company_startups: "Employers that are startups only.",
  linkedin_urls: `LinkedIn profile URLs. ${CONTACT_RULE}`,
  emails: `Email addresses. ${CONTACT_RULE}`,
  phones: `Phone numbers. ${CONTACT_RULE}`,
} satisfies Partial<Record<keyof typeof requestShape, string>>;

// Only the closed enum splits on commas: a role phrase, a domain list a host
// joined itself, or an address can hold one.
const inputSchema = z
  .object(
    optionalWithoutDefaults("tako_people_search", requestShape, DESCRIBES, {
      role: {},
      company_ids: {},
      company_domains: {},
      company_funding_stages: { commaSeparated: true },
      linkedin_urls: {},
      emails: {},
      phones: {},
    }),
  )
  .strict();
type Input = z.infer<typeof inputSchema>;

const outputSchema = peopleSearchOutputShape;
type Output = z.infer<typeof outputSchema>;

/** The request body: the filters the caller set, and never a contents field. */
export function buildPeopleSearchBody(input: Input): z.input<typeof PersonSearchRequest> {
  return givenFields(input) satisfies z.input<typeof PersonSearchRequest>;
}

const tako_people_search = {
  name: "tako_people_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: People Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  fixedInputs: [],
  async handler(input: Input, ctx): Promise<Output> {
    const wire = await postEnrich(
      "tako_people_search",
      "/api/v1/people/search",
      buildPeopleSearchBody(input),
      PersonSearchResponse,
      ctx,
    );
    return {
      total: wire.total,
      total_is_lower_bound: wire.total_is_lower_bound,
      applied: wire.applied,
      notes: wire.notes,
      unresolved: wire.unresolved,
      failed: wire.failed,
      ...projectEnrichCard("tako_people_search", wire.card, ctx),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderListSearchMarkdown(output as Output, "people");
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_people_search;
