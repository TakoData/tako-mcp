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

import { ContentItem } from "../generated/schemas.js";

import {
  CONTENT_META_KEYS,
  CONTENT_PAYLOAD_KEYS,
  NARROWER_WEB_ATTEMPT,
  buildSearchOutput,
  hoistSourceGlossary,
  orderCardsByUsefulness,
  slimCard,
  slimCardContent,
} from "./_search_results.js";
import type { ResultContent, TakoCard } from "./_search_results.js";

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

// `content` presence is the model-facing "tako_contents will work on this
// card" signal (the backend's export-safe gate 403s cards without it), so
// slimming must preserve exactly what the wire said: never fabricate a
// descriptor on an unexportable card, never drop one from an exportable card.
describe("slimCard — share opt-in on the passthrough embed_url", () => {
  // cards[].embed_url is backend passthrough; without the opt-in the SAME
  // top card carried showShare on the widget-rendered structuredContent url
  // but not on the copy an agent quotes from the text.
  it("appends showShare=true to a card's embed_url", () => {
    const card: TakoCard = {
      card_id: "c1",
      title: "t",
      embed_url: "https://trytako.com/embed/c1/",
    };
    expect(slimCard(card, null).embed_url).toBe(
      "https://trytako.com/embed/c1/?showShare=true",
    );
  });

  it("leaves a card without an embed_url untouched", () => {
    const card: TakoCard = { card_id: "c1", title: "t" };
    expect(slimCard(card, null)).not.toHaveProperty("embed_url");
  });
});

describe("slimCard — content presence is the export-eligibility signal", () => {
  it("does not fabricate a content descriptor on a card without one (not exportable)", () => {
    const card: TakoCard = { card_id: "c1", title: "t" };
    expect(slimCard(card, 5)).not.toHaveProperty("content");
    expect(slimCard(card, null)).not.toHaveProperty("content");
  });

  it("passes an explicit content: null through unchanged (still not exportable)", () => {
    const card: TakoCard = { card_id: "c1", content: null };
    expect(slimCard(card, 5).content).toBeNull();
    expect(slimCard(card, null).content).toBeNull();
  });

  it("keeps the content descriptor on an exportable card even in drop-all mode", () => {
    const card: TakoCard = { card_id: "c1", content: dataset([["2024-01-01", 1]]) };
    const out = slimCard(card, null);
    expect(out.content).not.toBeNull();
    expect(out.content?.total_rows).toBe(1);
    expect((out.content as { dataset?: unknown }).dataset).toBeNull();
  });

  it("keeps the content descriptor (with capped rows) in preview mode", () => {
    const card: TakoCard = {
      card_id: "c1",
      content: dataset([
        ["2024-01-01", 1],
        ["2024-01-02", 2],
      ]),
    };
    const out = slimCard(card, 1);
    expect(out.content).not.toBeNull();
    expect(rowsOf(out.content)).toEqual([["2024-01-02", 2]]);
  });
});

// The explicit `exportable` boolean is emitted so the model reads "no" from a
// field instead of having to notice a MISSING key (which it overlooks, then
// calls tako_contents anyway and 403s). The backend emits it authoritatively
// since TakoData/tako#27989 (same fail-closed export_safe gate as /contents),
// so a wire flag passes through untouched — even when it disagrees with
// content presence. Deriving from `content != null` is only the fallback for
// older backends that don't emit the flag.
describe("slimCard — explicit exportable flag", () => {
  it("passes a backend exportable: true through on a content-bearing card", () => {
    const card: TakoCard = {
      card_id: "c1",
      exportable: true,
      content: dataset([["2024-01-01", 1]]),
    };
    expect(slimCard(card, null).exportable).toBe(true);
    expect(slimCard(card, 5).exportable).toBe(true);
  });

  it("passes a backend exportable: false through (authoritative) even when content is present", () => {
    const card: TakoCard = {
      card_id: "c1",
      exportable: false,
      content: dataset([["2024-01-01", 1]]),
    };
    const out = slimCard(card, 5);
    expect(out.exportable).toBe(false);
    // The wire's content descriptor still survives slimming untouched.
    expect(out.content).not.toBeNull();
  });

  it("passes a backend exportable: true through even when content is absent", () => {
    const card: TakoCard = { card_id: "c1", exportable: true };
    expect(slimCard(card, 5).exportable).toBe(true);
  });

  it("falls back: marks a card WITHOUT flag or content attribute as exportable: false", () => {
    const card: TakoCard = { card_id: "c1", title: "t" };
    expect(slimCard(card, 5).exportable).toBe(false);
    expect(slimCard(card, null).exportable).toBe(false);
  });

  it("falls back: marks a flagless card with an explicit content: null as exportable: false", () => {
    const card: TakoCard = { card_id: "c1", content: null };
    expect(slimCard(card, 5).exportable).toBe(false);
    expect(slimCard(card, null).exportable).toBe(false);
  });

  it("falls back: marks a flagless content-bearing card as exportable: true (both modes)", () => {
    const card: TakoCard = { card_id: "c1", content: dataset([["2024-01-01", 1]]) };
    expect(slimCard(card, null).exportable).toBe(true);
    expect(slimCard(card, 5).exportable).toBe(true);
  });
});

