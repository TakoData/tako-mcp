/**
 * `tako_person_enrich`: match people the caller already names, behind
 * `?tools=person_enrich` on `/mcp`.
 *
 * Wraps `POST /api/v1/people/enrich`. `items` is the generated request field,
 * so the item shape and the 25-item limit come from the API.
 */
import { z } from "zod";

import { PersonEnrichRequest, PersonEnrichResponse } from "../generated/schemas.js";
import {
  alignEnrichResults,
  ENRICH_RESULT_SENTENCE,
  enrichOutputShape,
  postEnrich,
  projectEnrichCard,
  renderEnrichMarkdown,
} from "./_enrich.js";
import { describeListFields, PERSON_LIST_FIELDS } from "./_enrich_fields.js";
import { looseArray } from "./_loose_array.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION = [
  "Match up to 25 known people by email, phone, LinkedIn profile or name. Returns per-item `results` and one list card of matches.",
  "",
  "Use to look up known people, such as a contact list.",
  "",
  `${ENRICH_RESULT_SENTENCE} ${describeListFields(PERSON_LIST_FIELDS)}`,
].join("\n");

const inputSchema = z
  .object({
    items: looseArray(
      PersonEnrichRequest.shape.items.describe(
        "The people to match, 1 to 25. Each needs `email`, `phone`, `linkedin_url` or `name`. The first three match exactly, and `name` by score. `company_domain`, `company_name` and `title` are hints for a name. Give a phone with its country code.",
      ),
      { field: "tako_person_enrich.items", jsonObjectAsItem: true },
    ),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;

const outputSchema = enrichOutputShape;
type Output = z.infer<typeof outputSchema>;

/** The request body: the items, and never a contents field. */
export function buildPersonEnrichBody(input: Input): z.input<typeof PersonEnrichRequest> {
  return { items: input.items } satisfies z.input<typeof PersonEnrichRequest>;
}

const tako_person_enrich = {
  name: "tako_person_enrich",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Person Enrich",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  fixedInputs: [],
  async handler(input: Input, ctx): Promise<Output> {
    const wire = await postEnrich(
      "tako_person_enrich",
      "/api/v1/people/enrich",
      buildPersonEnrichBody(input),
      PersonEnrichResponse,
      ctx,
    );
    return {
      results: alignEnrichResults("tako_person_enrich", input.items, wire.results),
      ...projectEnrichCard("tako_person_enrich", wire.card, ctx),
    };
  },
  renderText(output, _ctx) {
    void _ctx;
    return renderEnrichMarkdown(output as Output, "person");
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_person_enrich;
