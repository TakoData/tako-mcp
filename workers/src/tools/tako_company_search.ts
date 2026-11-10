/**
 * `tako_company_search`: screen companies by filters, behind
 * `?tools=company_search` on `/mcp`.
 *
 * Wraps `POST /api/v1/companies/search`. The input is the generated
 * `CompanySearchRequest` without the contents fields (see `_enrich.ts`), so a
 * backend filter reaches this tool through the schema sync and a renamed one
 * fails to compile. The description's field list is built from
 * `_enrich_fields.ts`.
 */
import { z } from "zod";

import { CompanySearchRequest, CompanySearchResponse } from "../generated/schemas.js";
import {
  companySearchOutputShape,
  CONTENTS_FIELDS,
  givenFields,
  optionalWithoutDefaults,
  postEnrich,
  projectEnrichCard,
  renderListSearchMarkdown,
} from "./_enrich.js";
import { COMPANY_LIST_FIELDS, describeListFields } from "./_enrich_fields.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Screen active companies by industry, place, size, founding year, funding stage and ownership. Returns `total`, the filters `applied`, `notes` and one list card.",
  "",
  "Use to build a list of companies from filters, such as Series B enterprise SaaS companies in the US.",
  "",
  `${describeListFields(COMPANY_LIST_FIELDS)} \`total\` stops at 500, and \`total_is_lower_bound\` says when. It can't filter or sort by revenue.`,
].join("\n");

const requestShape = CompanySearchRequest.omit(CONTENTS_FIELDS).shape;

const DESCRIBES = {
  min_employees: "Fewest employees, on People Data Labs' estimate.",
  max_employees: "Most employees, on People Data Labs' estimate.",
  industry: "An industry name, alias or id, such as fintech or aerospace and defense. `applied` shows what it was read as.",
  ownership: "Publicly traded or privately held.",
  startups:
    "Startups only: private companies founded in the last ten years (unless the founded filters name other years), of a startup type, that raised a venture round or have at most 500 employees.",
  founded_after: "Founded in this year or later.",
  founded_before: "Founded in this year or earlier.",
} satisfies Partial<Record<keyof typeof requestShape, string>>;

const inputSchema = z
  .object(
    optionalWithoutDefaults("tako_company_search", requestShape, DESCRIBES, {
      funding_stages: { commaSeparated: true },
    }),
  )
  .strict();
type Input = z.infer<typeof inputSchema>;

const outputSchema = companySearchOutputShape;
type Output = z.infer<typeof outputSchema>;

/** The request body: the filters the caller set, and never a contents field. */
export function buildCompanySearchBody(input: Input): z.input<typeof CompanySearchRequest> {
  return givenFields(input) satisfies z.input<typeof CompanySearchRequest>;
}

const tako_company_search = {
  name: "tako_company_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Company Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  fixedInputs: [],
  async handler(input: Input, ctx): Promise<Output> {
    const wire = await postEnrich(
      "tako_company_search",
      "/api/v1/companies/search",
      buildCompanySearchBody(input),
      CompanySearchResponse,
      ctx,
    );
    return {
      total: wire.total,
      total_is_lower_bound: wire.total_is_lower_bound,
      applied: wire.applied,
      notes: wire.notes,
      ...projectEnrichCard("tako_company_search", wire.card, ctx),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderListSearchMarkdown(output as Output, "companies");
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_company_search;
