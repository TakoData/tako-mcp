/**
 * Tests for the relevance gate.
 *
 * Every case here is a REAL candidate observed from `/api/beta/graph/search`
 * on staging (2026-07-29), not an invented string — the gate exists to fix
 * measured failures, so it is pinned against them.
 */
import { describe, expect, it } from "vitest";

import { confidentMatch, gateCandidates, matchTokens, plausibleMatch } from "./_match_gate.js";

const name = (n: string, aliases?: string[]) => (aliases ? { name: n, aliases } : { name: n });

describe("matchTokens", () => {
  it("folds diacritics so Nestle matches Nestlé", () => {
    expect(matchTokens("Nestlé S.A.")).toEqual(matchTokens("Nestle SA"));
  });

  it("merges dotted initialisms so the suffix can be recognised as noise", () => {
    // "S.A." splits to ["s","a"]; merged to "sa" it is a corporate suffix.
    expect([...matchTokens("Nestlé S.A.")]).toEqual(["nestle"]);
  });

  it("does NOT fuse domains — netflix.com stays two tokens", () => {
    // Guards the run-length merge against the tempting global dot-strip, which
    // would make "netflixcom" and stop it matching "Netflix, Inc.".
    expect([...matchTokens("netflix.com")].sort()).toEqual(["com", "netflix"]);
    expect(plausibleMatch("netflix.com", name("Netflix, Inc."))).toBe(true);
  });

  it("drops corporate noise but keeps distinguishing words like 'group'", () => {
    expect([...matchTokens("UnitedHealth Group Incorporated")].sort()).toEqual([
      "group",
      "incorporated",
      "unitedhealth",
    ]);
    expect([...matchTokens("Apple Inc.")]).toEqual(["apple"]);
  });
});

describe("plausibleMatch — rejects the measured false positives", () => {
  // Each of these produced a confident `found: true` about the wrong company.
  it.each([
    ["Carnival Corporation", "Cuscal Limited"],
    ["UnitedHealth Group", "Blackstone Inc."],
    ["UnitedHealth Group", "SoftBank Group Corp."],
    ["X Corp", "ASICS Corporation"],
    ["Elon Musk", "Elon, NC"],
    ["Taylor Swift", "Taylor Walls"],
    ["the vibes of tuesday", "Tuesday Morning Corporation"],
    ["my neighbors dog", "Bellefontaine Neighbors, MO"],
    ["Zzzqq Industries", "Daikin Industries,Ltd."],
    ["number of unicorns", "Colombia Number Of Customers"],
  ])("rejects q=%s → %s", (q, candidate) => {
    expect(plausibleMatch(q, name(candidate))).toBe(false);
  });
});

describe("plausibleMatch — accepts the measured true positives", () => {
  it("query ⊆ candidate: a bare name matches the fuller legal name", () => {
    expect(plausibleMatch("Carnival", name("Carnival Corporation Ltd."))).toBe(true);
    expect(plausibleMatch("UnitedHealth Group", name("UnitedHealth Group Incorporated"))).toBe(true);
  });

  it("candidate ⊆ query: a phrase matches the metric inside it", () => {
    // The direction that makes `metric="Carnival passenger cruise days"` work.
    expect(plausibleMatch("Carnival passenger cruise days", name("Passenger Cruise Days"))).toBe(true);
  });

  // Aliases are load-bearing, not a refinement: this candidate shares ZERO
  // name tokens with the query and is the correct answer.
  it("matches through aliases when the name shares nothing (SpaceX)", () => {
    const spacex = name("Space Exploration Technologies Corp.", [
      "Space Exploration Technologies",
      "SpaceX",
      "SpaceX Starship",
    ]);
    expect(plausibleMatch("SpaceX", spacex)).toBe(true);
    expect(plausibleMatch("SpaceX", name("Space Exploration Technologies Corp."))).toBe(false);
  });

  it("matches a ticker through aliases", () => {
    expect(
      plausibleMatch("UNH", name("UnitedHealth Group Incorporated", ["UHG", "UNH", "UnitedHealth"])),
    ).toBe(true);
  });

  it("matches across diacritics", () => {
    expect(plausibleMatch("Nestle", name("Nestlé S.A.", ["Nestle", "Nestlé"]))).toBe(true);
  });

  it("never matches on an empty or punctuation-only query", () => {
    expect(plausibleMatch("", name("Apple Inc."))).toBe(false);
    expect(plausibleMatch("...", name("Apple Inc."))).toBe(false);
  });
});

