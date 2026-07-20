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

import { slimCardContent } from "./_search_results.js";
import type { ResultContent } from "./_search_results.js";

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
