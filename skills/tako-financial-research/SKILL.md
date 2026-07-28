---
name: tako-financial-research
description: Company financials and markets via Tako (sources vary by metric — S&P Global, Fiscal.ai, Xignite, Visible Alpha, and others). Revenue, earnings vs. estimates, margins, valuation, stock performance, and head-to-head company comparisons as citation-backed charts. Use for equity research, company deep-dives, competitor financial comparison, or any "what are/were <company>'s <financial metric>" question.
---

# Financial Research (Tako)

Tako serves proprietary company financials (sources vary by metric — S&P Global, Fiscal.ai, Xignite, Visible Alpha, and others) as interactive, citation-backed charts. Always cite the source the card actually returns, not a fixed name. All tools below live on the Tako MCP server (server name `tako`).

## Pick the tool by what you want back
- `tako_search` — the data as a chart. Default for "<company> <metric>" and "<A> vs <B> <metric>". The intent-matched card renders inline (see Rendering).
- `tako_answer` — one specific STATED value, in prose ("What was Apple's FY24 revenue?"). Relay the `answer` verbatim. It retrieves reported values; it does NOT compute derivations — for a growth rate, ratio, or margin change, pull the underlying levels (here or via `tako_search`) and compute it yourself.
- `tako_available_data` — FREE pre-check: confirm a metric exists and grab its exact name + `node_id` before spending a priced call. When the target is unambiguous, its `next_call` output is that follow-up search prewritten (query + pinned `node_ids`) — run it verbatim.
- Protected sources are read-only: S&P Global, FactSet, Visible Alpha, and CoinMarketCap cards come back `exportable: false` with NO inline preview rows, and `tako_contents` cannot export their CSV — a licensing wall, not an error, so never retry the export. Read the headline value from the card's `description`, cite the chart, or ask `tako_answer` for the specific number. (Fiscal.ai cards export normally.)
- Cohort/ranking asks ("which of the largest US chipmakers grew revenue fastest since 2020?") → resolve the cohort yourself, fire one narrow `tako_search` per member in parallel, and rank from the results.

## Query patterns (Critical)
- Query is ENTITY + METRIC: `"Nvidia revenue"`, `"Apple gross margin"`, `"Tesla free cash flow"`. Keep it to one entity + one metric per call, and add a cadence word (`quarterly`/`annual`) to steer the period.
- Comparisons are first-class: `"Intel vs Nvidia revenue"` returns a two-series comparison card — but it is not always ranked first (see Rendering), and comparisons default to annual (say `quarterly` for quarterly). 3–4-way comparisons usually work, but verify EVERY entity appears in the chosen card's title/`nodes` — if one is missing, fall back to pairwise searches and synthesize.
- Multi-metric or multi-company asks → fire PARALLEL narrow searches and synthesize yourself. Do not send a multi-part question as one query (a compound query returns cards for some of the metrics and silently misses others — a 3-metric ask came back missing gross margin).
- Ground in Tako data with `sources: ["data"]` — this is the default for financials. The price is the same either way, but omitting `sources` also searches the web and pads the response with ~10 web results of IR/filings/MacroTrends clutter; add `"web"` only when you deliberately want news or qualitative context.
- Empty result (zero cards) — HARD STOP on retries. Every search is billed, and rewording the same query almost never flips an empty result to a hit. Recover in exactly this order: (1) `tako_available_data` (free) to get the exact metric name + `node_id`; (2) if covered, ONE more search with that exact name and pinned `node_ids`; (3) if not covered, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query is its own question with its own budget).
- Empty also means "not covered in Tako," NOT that the fact is false — the response looks identical for an uncovered metric and a genuinely-nonexistent one. Don't infer a business fact from silence (e.g. no dividend card ≠ pays no dividend).

## Rendering (Critical)
- Pick the card by intent — do NOT trust index 0. Tako auto-renders card #0, but it routinely ranks an "Overview" or "Earnings & Estimates" card above the plain metric chart (e.g. `"Lucid revenue"` puts "Lucid Group Earnings & Estimates Overview" at #0 and the actual "Lucid Revenues (Annual)" chart at #2), and a segment-scoped variant can outrank the overall metric (`"Apple gross margin"` ranks "Gross margin - Products" at #0, above the company-wide margin). Choose the card whose `card_type` is `"chart"` and whose title matches the bare metric asked for, at the scope asked for. Overview/Estimates cards lead with a beat/miss "estimate vs. actual" narrative — NOT the value asked for; skip them unless the user asked about estimates. For a comparison, the right card has ALL compared entities in its `nodes`/title. If the chosen card isn't #0, reference it with `[Title](webpage_url)` and say it is the authoritative one.
- Actuals vs. estimates vs. projections — before quoting a number, confirm it's a reported actual: `data_as_of` must NOT be in the future (a future date like `2035-12-31` = a forward analyst projection), and the metric name must not be "Analyst Estimates (Mean)" or similar. Never relay a projection as a reported figure.
- Cross-currency comparisons are a correctness trap: a `"<A> vs <B>"` chart can plot two currencies on one axis unnormalized (Toyota ¥43.6T vs Ford $174B reads as ~250× raw, but ≈1.7× once converted). For cross-border pairs, state each series' currency and convert before comparing — do NOT present the raw chart as apples-to-apples.
- Period labels are calendar-normalized (Apple's annual points show "Dec 31" though its fiscal year ends in late September; a series may even show a future "Dec 31, 2026" point). Don't cite a label as the issuer's fiscal period; flag the normalization when precision matters.
- Cite the card's actual `sources[].source_name` (S&P Global, Fiscal.ai, Xignite, Visible Alpha, …) and its `data_as_of` date — the source varies by metric; it is not always S&P Global.
- Reference the chart in prose ("as the chart above shows"); do NOT paste `![](image_url)` for a card — that double-renders the inline chart.
- `tako_answer` prose may cite a different fiscal period than the embedded card's latest point (e.g. the answer says FY24 while the card headline is FY25) — reconcile them so text and chart agree.

## Examples
- Single metric → tako_search {"query": "Nvidia quarterly revenue", "sources": ["data"]}
- Comparison → tako_search {"query": "Intel vs Nvidia revenue", "sources": ["data"]}
- Coverage pre-check (free; note the arg is `q`) → tako_available_data {"q": "Costco"}
- Known value, prose → tako_answer {"query": "What was Microsoft's FY2024 net income?", "sources": ["data"]}
- Growth rate / ratio → pull the levels, then compute yourself: tako_search {"query": "Apple annual revenue", "sources": ["data"]} → compute FY24 vs FY23 % change (tako_answer/tako_search return levels, not the rate)
- Ranking → resolve the cohort, then parallel narrow searches: tako_search {"query": "Nvidia annual revenue", "sources": ["data"]} + one per remaining company → compute growth and rank yourself

## Output (tight and structured)
1) A 1–2 line read of the finding, referencing the intent-matched chart
2) Source (`source_name`) — `data_as_of` date
3) A single `[Open in Tako](embed_url)` for the card you embedded
