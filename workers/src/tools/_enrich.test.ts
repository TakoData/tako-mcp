import { describe, expect, it } from "vitest";

import { DjangoBadRequestError, DjangoHttpError, DjangoTimeoutError } from "../django.js";
import type { Env } from "../env.js";
import { djangoErrorToToolResult } from "../mcp.js";
import {
  alignEnrichResults,
  ENRICH_ENDPOINTS,
  enrichErrorGuidance,
  projectEnrichCard,
  withToolNames,
} from "./_enrich.js";
import { WITHHELD_CELLS_GUIDANCE } from "./_search_results.js";
import { noopSendProgress } from "./__test_helpers.js";
import type { ToolContext } from "./types.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = { token: "sk-test", env: ENV, sendProgress: noopSendProgress, surface: "generic" };
const PATH = "/api/v1/companies/search";

const badRequest = (body: unknown): DjangoBadRequestError =>
  new DjangoBadRequestError({ path: PATH, method: "POST", body: JSON.stringify(body) });
const httpError = (status: number, body: unknown): DjangoHttpError =>
  new DjangoHttpError({ path: PATH, method: "POST", status, body: JSON.stringify(body) });

describe("enrichErrorGuidance", () => {
  const unknownIndustry = {
    error_message: "No Tako industry matches 'fintek'",
    error_type: "BAD_REQUEST",
    code: "unknown_industry",
    field: "industry",
    suggestions: ["fintech", "financial_services"],
  };

  it("names the field, the code, the message and the suggestions of a 400", () => {
    const text = enrichErrorGuidance(badRequest(unknownIndustry), undefined);
    expect(text).toBe(
      "Tako can't run `industry` (unknown_industry): No Tako industry matches 'fintek'. Closest values: fintech, financial_services. Fix the input and call again.",
    );
  });

  it("adds what the default mapping has no place for: the field, the code and the suggestions", () => {
    const bare = djangoErrorToToolResult(badRequest(unknownIndustry)).content[0]?.text ?? "";
    expect(bare).toBe(`Django returned 400 for POST ${PATH}: No Tako industry matches 'fintek'`);
    const err = badRequest(unknownIndustry);
    err.modelGuidance = enrichErrorGuidance(err, undefined) ?? "";
    const text = djangoErrorToToolResult(err).content[0]?.text ?? "";
    expect(text).toContain("`industry`");
    expect(text).toContain("No Tako industry matches 'fintek'");
    expect(text).toContain("fintech, financial_services");
  });

  it("speaks of the whole request when a 400 names no field", () => {
    const text = enrichErrorGuidance(
      badRequest({ error_message: "Set at least one filter.", code: "no_filters", field: "", suggestions: [] }),
      undefined,
    );
    expect(text).toBe("Tako can't run this request (no_filters): Set at least one filter. Fix the input and call again.");
  });

  it("names the tool for a REST call only on a connection that registers it", () => {
    const body = {
      error_message: "To look people up by email, use POST /api/v1/people/enrich.",
      code: "contacts_need_a_filter",
      field: "emails",
    };
    expect(enrichErrorGuidance(badRequest(body), new Set(["tako_person_enrich"]))).toContain(
      "use `tako_person_enrich`.",
    );
    const without = enrichErrorGuidance(badRequest(body), new Set(["tako_people_search"]));
    expect(without).toContain("use a person match.");
    expect(without).not.toContain("/api/v1");
    expect(enrichErrorGuidance(badRequest(body), undefined)).not.toContain("tako_person_enrich");
  });

  it("tells the model a 403 won't clear on a retry", () => {
    const message = "Your account doesn't have access to People Data Labs data, which these endpoints serve.";
    expect(enrichErrorGuidance(httpError(403, { error_message: message, error_type: "FORBIDDEN" }), undefined)).toBe(
      `${message} This connection can't use the tool, so don't retry it; tell the user.`,
    );
  });

  it("leaves every other error to the default mapping", () => {
    expect(enrichErrorGuidance(badRequest({ detail: "Malformed" }), undefined)).toBeUndefined();
    expect(enrichErrorGuidance(httpError(429, { error_message: "Slow down", error_type: "RATE_LIMIT_EXCEEDED" }), undefined)).toBeUndefined();
    expect(
      enrichErrorGuidance(httpError(503, { error_message: "Narrow the filters.", error_type: "SERVICE_UNAVAILABLE" }), undefined),
    ).toBeUndefined();
    expect(
      enrichErrorGuidance(
        new DjangoHttpError({ path: PATH, method: "POST", status: 403, body: "<html>blocked</html>" }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      enrichErrorGuidance(new DjangoTimeoutError({ path: PATH, method: "POST", timeoutMs: 1 }), undefined),
    ).toBeUndefined();
  });
});

describe("withToolNames", () => {
  it("rewrites the call of every enrichment endpoint, and the contents call", () => {
    const calls = [...Object.values(ENRICH_ENDPOINTS), "/api/v1/contents"].map((path) => `POST ${path}`);
    expect(calls).toHaveLength(5);
    const registered = new Set([...Object.keys(ENRICH_ENDPOINTS), "tako_contents"]);
    expect(withToolNames(calls.join(", "), registered)).toBe(
      "`tako_company_search`, `tako_people_search`, `tako_company_enrich`, `tako_person_enrich`, `tako_contents`",
    );
    expect(withToolNames(calls.join(", "), new Set())).not.toMatch(/\/api\/|tako_/);
  });

  it("leaves a message with no REST call alone", () => {
    expect(withToolNames("town needs country or region beside it", new Set())).toBe(
      "town needs country or region beside it",
    );
  });
});

const wireCard = (content: Record<string, unknown> | null = { cost: 0.01, total_rows: 40 }) => ({
  card_id: "abc",
  title: "Series B fintechs in New York",
  description: "40 companies match.\n\n| Name | Status |\n| --- | --- |\n| Acme | Active |",
  webpage_url: "https://tako.com/card/abc/",
  embed_url: "https://tako.com/embed/abc/",
  exportable: true,
  sources: [{ source_name: "People Data Labs" }],
  relevance: "High",
  content,
});

describe("projectEnrichCard", () => {
  it("keeps the title, table, url, row count and source, and nothing else", () => {
    expect(projectEnrichCard("tako_company_search", wireCard(), CTX)).toEqual({
      card: {
        exportable: true,
        title: "Series B fintechs in New York",
        description: "40 companies match.\n\n| Name | Status |\n| --- | --- |\n| Acme | Active |",
        url: "https://tako.com/card/abc/",
        total_rows: 40,
        source: "People Data Labs",
      },
    });
  });

  it("keeps a null card null", () => {
    expect(projectEnrichCard("tako_company_search", null, CTX)).toEqual({ card: null });
    expect(projectEnrichCard("tako_company_enrich", undefined, CTX)).toEqual({ card: null });
  });

  it("says how to get withheld premium cells, only where tako_contents is registered", () => {
    const withheld = wireCard({ total_rows: 40, premium: false, premium_rows: { company_record: 16 } });
    const registered: ToolContext = { ...CTX, registeredTools: new Set(["tako_company_search", "tako_contents"]) };
    expect(projectEnrichCard("tako_company_search", withheld, registered).guidance).toBe(WITHHELD_CELLS_GUIDANCE);
    const alone: ToolContext = { ...CTX, registeredTools: new Set(["tako_company_search"]) };
    expect(projectEnrichCard("tako_company_search", withheld, alone).guidance).toBeUndefined();
    expect(projectEnrichCard("tako_company_search", wireCard(), registered).guidance).toBeUndefined();
  });

  it("fails on a card that isn't a card", () => {
    expect(() => projectEnrichCard("tako_company_search", { title: 7 }, CTX)).toThrow(/unexpected shape/);
  });
});

describe("alignEnrichResults", () => {
  const wire = (status: string, extra: Record<string, unknown> = {}) => ({
    status, alternates: 0, unresolved: [], failed: [], ...extra,
  });

  it("gives each result its position and the item as sent", () => {
    const rows = alignEnrichResults(
      "tako_company_enrich",
      [{ domain: "stripe.com" }, { name: "Nope Co", country: "US", city: null }],
      [
        wire("matched", { match_id: "co_1", confidence: "exact", matched_on: "domain" }),
        wire("no_match", { match_id: null, confidence: null, unresolved: ["name=Nope Co"] }),
      ],
    );
    expect(rows).toEqual([
      {
        index: 0, input: { domain: "stripe.com" }, status: "matched", match_id: "co_1", confidence: "exact",
        matched_on: "domain", alternates: 0, unresolved: [], failed: [],
      },
      {
        index: 1, input: { name: "Nope Co", country: "US" }, status: "no_match", alternates: 0,
        unresolved: ["name=Nope Co"], failed: [],
      },
    ]);
  });

  it("fails when the counts differ, since positions are all that ties a result to an item", () => {
    expect(() =>
      alignEnrichResults("tako_company_enrich", [{ domain: "a.com" }, { domain: "b.com" }], [wire("matched")]),
    ).toThrow(/unexpected shape/);
  });
});
