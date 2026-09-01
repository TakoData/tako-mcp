/**
 * Unit tests for `slimCardContent` — the inline-preview row cap.
 *
 * The cap must keep the MOST-RECENT rows regardless of backend sort order:
 * timeseries cards arrive ascending (newest last), stock cards descending
 * (newest first). A blind tail slice drops the latest value on stock cards —
 * the correctness bug these tests pin. Also covers the json_records slice branch
 * and the CSV content_format guard (both previously untested).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_REGISTRY } from "./_registry.js";

import { ContentItem } from "../generated/schemas.js";

import tako_search from "./tako_search.js";
import tako_search_advanced from "./tako_search_advanced.js";
import { searchAdvancedOutputShape } from "./_render_markdown.js";

import {
  BOTH_SOURCES_ARG,
  CONTENT_META_KEYS,
  CONTENT_PAYLOAD_KEYS,
  buildDataGapGuidance,
  buildReferenceMaps,
  buildSearchOutput,
  orderCardsByUsefulness,
  projectCard,
  projectCardRows,
  projectWebResult,
  slimCardContent,
  strictPinGuidance,
} from "./_search_results.js";
import type {
  ResultContent,
  SearchedSources,
  SearchToolName,
  TakoCard,
  WebResult,
} from "./_search_results.js";

import type { Env } from "../env.js";

// json_compact dataset with a declared temporal column at index 0.
const dataset = (rows: unknown[][]): ResultContent =>
  ({
    content_format: "json_compact",
    cost: 0.001,
    total_rows: rows.length,
    truncated: false,
    dataset: {
      columns: [
        { name: "t", type: "datetime" },
        { name: "v", type: "number" },
      ],
      rows,
    },
  }) as unknown as ResultContent;

const rowsOf = (c: ResultContent | null | undefined): unknown[][] =>
  ((c as { dataset?: { rows?: unknown[][] } } | null | undefined)?.dataset?.rows ?? []) as unknown[][];

describe("slimCardContent — dataset ordering", () => {
  it("keeps the newest rows (tail) for an ASCENDING timeseries card", () => {
    const rows = [
      ["2024-01-01", 1],
      ["2024-01-02", 2],
      ["2024-01-03", 3],
      ["2024-01-04", 4],
    ];
    const out = slimCardContent(dataset(rows), 2);
    // Ascending → newest at the tail.
    expect(rowsOf(out)).toEqual([
      ["2024-01-03", 3],
      ["2024-01-04", 4],
    ]);
    expect((out as { truncated?: boolean }).truncated).toBe(true);
  });

  it("keeps the newest rows (head) for a DESCENDING stock card — retains the latest value", () => {
    // Stock cards are newest-first. A tail slice would drop 2024-01-04 (latest).
    const rows = [
      ["2024-01-04", 40], // newest / latest price
      ["2024-01-03", 30],
      ["2024-01-02", 20],
      ["2024-01-01", 10],
    ];
    const out = slimCardContent(dataset(rows), 2);
    expect(rowsOf(out)).toEqual([
      ["2024-01-04", 40],
      ["2024-01-03", 30],
    ]);
    // The latest value survives the cap.
    expect(rowsOf(out)[0]).toEqual(["2024-01-04", 40]);
  });

  it("falls back to the tail when the temporal column has no date signal", () => {
    // Non-date labels ("d0".."d3") → direction unknown → tail (back-compat).
    const rows = [
      ["d0", 0],
      ["d1", 1],
      ["d2", 2],
      ["d3", 3],
    ];
    const out = slimCardContent(dataset(rows), 2);
    expect(rowsOf(out)).toEqual([
      ["d2", 2],
      ["d3", 3],
    ]);
  });

  it("returns rows unchanged when the count is at or under the cap", () => {
    const rows = [["2024-01-01", 1]];
    const out = slimCardContent(dataset(rows), 5);
    expect(rowsOf(out)).toEqual(rows);
    expect((out as { truncated?: boolean }).truncated).toBe(false);
  });
});

describe("slimCardContent — json_records ordering", () => {
  const records = (arr: Array<Record<string, unknown>>): ResultContent =>
    ({ content_format: "json_records", cost: 0.001, total_rows: arr.length, records: arr }) as unknown as ResultContent;
  const recsOf = (c: ResultContent | null | undefined) =>
    (c as { records?: Array<Record<string, unknown>> } | null | undefined)?.records ?? [];

  it("keeps the newest records for a DESCENDING set (detects the date key)", () => {
    const arr = [
      { date: "2024-03-03", close: 3 }, // newest
      { date: "2024-03-02", close: 2 },
      { date: "2024-03-01", close: 1 },
    ];
    const out = slimCardContent(records(arr), 1);
    expect(recsOf(out)).toEqual([{ date: "2024-03-03", close: 3 }]);
  });

  it("keeps the newest records (tail) for an ASCENDING set", () => {
    const arr = [
      { date: "2024-03-01", close: 1 },
      { date: "2024-03-02", close: 2 },
      { date: "2024-03-03", close: 3 }, // newest
    ];
    const out = slimCardContent(records(arr), 1);
    expect(recsOf(out)).toEqual([{ date: "2024-03-03", close: 3 }]);
  });
});

describe("slimCardContent — CSV guard", () => {
  const csv = (text: string): ResultContent =>
    ({ content_format: "csv", cost: 0.001, data: text }) as unknown as ResultContent;
  const dataOf = (c: ResultContent | null | undefined) =>
    (c as { data?: string | null } | null | undefined)?.data ?? null;

  it("keeps the header + newest data lines instead of nulling a CSV preview (DESCENDING)", () => {
    const out = slimCardContent(csv("date,price\n2024-01-04,40\n2024-01-03,30\n2024-01-02,20\n2024-01-01,10"), 2);
    // Descending first column → newest at the head; header preserved.
    expect(dataOf(out)).toBe("date,price\n2024-01-04,40\n2024-01-03,30");
    expect((out as { truncated?: boolean }).truncated).toBe(true);
  });

  it("keeps the header + newest data lines for an ASCENDING CSV", () => {
    const out = slimCardContent(csv("date,price\n2024-01-01,10\n2024-01-02,20\n2024-01-03,30\n2024-01-04,40"), 2);
    expect(dataOf(out)).toBe("date,price\n2024-01-03,30\n2024-01-04,40");
  });

  it("returns the CSV unchanged when data lines are at or under the cap", () => {
    const text = "date,price\n2024-01-01,10";
    const out = slimCardContent(csv(text), 5);
    expect(dataOf(out)).toBe(text);
    expect((out as { truncated?: boolean }).truncated).toBe(false);
  });
});

describe("slimCardContent — drop-all mode (capRows = null)", () => {
  it("nulls every payload channel but preserves metadata", () => {
    const out = slimCardContent(dataset([["2024-01-01", 1]]), null);
    expect((out as { data?: unknown; records?: unknown; dataset?: unknown })).toMatchObject({
      data: null,
      records: null,
      dataset: null,
    });
    expect((out as { total_rows?: number }).total_rows).toBe(1);
  });
});

// `tako_search`'s call shape: no inlined rows, no web page text. Shared by the
// buildSearchOutput tests below, which exercise guidance and ordering rather
// than the `tako_search_advanced` inline path.
const OPTS = { rowCap: null, keepWebText: false, toolName: "tako_search" } as const;

describe("buildSearchOutput — zero-card guidance", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("attaches the full anti-retry protocol when cards AND web_results are both empty", () => {
    const out = buildSearchOutput([], [], "req-1", null, ENV, ["data", "web"], false, "authenticated", OPTS);
    // The load-bearing instruction: rewording does not converge and costs money.
    expect(out.guidance).toMatch(/rewording alone will not change that/i);
    expect(out.guidance).toMatch(/every retry is priced/i);
    expect(out.guidance).toMatch(/tako_available_data/);
  });

  it("still fires on zero cards WITH web_results — steering to the web fallback", () => {
    // The common default-source miss: no data card, some web hits. This is
    // exactly the "reword and retry for a chart" loop case, so guidance must
    // not be silently skipped here.
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3", null, ENV, ["data", "web"], false, "authenticated", OPTS);
    expect(out.guidance).toMatch(/web_results/);
    // The verdict is scoped to the graph, not to the whole call.
    expect(out.guidance).toMatch(/data graph does not cover this query/i);
  });

  // THE MISFIRE. This branch used to say "do NOT re-search with rephrasings"
  // flat out, which is right for hunting a data card and wrong for every
  // question whose answer is on the web: a docs or reference lookup is won by
  // re-searching per entity or per provider, and the guidance was telling the
  // model to stop after one call. The ban must name the DATA axis and the
  // carve-out must be explicit — a model reading this cannot be left to infer
  // that web refinement is still allowed.
  it("does not ban web re-searching when zero cards come back with web results", () => {
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3b", null, ENV, ["data", "web"], false, "authenticated", OPTS);
    const g = out.guidance ?? "";
    // The two-sentence rewrite keeps the MISFIRE fix by scoping: the no-reword
    // verdict names the DATA GRAPH, never the call as a whole, so nothing here
    // reads as a ban on refining a WEB query.
    expect(g).toMatch(/data graph does not cover this query/i);
    expect(g).not.toMatch(/do not re-?search/i);
    expect(g).not.toMatch(/stop calling/i);
  });

  // The mirror of buildDataGapGuidance's `searchedWebToo` fix. A web-only search
  // has zero cards by construction, so the graph verdict below would be built
  // from evidence that does not exist.
  it("renders no graph verdict for a web-only search that DID return web results", () => {
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3c", null, ENV, ["web"], false, "authenticated", OPTS);
    const g = out.guidance ?? "";
    expect(g).toMatch(/web source only/i);
    expect(g).not.toMatch(/data graph does not cover/i);
    // And none of the data-axis recovery, which does not apply to a deliberate
    // web-only narrow.
    expect(g).not.toMatch(/node_id/);
    expect(g).not.toMatch(/strict/);
    // It still names the way to GET a coverage answer, which is the cheap
    // re-ask. Derived from BOTH_SOURCES_ARG rather than retyped: the point of
    // that constant is that the advertised argument and the sendable one are
    // the same value, and a literal here would reintroduce the second copy.
    expect(g).toContain(JSON.stringify(BOTH_SOURCES_ARG.tako_search).slice(1, -1));
    expect(g).toMatch(/tako_available_data/);
  });

  it("tailors the both-empty protocol for a data-only search (web fallback allowed on the single retry)", () => {
    const out = buildSearchOutput([], [], "req-4", null, ENV, ["data"], false, "authenticated", OPTS);
    expect(out.guidance).toMatch(/tako_available_data/);
    // No web-axis carve-out here: the web was never searched, so there is no
    // empty web result to reinterpret.
    expect(out.guidance).not.toMatch(/narrower web question/);
  });

  // THE INVARIANT, checked on BOTH surfaces in one test on purpose. The answer
  // path has always allowed ONE narrower web attempt; the search path used to
  // end flatly at "stop calling Tako for this question" — same situation,
  // opposite verdict, on the most common Tako-has-nothing path, which teaches a
  // model that reads both that one of them is wrong.
  //
  // A string-identity check cannot hold this: BOTH surfaces are now capped at
  // two sentences, so each states the carve-out as a clause in its own words
  // and there is no shared constant left to compare against. Asserting each
  // side separately would let a future edit delete either wording with the
  // suite green, so both are asserted here.
  it("both zero-result surfaces permit exactly one narrower web attempt", () => {
    const search =
      buildSearchOutput([], [], "req-4b", null, ENV, ["data", "web"], false, "authenticated", OPTS)
        .guidance ?? "";
    const answer = buildDataGapGuidance(false, true, "tako_search_advanced");
    for (const [surface, g] of [
      ["search", search],
      ["answer", answer],
    ] as const) {
      // "genuinely narrower" is the phrasing BOTH carry. The nouns already
      // differ — search says "narrower web question", answer says "narrower
      // question" — which is exactly how far apart two hand-written statements
      // of one rule drift, and why the invariant is asserted rather than the
      // string.
      expect(g, `${surface} drops the narrower-web carve-out`).toMatch(/genuinely narrower/i);
      expect(g, `${surface} forbids the attempt the other surface allows`).not.toMatch(
        /do not (re-?search|try) the web/i,
      );
    }
  });

  // A web-only search that came back empty has NO data verdict to report (the
  // data source was never queried) and exactly one lever available: the query.
  // This branch used to ban that lever — "do NOT retry this query or
  // rephrasings of it" — which left the model with nothing to do at all.
  it("tells a web-only search to refine, and claims nothing about graph coverage", () => {
    const out = buildSearchOutput([], [], "req-5", null, ENV, ["web"], false, "authenticated", OPTS);
    const g = out.guidance ?? "";
    expect(g).not.toMatch(/node_id/);
    expect(g).toMatch(/refine to one entity/i);
    expect(g).toMatch(/says nothing about Tako's coverage/i);
    expect(g).not.toMatch(/rewording alone will not change/i);
  });

  it("takes the DATA-verdict branch for a data-source search", () => {
    // Was "treats the legacy tako alias as data" and keyed on /node_id/ in the
    // guidance; the alias is gone and so is the pin recipe, so pin the branch
    // by the verdict it is the only one to state.
    const out = buildSearchOutput([], [], "req-6", null, ENV, ["data"], false, "authenticated", OPTS);
    expect(out.guidance).toMatch(/tako_available_data/);
    expect(out.guidance).toMatch(/every retry is priced/i);
  });

  it("omits guidance when any card is present", () => {
    const out = buildSearchOutput([{ card_id: "c1" }], [], "req-2", null, ENV, ["data", "web"], false, "authenticated", OPTS);
    expect(out.guidance).toBeUndefined();
  });
});

/**
 * EVERY guidance branch is two sentences: the verdict (which corpora this
 * response is evidence about) and the one next action. A branch that cannot
 * survive at two sentences dies (spec: 2026-08-26-model-facing-surface-
 * redesign, "guidance" decision).
 *
 * Counted rather than eyeballed because the three answer-endpoint branches
 * were the last ones over — five to six sentences and up to 740 chars each,
 * three of them spent on anti-instructions the one action already implies.
 * A sentence budget is the only thing that stops guidance regrowing: it is
 * written mid-failure, when more advice always feels like the safe choice.
 */
