import { describe, expect, it } from "vitest";

import { listDiff } from "./list-diff.js";

describe("listDiff", () => {
  it("names what was dropped and what was added", () => {
    expect(listDiff(["name", "status", "ticker"], ["name", "ticker", "stock_symbol"])).toBe(
      "the API dropped [status] and added [stock_symbol]",
    );
  });

  it("prints both orders when the names match and only the order moved", () => {
    expect(listDiff(["name", "status", "ticker"], ["name", "ticker", "status"])).toBe(
      "the API returns the same names in a different order: expected [name, status, ticker], got [name, ticker, status]",
    );
  });
});
