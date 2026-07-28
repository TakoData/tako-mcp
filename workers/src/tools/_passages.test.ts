import { describe, expect, it } from "vitest";

import { extractPassages } from "./_passages.js";

// A long synthetic page: filler with two islands of relevant text far apart.
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(200); // ~12.4k chars
const PAGE = [
  FILLER,
  "Hotel occupancy improved and RevPAR reached $142.11 in Q3 2025, up 4% year over year.",
  FILLER,
  "Full-year guidance: RevPAR growth of 2-3% on flat occupancy.",
  FILLER,
].join("\n");

describe("extractPassages", () => {
  it("extracts the windows around full-phrase matches, dropping the filler", () => {
    const r = extractPassages(PAGE, "RevPAR");
    expect(r.matched).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.data).toContain("$142.11");
    expect(r.data).toContain("guidance: RevPAR growth");
    expect(r.data.length).toBeLessThan(PAGE.length / 2); // the point: most filler gone
    // The match summary rides in `note`, keeping `data` pure page text.
    expect(r.note).toContain("2 match(es)");
    expect(r.data).not.toContain("match(es)");
  });

  it("matches case-insensitively", () => {
    const r = extractPassages(PAGE, "revpar");
    expect(r.matched).toBe(true);
    expect(r.data).toContain("$142.11");
  });

  it("falls back to per-term matching when the full phrase never occurs", () => {
    const r = extractPassages(PAGE, "RevPAR occupancy 2031"); // phrase absent; terms present
    expect(r.matched).toBe(true);
    expect(r.data).toContain("$142.11");
    expect(r.note).toContain("terms of");
  });

  it("merges overlapping windows into one passage", () => {
    const text = `${"x".repeat(5000)} alpha beta ${"y".repeat(5000)}`;
    const r = extractPassages(text, "alpha beta"); // two terms 6 chars apart
    // One merged passage — the separator marker between passages is absent.
    expect(r.data).not.toContain("[…]");
    expect(r.data).toContain("alpha beta");
  });

  it("no match → explicit deterministic miss with the page head, never an empty string", () => {
    const r = extractPassages(PAGE, "zebra unicorn");
    expect(r.matched).toBe(false);
    expect(r.note).toContain("NOT FOUND");
    expect(r.note).toContain("do not refetch it with a reworded query");
    expect(r.data).toContain("lorem ipsum"); // head slice for orientation
    expect(r.truncated).toBe(true);
  });

  it("caps the passage count on a page where the query matches everywhere", () => {
    const spam = Array.from({ length: 200 }, (_v, i) => `${"z".repeat(4000)} target ${i}`).join("\n");
    const r = extractPassages(spam, "target");
    expect(r.matched).toBe(true);
    // 8-passage ceiling → far smaller than the source.
    expect(r.data.length).toBeLessThan(spam.length / 3);
    expect(r.truncated).toBe(true);
  });

  it("not truncated when the windows cover the whole (short) text", () => {
    const r = extractPassages("RevPAR was up.", "RevPAR");
    expect(r.matched).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.data).toContain("RevPAR was up.");
  });

  it("a common early term never starves a rare late term out of the passages (review regression)", () => {
    // 100 early "occupancy" hits could consume a pooled position-sorted match
    // budget before the single late "RevPAR" hit is considered — returning
    // matched:true WITHOUT the answer-bearing passage. The budget is split
    // per term precisely so the rare term always contributes its window.
    const commonHalf = Array.from(
      { length: 100 },
      () => `${"z".repeat(2400)} occupancy was steady `,
    ).join("");
    const doc = `${commonHalf}${"z".repeat(5000)} RevPAR reached $142.11 in Q3. ${"z".repeat(2000)}`;
    const r = extractPassages(doc, "RevPAR occupancy 2031"); // phrase absent → per-term tier
    expect(r.matched).toBe(true);
    expect(r.data).toContain("$142.11");
  });

  it("window SELECTION is term-fair too: many spaced-out common windows can't crowd out the rare term's window (review round 2)", () => {
    // Reviewer's exact repro: 12 "occupancy" hits spaced 4000 chars apart —
    // wider than the merge span, so each stays its own window. A positional
    // windows.slice(0, 8) kept only common windows and dropped the late
    // RevPAR one. selectWindows must hand every term a window first.
    const spaced = Array.from(
      { length: 12 },
      () => `${"z".repeat(4000)} occupancy held `,
    ).join("");
    const doc = `${spaced}${"z".repeat(4000)} RevPAR reached $142.11 in Q3. ${"z".repeat(1000)}`;
    const r = extractPassages(doc, "RevPAR occupancy 2031");
    expect(r.matched).toBe(true);
    expect(r.data).toContain("$142.11");
    // Still bounded: at most 8 passages.
    expect((r.data.match(/\[…\]/g) ?? []).length).toBeLessThanOrEqual(7);
  });

  it("the '+' saturation marker only appears when matches were actually dropped", () => {
    const exactly64 = Array.from({ length: 64 }, () => "target, ").join("");
    const r64 = extractPassages(exactly64, "target");
    expect(r64.note).toContain("64 match(es)");
    expect(r64.note).not.toContain("64+");

    const more = Array.from({ length: 70 }, () => "target, ").join("");
    const r70 = extractPassages(more, "target");
    expect(r70.note).toContain("64+ match(es)");
  });
});
