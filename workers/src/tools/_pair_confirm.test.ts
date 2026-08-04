import { describe, expect, it } from "vitest";

import {
  MAX_FILTER_VARIANTS,
  filterVariants,
  reconcilePair,
} from "./_pair_confirm.js";

const node = (id: string, name: string, aliases?: string[]) => ({
  id,
  type: "metric",
  name,
  ...(aliases === undefined ? {} : { aliases }),
});

describe("filterVariants", () => {
  it("confirm mode leads with the resolved node's own name", () => {
    // graph/related's `q` is a SUBSTRING filter, so the exact resolved name is
    // the one string guaranteed to match the node we are trying to confirm.
    expect(
      filterVariants({
        metricQuery: "gross margin",
        resolvedName: "Gross Margin (%)",
        confident: true,
      }),
    ).toEqual(["Gross Margin (%)", "gross margin"]);
  });

  it("rescue mode leads with the caller's phrase, then its longest token", () => {
    // "Rescue" now means SURFACING near-misses for the caller to choose from,
    // never auto-pinning one. The resolved name is deliberately absent: rank 0
    // failed the name test, so filtering by it would look for the wrong metric.
    // Measured on prod, this is what finds Pfizer's real R&D metrics — "R&D
    // expense" is not a substring of "R&D Expenses (Normalized)".
    expect(
      filterVariants({
        metricQuery: "R&D expense",
        resolvedName: "Operating costs and expenses",
        confident: false,
      }),
    ).toEqual(["R&D expense", "expense"]);
  });

  it("never exceeds MAX_FILTER_VARIANTS", () => {
    const out = filterVariants({
      metricQuery: "passenger cruise days",
      resolvedName: "Passenger Cruise Days",
      confident: true,
    });
    expect(out.length).toBeLessThanOrEqual(MAX_FILTER_VARIANTS);
  });

  it("dedupes case-insensitively rather than spending a round trip twice", () => {
    expect(
      filterVariants({
        metricQuery: "Revenues",
        resolvedName: "revenues",
        confident: true,
      }),
    ).toEqual(["revenues"]);
  });

  it("drops variants too short to be a meaningful substring filter", () => {
    // A 1-2 char filter matches most of the list and tells us nothing.
    expect(
      filterVariants({ metricQuery: "PE", resolvedName: null, confident: false }),
    ).toEqual([]);
  });

  it("returns no variants for an empty query rather than an unfiltered drill", () => {
    expect(
      filterVariants({ metricQuery: "   ", resolvedName: null, confident: false }),
    ).toEqual([]);
  });
});

describe("reconcilePair", () => {
  const gm = node("mt::gross_margin::9", "Gross Margin (%)");

  it("confident + present on the entity's list → pair", () => {
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: gm,
      scoped: [node("mt::other::1", "Revenues"), gm],
    });
    expect(out.verified).toBe("pair");
  });

  it("confident + absent from the entity's list → unlinked", () => {
    // Lockheed / backlog: the name fits and the graph holds no edge. Measured
    // on prod — Lockheed has `12 Month Backlog`, not the generic `Backlog`.
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      scoped: [node("mt::revenues::2", "Revenues")],
    });
    expect(out.verified).toBe("unlinked");
  });

  it("matches on node NAME as well as id, so an id-space mismatch is not a false 'unlinked'", () => {
    // graph/search and graph/related are assumed to share an id space. If they
    // ever do not, id-only matching would report `unlinked` for EVERY pair — a
    // systematic false negative that would unpin every handle the tool emits.
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: node("mt::gross_margin::9", "Gross Margin (%)"),
      scoped: [node("relation-item-7", "Gross Margin (%)")],
    });
    expect(out.verified).toBe("pair");
  });

  it("NEVER pins a node off the entity's list, however well it matches", () => {
    // THE regression guard for the removed re-pin branch. Measured on prod
    // (24 pairs, 2026-08-04): Netflix's own metrics relation contains
    // `Disney Core Paid Subscribers` and Walmart's contains
    // `5G Telco Edge IoT Revenue Total Revenue`, both passing confidentMatch.
    // Choosing from a relation that noisy converted "no handle" into a
    // confidently wrong PRICED call.
    const out = reconcilePair({
      metricQuery: "paid subscribers",
      globalMetric: node("mt::top_paid::1", "Top Paid"),
      scoped: [node("mt::disney::2", "Disney Core Paid Subscribers")],
    });
    expect(out).not.toHaveProperty("metric");
    expect(out).not.toHaveProperty("repinned");
    expect(out.verified).toBe("unlinked");
  });

  it("linkage NEVER vouches for a node that failed the name test", () => {
    // Pfizer really does have `Operating costs and expenses`, so confirming its
    // edge for an R&D question would be a confident wrong pin.
    const opex = node("mt::opex::1", "Operating costs and expenses");
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: opex,
      scoped: [opex, node("mt::revenues::3", "Revenues")],
    });
    expect(out.verified).toBe("unlinked");
  });

  it("no global metric → unlinked, and nothing is invented", () => {
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: null,
      scoped: [gm],
    });
    expect(out.verified).toBe("unlinked");
  });

  it("carries the entity's near-miss metrics so the caller can pick deliberately", () => {
    // The genuinely useful half of an unlinked verdict — naming what the entity
    // DOES hold, for the caller to pin deliberately.
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      scoped: [node("mt::b12::2", "12 Month Backlog"), node("mt::rev::3", "Revenues")],
    });
    expect(out.entityMetricMatches.map((n) => n.name)).toEqual([
      "12 Month Backlog",
      "Revenues",
    ]);
  });
});
