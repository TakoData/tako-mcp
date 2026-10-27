/**
 * Unit tests for `slimCardContent` — the inline-preview row cap.
 *
 * The cap must keep the MOST-RECENT rows regardless of backend sort order:
 * timeseries cards arrive ascending (newest last), stock cards descending
 * (newest first). A blind tail slice drops the latest value on stock cards —
 * the correctness bug these tests pin. Also covers the json_records slice branch
 * and the CSV content_format guard (both previously untested).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TOOL_REGISTRY } from "./_registry.js";

import { ContentItem } from "../generated/schemas.js";

import { searchAdvancedOutputShape } from "./_render_markdown.js";

import {
  CONTENT_META_KEYS,
  CONTENT_PAYLOAD_KEYS,
  buildReferenceMaps,
  buildSearchOutput,
  cardCharts,
  projectCard,
  projectCardRows,
  projectWebResult,
  slimCardContent,
  WITHHELD_CELLS_GUIDANCE,
} from "./_search_results.js";
import type {
  ResultContent,
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
// buildSearchOutput tests below, which exercise guidance and card order rather
// than the `tako_search_advanced` inline path.
const OPTS = { rowCap: null, keepWebText: false, toolName: "tako_search", premiumGuidance: WITHHELD_CELLS_GUIDANCE } as const;

describe("buildSearchOutput — zero-card guidance", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
  const WEB: WebResult[] = [{ title: "t", url: "https://x.com" }];

  it("attaches no guidance to an unpinned zero-card result", () => {
    for (const web of [[], WEB]) {
      for (const tier of ["free", "authenticated"] as const) {
        for (const extras of [{}, { answer: "No figure found." }]) {
          const out = buildSearchOutput([], web, "req", null, ENV, false, tier, OPTS, extras);
          const label = `web=${web.length} tier=${tier} answer=${"answer" in extras}`;
          expect(out.guidance, label).toBeUndefined();
        }
      }
    }
  });

  it("blames the FILTER, not coverage, when the request carried a strict pin", () => {
    // Reachable only from tako_search_advanced. Without this branch the model
    // gets an empty `cards` list and no guidance after a hard filter returned
    // nothing, and reads it as a coverage gap — a verdict the request cannot
    // support (KE-812: pinned handles returned FEWER cards on 11 of 20 pairs),
    // and one that contradicts that tool's own description.
    const g = buildSearchOutput([], [], "req", null, ENV, true, "authenticated", OPTS).guidance ?? "";
    expect(g).toMatch(/hard filter/i);
    expect(g).toMatch(/node_ids/);
  });

  it("omits guidance when any card is present", () => {
    const out = buildSearchOutput([{ card_id: "c1" }], [], "req-2", null, ENV, false, "authenticated", OPTS);
    expect(out.guidance).toBeUndefined();
  });
});

describe("buildSearchOutput — withheld cells", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
  const peopleCard = (premium: boolean, premiumRows: Record<string, number> | null) =>
    ({
      card_id: "people",
      content: { cost: 0.001, total_rows: 2, truncated: false, premium, premium_rows: premiumRows },
    }) as unknown as TakoCard;

  it("tells a signed-in caller how to get a card's withheld cells", () => {
    const out = buildSearchOutput([peopleCard(false, { person_contact: 2 })], [], "r", null, ENV, false, "authenticated", OPTS);
    expect(out.guidance).toBe(WITHHELD_CELLS_GUIDANCE);
  });

  it("says nothing on a surface whose tako_contents has no premium input", () => {
    const out = buildSearchOutput([peopleCard(false, { person_contact: 2 })], [], "r", null, ENV, false, "authenticated", {
      ...OPTS,
      premiumGuidance: null,
    });
    expect(out.guidance).toBeUndefined();
  });

  it("says nothing to a keyless caller, who can't call tako_contents", () => {
    const out = buildSearchOutput([peopleCard(false, { person_contact: 2 })], [], "r", null, ENV, false, "free", OPTS);
    expect(out.guidance).toBeUndefined();
  });

  it("says nothing when no cell is withheld or the cells are already revealed", () => {
    for (const card of [peopleCard(false, null), peopleCard(false, { person_contact: 0 }), peopleCard(true, { person_contact: 2 })]) {
      expect(buildSearchOutput([card], [], "r", null, ENV, false, "authenticated", OPTS).guidance).toBeUndefined();
    }
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

describe("buildSearchOutput keeps search's card order", () => {
  it("lists and charts the cards in the order search returned them", () => {
    const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
    const first = { card_id: "stale_first", title: "Stale series", data_freshness: { data_as_of: "2024-01-01" } } as TakoCard;
    const second = { card_id: "fresh_second", title: "Fresh series", data_freshness: { data_as_of: "2026-09-01" } } as TakoCard;
    const out = buildSearchOutput([first, second], [], "req-order", null, ENV, false, "authenticated", OPTS);
    expect(out.cards.map((c) => c.title)).toEqual(["Stale series", "Fresh series"]);
    expect(out.pub_id).toBe("stale_first");
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

  // Driven through `buildSearchOutput`, not `projectCardRows`: the breadcrumb
  // is only as good as what the PRODUCTION caller threads in, and the unit
  // takes `log` optionally. Asserting on the unit with a hand-built `log`
  // would pass with nothing wired at line 1759.
  //
  // This is the one guard that discards a payload the caller was BILLED for
  // while still answering 200, so an anonymous line here costs an on-call the
  // only route back to the backend request (`_log.ts`).
  it("names the tool and the request when it drops a billed row payload", () => {
    const badRow = {
      card_id: "c1",
      exportable: true,
      content: {
        content_format: "json_compact",
        total_rows: 2,
        dataset: { columns: [{ name: "v" }], rows: [[1], "oops"] },
      },
    } as unknown as TakoCard;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      const out = buildSearchOutput(
        [badRow],
        [],
        "req-drop-1",
        null,
        { DJANGO_BASE_URL: "https://staging.trytako.com" },
        false,
        "authenticated",
        { rowCap: "all", keepWebText: false, toolName: "tako_search_advanced", premiumGuidance: WITHHELD_CELLS_GUIDANCE },
      );
      expect(out.cards[0]?.rows, "the bad payload is still dropped").toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const line = errors.find((e) => e.includes("wire-guard failed"));
    expect(line, "the drop must leave a breadcrumb").toBeDefined();
    expect(line).toContain("tool=tako_search_advanced");
    expect(line).toContain("request_id=req-drop-1");
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

describe("cardCharts", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("cardCharts skips a card with no card_id and keeps the others in order", () => {
    const charts = cardCharts([{ card_id: "a" }, { card_id: null }, { card_id: "c" }], ENV);
    expect(charts.map((c) => c.pub_id)).toEqual(["a", "c"]);
  });

  it("the top-level chart fields describe the first chart", () => {
    const out = buildSearchOutput(
      [{ card_id: "a" }, { card_id: "b" }],
      [],
      "req-charts",
      null,
      ENV,
      false,
      "authenticated",
      OPTS,
    );
    expect(out.charts?.length).toBe(2);
    expect(out.pub_id).toBe(out.charts?.[0]?.pub_id);
    expect(out.embed_url).toBe(out.charts?.[0]?.embed_url);
    expect(out.image_url).toBe(out.charts?.[0]?.image_url);
  });

  it("renders no chart when search's first card has no card_id", () => {
    const out = buildSearchOutput(
      [{ card_id: null }, { card_id: "b" }],
      [],
      "req-chartless-first",
      null,
      ENV,
      false,
      "authenticated",
      OPTS,
    );
    expect(out.pub_id).toBeUndefined();
    expect(out.embed_url).toBeUndefined();
    expect(out.charts).toBeUndefined();
  });

  it("a zero-card result carries no charts", () => {
    const out = buildSearchOutput([], [], "req-none", null, ENV, false, "authenticated", OPTS);
    expect(out.charts).toBeUndefined();
  });
});
