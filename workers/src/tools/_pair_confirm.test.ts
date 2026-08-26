import { describe, expect, it } from "vitest";

import { metricFilter, metricFilters, PAIR_ENTITY_PROBES, reconcilePair } from "./_pair_confirm.js";

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

  it("confident + id on the entity's complete list → pair", () => {
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: gm,
      verbatim: [],
      scoped: [node("mt::other::1", "Revenues"), gm],
      complete: true,
    });
    expect(out.verified).toBe("pair");
  });

  it("a FOUND node is pair even when the page was truncated", () => {
    // Truncation cannot un-prove a positive: the id is on the list either way.
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: gm,
      verbatim: [],
      scoped: [gm],
      complete: false,
    });
    expect(out.verified).toBe("pair");
  });

  it("confident + absent from a COMPLETE list → unlinked", () => {
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      verbatim: [],
      scoped: [node("mt::revenues::2", "Revenues")],
      complete: true,
    });
    expect(out.verified).toBe("unlinked");
  });

  it("confident + absent from a TRUNCATED list → resolution, never a false unlinked", () => {
    // Measured on prod: `q="Backlog"` scoped to Lockheed fills the page and
    // returns a next_cursor, because the filter is a substring match and the
    // entity holds `12 Month Backlog`, `90 Day Backlog`, `AA&S Backlog`, ...
    // The node may sit on page 2, so `unlinked` would drop the pin and print
    // "the graph holds no edge ... report the gap" on evidence we do not have.
    const out = reconcilePair({
      metricQuery: "backlog",
      globalMetric: node("mt::backlog::1", "Backlog"),
      verbatim: [],
      scoped: [node("mt::b12::2", "12 Month Backlog")],
      complete: false,
    });
    expect(out.verified).toBe("resolution");
  });

  it("matches by ID ONLY — a same-named twin is not confirmation", () => {
    // The name-equality arm was measured dead (0 of 18 pair verdicts) while
    // still able to fire on KE-812 twins: same name, different id, only one
    // carrying cards. That would report `pair` for a node whose id is NOT the
    // id next_call pins.
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: node("mt::gross_margin::9", "Gross Margin (%)"),
      verbatim: [],
      scoped: [node("mt::gross_margin_TWIN::4", "Gross Margin (%)")],
      complete: true,
    });
    expect(out.verified).toBe("unlinked");
  });

  it("unvetted rank 0 → resolution, NOT unlinked, even with scoped matches", () => {
    // Nothing about linkage is established on this path: there is no pinned
    // node, and the filter was chosen for near-miss recall. Claiming the
    // entity's list "holds nothing matching" while several entries sit in
    // entityMetricMatches is the contradiction this fixes.
    const opex = node("mt::opex::1", "Operating costs and expenses");
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: opex,
      verbatim: [],
      scoped: [opex, node("mt::rd::3", "R&D Expenses (Normalized)")],
      complete: true,
    });
    expect(out.verified).toBe("resolution");
  });

  it("NEVER pins a node off the entity's list, however well it matches", () => {
    // Regression guard for the removed re-pin branch: Netflix's own metrics
    // relation contains `Disney Core Paid Subscribers`, which passes
    // confidentMatch.
    const out = reconcilePair({
      metricQuery: "paid subscribers",
      globalMetric: node("mt::top_paid::1", "Top Paid"),
      verbatim: [],
      scoped: [node("mt::disney::2", "Disney Core Paid Subscribers")],
      complete: true,
    });
    expect(out).not.toHaveProperty("metric");
    expect(out).not.toHaveProperty("repinned");
    expect(out.verified).toBe("resolution");
  });

  it("no global metric → resolution", () => {
    const out = reconcilePair({
      metricQuery: "gross margin",
      globalMetric: null,
      verbatim: [],
      scoped: [gm],
      complete: true,
    });
    expect(out.verified).toBe("resolution");
  });

  it("carries near-miss metrics on ANY handle-withholding verdict", () => {
    // They are the whole payload when no handle is emitted, so they must
    // survive the `resolution` verdict too.
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: node("mt::opex::1", "Operating costs and expenses"),
      verbatim: [],
      scoped: [node("mt::rd::2", "R&D Expenses (Normalized)"), node("mt::rev::3", "Revenues")],
      complete: true,
    });
    expect(out.verified).toBe("resolution");
    expect(out.entityMetricMatches.map((n) => n.name)).toEqual([
      "R&D Expenses (Normalized)",
      "Revenues",
    ]);
  });

  it("orders near-misses by query overlap, not backend order", () => {
    // The list is sliced to 3 and is the whole payload on this path. Measured,
    // `q="expense"` on Pfizer returns the generic expense metrics first and
    // buries the R&D one the caller asked about.
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: node("mt::opex::1", "Operating costs and expenses"),
      verbatim: [],
      scoped: [
        node("mt::adv::1", "Advertising Expense (Normalized)"),
        node("mt::accr::2", "Change in Accrued Expenses"),
        node("mt::opex::3", "Operating costs and expenses"),
        node("mt::rd::4", "R&D Expenses (Normalized)"),
      ],
      complete: true,
    });
    expect(out.entityMetricMatches[0]?.name).toBe("R&D Expenses (Normalized)");
  });
});

