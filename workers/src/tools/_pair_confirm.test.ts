import { describe, expect, it } from "vitest";

import { metricFilter, reconcilePair } from "./_pair_confirm.js";

const node = (id: string, name: string, aliases?: string[]) => ({
  id,
  type: "metric",
  name,
  ...(aliases === undefined ? {} : { aliases }),
});

describe("metricFilter", () => {
  it("confirm mode filters by the resolved node's OWN name", () => {
    // The only string guaranteed to substring-match the node being confirmed.
    expect(
      metricFilter({
        metricQuery: "gross margin",
        resolvedName: "Gross Margin (%)",
        confident: true,
      }),
    ).toBe("Gross Margin (%)");
  });

  it("confirm mode does NOT fall back to the caller's phrase", () => {
    // Measured: "aircraft deliveries" is not a substring of Boeing's
    // "Deliveries - Aircraft", so filtering by the phrase would report a false
    // `unlinked` and unpin a handle that retrieves.
    expect(
      metricFilter({
        metricQuery: "aircraft deliveries",
        resolvedName: "Deliveries - Aircraft",
        confident: true,
      }),
    ).toBe("Deliveries - Aircraft");
  });

  it("diagnose mode filters by the query's longest token, not the wrong node", () => {
    // Rank 0 is the WRONG metric here, so filtering by its name would check
    // something nobody asked about. Measured: "R&D expense" matches nothing on
    // Pfizer; "expense" surfaces its real R&D metrics.
    expect(
      metricFilter({
        metricQuery: "R&D expense",
        resolvedName: "Operating costs and expenses",
        confident: false,
      }),
    ).toBe("expense");
  });

  it("returns exactly one filter — the probe is one round trip", () => {
    const out = metricFilter({
      metricQuery: "passenger cruise days",
      resolvedName: "Passenger Cruise Days",
      confident: true,
    });
    expect(typeof out).toBe("string");
  });

  it("drops a filter too short to be a meaningful substring match", () => {
    // A 1-2 char filter matches most of the list and tells us nothing; null
    // means the probe is skipped rather than run uselessly.
    expect(metricFilter({ metricQuery: "PE", resolvedName: "PE", confident: true })).toBeNull();
  });

  it("returns null for an empty query rather than an unfiltered drill", () => {
    expect(
      metricFilter({ metricQuery: "   ", resolvedName: null, confident: false }),
    ).toBeNull();
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
