/**
 * `tako_company_search`: screen companies by filters, behind
 * `?tools=contents,company_search` on `/mcp`. `tako_contents` fetches the rows of the
 * card this tool returns, so a connection needs both.
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
  postEnrich,
  projectEnrichCard,
  enrichFieldSentences,
} from "./_enrich.js";
import { optionalWithoutDefaults } from "./_optional_without_defaults.js";
import { renderListSearchMarkdown } from "./_render_markdown.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Screen active companies by industry, place, size, founding year, funding stage and ownership. Returns `total`, the filters `applied`, `notes` and one list card.",
  "",
  "Use to build a list of companies from filters, such as Series B enterprise SaaS companies in the US.",
  "",
  `${enrichFieldSentences("tako_company_search")} \`total\` stops at 500, and \`total_is_lower_bound\` says when. It can't filter or sort by revenue.`,
].join("\n");

const requestShape = CompanySearchRequest.omit(CONTENTS_FIELDS).shape;

// Only what the generated description can't say: `industry` replaces a REST
// call the model can't make, and the other three have no generated text.
const DESCRIBES = {
  industry: "An industry name, alias or id, such as fintech or aerospace and defense. `applied` shows what it was read as.",
  ownership: "Publicly traded or privately held.",
  founded_after: "Founded in this year or later.",
  founded_before: "Founded in this year or earlier.",
} satisfies Partial<Record<keyof typeof requestShape, string>>;

const inputSchema = z
  .object(
    optionalWithoutDefaults(requestShape, DESCRIBES, {
      tool: "tako_company_search",
      fields: { funding_stages: { commaSeparated: true } },
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
