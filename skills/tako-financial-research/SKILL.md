---
name: tako-financial-research
description: >-
  Use when the user asks what a company's financial metric is or was (revenue, margins, EPS, cash flow, valuation, stock price, analyst estimates), compares companies on a metric, asks who a company competes with or what data exists on it, or wants a financial chart — including private companies and crypto spot prices. Returns the figures as structured, citation-backed data from Tako (S&P Global, Fiscal.ai, Visible Alpha, Xignite and others), each with a chart. Company-level data only, not country indicators or website traffic.
---

# Financial Research (Tako)

Tako serves company financials as structured, cited data: each result is a card carrying the headline value, the underlying rows, and a chart of the series. All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields and the zero-card recovery; this skill covers what they can't: how to shape a financial query, which card to trust, and how to report.

## Workflow

1. **Shape the query as ENTITY + METRIC**, one pair per call: `"Nvidia revenue"`, `"Tesla free cash flow"`. Add `quarterly` or `annual` to steer the period. A compound question ("Nvidia revenue and margins") returns cards for some parts and silently drops the rest, so split it and run the calls in parallel.
2. **Call `tako_search`** with the default sources (data + web). Web results carry the qualitative half and the facts the graph doesn't hold (earnings dates, management commentary, companies with no filings or coverage), at no extra cost. Narrow to `["data"]` only in a parallel fan-out where ten web results per call would swamp context.
3. **Pick the card** with the checklist below. The top card renders inline automatically; if the right card is elsewhere, link its title to its `url` and say it is the authoritative one.
4. **Read the figure from the card's `description`.** It holds the headline value. Fetch the series with `tako_contents` on the card's `url` only when you need the rows — to compute a growth rate, ratio or change yourself, since search retrieves reported values and derives nothing. A locked card (`exportable: false`) is a licensing wall, not an error: quote the headline and stop.
5. **Zero cards?** Follow the recovery the result states: one free `tako_available_data` call for the canonical metric name, at most one more search on that name, then answer from the web results. Two priced searches per question is the ceiling. Empty means Tako doesn't cover it, not that the fact is false — no dividend card is not "pays no dividend".
6. **Ambiguous entity?** `"Costco"` resolves to Costco Wholesale Corporation and Costco Wholesale Australia; `"Coca-Cola"` to four listed companies. If the user's intent doesn't settle it, ask before quoting a number.
7. **Discovery asks** ("who does Nvidia compete with", "what does Tako track for Tesla", "Nvidia's acquisitions")? Resolve the entity with `tako_available_data` to get its node id, then call `tako_graph_related` on it. The first call returns the relation map with counts (`rel:competes_with`, `rel:subsidiaries`, `rel:acquisitions`, `metrics`, `sources`); pass `relation` to page one and `q` to filter it, then search on the names it returns.

## Choosing the right card

Ranking favours breadth, so #0 is often not the metric asked for, and the relevance field doesn't correct for it. Check, in order:

1. **Title is the bare metric.** Overview cards ("Earnings & Estimates Overview", "Ratios Overview", "Stock Overview") rank first on many queries and lead with an estimate-vs-actual narrative. Skip them unless the question is about estimates; querying with the exact metric name doesn't demote them.
2. **Company-wide, not a segment.** Segment- and geography-scoped variants outrank the consolidated metric, especially from Visible Alpha, because the segment note yields more series. If no company-wide card appears, say so; never pass a segment off as the total.
3. **The unit matches the question.** A query for a rate can rank the level first (operating income above operating margin). Confirm the unit in `description`.
4. **Reported or estimate, as asked.** Analyst-estimate and consensus cards rank #0 on plain metric queries, and a future `coverage_end` is how you spot one. Both are financial data: quote the estimate when the question is about forecasts or consensus and label it so; otherwise take the reported card.
5. **`nodes` names the entity asked about.** Related listed entities compete for the same query. Some cards (Fiscal.ai charts, Stock and Ratios Overviews) carry no nodes; fall back to the title there.

## Comparisons

- A two-series comparison card exists for many pairs but isn't guaranteed; some pairs return two single-entity cards instead. Treat a card as a comparison only if every compared entity appears in its `nodes` or title; otherwise synthesize from the per-entity cards. Comparisons default to annual; say `quarterly` for quarterly.
- A cross-currency pair plots both series on one axis unnormalized. State each currency and convert before comparing; never present the raw chart as like-for-like.
- Period labels are calendar-normalized (a September fiscal year-end shows as Dec 31). Flag the normalization when the fiscal period matters.

## Output

1. One or two lines on the finding, referencing the chart in prose. Never re-post the image URL: it double-renders the inline chart.
2. Source name and `coverage_end` date. Cite the source the card names; it varies by metric. Say plainly when a figure came from a web result rather than a card.
3. One `[Open in Tako](url)` link for the card you embedded.
