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
    // The resolved name is deliberately ABSENT here: in rescue mode rank 0
    // failed the name test, so filtering by it would look for the wrong metric.
    // "R&D expense" is not a substring of "Research & development expense
    // (R&D) - Americas" — the bare token is what finds it.
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
    expect(out.metric?.id).toBe("mt::gross_margin::9");
    expect(out.repinned).toBe(false);
  });

  it("confident + absent from the entity's list → unlinked, pin unchanged", () => {
    // Lockheed / backlog: the name fits, the graph holds no edge. `found` must
    // NOT be vetoed by this — near-duplicate metric nodes (KE-812) mean the
    // twin carrying the edge may not be the twin that resolved.
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      scoped: [node("mt::revenues::2", "Revenues")],
    });
    expect(out.verified).toBe("unlinked");
    expect(out.metric?.id).toBe("mt::backlog::1");
    expect(out.repinned).toBe(false);
  });

  it("matches on node NAME as well as id, so an id-space mismatch is not a false 'unlinked'", () => {
    // graph/search and graph/related are assumed to share an id space. If they
    // ever do not, id-only matching would report `unlinked` for EVERY pair — a
    // systematic false negative. Name equality is the cheap backstop.
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: node("mt::gross_margin::9", "Gross Margin (%)"),
      scoped: [node("relation-item-7", "Gross Margin (%)")],
    });
    expect(out.verified).toBe("pair");
  });

  it("NOT confident + a confident node on the entity's list → re-pin", () => {
    // The Pfizer repair: the global search ranked `Operating costs and
    // expenses` first; Pfizer's own metric list holds the real one.
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: node("mt::opex::1", "Operating costs and expenses"),
      scoped: [
        node("mt::rd_americas::2", "Research & development expense (R&D) - Americas"),
      ],
    });
    expect(out.verified).toBe("pair");
    expect(out.metric?.id).toBe("mt::rd_americas::2");
    expect(out.repinned).toBe(true);
  });

  it("linkage NEVER vouches for a node that failed the name test", () => {
    // Pfizer really does have `Operating costs and expenses`. Confirming the
    // edge for a node that does not answer the question would convert a wrong
    // pin into a CONFIDENT wrong pin — strictly worse than today.
    const opex = node("mt::opex::1", "Operating costs and expenses");
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: opex,
      scoped: [opex, node("mt::revenues::3", "Revenues")],
    });
    expect(out.verified).toBe("unlinked");
    expect(out.repinned).toBe(false);
    expect(out.metric?.id).toBe("mt::opex::1");
  });

  it("rescues when the global metric probe found nothing at all", () => {
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: null,
      scoped: [gm],
    });
    expect(out.verified).toBe("pair");
    expect(out.metric?.id).toBe("mt::gross_margin::9");
    expect(out.repinned).toBe(true);
  });

  it("no global metric and nothing scoped → still no metric", () => {
    const out = reconcilePair({
      metricQuery: "quantum flux capacity",
      globalMetric: null,
      scoped: [],
    });
    expect(out.metric).toBeNull();
    expect(out.verified).toBe("unlinked");
  });

  it("carries the entity's near-miss metrics so the caller can pick deliberately", () => {
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      scoped: [node("mt::orders::2", "Order Intake"), node("mt::rev::3", "Revenues")],
    });
    expect(out.entityMetricMatches.map((n) => n.name)).toEqual([
      "Order Intake",
      "Revenues",
    ]);
  });

  it("an alias-only confident scoped node still rescues", () => {
    // capex → `Capital Expenditure` is alias-only with no name overlap.
    const out = reconcilePair({
      metricQuery: "capex",
      globalMetric: node("mt::wrong::1", "Capital Structure"),
      scoped: [node("mt::capex::2", "Capital Expenditure", ["capex"])],
    });
    expect(out.verified).toBe("pair");
    expect(out.metric?.id).toBe("mt::capex::2");
  });
});