// Non-exportable (exportable:false) cards carry no rows anywhere; the
// values_hint makes the routing (description holds the headline when present;
// tako_answer for figures) per-card and deterministic instead of a
// tool-description recall exercise. Wording is neutral ("not exportable"):
// export_safe() also fails closed on non-licensing causes.
describe("slimCard — values_hint on gated cards", () => {
  it("stamps a plain not-exportable hint that routes to NO tool", () => {
    // `tako_answer` is opt-in (spec D1): a hint naming it would send the
    // model into "tool not found" on the default surface, so the hint
    // states what IS true (no rows on any path; headline in description)
    // and advises no call at all.
    const card: TakoCard = {
      card_id: "c1",
      exportable: false,
      nodes: [
        { id: "n1", name: "Entity", type: "entity" },
        { id: "n2", name: "Metric", type: "metric" },
      ],
    };
    const hint = slimCard(card, 5).values_hint;
    expect(hint).toContain("not exportable");
    expect(hint).not.toContain("tako_answer");
    expect(hint).not.toContain("node_ids");
    expect(hint).not.toContain("strict");
  });

  it("points at the headline only when the card actually carries a description", () => {
    const withDesc: TakoCard = {
      card_id: "c1",
      exportable: false,
      description: "Latest value 59.2%, up 1.1pp",
    };
    expect(slimCard(withDesc, 5).values_hint).toContain("headline value is in description");
    const withoutDesc: TakoCard = { card_id: "c2", exportable: false };
    expect(slimCard(withoutDesc, 5).values_hint).not.toContain("description");
    const blankDesc: TakoCard = { card_id: "c3", exportable: false, description: "  " };
    expect(slimCard(blankDesc, 5).values_hint).not.toContain("description");
  });

  it("stamps the hint on a fallback-derived gated card (no flag, no content)", () => {
    const card: TakoCard = { card_id: "c1", title: "t" };
    expect(slimCard(card, 5).values_hint).toContain("not exportable");
  });

  it("never stamps a values_hint on an exportable card", () => {
    const card: TakoCard = { card_id: "c1", content: dataset([["2024-01-01", 1]]) };
    expect(slimCard(card, 5)).not.toHaveProperty("values_hint");
  });

  it("orders description and values_hint before the URL/methodology chrome", () => {
    const card: TakoCard = {
      card_id: "c1",
      title: "t",
      exportable: false,
      description: "Latest value 59.2%, up 1.1pp",
      webpage_url: "https://trytako.com/card/c1",
      image_url: "https://trytako.com/card/c1.png",
    };
    const keys = Object.keys(slimCard(card, 5) as Record<string, unknown>);
    expect(keys.indexOf("description")).toBeLessThan(keys.indexOf("webpage_url"));
    expect(keys.indexOf("values_hint")).toBeLessThan(keys.indexOf("webpage_url"));
    expect(keys.indexOf("description")).toBeLessThan(keys.indexOf("image_url"));
  });
});