describe("every guidance branch is two sentences", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
  // Abbreviations end in a period too, so a naive split over-counts. The
  // branches here contain none; if one gains one, extend this rather than
  // loosening the count.
  const sentences = (text: string): string[] =>
    text.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== "");

  const branches = (): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const [label, sources] of [
      ["search: data+web", ["data", "web"]],
      ["search: data only", ["data"]],
      ["search: web only", ["web"]],
    ] as const) {
      for (const webResults of [[], [{ url: "https://e.com" }]]) {
        const g = buildSearchOutput(
          [],
          webResults as WebResult[],
          "r",
          null,
          ENV,
          sources as unknown as SearchedSources,
          false,
          "authenticated",
          OPTS,
        ).guidance;
        if (g !== undefined) out.push([`${label} / ${webResults.length} web`, g]);
      }
    }
    out.push(["answer: data only", buildDataGapGuidance(false, false, "tako_search_advanced")]);
    out.push(["answer: web-grounded", buildDataGapGuidance(true, true, "tako_search_advanced")]);
    out.push(["answer: nothing", buildDataGapGuidance(false, true, "tako_search_advanced")]);
    out.push(["strict pin", strictPinGuidance("authenticated")]);
    return out;
  };

  it("covers every branch, so the count cannot pass vacuously", () => {
    expect(branches().length).toBeGreaterThanOrEqual(8);
  });

  it("no branch runs past two sentences", () => {
    for (const [label, text] of branches()) {
      expect(sentences(text).length, `${label}: ${text}`).toBeLessThanOrEqual(2);
    }
  });
});

/**
 * Guidance names an ARGUMENT, so the argument has to be one the receiving tool
 * accepts.
 *
 * `tako_search` publishes `sources` as an ARRAY. `tako_search_advanced`
 * publishes no `sources` key at all — the two blocks sit at the top level and
 * every level is `.strict()`. Both builders named `tako_search`'s form
 * unconditionally, so on the advanced tool the zero-result recovery step, the
 * one that exists to stop a priced retry loop, was itself an
 * `Unrecognized key: "sources"` before the request left the Worker.
 *
 * Only the tool's own schema knows this, which is why the assertion parses
 * rather than compares strings.
 */
