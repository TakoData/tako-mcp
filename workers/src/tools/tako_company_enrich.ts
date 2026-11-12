/**
 * `tako_company_enrich`: match companies the caller already names, behind
 * `?tools=contents,company_enrich` on `/mcp`. `tako_contents` fetches the rows of the
 * card this tool returns, so a connection needs both.
 *
 * Wraps `POST /api/v1/companies/enrich`. `items` is the generated request
 * field, so the item shape and the 25-item limit come from the API.
 */
import { z } from "zod";

import { CompanyEnrichRequest, CompanyEnrichResponse } from "../generated/schemas.js";
import {
  alignEnrichResults,
  ENRICH_RESULT_SENTENCE,
  enrichOutputShape,
  postEnrich,
  projectEnrichCard,
  enrichFieldSentences,
} from "./_enrich.js";
import { looseArray } from "./_loose_array.js";
import { renderEnrichMarkdown } from "./_render_markdown.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Match up to 25 known companies by website, LinkedIn page or name. Returns per-item `results` and one list card of matches.",
  "",
  "Use to look up companies you can name, such as a list of domains.",
  "",
  `${ENRICH_RESULT_SENTENCE} ${enrichFieldSentences("tako_company_enrich")}`,
].join("\n");

const inputSchema = z
  .object({
    items: looseArray(
      CompanyEnrichRequest.shape.items.describe(
        "The companies to match, 1 to 25. Each needs `id` (a co_ id or Tako link; other fields are then ignored), `domain`, `linkedin_url` or `name`. All but `name` match exactly; `name` matches by score. `city`, `region`, `country` and `industry` rank a name's matches and never exclude one.",
      ),
      { field: "tako_company_enrich.items", jsonObjectAsItem: true },
    ),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;

const outputSchema = enrichOutputShape;
type Output = z.infer<typeof outputSchema>;

/** The request body: the items, and never a contents field. */
export function buildCompanyEnrichBody(input: Input): z.input<typeof CompanyEnrichRequest> {
  return { items: input.items } satisfies z.input<typeof CompanyEnrichRequest>;
}

const tako_company_enrich = {
  name: "tako_company_enrich",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Company Enrich",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  fixedInputs: [],
  async handler(input: Input, ctx): Promise<Output> {
    const wire = await postEnrich(
      "tako_company_enrich",
      buildCompanyEnrichBody(input),
      CompanyEnrichResponse,
      ctx,
    );
    return {
      results: alignEnrichResults("tako_company_enrich", input.items, wire.results),
      ...projectEnrichCard("tako_company_enrich", wire.card, ctx),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderEnrichMarkdown(output as Output, "company");
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_company_enrich;