describe("buildSearchOutput — zero-card guidance", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("attaches the full anti-retry protocol when cards AND web_results are both empty", () => {
    const out = buildSearchOutput([], [], "req-1", null, ENV, ["data", "web"]);
    // The load-bearing instruction: do not re-issue reworded searches.
    expect(out.guidance).toMatch(/do not retry/i);
    expect(out.guidance).toMatch(/tako_available_data/);
  });

  it("still fires on zero cards WITH web_results — steering to the web fallback", () => {
    // The common default-source miss: no data card, some web hits. This is
    // exactly the "reword and retry for a chart" loop case, so guidance must
    // not be silently skipped here.
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3", null, ENV, ["data", "web"]);
    expect(out.guidance).toMatch(/web_results/);
    // The verdict is scoped to the graph, not to the whole call.
    expect(out.guidance).toMatch(/DATA GRAPH only/);
  });

  // THE MISFIRE. This branch used to say "do NOT re-search with rephrasings"
  // flat out, which is right for hunting a data card and wrong for every
  // question whose answer is on the web: a docs or reference lookup is won by
  // re-searching per entity or per provider, and the guidance was telling the
  // model to stop after one call. The ban must name the DATA axis and the
  // carve-out must be explicit — a model reading this cannot be left to infer
  // that web refinement is still allowed.
  it("does not ban web re-searching when zero cards come back with web results", () => {
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3b", null, ENV, ["data", "web"]);
    const g = out.guidance ?? "";
    expect(g).toContain("Re-searching is NOT banned here");
    // Names the fan-out that wins these questions.
    expect(g).toMatch(/SEVERAL narrow queries/);
    expect(g).toMatch(/one per entity, provider or site/);
    // Any surviving blanket ban would read as one of these.
    expect(g).not.toMatch(/do NOT re-search with rephrasings/i);
  });

  // The mirror of buildDataGapGuidance's `searchedWebToo` fix. A web-only search
  // has zero cards by construction, so the graph verdict below would be built
  // from evidence that does not exist.
  it("renders no graph verdict for a web-only search that DID return web results", () => {
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3c", null, ENV, ["web"]);
    const g = out.guidance ?? "";
    expect(g).toMatch(/WEB source only/);
    expect(g).not.toMatch(/DATA GRAPH only/);
    expect(g).not.toMatch(/already shown the graph does not hold it/);
    // And none of the data-axis recovery, which does not apply to a deliberate
    // web-only narrow.
    expect(g).not.toMatch(/node_id/);
    expect(g).not.toMatch(/strict/);
    // It still names the way to GET a coverage answer, which is the cheap re-ask.
    expect(g).toMatch(/sources:\["data","web"\]/);
    expect(g).toMatch(/tako_available_data/);
  });

  it("tailors the both-empty protocol for a data-only search (web fallback allowed on the single retry)", () => {
    const out = buildSearchOutput([], [], "req-4", null, ENV, ["data"]);
    expect(out.guidance).toMatch(/tako_available_data/);
    expect(out.guidance).toMatch(/"web"/);
    // No web-axis carve-out here: the web was never searched, so there is no
    // empty web result to reinterpret. Step (2) already offers web as a fallback
    // source, and both at once would contradict each other.
    expect(out.guidance).not.toContain(NARROWER_WEB_ATTEMPT);
  });

  // tako_answer's both-empty branch has always allowed ONE narrower web attempt;
  // this branch used to end flatly at "stop calling Tako for this question". Same
  // situation, opposite verdict, on the most common Tako-has-nothing path — so it
  // is now one shared constant rather than a sentence in one of the two tools.
  it("allows the same single narrower web attempt tako_answer allows, when web was searched", () => {
    const out = buildSearchOutput([], [], "req-4b", null, ENV, ["data", "web"]);
    expect(out.guidance).toContain(NARROWER_WEB_ATTEMPT);
    expect(out.guidance).toMatch(/WEB axis only/);
  });

  // A web-only search that came back empty has NO data verdict to report (the
  // data source was never queried) and exactly one lever available: the query.
  // This branch used to ban that lever — "do NOT retry this query or
  // rephrasings of it" — which left the model with nothing to do at all.
  it("tells a web-only search to refine, and claims nothing about graph coverage", () => {
    const out = buildSearchOutput([], [], "req-5", null, ENV, ["web"]);
    const g = out.guidance ?? "";
    expect(g).not.toMatch(/node_id/);
    expect(g).toMatch(/Refine and re-search/i);
    expect(g).toMatch(/NOT a coverage verdict/i);
    expect(g).not.toMatch(/do NOT retry/i);
    // Still not an invitation to loop forever.
    expect(g).toMatch(/Stop only once/i);
  });

  it("takes the DATA-verdict branch for a data-source search", () => {
    // Was "treats the legacy tako alias as data" and keyed on /node_id/ in the
    // guidance; the alias is gone and so is the pin recipe, so pin the branch
    // by the verdict it is the only one to state.
    const out = buildSearchOutput([], [], "req-6", null, ENV, ["data"]);
    expect(out.guidance).toMatch(/tako_available_data/);
    expect(out.guidance).toMatch(/do NOT retry/i);
  });

  it("omits guidance when any card is present", () => {
    const out = buildSearchOutput([{ card_id: "c1" }], [], "req-2", null, ENV, ["data", "web"]);
    expect(out.guidance).toBeUndefined();
  });
});

