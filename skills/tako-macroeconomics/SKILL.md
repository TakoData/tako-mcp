---
name: tako-macroeconomics
description: >-
  Use when the user asks what a country's economic indicator is or was (inflation, CPI, PCE, unemployment, GDP, interest rates, population), compares countries on one, or wants a macro chart or briefing. Returns the figures as structured, citation-backed data from Tako (FRED, BLS, OECD, BIS, IMF, World Bank, Census and Polymarket), each with a chart. Country-level indicators only, not company financials or website traffic.
---

# Macroeconomics (Tako)

Tako serves macro and demographic indicators as structured, cited data: each result is a card carrying the headline value, the underlying rows, and a chart of the series. All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields and the zero-card recovery; this skill covers how to shape a macro query, which card to trust, and how to report.

## Workflow

1. **Shape the query as COUNTRY + INDICATOR**, one pair per call: `"US CPI inflation"`, `"Japan unemployment rate"`. Coverage is country-keyed: individual countries resolve well, blocs don't (a Eurozone query returns a prediction-market card or nothing). For a bloc, query member countries and aggregate yourself, or take the figure from the web results and say so.
2. **Name the variant when intent is precise.** Most indicators exist in several variants with materially different values (headline vs core, seasonally adjusted or not, BLS vs IMF vs OECD-harmonised, U-3 vs U-6). When you don't know the exact name, call `tako_available_data` first, which is free, and search on the name it returns. PCE is the sharpest case: a "core PCE inflation" query returns a core CPI card, while the year-over-year series is named "Core PCE Price Index (% Change)".
3. **Call `tako_search`** with the default sources. Web results carry release commentary and cover the bloc-level gaps. Narrow to `["data"]` only in a parallel fan-out.
4. **Pick the card** with the checklist below. If the right card isn't the one rendered, link its title to its `url` and say it is the authoritative one.
5. **Read the value from `description`.** FRED, OECD and BIS cards export, so `tako_contents` on the card's `url` returns the series when you need more than the headline.
6. **Zero cards?** Follow the recovery the result states: free `tako_available_data` for the exact indicator name, at most one more search on it, then the web results. Two priced searches per question is the ceiling. Empty means not covered, not that the indicator doesn't exist.

## Choosing the right card

For macro the least specific or stalest series often ranks first, and the relevance field doesn't correct for it. Check, in order:

1. **Title names the variant asked for.** One query returns several headline numbers from different providers and methodologies; don't average them or take the first.
2. **Freshest `coverage_end` among the matches.** Discontinued series (a historical target-rate series, an inflation series that stopped years ago) still rank above the live one. Series also refresh on different schedules, so don't present two indicators as the same vintage without checking.
3. **A rate, not an index level.** A "(% Change)" card is a percentage; a bare "Price Index" card is index points. Confirm from the unit in `description`.
4. **An indicator, not a prediction market.** Polymarket cards answer "what do traders expect", not "what was reported", and rank first on some bloc and forward-looking queries. Use one only when the question is about expectations, and label it market-implied.
5. **`nodes` names the country.** Country overview cards sometimes carry no nodes; fall back to the title there.

## Comparisons

- Cross-country comparison is built in: `"US vs China inflation"` returns a two-series card. For currency-denominated indicators (GDP, wages) the chart plots both currencies on one axis unnormalized; state each currency and convert before comparing.

## Output

1. One or two lines on the indicator, referencing the chart in prose. Never re-post the image URL: it double-renders the inline chart.
2. Source name and `coverage_end` date. The roster is wider than FRED, so cite what the card names. Say plainly when a figure is web-sourced.
3. One `[Open in Tako](url)` link for the card you embedded.
