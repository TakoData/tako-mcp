---
name: tako-macroeconomics
description: Macroeconomic and demographic indicators via Tako (sources vary — FRED, BLS, OECD, BIS, IMF, World Bank, Census). Inflation (CPI/PCE), unemployment, GDP, interest and policy rates, population, and cross-country comparisons as citation-backed charts. Use for macro monitoring, economic briefings, or any "what is/was <country>'s <indicator>" question.
---

# Macroeconomics (Tako)

Tako serves macro indicators as interactive, citation-backed charts. All tools below live on the Tako MCP server (server name `tako`).

## What's in range
- **Prices** — CPI (headline, core, seasonally adjusted and not), PCE price indices, country inflation rates.
- **Labor** — unemployment (headline, U-6, harmonised), employment measures.
- **Output and rates** — nominal and real GDP, GDP growth, policy and market interest rates.
- **Demographics** — population, population by age band, median age (Census, World Bank). These sit naturally in this skill's scope; don't send them elsewhere.
- **Prediction markets** — Polymarket contracts on macro outcomes are in the graph (`"Polymarket odds Fed rate cut 2026"` returns "How many Fed rate cuts in 2026?"). Useful when the question is genuinely about expectations — and a trap otherwise, see below.

**Coverage is country-keyed.** Individual countries resolve well (US, China, Japan, India). Multi-country blocs are weak: `"Eurozone inflation rate"` returns a Polymarket contract instead of an indicator, and `"Euro area CPI inflation rate"` returns nothing at all. For a bloc, query member countries and aggregate yourself, or take the figure from the web results and say so.

## Pick the tool
- `tako_search` — indicator as a chart (default).
- `tako_answer` — one known value, in prose ("What is the current US unemployment rate?"). Relay verbatim.
- `tako_available_data` — FREE: resolve the exact indicator name + `node_id`. When the target is unambiguous, its `next_call` output is the follow-up search prewritten — run it verbatim.
- Cohort/ranking asks ("which G7 economy has the highest inflation right now?") → fire one narrow `tako_search` per country in parallel and rank from the results.

## Query patterns (Critical)
- Query is COUNTRY + INDICATOR: `"US CPI inflation"`, `"US unemployment rate"`, `"US federal funds rate"` (which resolves to the Effective Federal Funds Rate, not the FOMC target range).
- Be specific — most indicators have many variants, and they carry materially different numbers. `"US unemployment rate"` returns BLS headline (4.2%), IMF (4.3%), OECD harmonised (4.2%), and U-6 (7.9%) together. Name the variant when intent is precise; run `tako_available_data` first when it isn't.
- PCE is the sharpest naming trap: `"US core PCE inflation"` silently returns a Core **CPI** card. Query the year-over-year variant by name instead — `"US core PCE price index % change"` returns the correct "Core PCE Price Index (% Change)" card. Verify the chosen card's title actually says `PCE` and `(% Change)`; a plain "PCE Price Index" card is an index level (~130 points), not a rate. Run `tako_available_data` FIRST here.
- Parallelize multi-part asks: send each metric as its own narrow concurrent `tako_search`, then synthesize — not one query.
- Cross-country comparison is built in: `"US vs China inflation"` returns a 2-series comparison card. For currency-denominated indicators (GDP, wages), a cross-country chart may plot different currencies on one axis unnormalized — state each series' currency and convert before comparing.
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The chart grounds the number, web results add the release commentary and context that make a briefing readable, and web is the built-in fallback when Tako lacks the indicator — including the bloc-level gaps above. Price is identical either way. Narrow to `["data"]` only when coverage is already confirmed (`tako_available_data`, pinned `node_ids`) or in a parallel fan-out where per-call web results would swamp context.
- Empty result (zero cards) — do NOT reword and retry blind; every search is billed. Recover in order: (1) `tako_available_data` (free) for the exact indicator name + `node_id`; (2) if covered, ONE more search with that exact name and pinned `node_ids`; (3) if not covered, stop searching Tako and answer from the web results already in the response. Never more than 2 priced searches per underlying question (in a fan-out, each country+indicator query has its own budget).
- Empty is usually genuine non-coverage but has been observed transient, which is why the free coverage check — not a hunch — decides whether a retry is justified. Empty also means "not covered in Tako," NOT that the indicator doesn't exist; don't infer a fact from silence.

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts — whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
Tako auto-renders #0, and for macro the **least-specific or stalest card often ranks first**. the relevance fact is unreliable — the correct card is frequently tagged `Low`. If the right card isn't #0, reference it by linking its title to the card's chart URL and say it is the authoritative one. Check, in order:

1. **Right variant?** `"US CPI inflation"` returns three different headline numbers at once — a BIS country card (4.2%), a FRED "Inflation Rate" series (2.9%), and FRED "CPI Inflation Rate (Seasonally Adjusted)" (3.5%). Pick the card whose title matches the variant asked for; don't average them or take whichever is first.
2. **Fresh, not a stale vintage?** Stale series rank high routinely: that FRED "Inflation Rate" card at #1 ends in Jan 2024, and `"US federal funds rate"` ranks "Fed Funds Target Rate (Historical)" — a series that ends in Dec 2008 — above the current one. Compare as-of dates across cards and take the freshest match. Freshness also varies by series: Core CPI runs to Jun 2026 while Core PCE stops at Jan 2026, so don't present them as the same vintage.
3. **Rate, not an index level?** A `(% Change)` card is a rate in percent; a bare "Price Index" card is index points. Confirm from the units in `description`.
4. **An indicator, not a prediction market?** A Polymarket card answers "what do traders expect," not "what was reported." `"Eurozone inflation rate"` returns exactly this. Only use one when the question is about expectations, and label it as market-implied odds.
5. **Right country?** Confirm the card's `nodes` names it. Country overview cards (type `card`) sometimes carry no nodes at all — fall back to reading the title.

## Rendering
- On a comparison card, the as-of date is the QUERY date, not the data date (the US-vs-China card reported the day it was run while its latest point is May 2026). Cite the period from the card's `description`, not that fact.
- Cite the card's source name and as-of date. The roster is wider than FRED alone — BIS, OECD, IMF, World Bank, BLS, Census and Polymarket all appear, and the same indicator arrives from different providers on different cards. Never cite from a fixed list.
- Reference the chart in prose; do NOT re-post the card's image URL as a markdown image — that double-renders the inline chart.

## Examples
- Single → tako_search {"query": "US CPI inflation", "sources": ["data", "web"]} → pick the card matching the variant asked for, not #0 by default
- Parallel multi-metric → four calls: "US CPI inflation", "US core CPI inflation", "US core PCE price index % change", "US PCE price index % change" — coverage confirmed via tako_available_data first, so use `"sources": ["data"]` to keep the fan-out lean (take each card titled "(% Change)"; the plain "PCE Price Index" cards are index levels)
- Cross-country → tako_search {"query": "US vs China inflation", "sources": ["data", "web"]}
- Indicator-name pre-check (free; note the arg is `q`) → tako_available_data {"q": "US core PCE"}
- Known value, prose → tako_answer {"query": "What is the current US federal funds rate?", "sources": ["data", "web"]}
- Bloc-level ask → no Eurozone card exists; query member countries in parallel and aggregate, or use the web results and label the figure web-sourced

## Output (tight and structured)
1) A 1–2 line read of the indicator, referencing the intent-matched chart
2) Source name — as-of date, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the card you embedded
