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

import { buildSearchOutput, slimCard, slimCardContent } from "./_search_results.js";
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

describe("buildSearchOutput — zero-card guidance", () => {
  const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

  it("attaches the full anti-retry protocol when cards AND web_results are both empty", () => {
    const out = buildSearchOutput([], [], "req-1", null, ENV, ["data", "web"]);
    // The load-bearing instruction: do not re-issue reworded searches.
    expect(out.guidance).toMatch(/do not retry/i);
    expect(out.guidance).toMatch(/tako_available_data/);
  });

  it("still fires on zero cards WITH web_results — steering to the web fallback, not a re-search", () => {
    // The common default-source miss: no data card, some web hits. This is
    // exactly the "reword and retry for a chart" loop case, so guidance must
    // not be silently skipped here.
    const out = buildSearchOutput([], [{ title: "t", url: "https://x.com" }], "req-3", null, ENV, ["data", "web"]);
    expect(out.guidance).toMatch(/do not re-search/i);
    expect(out.guidance).toMatch(/web_results/);
  });

  it("tailors the both-empty protocol for a data-only search (web fallback allowed on the single retry)", () => {
    const out = buildSearchOutput([], [], "req-4", null, ENV, ["data"]);
    expect(out.guidance).toMatch(/tako_available_data/);
    expect(out.guidance).toMatch(/"web"/);
  });

  it("gives a web-only search web-shaped guidance instead of node-pinning advice", () => {
    const out = buildSearchOutput([], [], "req-5", null, ENV, ["web"]);
    expect(out.guidance).toMatch(/do not retry/i);
    expect(out.guidance).not.toMatch(/pinning node_ids/);
  });

  it("treats the legacy \"tako\" source alias as data", () => {
    const out = buildSearchOutput([], [], "req-6", null, ENV, ["tako"]);
    expect(out.guidance).toMatch(/pinning node_ids/);
  });

  it("omits guidance when any card is present", () => {
    const out = buildSearchOutput([{ card_id: "c1" }], [], "req-2", null, ENV, ["data", "web"]);
    expect(out.guidance).toBeUndefined();
  });
});