describe("metricFilters", () => {
  it("sends the caller's phrase verbatim plus today's fallback when they differ", () => {
    expect(metricFilters({ metricQuery: "data center revenue", resolvedName: "Revenues", confident: false }))
      .toEqual({ verbatim: "data center revenue", fallback: "revenue" });
    expect(metricFilters({ metricQuery: "gross margin", resolvedName: "Gross Margin (%)", confident: true }))
      .toEqual({ verbatim: "gross margin", fallback: "Gross Margin (%)" });
  });
  it("collapses to one filter when the two are the same string (single-token confident case)", () => {
    expect(metricFilters({ metricQuery: "backlog", resolvedName: "Backlog", confident: true }))
      .toEqual({ verbatim: "backlog", fallback: null });
    expect(metricFilters({ metricQuery: "revenue", resolvedName: "Revenues", confident: false }))
      .toEqual({ verbatim: "revenue", fallback: null });
  });
  it("drops a verbatim phrase shorter than the minimum filter length", () => {
    expect(metricFilters({ metricQuery: "gm", resolvedName: "Gross Margin", confident: true }))
      .toEqual({ verbatim: null, fallback: "Gross Margin" });
  });
  it("probes two entities", () => {
    expect(PAIR_ENTITY_PROBES).toBe(2);
  });
});

describe("reconcilePair — metricList", () => {
  const metric = (id: string, name: string) => ({ id, type: "metric", name });
  it("returns the verbatim hits as the list, deduped by id, and still judges the pin off the union", () => {
    const rev = metric("mt::rev::1", "Revenues");
    const out = reconcilePair({
      metricQuery: "revenue",
      globalMetric: { ...rev, aliases: ["Revenue"] },
      verbatim: [metric("mt::dc::1", "Total revenue - Data center"), rev],
      scoped: [rev, metric("mt::dc::1", "Total revenue - Data center")],
      complete: true,
    });
    expect(out.verified).toBe("pair");
    expect(out.metricList.map((n) => n.id)).toEqual(["mt::dc::1", "mt::rev::1"]);
  });
  it("an empty verbatim list yields an empty metricList even when the fallback found near-misses", () => {
    const out = reconcilePair({
      metricQuery: "R&D expense",
      globalMetric: metric("mt::opex::1", "Operating costs and expenses"),
      verbatim: [],
      scoped: [metric("mt::rd::1", "R&D Expenses (Normalized)")],
      complete: true,
    });
    expect(out.metricList).toEqual([]);
    expect(out.entityMetricMatches.map((n) => n.name)).toEqual(["R&D Expenses (Normalized)"]);
  });
});