describe("payload layout — data serializes before boilerplate", () => {
  // Clients with result-size caps truncate the TAIL of the serialized JSON, so
  // the failure mode these tests pin is: five cards of source paragraphs
  // survive while every data point is cut. Key insertion order IS the fix
  // (JSON.stringify preserves it into content.text and structuredContent).

  const wireCard: TakoCard = {
    // Deliberately in the backend's wire order: metadata first, content late.
    card_id: "c1",
    title: "PANW Revenue",
    description: "Quarterly revenue for Palo Alto Networks.",
    semantic_description: "A long retrieval-oriented blob…",
    webpage_url: "https://tako.com/card/c1",
    sources: [{ source_name: "Visible Alpha", source_description: "x".repeat(300) }],
    methodologies: [{ methodology_name: "m", methodology_description: "consensus" }],
    card_type: "timeseries",
    content: dataset([
      ["2025-01-01", 1],
      ["2025-04-01", 2],
    ]),
  } as unknown as TakoCard;

  it("slimCard reorders keys: description + content (the substance) before URL/source chrome", () => {
    const keys = Object.keys(slimCard(wireCard, 5));
    const pos = (k: string) => keys.indexOf(k);
    expect(pos("card_id")).toBe(0);
    expect(pos("content")).toBeGreaterThan(-1);
    // description precedes content: on license-gated cards it carries the
    // headline value, so it must survive truncation alongside the data.
    expect(pos("description")).toBeLessThan(pos("content"));
    expect(pos("content")).toBeLessThan(pos("webpage_url"));
    expect(pos("content")).toBeLessThan(pos("sources"));
    expect(pos("content")).toBeLessThan(pos("methodologies"));
    expect(pos("content")).toBeLessThan(pos("semantic_description"));
    expect(pos("title")).toBeLessThan(pos("content"));
  });

  it("slimCard keeps unknown keys (after the known ones) — loose passthrough survives reordering", () => {
    const withUnknown = { ...wireCard, brand_new_field: 42 } as unknown as TakoCard;
    const out = slimCard(withUnknown, 5) as unknown as Record<string, unknown>;
    expect(out.brand_new_field).toBe(42);
  });

  it("slimmed content serializes rows before descriptor metadata", () => {
    const out = slimCardContent(dataset([["2025-01-01", 1]]), 5);
    const keys = Object.keys(out as Record<string, unknown>);
    expect(keys.indexOf("dataset")).toBeLessThan(keys.indexOf("content_format"));
    expect(keys.indexOf("dataset")).toBeLessThan(keys.indexOf("cost"));
  });
});