describe("the sources argument guidance names is one that tool accepts", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
  const TOOLS = { tako_search, tako_search_advanced } as const;
  const NAMES = Object.keys(TOOLS) as SearchToolName[];

  it("every advertised argument parses against that tool's published schema", () => {
    for (const name of NAMES) {
      const parsed = TOOLS[name].inputSchema.safeParse({
        query: "us gdp",
        ...BOTH_SOURCES_ARG[name],
      });
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  // Catches a HAND-WRITTEN argument too, not only the derived one: any code
  // span that parses as a JSON object body is what a model will paste, so it
  // is held to the same bar. A span that is prose (`related`, `tako_contents`)
  // fails JSON.parse and is skipped — as would an argument written with
  // unquoted keys, which is the one hole here and the reason the derived form
  // stringifies.
  const argumentsNamedIn = (text: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const [, span] of text.matchAll(/`([^`]+)`/g)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(`{${span}}`);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    }
    return out;
  };

  it("every argument named in any guidance branch is sendable to the tool that emitted it", () => {
    let checked = 0;
    for (const name of NAMES) {
      const branches: string[] = [];
      for (const sources of [["data"], ["web"], ["data", "web"]] as SearchedSources[]) {
        for (const web of [[], [{ url: "https://e.com" }]]) {
          const g = buildSearchOutput(
            [],
            web as WebResult[],
            "r",
            null,
            ENV,
            sources,
            false,
            "authenticated",
            { rowCap: null, keepWebText: false, toolName: name },
          ).guidance;
          if (g !== undefined) branches.push(g);
        }
      }
      if (name === "tako_search_advanced") {
        for (const hasWeb of [true, false]) {
          for (const searchedWebToo of [true, false]) {
            branches.push(buildDataGapGuidance(hasWeb, searchedWebToo, name));
          }
        }
      }
      for (const g of branches) {
        for (const argument of argumentsNamedIn(g)) {
          checked += 1;
          const parsed = TOOLS[name].inputSchema.safeParse({ query: "us gdp", ...argument });
          expect(
            parsed.success,
            `${name} guidance names an unsendable argument ${JSON.stringify(argument)}: ${JSON.stringify(parsed.error?.issues)}\n${g}`,
          ).toBe(true);
        }
      }
    }
    // Vacuity guard: this passes trivially if no branch names an argument at
    // all, which is also how the wording could silently stop being actionable.
    expect(checked, "no guidance branch named an argument to check").toBeGreaterThan(0);
  });
});

describe("payload layout — data serializes before boilerplate", () => {
  // Clients with result-size caps truncate the TAIL of the serialized JSON, so
  // the failure mode this pins is: source paragraphs survive while every data
  // point is cut. Key insertion order IS the fix (JSON.stringify preserves it
  // into content.text and structuredContent).
  //
  // The CARD-level half of this block went with `slimCard`: card key order was
  // its job, and the projection now decides the order by construction — every
  // key is written in `projectCard` in the order it should serialize, so there
  // is nothing left to reorder. `projectCard`'s own describe pins that shape.

  it("slimmed content serializes rows before descriptor metadata", () => {
    const out = slimCardContent(dataset([["2025-01-01", 1]]), 5);
    const keys = Object.keys(out as Record<string, unknown>);
    expect(keys.indexOf("dataset")).toBeLessThan(keys.indexOf("content_format"));
    expect(keys.indexOf("dataset")).toBeLessThan(keys.indexOf("cost"));
  });
});

// ---------------------------------------------------------------------------
// orderCardsByUsefulness
// ---------------------------------------------------------------------------
//
// The failure this ordering exists for, verbatim from prod (2026-07-29):
// `tako_search "US inflation rate"` ranked `United States Inflation Rate`
// (newest row 2024-01-01) ABOVE `United States CPI Inflation Rate (Seasonally
// Adjusted)` (newest row 2026-06-01). Read top-down, that answers "what is US
// inflation" with a 2½-year-old figure.

const seriesCard = (
  card_id: string,
  lastTimestamp: string,
  extra: Record<string, unknown> = {},
): TakoCard =>
  ({
    card_id,
    content: {
      content_format: "json_compact",
      dataset: {
        columns: [{ name: "Timestamp", type: "datetime" }, { name: "v", type: "number" }],
        rows: [["2020-01-01T00:00:00+00:00", 1], [lastTimestamp, 2]],
      },
    },
    ...extra,
  }) as TakoCard;

describe("orderCardsByUsefulness", () => {
  it("puts the fresher series first (the live stale-top-card failure)", () => {
    const stale = seriesCard("annual", "2024-01-01T00:00:00+00:00");
    const fresh = seriesCard("cpi_sa", "2026-06-01T00:00:00+00:00");
    expect(orderCardsByUsefulness([stale, fresh]).map((c) => c.card_id)).toEqual([
      "cpi_sa",
      "annual",
    ]);
  });

  // A `date`-typed column holding bare years is a real shape for annual
  // series. Passed through unchanged, `2024` compares against ~1.7e12 for any
  // string-dated card and sorts below every one of them — including genuinely
  // staler ones. Same-card comparisons (capRecentRows) never saw this because
  // both sides came from one parse path; ordering compares across cards.
  const yearRowCard = (card_id: string, lastYear: number): TakoCard =>
    ({
      card_id,
      content: {
        content_format: "json_compact",
        dataset: {
          columns: [{ name: "Year", type: "date" }, { name: "v", type: "number" }],
          rows: [[2000, 1], [lastYear, 2]],
        },
      },
    }) as TakoCard;

  it("compares bare-year rows on the same scale as string dates", () => {
    const annual2026 = yearRowCard("annual_2026", 2026);
    const stale2019 = seriesCard("stale_2019", "2019-01-01T00:00:00+00:00");
    expect(orderCardsByUsefulness([stale2019, annual2026]).map((c) => c.card_id)).toEqual([
      "annual_2026",
      "stale_2019",
    ]);
  });

  it("still orders two bare-year cards against each other", () => {
    expect(
      orderCardsByUsefulness([yearRowCard("old", 2011), yearRowCard("new", 2025)]).map(
        (c) => c.card_id,
      ),
    ).toEqual(["new", "old"]);
  });

  it("demotes row-less Overview cards below real series cards", () => {
    const overview = { card_id: "overview", title: "Earnings & Estimates Overview" } as TakoCard;
    const series = seriesCard("gross_margin", "2026-06-01T00:00:00+00:00");
    expect(orderCardsByUsefulness([overview, series]).map((c) => c.card_id)).toEqual([
      "gross_margin",
      "overview",
    ]);
  });

  it("falls back to data_freshness.data_as_of when no rows are inlined", () => {
    // include_contents:false strips rows, so the declared as-of date is the
    // only recency signal left. The backend ships it as an OBJECT.
    const older = { card_id: "older", data_freshness: { data_as_of: "2024-03-31" } } as TakoCard;
    const newer = { card_id: "newer", data_freshness: { data_as_of: "2026-06-30" } } as TakoCard;
    expect(orderCardsByUsefulness([older, newer]).map((c) => c.card_id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("normalises a numeric data_as_of against a string-dated one (same rule as rows)", () => {
    // The as-of tier is also a cross-card comparison, so it goes through
    // `comparableEpoch` too. Un-normalised, `2011` would sort below a
    // string-dated 2019 card and, worse, below every string-dated card forever.
    const numericNewer = { card_id: "numeric_2026", data_freshness: { data_as_of: 2026 } } as TakoCard;
    const stringOlder = { card_id: "string_2019", data_freshness: { data_as_of: "2019-01-01" } } as TakoCard;
    expect(orderCardsByUsefulness([stringOlder, numericNewer]).map((c) => c.card_id)).toEqual([
      "numeric_2026",
      "string_2019",
    ]);
  });

  it("breaks remaining ties on relevance, then on backend order (stable)", () => {
    const low = { card_id: "low", relevance: "Low" } as TakoCard;
    const high = { card_id: "high", relevance: "High" } as TakoCard;
    expect(orderCardsByUsefulness([low, high]).map((c) => c.card_id)).toEqual(["high", "low"]);

    const a = { card_id: "a" } as TakoCard;
    const b = { card_id: "b" } as TakoCard;
    const c = { card_id: "c" } as TakoCard;
    expect(orderCardsByUsefulness([a, b, c]).map((x) => x.card_id)).toEqual(["a", "b", "c"]);
  });

  it("orders only — never drops, folds, or mutates the input", () => {
    const input = [
      seriesCard("stale", "2024-01-01T00:00:00+00:00"),
      seriesCard("fresh", "2026-06-01T00:00:00+00:00"),
      { card_id: "no_rows" } as TakoCard,
    ];
    const snapshot = JSON.stringify(input);
    const out = orderCardsByUsefulness(input);
    expect(out).toHaveLength(3);
    expect([...out].map((c) => c.card_id).sort()).toEqual(["fresh", "no_rows", "stale"]);
    expect(JSON.stringify(input)).toBe(snapshot); // immutable
  });

  it("drives the widget: buildSearchOutput lifts the REORDERED top card", () => {
    const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
    // Titles, because the projection drops `card_id` and the two cards are
    // otherwise identical — without them the projected-card assertion below
    // compares undefined to undefined and passes on any ordering.
    const stale = seriesCard("stale_top", "2024-01-01T00:00:00+00:00", { title: "Stale series" });
    const fresh = seriesCard("fresh_second", "2026-06-01T00:00:00+00:00", { title: "Fresh series" });
    const out = buildSearchOutput([stale, fresh], [], "req-order", null, ENV, ["data"], false, "authenticated", OPTS);
    // The widget lift is one observable: it must follow the REORDERED top card,
    // not the wire order.
    expect(out.pub_id).toBe("fresh_second");
    // And the document is the other. The chart a host renders must not disagree
    // with the list beneath it, so the first projected card has to be the same
    // card the widget lifted.
    expect(out.cards[0]?.title).toBe("Fresh series");
  });
});

describe("orderCardsByUsefulness — as-of presence", () => {
  it("ranks a card that declares data_freshness above one that declares none", () => {
    // Both row-less (exportable:false cards carry no inline rows), so without
    // this rule they tie and backend order wins — which put an
    // `Earnings & Estimates Overview` above the actual gross-margin series.
    const overview = { card_id: "overview", title: "Earnings & Estimates Overview" } as TakoCard;
    const dated = {
      card_id: "actuals",
      data_freshness: { data_as_of: "2025-12-31" },
    } as TakoCard;
    expect(orderCardsByUsefulness([overview, dated]).map((c) => c.card_id)).toEqual([
      "actuals",
      "overview",
    ]);
  });

  it("still puts a rowed card above a merely-dated one", () => {
    const dated = { card_id: "dated", data_freshness: { data_as_of: "2026-06-30" } } as TakoCard;
    const rowed = seriesCard("rowed", "2024-01-01T00:00:00+00:00");
    expect(orderCardsByUsefulness([dated, rowed]).map((c) => c.card_id)).toEqual([
      "rowed",
      "dated",
    ]);
  });
});

describe("zero-card guidance never prescribes a tool the tier cannot call", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
  // Every source combination `tako_search` can produce, plus the pinned path
  // `tako_search_advanced` adds. `tako_search` is the WHOLE anonymous surface,
  // so on the free tier none of these may route through another tool.
  const SHAPES: ReadonlyArray<{
    sources: Array<"data" | "web">;
    web: boolean;
    pin: boolean;
  }> = [
    { sources: ["data", "web"], web: false, pin: false },
    { sources: ["data", "web"], web: true, pin: false },
    { sources: ["data"], web: false, pin: false },
    { sources: ["web"], web: false, pin: false },
    { sources: ["web"], web: true, pin: false },
    { sources: ["data", "web"], web: false, pin: true },
  ];

  const guidanceFor = (
    shape: (typeof SHAPES)[number],
    tier: "free" | "authenticated",
  ): string =>
    buildSearchOutput(
      [],
      shape.web ? [{ title: "t", url: "https://x.com" }] : [],
      "req",
      null,
      ENV,
      shape.sources,
      shape.pin,
      tier,
      OPTS,
    ).guidance ?? "";

  it("names no other tool on the free tier, on any branch", () => {
    // The bug this pins: all four branches opened with "call
    // tako_available_data (free)", and three also routed to tako_contents.
    // An anonymous zero-result caller got a numbered protocol in which every
    // step answers a sign-in refusal.
    for (const shape of SHAPES) {
      const g = guidanceFor(shape, "free");
      const label = `sources=${shape.sources.join(",")} web=${shape.web} pin=${shape.pin}`;
      expect(g, label).not.toContain("tako_contents");
      // tako_available_data may be NAMED as the thing sign-in unlocks, but
      // never as a step to take now.
      expect(g, label).not.toMatch(/(call|run|check) tako_available_data/i);
      expect(g.length, label).toBeGreaterThan(0);
    }
  });

  it("still prescribes the full protocol when authenticated", () => {
    // Guards the other direction: a blanket strip would cost every paying
    // caller the recovery that keeps them off the retry loop.
    const g = guidanceFor({ sources: ["data", "web"], web: false, pin: false }, "authenticated");
    expect(g).toMatch(/call tako_available_data/i);
    expect(g).toMatch(/canonical metric name/i);
  });

  it("keeps the shape rules the anonymous caller CAN act on", () => {
    // Removing the refusing steps must not leave an empty protocol: the query
    // shape is the one lever an anonymous caller still has.
    const g = guidanceFor({ sources: ["data", "web"], web: false, pin: false }, "free");
    expect(g).toMatch(/one metric per query/i);
    expect(g).toMatch(/rewording alone will not change/i);
    expect(g).toMatch(/signed-in connection/i);
  });
});

describe("zero-card guidance routes to the canonical name, never to a pin", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("sends the model to tako_available_data for the exact name", () => {
    for (const sources of [["data", "web"], ["data"]] as ReadonlyArray<Array<"data" | "web">>) {
      const g = buildSearchOutput([], [], "req", null, ENV, sources, false, "authenticated", OPTS).guidance ?? "";
      expect(g).toContain("tako_available_data");
      expect(g).toMatch(/canonical metric name/i);
    }
  });

  it("never advises a pin on an UNPINNED call — tako_search takes none after the D4 split", () => {
    // This guidance used to interpolate PINNED_RETRY. Advice for `node_ids` /
    // `strict` on a tool that rejects both is a phantom parameter, and it is
    // invisible to phantom_tool.test.ts — that guard reads published schemas
    // and descriptions, and this is a runtime VALUE.
    //
    // `strictPin: false` is what `tako_search` always produces (it cannot send
    // either field), so this is that tool's every path.
    for (const sources of [["data", "web"], ["data"], ["web"]] as ReadonlyArray<Array<"data" | "web">>) {
      const g = buildSearchOutput([], [], "req", null, ENV, sources, false, "authenticated", OPTS).guidance ?? "";
      expect(g, `sources=${sources.join(",")}`).not.toMatch(/node_ids|strict/i);
    }
  });

  it("blames the FILTER, not coverage, when the request carried a strict pin", () => {
    // Reachable only from tako_search_advanced. Without this branch the model
    // reads "the data is not covered, rewording will not change that" after a
    // hard filter returned nothing — a coverage verdict the request cannot
    // support (KE-812: pinned handles returned FEWER cards on 11 of 20 pairs),
    // and one that contradicts that tool's own description.
    const g = buildSearchOutput([], [], "req", null, ENV, ["data", "web"], true, "authenticated", OPTS).guidance ?? "";
    expect(g).toMatch(/hard filter/i);
    expect(g).toMatch(/node_ids/);
    // The verdict the unpinned branch gives must NOT appear here.
    expect(g).not.toMatch(/does not cover this query/i);
    expect(g).not.toMatch(/every retry is priced/i);
  });

  it("keeps the pin branch off the web-only path, which never applied a data filter", () => {
    const g = buildSearchOutput([], [], "req", null, ENV, ["web"], true, "authenticated", OPTS).guidance ?? "";
    expect(g).not.toMatch(/hard filter/i);
  });
});

describe("slimCardContent and the card_json payload", () => {
  const cardJson = {
    content_format: "card_json",
    card_data: { card_type: "timeseries", records: [1, 2, 3] },
    card_data_schema: { title: "Timeseries", type: "object" },
    total_rows: 3,
    cost: 0.01,
  };

  it("drops card_data when the cap says drop every row", () => {
    // Before this, card_data was not one of the three destructured payload
    // keys, so it rode through in `meta` — a "drop all rows" call shipped the
    // whole rich object anyway.
    const out = slimCardContent(cardJson as never, null) as Record<string, unknown>;
    expect(out.card_data).toBeNull();
    // Metadata survives so the "rows available, call tako_contents" signal does.
    expect(out.content_format).toBe("card_json");
    expect(out.total_rows).toBe(3);
    // card_data_schema is the SHAPE, not the payload: a url-mode or quote
    // response returns it beside a null card_data, so it must not be dropped.
    expect(out.card_data_schema).toEqual({ title: "Timeseries", type: "object" });
  });

  it('keeps card_data verbatim under the "all" cap', () => {
    const out = slimCardContent(cardJson as never, "all") as Record<string, unknown>;
    expect(out.card_data).toEqual({ card_type: "timeseries", records: [1, 2, 3] });
  });

  it('keeps every row payload verbatim under the "all" cap', () => {
    // "all" is what tako_search_advanced passes: it sends sources.data.max_rows
    // on the wire, so the backend already applied the caller's cap and a
    // second cap here could only clamp BELOW what they paid for.
    const dense = {
      content_format: "json_compact",
      cost: 0.01,
      dataset: {
        columns: [{ name: "t", type: "datetime" }, { name: "v", type: "number" }],
        rows: [["d0", 0], ["d1", 1], ["d2", 2]],
        total_rows: 3,
        truncated: false,
        ref: "r",
        sources: [],
        provenance: "query",
      },
    };
    const out = slimCardContent(dense as never, "all") as Record<string, unknown>;
    expect((out.dataset as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it("still caps a numeric budget to the most-recent rows", () => {
    const dense = {
      content_format: "json_records",
      cost: 0.01,
      records: [{ t: "2024-01-01", v: 1 }, { t: "2024-02-01", v: 2 }, { t: "2024-03-01", v: 3 }],
    };
    const out = slimCardContent(dense as never, 2) as Record<string, unknown>;
    expect(out.records).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });
});

// The card_data leak was a hand-listed set falling behind a generated one:
// slimCardContent destructured three payload keys while ContentItem had four, so
// `rowCap: null` — "drop every row" — shipped the whole card_json object. Adding a
// fourth literal fixes that instance and leaves the class open, because nothing
// notices a FIFTH channel.
//
// These two tests close it by binding CONTENT_PAYLOAD_KEYS at both ends: to the
// function's real behaviour, and to the backend's real schema. Neither is
// checkable by reading the destructure, which is why the classification is a
// declared const now.
describe("the payload/metadata split cannot drift", () => {
  it("slimCardContent nulls every key classified as a payload", () => {
    // Built per-key rather than all at once: a single object would pass even if
    // the function only handled one of the four.
    for (const key of CONTENT_PAYLOAD_KEYS) {
      const content = { content_format: "json_compact", cost: 1, [key]: { some: "payload" } };
      const out = slimCardContent(content as unknown as ResultContent, null) as unknown as Record<
        string,
        unknown
      >;
      expect(out[key], `slimCardContent leaked ${key} at rowCap null`).toBeNull();
    }
  });

  it("keeps every metadata key through the same drop", () => {
    const content = {
      content_format: "json_compact",
      cost: 2,
      total_rows: 300,
      truncated: true,
      card_data_schema: { title: "shape" },
      manifest: [{ name: "t" }],
      source_url: "https://trytako.com/c/x",
      data: "rows",
    };
    const out = slimCardContent(content as unknown as ResultContent, null) as unknown as Record<
      string,
      unknown
    >;
    for (const key of ["content_format", "cost", "total_rows", "truncated", "card_data_schema", "manifest", "source_url"]) {
      expect(out[key], `slimCardContent dropped metadata ${key}`).not.toBeNull();
    }
  });

  it("classifies every generated ContentItem key as payload or metadata", () => {
    // The guard that actually catches a NEW backend channel. A fifth payload key
    // upstream lands here as an unclassified name, and the author has to decide
    // which side it belongs on — instead of it defaulting into `meta` and riding
    // out on a call that asked for no rows.
    const classified = new Set<string>([...CONTENT_PAYLOAD_KEYS, ...CONTENT_META_KEYS]);
    const generated = Object.keys(ContentItem.shape);
    expect(generated.length).toBeGreaterThan(10);
    const unclassified = generated.filter((k) => !classified.has(k)).sort();
    expect(
      unclassified,
      "new ContentItem key(s): classify as a row payload (add to CONTENT_PAYLOAD_KEYS and the slimCardContent destructure) or as metadata (CONTENT_META_KEYS)",
    ).toEqual([]);
    // And nothing classified has disappeared upstream — a stale name here would
    // make the check above pass while covering a key that no longer exists.
    const stale = [...classified].filter((k) => !generated.includes(k)).sort();
    expect(stale, "classified key(s) no longer in ContentItem").toEqual([]);
  });

  // `projectCardRows` handles each payload channel in its own branch, so it
  // cannot loop over CONTENT_PAYLOAD_KEYS. The guard therefore CALLS it once
  // per classified channel rather than comparing two name lists: a list-vs-list
  // assertion went green the moment someone added the fifth name to the second
  // list, with no branch reading it — which is the silent drop the guard exists
  // to catch, not a guard against it.
  //
  // `SAMPLES` is typed by CONTENT_PAYLOAD_KEYS, so a new channel fails to
  // COMPILE here until someone writes a payload for it, and then fails to PASS
  // until `projectCardRows` grows the branch. Both steps are the point.
  //
  // The drift this replaces has shipped twice: `slimCardContent` carried three
  // names against `ContentItem`'s four, and renaming the real `content_format`
  // to `format` dropped it from every inlined `rows` object with all 1267 tests
  // still green.
  it("projectCardRows has a branch for every classified payload channel", () => {
    const SAMPLES: Record<(typeof CONTENT_PAYLOAD_KEYS)[number], unknown> = {
      dataset: { columns: [{ name: "v" }], rows: [[1]] },
      records: [{ v: 1 }],
      data: "v\n1",
      card_data: { card_type: "chart" },
    };
    for (const key of CONTENT_PAYLOAD_KEYS) {
      const projected = projectCardRows({ content_format: "json_compact", [key]: SAMPLES[key] }, undefined);
      expect(projected, `projectCardRows drops the ${key} channel entirely`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The model-facing projection (spec: 2026-08-26-model-facing-surface-redesign)
// ---------------------------------------------------------------------------

describe("projectCard — the nine-field model-facing card", () => {
  const wireCard = {
    card_id: "c1",
    title: "NVIDIA Data Center Revenue",
    description: "Latest value was $75.2B in Apr 2026.",
    exportable: true,
    content: { data: null, records: null, dataset: null, total_rows: 26, truncated: false },
    nodes: [{ id: "ent::nvidia::1", name: "NVIDIA", type: "entity" }],
    card_type: "chart",
    data_freshness: { coverage_end: "2026-04", data_as_of: "2026-04-26", last_updated: "2026-08-26T10:00:00Z" },
    relevance: "High",
    webpage_url: "https://tako.com/card/c1/",
    image_url: "https://tako.com/api/v1/image/c1/",
    embed_url: "https://tako.com/embed/c1/",
    sources: [{ source_name: "Fiscal.ai", source_index: "data" }],
    methodologies: [{ methodology_name: "m" }],
    source_indexes: ["data"],
    semantic_description: "restates the title",
  } as unknown as TakoCard;

  it("maps exactly the projected fields — plumbing and duplicates cannot leak", () => {
    const out = projectCard(wireCard, null);
    expect(out).toEqual({
      exportable: true,
      title: "NVIDIA Data Center Revenue",
      description: "Latest value was $75.2B in Apr 2026.",
      url: "https://tako.com/card/c1/",
      source: "Fiscal.ai",
      coverage_end: "2026-04",
      last_updated: "2026-08-26",
      relevance: "High",
      nodes: [{ id: "ent::nvidia::1", name: "NVIDIA", type: "entity" }],
      total_rows: 26,
    });
    // The drops that motivated the projection, asserted by name so a
    // regression names the field that came back.
    const keys = Object.keys(out);
    for (const dropped of [
      "card_id",
      "content",
      "card_type",
      "semantic_description",
      "methodologies",
      "source_indexes",
      "image_url",
      "embed_url",
      "data_freshness",
    ]) {
      expect(keys, dropped).not.toContain(dropped);
    }
  });

  // The numeric arm is an ENTITLEMENT, and it had no test: deleting it and
  // keeping `nonEmpty(rec.relevance)` alone left all 1267 green, so a paid
  // account's score could be dropped silently. No fixture in this file or
  // tako_search.test.ts sets `relevance_score`, which is why these two exist.
  it("prefers the entitled numeric relevance_score over the coarse string", () => {
    const out = projectCard({ ...wireCard, relevance_score: 4.5 } as unknown as TakoCard, null);
    expect(out.relevance).toBe("4.5");
  });

  it("falls back to the coarse relevance string when relevance_score is absent", () => {
    const out = projectCard(wireCard, null);
    expect(out.relevance).toBe("High");
  });

  it("last_updated is date-only", () => {
    expect(projectCard(wireCard, null).last_updated).toBe("2026-08-26");
  });

  it("a locked card reports exportable: false and fabricates no row count", () => {
    const locked = { ...wireCard, exportable: false, content: null } as unknown as TakoCard;
    const out = projectCard(locked, null);
    expect(out.exportable).toBe(false);
    expect(out.total_rows).toBeUndefined();
    expect(out).not.toHaveProperty("rows");
  });

  // The published describe says "exportable cards only", and the text channel
  // prints the count only in the exportable arm — so a locked card carrying a
  // descriptor must not put one in structuredContent either, or the two
  // channels disagree about a card nobody can fetch rows for. Unreachable
  // today (the backend's shared export gate ships `content: null` on locked
  // cards); this pins the invariant against that changing.
  it("suppresses total_rows on a locked card even when a descriptor carries one", () => {
    const locked = {
      ...wireCard,
      exportable: false,
      content: { total_rows: 42, data: null, dataset: null, records: null },
    } as unknown as TakoCard;
    expect(projectCard(locked, null).total_rows).toBeUndefined();
  });

  it("rows ride ONLY when the caller asked to inline them (advanced path)", () => {
    const withRows = {
      ...wireCard,
      content: {
        content_format: "json_compact",
        cost: 0.002,
        total_rows: 2,
        truncated: false,
        dataset: {
          columns: [
            { name: "t", type: "datetime" },
            { name: "v", type: "number" },
          ],
          rows: [
            ["2026-01-01", 1],
            ["2026-02-01", 2],
          ],
        },
      },
    } as unknown as TakoCard;
    expect(projectCard(withRows, null).rows).toBeUndefined();
    const inlined = projectCard(withRows, "all");
    expect(inlined.rows).toEqual({
      columns: ["t", "v"],
      rows: [
        ["2026-01-01", 1],
        ["2026-02-01", 2],
      ],
    });
  });

  // The keys that used to ride inside `dataset` on every inlined card: two of
  // them restate a field the card already carries, and `total_rows` shipped
  // THREE times (card, rows, dataset). ~200 chars per card, in both channels,
  // paid once per `data.count`.
  it("drops the dataset envelope's plumbing and the duplicated counts", () => {
    const withRows = {
      ...wireCard,
      content: {
        content_format: "json_compact",
        cost: 0.002,
        total_rows: 26,
        truncated: true,
        dataset: {
          columns: [{ name: "v", type: "number" }],
          rows: [[1]],
          total_rows: 26,
          truncated: true,
          ref: "https://tako.com/card/c1/",
          sources: [{ name: "Fiscal.ai", index: "data" }],
          provenance: "query",
        },
      },
    } as unknown as TakoCard;
    const card = projectCard(withRows, "all");
    expect(card.total_rows, "the count belongs to the card").toBe(26);
    expect(card.rows).toEqual({ columns: ["v"], rows: [[1]], truncated: true });
    const serialized = JSON.stringify(card.rows);
    for (const gone of ["ref", "sources", "provenance", "total_rows", "cost"]) {
      expect(serialized, `rows still carries ${gone}`).not.toContain(gone);
    }
  });

  // The unit is the reason the manifest is read at all. It is folded into the
  // COLUMN NAME rather than shipped as a parallel array: a `json_records`
  // payload has bare keys, so without this `[{"revenue": 12.4}]` reaches the
  // model with nothing saying whether 12.4 is USD, USD billions or a percent —
  // and a separate manifest costs `metric`/`entity` prose per column that
  // repeats the card title.
  it("folds the manifest's unit into the column name (json_records)", () => {
    const withRows = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_records",
        cost: 0.01,
        total_rows: 1,
        truncated: false,
        records: [{ revenue: 12.4 }],
        manifest: [{ name: "revenue", metric: "Total Revenue", entity: "Tesla, Inc.", unit: "USD" }],
      },
    } as unknown as TakoCard;
    expect(projectCard(withRows, "all").rows).toEqual({
      columns: ["revenue (USD)"],
      rows: [[12.4]],
    });
  });

  // The join is by NAME. It has to be: this branch derives its column order
  // first-seen across records (the backend omits a null-valued key), so the
  // derived order and the manifest's order differ exactly when a record is
  // missing a key — and a positional join then labels every later column with
  // its neighbour's unit. A wrong unit is worse than none: the model quotes a
  // margin as dollars instead of asking.
  //
  // `ColumnDescriptor.name` is documented as "the CSV header, the
  // json_records key, and the dataset column label", so the key is exact.
  it("joins the manifest by column NAME, not by position", () => {
    const withRows = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_records",
        records: [
          { date: "2026-01-01", margin: 12 },
          { date: "2026-02-01", revenue: 13, margin: 5 },
        ],
        manifest: [
          { name: "date", dtype: "datetime" },
          { name: "revenue", dtype: "number", unit: "USD" },
          { name: "margin", dtype: "number", unit: "%" },
        ],
      },
    } as unknown as TakoCard;
    expect(projectCard(withRows, "all").rows).toEqual({
      columns: ["date", "margin (%)", "revenue (USD)"],
      rows: [
        ["2026-01-01", 12, null],
        ["2026-02-01", 5, 13],
      ],
    });
  });

  // Same join, on the dataset branch: a column the manifest describes under a
  // different index still gets ITS unit, not the one sitting at its position.
  it("joins the manifest by name on the dataset branch too", () => {
    const withRows = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_compact",
        dataset: {
          columns: [{ name: "margin" }, { name: "revenue" }],
          rows: [[5, 13]],
        },
        manifest: [
          { name: "revenue", unit: "USD" },
          { name: "margin", unit: "%" },
        ],
      },
    } as unknown as TakoCard;
    expect(projectCard(withRows, "all").rows).toEqual({
      columns: ["margin (%)", "revenue (USD)"],
      rows: [[5, 13]],
    });
  });

  // The backend omits a key whose value is null for that row, so reading the
  // first record's keys alone drops a column the rest of the payload has —
  // and every cell after the hole then shifts left by one.
  it("takes json_records columns first-seen across every record, holes as null", () => {
    const withRows = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_records",
        records: [{ a: 1 }, { a: 2, b: 3 }],
      },
    } as unknown as TakoCard;
    expect(projectCard(withRows, "all").rows).toEqual({
      columns: ["a", "b"],
      rows: [
        [1, null],
        [2, 3],
      ],
    });
  });

  // The wire guard for `content` is `.loose()` with every field optional, on
  // purpose — hard-requiring a field there turned a benign backend rename into
  // a total outage once. That makes THIS the layer that has to survive junk.
  // The two loops in the records branch read the same list, so an entry the key
  // scan skips must not be one the row build indexes: it skipped `null` and the
  // row build did not, which threw a TypeError after the call was billed. The
  // manifest half threw the same way before the unit join moved to names.
  it("survives junk entries in records and manifest", () => {
    const card = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_records",
        records: [{ a: 1 }, null, "nope", [9], { a: 2, b: 3 }],
        manifest: [null, { name: "b", unit: "%" }],
      },
    } as unknown as TakoCard;
    expect(projectCard(card, "all").rows).toEqual({
      columns: ["a", "b (%)"],
      rows: [
        [1, null],
        [2, 3],
      ],
    });
  });

  // Two of the four formats this tool can request are not row-shaped. Parsing
  // a CSV string back into cells would invent quoting rules the caller did not
  // ask for, so it rides verbatim under the key that names it.
  it("passes a non-tabular payload through under its own format", () => {
    const csv = {
      card_id: "c1",
      exportable: true,
      content: { content_format: "csv", data: "t,v\n2026-01-01,1", truncated: true },
    } as unknown as TakoCard;
    expect(projectCard(csv, "all").rows).toEqual({
      format: "csv",
      data: "t,v\n2026-01-01,1",
      truncated: true,
    });
    const cardJson = {
      card_id: "c1",
      exportable: true,
      content: { content_format: "card_json", card_data: { card_type: "chart", series: [] } },
    } as unknown as TakoCard;
    expect(projectCard(cardJson, "all").rows).toEqual({
      format: "card_json",
      card_data: { card_type: "chart", series: [] },
    });
  });

  // The projection must not emit something the tool's own outputSchema
  // rejects. `resultContentSchema` is loose by design, so a backend that ships
  // a non-array row or an ARRAY card_data passes the wire guard — and `mcp.ts`
  // serves a non-conforming structuredContent anyway, which makes a
  // spec-compliant client discard the whole billed result rather than one
  // field. Dropping `rows` for that card leaves `exportable`/`total_rows` to
  // route the model to tako_contents.
  it("drops rows the published output schema would reject, rather than shipping them", () => {
    const badRow = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_compact",
        total_rows: 2,
        dataset: { columns: [{ name: "v" }], rows: [[1], "oops"] },
      },
    } as unknown as TakoCard;
    const card = projectCard(badRow, "all");
    expect(card.rows).toBeUndefined();
    expect(card.total_rows, "the fetch route must survive").toBe(2);

    const badCardData = {
      card_id: "c1",
      exportable: true,
      content: { content_format: "card_json", card_data: [{ a: 1 }] },
    } as unknown as TakoCard;
    expect(projectCard(badCardData, "all").rows).toBeUndefined();
  });

  // ...and the whole projected output conforms, which is the assertion that
  // actually binds the projection to what the tool publishes.
  it("projects a card whose output the advanced tool's outputSchema accepts", () => {
    const ok = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_compact",
        dataset: { columns: [{ name: "v", unit: "USD" }], rows: [[1]] },
      },
    } as unknown as TakoCard;
    const parsed = searchAdvancedOutputShape.safeParse({
      cards: [projectCard(ok, "all")],
      web_results: [],
      usage: null,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // A descriptor with a cost quote and no payload is not rows. An empty
  // `rows: {}` would read as "this card has no data" when the truth is "you
  // did not ask to inline it".
  it("emits no rows object when no payload channel arrived", () => {
    const quoteOnly = {
      card_id: "c1",
      exportable: true,
      content: { content_format: "json_compact", cost: 0.002, total_rows: 26, truncated: false },
    } as unknown as TakoCard;
    expect(projectCard(quoteOnly, "all").rows).toBeUndefined();
  });
});

describe("projectWebResult", () => {
  const wire = {
    title: "NVIDIA announces results",
    url: "https://investor.nvidia.com/x",
    snippet: "Record revenue of $81.6 billion.",
    source_name: "investor.nvidia.com",
    publish_date: "2026-08-25T12:00:01.000Z",
    citation_number: null,
    content: { cost: 0.001, truncated: false, data: null, records: null, dataset: null },
  } as unknown as WebResult;

  it("maps title/url/snippet/source/published and drops citation_number + content nulls", () => {
    expect(projectWebResult(wire, false)).toEqual({
      url: "https://investor.nvidia.com/x",
      title: "NVIDIA announces results",
      snippet: "Record revenue of $81.6 billion.",
      source: "investor.nvidia.com",
      published: "2026-08-25",
    });
  });

  it("keeps a null snippet (page had no relevant passage) and a null published", () => {
    const nulls = { ...wire, snippet: null, publish_date: null } as unknown as WebResult;
    const out = projectWebResult(nulls, false);
    expect(out.snippet).toBeNull();
    expect(out.published).toBeNull();
  });

  it("keeps page text only when the request asked for it", () => {
    const withText = {
      ...wire,
      content: { cost: 0.001, truncated: false, data: "full page text", records: null, dataset: null },
    } as unknown as WebResult;
    expect(projectWebResult(withText, false).content).toBeUndefined();
    expect(projectWebResult(withText, true).content).toEqual({ data: "full page text", truncated: false });
  });
});

describe("buildReferenceMaps — deduped across cards, conflicts never lose text", () => {
  const defCard = (id: string, name: string, definition: string, source = "Fiscal.ai") =>
    ({
      card_id: id,
      metric_definitions: [{ name, definition }],
      sources: [{ source_name: source }],
    }) as unknown as TakoCard;

  it("one entry per distinct metric definition, however many cards repeat it", () => {
    const { metric_definitions } = buildReferenceMaps([
      defCard("a", "Revenue", "Reported revenue."),
      defCard("b", "Revenue", "Reported revenue."),
      defCard("c", "Revenue", "Reported revenue."),
    ]);
    expect(metric_definitions).toEqual({ Revenue: "Reported revenue." });
  });

  it("same name + different text disambiguates with the source suffix", () => {
    const { metric_definitions } = buildReferenceMaps([
      defCard("a", "Revenue", "Reported revenue.", "Fiscal.ai"),
      defCard("b", "Revenue", "Trailing twelve months revenue.", "S&P"),
    ]);
    expect(metric_definitions).toEqual({
      Revenue: "Reported revenue.",
      "Revenue — S&P": "Trailing twelve months revenue.",
    });
  });

  // The suffix names the card's WHOLE source string, so it joins against the
  // card's `source` field. Keyed by `sources[0]` this read "Revenue —
  // Fiscal.ai", which is the OTHER card's source — a blended definition
  // attributed to a single source that did not produce it.
  it("suffixes a multi-source conflict with the card's full source string", () => {
    const cards = [
      {
        card_id: "single",
        sources: [{ source_name: "Fiscal.ai" }],
        metric_definitions: [{ name: "Revenue", definition: "Reported revenue." }],
      },
      {
        card_id: "multi",
        sources: [{ source_name: "Fiscal.ai" }, { source_name: "S&P" }],
        metric_definitions: [{ name: "Revenue", definition: "Trailing twelve months revenue." }],
      },
    ] as unknown as TakoCard[];
    const { metric_definitions } = buildReferenceMaps(cards);
    expect(metric_definitions).toEqual({
      Revenue: "Reported revenue.",
      "Revenue — Fiscal.ai, S&P": "Trailing twelve months revenue.",
    });
    // The suffix is exactly what the card shows, so the lookup resolves.
    expect(projectCard(cards[1]!, null).source).toBe("Fiscal.ai, S&P");
  });

  it("source_notes merges source_description and methodology paragraphs under the source name", () => {
    const card = {
      card_id: "a",
      sources: [{ source_name: "Fiscal.ai", source_description: "Who the source is." }],
      methodologies: [{ methodology_name: "m", methodology_description: "How it builds data." }],
    } as unknown as TakoCard;
    const { source_notes } = buildReferenceMaps([card]);
    expect(source_notes).toEqual({ "Fiscal.ai": "Who the source is.\n\nHow it builds data." });
  });

  it("omits both maps when the backend sends no paragraphs", () => {
    const bare = { card_id: "a", sources: [{ source_name: "Fiscal.ai" }] } as unknown as TakoCard;
    expect(buildReferenceMaps([bare])).toEqual({});
  });

  // The join is the whole point: the model reads `source` off a card and looks
  // it up here. A two-source card shows "Fiscal.ai, S&P", so that is the key —
  // NOT `methodology_name`, which appears on no card and used to be the key
  // whenever a card had anything other than exactly one source.
  it("keys a multi-source card's methodology by the same string projectCard puts in `source`", () => {
    const card = {
      card_id: "a",
      sources: [{ source_name: "Fiscal.ai" }, { source_name: "S&P" }],
      methodologies: [{ methodology_name: "consensus", methodology_description: "How it blends." }],
    } as unknown as TakoCard;
    const { source_notes } = buildReferenceMaps([card]);
    expect(source_notes).toEqual({ "Fiscal.ai, S&P": "How it blends." });
    expect(Object.keys(source_notes ?? {})).not.toContain("consensus");
    // The contract the key exists to satisfy, asserted end to end.
    expect(projectCard(card, null).source).toBe("Fiscal.ai, S&P");
  });

  it("drops a methodology on a card that names no source — there is nothing to join to", () => {
    const card = {
      card_id: "a",
      methodologies: [{ methodology_name: "consensus", methodology_description: "How it blends." }],
    } as unknown as TakoCard;
    expect(buildReferenceMaps([card])).toEqual({});
  });

  // Keys are upstream strings, so an Object.prototype member name must behave
  // like any other key. Before the null-prototype maps, `sourceNotes["toString"]`
  // read back the inherited function and `existing.includes(text)` threw a
  // TypeError — failing the call after the backend round-trip was billed, and
  // invisible to TS because both maps are typed `Record<string, string>`.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "treats %s as an ordinary source and metric name",
    (name) => {
      const card = {
        card_id: "a",
        sources: [{ source_name: name, source_description: "Who the source is." }],
        metric_definitions: [{ name, definition: "Reported revenue." }],
      } as unknown as TakoCard;
      const maps = buildReferenceMaps([card]);
      expect(maps.source_notes).toEqual({ [name]: "Who the source is." });
      expect(maps.metric_definitions).toEqual({ [name]: "Reported revenue." });
    },
  );

  // THE CONFORMANCE TEST (spec: 2026-08-26-model-facing-surface-redesign,
  // "Reference prose"). The maps are only worth their bytes if the model can
  // JOIN them: it reads `source` off a projected card, or a metric name out of
  // a card's definitions, and looks the string up here. Every other test in
  // this block inspects a map in isolation, which is how two real join bugs
  // shipped — a `methodology_name` key that is on no card, and a `sources[0]`
  // conflict suffix that disagrees with the card's joined `source`.
  //
  // "Exactly one entry", as the spec words it, is deliberately relaxed on the
  // metric side: a same-name-different-text conflict is SUPPOSED to produce a
  // second entry ("Revenue" and "Revenue — S&P") rather than drop text. The
  // invariant that survives is two-way reachability — no orphan keys, no
  // dropped paragraphs.
  it("every map key traces back to a card, and every card paragraph reaches a key", () => {
    const cards = [
      {
        card_id: "single",
        sources: [{ source_name: "Fiscal.ai", source_description: "Who Fiscal.ai is." }],
        metric_definitions: [{ name: "Revenue", definition: "Reported revenue." }],
        methodologies: [{ methodology_name: "segment", methodology_description: "From the segment note." }],
      },
      {
        card_id: "multi",
        sources: [{ source_name: "Fiscal.ai" }, { source_name: "S&P", source_description: "Who S&P is." }],
        metric_definitions: [{ name: "Revenue", definition: "Trailing twelve months revenue." }],
        methodologies: [{ methodology_name: "blend", methodology_description: "How it blends." }],
      },
      { card_id: "bare", sources: [{ source_name: "Xignite" }] },
    ] as unknown as TakoCard[];
    const maps = buildReferenceMaps(cards);
    const notes = maps.source_notes ?? {};
    const defs = maps.metric_definitions ?? {};

    // FORWARD — the direction with teeth. A key no card carries is prose the
    // model can read and cannot attribute.
    //
    // ONE set, built from `projectCard` itself: a card carries exactly one
    // source field and it is the joined list, so that string is the only join
    // target there is. An earlier version of this test also admitted each bare
    // `source_name` — which is what let a two-source card file "Fiscal.ai" and
    // "S&P" beside the "Fiscal.ai, S&P" the card actually carries, with the
    // model able to read both descriptions and reach neither.
    const noteKeys = new Set<string>();
    for (const c of cards) {
      const projected = projectCard(c, null).source;
      if (projected !== undefined) noteKeys.add(projected);
    }
    for (const key of Object.keys(notes)) {
      expect(noteKeys.has(key), `source_notes key "${key}" is on no card`).toBe(true);
    }

    // Every (name, definition) pair on a card, with the `source` of the card
    // that carries it. Checking the suffix against a FLAT set of card sources
    // is not enough: `sources[0]` produces "Revenue — Fiscal.ai", and some
    // other single-source card's `source` is "Fiscal.ai", so a flat check
    // passes while the definition under that key came from a different card.
    // The suffix has to identify the card the TEXT came from.
    const definitionOwners = new Map<string, Set<string | undefined>>();
    const metricNames = new Set<string>();
    for (const c of cards) {
      const owner = projectCard(c, null).source;
      for (const d of (c as unknown as { metric_definitions?: { name: string; definition: string }[] })
        .metric_definitions ?? []) {
        metricNames.add(d.name);
        const owners = definitionOwners.get(d.definition) ?? new Set<string | undefined>();
        owners.add(owner);
        definitionOwners.set(d.definition, owners);
      }
    }
    for (const [key, text] of Object.entries(defs)) {
      // Strip the two disambiguators the conflict rule may append.
      const base = (key.split(" — ")[0] ?? key).replace(/ \(\d+\)$/, "");
      expect(metricNames.has(base), `metric_definitions key "${key}" is on no card`).toBe(true);
      const cut = key.indexOf(" — ");
      if (cut === -1) continue;
      const suffix = key.slice(cut + 3);
      const owners = definitionOwners.get(text) ?? new Set();
      expect(
        owners.has(suffix),
        `metric_definitions key "${key}" names a source that did not produce this definition ` +
          `(it came from ${[...owners].map((o) => JSON.stringify(o)).join(", ")})`,
      ).toBe(true);
    }

    // REVERSE — every paragraph a card carries reaches some entry. Only cards
    // that name a source can be attributed, which is the #7 rule.
    const noteText = Object.values(notes).join("\n");
    for (const c of cards) {
      const rec = c as unknown as {
        sources?: { source_name?: string; source_description?: string }[];
        methodologies?: { methodology_description?: string }[];
      };
      const named = (rec.sources ?? []).some((s) => s.source_name !== undefined);
      for (const s of rec.sources ?? []) {
        if (s.source_description !== undefined) expect(noteText).toContain(s.source_description);
      }
      if (!named) continue;
      for (const m of rec.methodologies ?? []) {
        if (m.methodology_description !== undefined) expect(noteText).toContain(m.methodology_description);
      }
    }
    const defText = Object.values(defs).join("\n");
    for (const c of cards) {
      for (const d of (c as unknown as { metric_definitions?: { definition: string }[] })
        .metric_definitions ?? []) {
        expect(defText).toContain(d.definition);
      }
    }
  });
});

/**
 * The published snippet contract.
 *
 * `95b8bb0` established what this description must carry, `f5fd69d` measured
 * the case and settled the wording: never assert the CAUSE of a `' … '` (a
 * consumer cannot tell a backend join from the page's own ellipsis — the arm
 * that structurally cannot carry a join still reported 2 of 260), always keep
 * the ACTION. This branch then shipped the inverse — cause asserted, action
 * dropped — and nothing failed, because no test read the string.
 *
 * Asserted on the PUBLISHED JSON Schema, and on every tool that publishes a
 * `snippet`, so moving the description between the array and the element (this
 * has happened once already) cannot drop it silently.
 */
describe("the published snippet contract", () => {
  const snippetDescriptions = (schema: unknown): string[] => {
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const props = obj.properties;
      if (props !== null && typeof props === "object") {
        const snippet = (props as Record<string, unknown>).snippet as
          | { description?: unknown }
          | undefined;
        if (snippet !== undefined && typeof snippet.description === "string") {
          found.push(snippet.description);
        }
      }
      for (const value of Object.values(obj)) walk(value);
    };
    walk(schema);
    return found;
  };

  const publishing = TOOL_REGISTRY.filter(
    (t) =>
      t.outputSchema !== undefined &&
      snippetDescriptions(z.toJSONSchema(t.outputSchema as z.ZodType, { io: "output" })).length > 0,
  );

  it("finds tools that publish a snippet, so the checks below are not vacuous", () => {
    expect(publishing.length).toBeGreaterThan(0);
  });

  for (const tool of publishing) {
    it(`${tool.name} keeps the actionable clause, not a claim about the cause`, () => {
      for (const description of snippetDescriptions(
        z.toJSONSchema(tool.outputSchema as z.ZodType, { io: "output" }),
      )) {
        // The ACTION, in whatever words: a reader must be told not to read
        // across the separator as one continuous sentence.
        expect(description, `${tool.name} snippet drops the "do not quote across" clause`).toMatch(
          /never quote across|not.{0,20}quote.{0,20}across/i,
        );
        // And `null` stays a documented outcome, not an error.
        expect(description, `${tool.name} snippet drops the null contract`).toMatch(/null/);
      }
    });
  }
});