describe("gateCandidates", () => {
  it("keeps plausible candidates in the backend's order", () => {
    // Delta is the case with NO rank-independent tiebreak — both candidates
    // pass and both carry an exact alias "Delta", so order must be preserved.
    const candidates = [
      name("Delta Air Lines, Inc.", ["Delta", "DAL"]),
      name("Delta Corp Limited", ["Delta", "DCL"]),
    ];
    const { kept, gated } = gateCandidates("Delta", candidates);
    expect(gated).toBe(true);
    expect(kept.map((c) => c.name)).toEqual(["Delta Air Lines, Inc.", "Delta Corp Limited"]);
  });

  it("drops the impostor but keeps the real match (the Carnival ordering)", () => {
    const { kept } = gateCandidates("Carnival Corporation", [
      name("Carnival, Inc."),
      name("Cuscal Limited"),
      name("Carnival Corporation Ltd.", ["CCL", "Carnival Ltd."]),
    ]);
    expect(kept.map((c) => c.name)).toEqual(["Carnival, Inc.", "Carnival Corporation Ltd."]);
  });

  // The fail-open contract: too-strict is allowed to degrade to today's
  // behaviour, never to a false "Tako has no data on X".
  it("fails OPEN — returns everything when nothing is plausible", () => {
    const candidates = [name("Cuscal Limited"), name("WW International, Inc.")];
    const { kept, gated } = gateCandidates("Carnival", candidates);
    expect(gated).toBe(false);
    expect(kept).toHaveLength(2);
  });
});

// The alias data is genuinely poisoned in places, so a name match must outrank
// an alias match. Observed on staging: `Cuscal Limited` (an Australian
// payments company) carries the aliases "Carnival Corp", "Carnival
// Corporation", "Carnival Cruise" — treating names and aliases alike ranked it
// ABOVE the real Carnival Corporation and produced `found: true` about Cuscal.
describe("gateCandidates — name matches outrank alias matches", () => {
  const cuscal = {
    name: "Cuscal Limited",
    aliases: ["Carnival Corp", "Carnival Corporation", "Carnival Cruise"],
  };
  const carnival = { name: "Carnival Corporation", aliases: ["Carnival"] };

  it("demotes an alias-only match below a real name match", () => {
    const { kept } = gateCandidates("Carnival Corporation", [cuscal, carnival]);
    expect(kept.map((c) => c.name)).toEqual(["Carnival Corporation", "Cuscal Limited"]);
  });

  it("still uses an alias match when no name match exists (SpaceX)", () => {
    const spacex = {
      name: "Space Exploration Technologies Corp.",
      aliases: ["SpaceX", "Space Exploration Technologies"],
    };
    const { kept, gated } = gateCandidates("SpaceX", [spacex]);
    expect(gated).toBe(true);
    expect(kept.map((c) => c.name)).toEqual(["Space Exploration Technologies Corp."]);
  });
});

// Confidence is a stricter question than "worth showing". An alias BROADER
// than the query is not evidence: `metric="index level"` reported found:true
// via `Employment Index`, whose alias `employment level index` is a superset.
// But requiring a NAME match instead would break every abbreviation —
// measured, ROA / P/E ratio / FCF / capex are all alias-only with no name
// match at all, and every one has alias ⊆ query.
describe("confidentMatch", () => {
  it("rejects an alias broader than the query", () => {
    expect(
      confidentMatch("index level", {
        name: "Employment Index",
        aliases: ["employment level index", "jobs index"],
      }),
    ).toBe(false);
  });

  it("accepts an abbreviation alias narrower than the query", () => {
    expect(confidentMatch("ROA", { name: "Return on Assets", aliases: ["ROA"] })).toBe(true);
    expect(
      confidentMatch("P/E ratio", { name: "Price to Earnings (P/E)", aliases: ["P/E"] }),
    ).toBe(true);
    expect(confidentMatch("capex", { name: "Capital Expenditure", aliases: ["CAPEX"] })).toBe(true);
  });

  it("still accepts a NAME match in either direction", () => {
    // A name containing the query is a specialisation of what was asked.
    expect(confidentMatch("gross margin", { name: "Gross Margin (%)" })).toBe(true);
    expect(confidentMatch("revenue", { name: "Avnet Revenue Total Revenue" })).toBe(true);
  });

  it("rejects when nothing matches on any surface", () => {
    expect(confidentMatch("number of unicorns", { name: "Concentra Number Of Visits" })).toBe(false);
  });
});
