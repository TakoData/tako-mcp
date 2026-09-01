---
name: tako-financial-research
description: >-
  Use when the user asks what a company's financial metric is or was (revenue, margins, EPS, cash flow, valuation, stock price, analyst estimates), compares companies on a metric, asks who a company competes with or what data exists on it, or wants a financial chart — including private companies and crypto spot prices. Returns the figures as structured, citation-backed data from Tako (S&P Global, Fiscal.ai, Visible Alpha, Xignite and others), each with a chart. Company-level data only, not country indicators or website traffic.
---

# Financial Research (Tako)

Tako serves company financials as structured, cited data: each result is a card carrying the headline value, the underlying rows, and a chart of the series. All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields, the `sources` guidance and the zero-card recovery; this skill covers how to shape a financial query, how to check a card against the question, and how to report.

## Workflow

1. **Query as ENTITY + METRIC**: `"Nvidia revenue"`, `"Tesla free cash flow"`, with `quarterly` or `annual` to steer the period. When the user wants several metrics or companies, run one call per pair in parallel: each answer then comes back as its own card, and the checks below apply cleanly to each.
2. **Call `tako_search`** with the default sources. Web results carry the qualitative half and the facts the graph doesn't hold (earnings dates, management commentary, companies with no filings or coverage).
3. **Check the top card against the question** with the list below. The top card renders inline automatically; if a different card is the right one, link its title to its `url` and say so.
4. **Read the figure from the card's `description`.** Fetch the series with `tako_contents` on the card's `url` only when you need the rows, such as to compute a growth rate, ratio or change yourself: search retrieves reported values and derives nothing. A locked card (`exportable: false`) is a licensing wall, not an error: quote the headline and stop.
5. **Zero cards?** Follow the recovery the result states, and keep to two priced searches per question. Empty means Tako doesn't cover it, not that the fact is false: no dividend card is not "pays no dividend".
6. **Ambiguous entity?** `"Costco"` resolves to Costco Wholesale Corporation and Costco Wholesale Australia; `"Coca-Cola"` to four listed companies. If the user's intent doesn't settle it, ask before quoting a number.
7. **Discovery asks** ("who does Nvidia compete with", "what does Tako track for Tesla", "Nvidia's acquisitions")? Resolve the entity with `tako_available_data` to get its node id, then call `tako_graph_related` on it. The first call returns the relation map with counts (`rel:competes_with`, `rel:subsidiaries`, `rel:acquisitions`, `metrics`, `sources`); pass `relation` to page one and `q` to filter it, then search on the names it returns.

## Checking a card against the question

Search ranks on relevance to the words, and financial vocabulary is dense: the same query can match a level and a rate, a segment and the total, an actual and an estimate. Before quoting, confirm:

1. **Metric.** The title names the metric asked for, not an overview of several. Overview cards ("Earnings & Estimates Overview", "Ratios Overview", "Stock Overview") summarize many metrics and lead with estimate-vs-actual; use one only when the question is that broad.
2. **Scope.** The card is company-wide unless a segment or geography was asked for. Segment cards exist for every line the company reports, so they can match the same words. If only a segment card exists, say so; never pass a segment off as the total.
3. **Unit.** A rate query can match the level (operating income vs operating margin). Confirm the unit in `description`.
4. **Reported or estimate, as asked.** Analyst-estimate and consensus cards match plain metric queries, and a future `coverage_end` is how you spot one. Both are financial data: quote the estimate when the question is about forecasts or consensus and label it so; otherwise take the reported card.
5. **Entity.** `nodes` names the company asked about; related listed entities share names. Some cards (Fiscal.ai charts, Stock and Ratios Overviews) carry no nodes; fall back to the title there.

## Comparisons

- A two-series comparison card exists for many pairs but not all; some pairs return two single-entity cards. Treat a card as a comparison only if every compared entity appears in its `nodes` or title; otherwise synthesize from the per-entity cards. Comparisons default to annual; say `quarterly` for quarterly.
- A cross-currency pair plots both series on one axis unnormalized. State each currency and convert before comparing; never present the raw chart as like-for-like.
- Period labels are calendar-normalized (a September fiscal year-end shows as Dec 31). Flag the normalization when the fiscal period matters.

## Output

1. One or two lines on the finding, referencing the chart in prose. Never re-post the image URL: it double-renders the inline chart.
2. Source name and `coverage_end` date. Cite the source the card names; it varies by metric. Say plainly when a figure came from a web result rather than a card.
3. One `[Open in Tako](url)` link for the card you embedded.
