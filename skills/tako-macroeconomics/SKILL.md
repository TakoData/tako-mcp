---
name: tako-macroeconomics
description: >-
  Use when the user asks what a country's economic indicator is or was (inflation, CPI, PCE, unemployment, GDP, interest rates, population), compares countries on one, or wants a macro chart or briefing. Returns the figures as structured, citation-backed data from Tako (FRED, BLS, OECD, BIS, IMF, World Bank, Census and Polymarket), each with a chart. Country-level indicators only, not company financials or website traffic.
---

# Macroeconomics (Tako)

Tako serves macro and demographic indicators as structured, cited data: each result is a card carrying the headline value, the underlying rows, and a chart of the series. All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields, the `sources` guidance and the zero-card recovery; this skill covers how to shape a macro query, how to check a card against the question, and how to report.

## Workflow

1. **Query as COUNTRY + INDICATOR**: `"US CPI inflation"`, `"Japan unemployment rate"`. Coverage is country-keyed: individual countries resolve well, blocs don't (a Eurozone query returns a prediction-market card or nothing). For a bloc, query member countries and aggregate yourself, or take the figure from the web results and say so.
2. **Name the variant when intent is precise.** Most indicators exist in several variants with materially different values (headline vs core, seasonally adjusted or not, BLS vs IMF vs OECD-harmonised, U-3 vs U-6, target rate vs effective rate). When you don't know the exact name, call `tako_available_data` first, which is free, and search on the name it returns. PCE is the sharpest case: the level series is "Core PCE Price Index" and the rate is "Core PCE Price Index (% Change)"; a query that says "inflation" can match either, or a CPI card.
3. **Call `tako_search`** with the default sources. Web results carry release commentary and cover the bloc-level gaps.
4. **Check the top card against the question** with the list below. If a different card is the right one, link its title to its `url` and say so.
5. **Read the value from `description`.** FRED, OECD and BIS cards export, so `tako_contents` on the card's `url` returns the series when you need more than the headline.
6. **Zero cards?** Follow the recovery the result states, and keep to two priced searches per question. Empty means not covered, not that the indicator doesn't exist.

## Checking a card against the question

One indicator name covers many series: providers, methodologies, vintages, levels and rates, and prediction markets on the same quantity. Before quoting, confirm:

1. **Variant.** The title names the variant asked for; several providers' headline numbers can come back together. Don't average them or take the first.
2. **Vintage.** `coverage_end` is the latest among the matching series. Discontinued series stay in the graph (a historical target-rate series, an annual series a year behind the monthly one), and series refresh on different schedules, so don't present two indicators as the same vintage without checking.
3. **Rate, not level.** A "(% Change)" card is a percentage; a bare "Price Index" card is index points. Confirm from the unit in `description`.
4. **Indicator, not prediction market.** Polymarket cards answer "what do traders expect", not "what was reported", and exist for many macro quantities. Use one only when the question is about expectations, and label it market-implied.
5. **Country.** `nodes` names it. Country overview cards sometimes carry no nodes; fall back to the title there.

## Comparisons

- Cross-country comparison is built in: `"US vs China inflation"` returns a two-series card. For currency-denominated indicators (GDP, wages) the chart plots both currencies on one axis unnormalized; state each currency and convert before comparing.

## Output

1. One or two lines on the indicator, referencing the chart in prose. Never re-post the image URL: it double-renders the inline chart.
2. Source name and `coverage_end` date. The roster is wider than FRED, so cite what the card names. Say plainly when a figure is web-sourced.
3. One `[Open in Tako](url)` link for the card you embedded.