describe("hoistSourceGlossary", () => {
  const para = "Consensus estimates built from detailed sell-side analyst models across sectors. ".repeat(3);

  const cardWithSource = (id: string, description: string): TakoCard =>
    ({
      card_id: id,
      title: id,
      sources: [{ source_name: "Alpha Source", source_description: description }],
    }) as unknown as TakoCard;

  it("hoists a repeated long source_description into ONE glossary entry keyed by source_name", () => {
    const { cards, glossary } = hoistSourceGlossary([
      cardWithSource("c1", para),
      cardWithSource("c2", para),
      cardWithSource("c3", para),
    ]);
    expect(glossary).toEqual({ "Alpha Source": para });
    const out = cards as unknown as Array<{ sources: Array<Record<string, unknown>> }>;
    for (const c of out) {
      // The paragraph is gone from every card; the name key survives as the
      // glossary lookup handle.
      expect(c.sources[0]).toEqual({ source_name: "Alpha Source" });
    }
  });

  it("hoists even a single occurrence (moves boilerplate behind the data)", () => {
    const { cards, glossary } = hoistSourceGlossary([cardWithSource("c1", para)]);
    expect(glossary).toEqual({ "Alpha Source": para });
    expect(
      (cards as unknown as Array<{ sources: Array<Record<string, unknown>> }>)[0]?.sources[0],
    ).not.toHaveProperty("source_description");
  });

  it("leaves short strings inline — hoisting a label costs more than it saves", () => {
    const { cards, glossary } = hoistSourceGlossary([
      cardWithSource("c1", "Short label"),
      cardWithSource("c2", "Short label"),
    ]);
    expect(glossary).toBeUndefined();
    expect(
      (cards as unknown as Array<{ sources: Array<{ source_description: string }> }>)[1]
        ?.sources[0]?.source_description,
    ).toBe("Short label");
  });

  it("hoists methodology_description keyed by methodology_name", () => {
    const method = { methodology_name: "consensus", methodology_description: para };
    const input = [
      { card_id: "a", methodologies: [method] },
      { card_id: "b", methodologies: [{ ...method }] },
    ] as unknown as TakoCard[];
    const { cards, glossary } = hoistSourceGlossary(input);
    expect(glossary).toEqual({ consensus: para });
    const out = cards as unknown as Array<{ methodologies: Array<Record<string, unknown>> }>;
    expect(out[0]?.methodologies[0]).not.toHaveProperty("methodology_description");
    expect(out[1]?.methodologies[0]).not.toHaveProperty("methodology_description");
  });

  it("keeps a same-name entry with DIFFERENT text inline (no information loss)", () => {
    const other = "A completely different but still paragraph-length source description text. ".repeat(3);
    const { cards, glossary } = hoistSourceGlossary([
      cardWithSource("c1", para),
      cardWithSource("c2", other),
    ]);
    expect(glossary).toEqual({ "Alpha Source": para });
    expect(
      (cards as unknown as Array<{ sources: Array<{ source_description: string }> }>)[1]
        ?.sources[0]?.source_description,
    ).toBe(other);
  });

  it("leaves entries without a usable name inline", () => {
    const input = [
      { card_id: "a", sources: [{ source_description: para }] },
    ] as unknown as TakoCard[];
    const { cards, glossary } = hoistSourceGlossary(input);
    expect(glossary).toBeUndefined();
    expect(
      (cards as unknown as Array<{ sources: Array<{ source_description: string }> }>)[0]
        ?.sources[0]?.source_description,
    ).toBe(para);
  });

  it("returns untouched cards by reference and never mutates inputs", () => {
    const bare = { card_id: "x", title: "no arrays" } as unknown as TakoCard;
    const hoistable = cardWithSource("c1", para);
    const { cards } = hoistSourceGlossary([bare, hoistable]);
    expect(cards[0]).toBe(bare);
    // The hoisted card is a NEW object; the original stays intact (immutability).
    expect(cards[1]).not.toBe(hoistable);
    expect(
      (hoistable as unknown as { sources: Array<{ source_description: string }> })
        .sources[0]?.source_description,
    ).toBe(para);
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
    const stale = seriesCard("stale_top", "2024-01-01T00:00:00+00:00");
    const fresh = seriesCard("fresh_second", "2026-06-01T00:00:00+00:00");
    const out = buildSearchOutput([stale, fresh], [], "req-order", null, ENV, ["data"]);
    expect(out.cards[0]?.card_id).toBe("fresh_second");
    // The chart the host renders must not disagree with the document.
    expect(out.pub_id).toBe("fresh_second");
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

describe("zero-card guidance routes to the canonical name, never to a pin", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("sends the model to tako_available_data for the exact name", () => {
    for (const sources of [["data", "web"], ["data"]] as ReadonlyArray<Array<"data" | "web">>) {
      const g = buildSearchOutput([], [], "req", null, ENV, sources).guidance ?? "";
      expect(g).toContain("tako_available_data");
      expect(g).toMatch(/canonical name/i);
    }
  });

  it("never advises a pin, because tako_search takes none after the D4 split", () => {
    // This guidance used to interpolate PINNED_RETRY. Advice for `node_ids` /
    // `strict` on a tool that rejects both is a phantom parameter, and it is
    // invisible to phantom_tool.test.ts — that guard reads published schemas
    // and descriptions, and this is a runtime VALUE.
    for (const sources of [["data", "web"], ["data"], ["web"]] as ReadonlyArray<Array<"data" | "web">>) {
      const g = buildSearchOutput([], [], "req", null, ENV, sources).guidance ?? "";
      expect(g, `sources=${sources.join(",")}`).not.toMatch(/node_ids|strict/i);
    }
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
});
