---
name: tako-financial-research
description: Company financials and markets via Tako (sources vary by metric — S&P Global, Fiscal.ai, Visible Alpha, Xignite, and others). Revenue, earnings vs. estimates, margins, valuation, stock quotes, and head-to-head company comparisons as citation-backed charts. Use for equity research, company deep-dives, competitor financial comparison, or any "what are/were <company>'s <financial metric>" question.
---

# Financial Research (Tako)

Tako serves proprietary company financials as interactive, citation-backed charts. Sources vary by metric — S&P Global, Fiscal.ai, Visible Alpha, Xignite and others, so always cite the source the card actually returns, never a fixed name. All tools below live on the Tako MCP server (server name `tako`).

## What's in range
Broader than statutory financials, so assume coverage and check rather than talking yourself out of a search:
- **Income statement, balance sheet, cash flow** at annual and quarterly cadence, plus derived metrics (margins, ratios, per-share).
- **Valuation and market data**: `"Nvidia PE ratio"` returns P/E history; `"Apple stock price"` returns a Stock Overview card with price, market cap, P/E, and 52-week range.
- **Private companies**: coverage is not limited to listed issuers. `"SpaceX revenue"` returns real S&P Global and Visible Alpha cards. Never assume private means uncovered.
- **Segment and KPI detail** (Visible Alpha): bookings, subscribers, per-segment revenue and margin.
- **Analyst estimates and consensus**, alongside actuals.
- **Crypto spot rates** (CoinMarketCap) — `"Bitcoin price"` works.

Reliably NOT in the data graph, and where web carries the answer instead: forward-looking calendar facts (`"Nvidia next earnings date"` returns an Overview card with no date, while the web results have it), revenue for companies with no filings or analyst coverage (`"OpenAI annualized revenue"` returns zero cards), and anything qualitative (moat, strategy, management commentary).

## Pick the tool by what you want back
- `tako_answer`: **the default for any "<company> <metric>" question.** It returns the figure in prose ("What was Apple's FY25 revenue?" → "$416.2 billion") with its cited cards and their rows attached, so one priced call finishes the job. Relay the `answer` verbatim. It retrieves reported values; it does NOT compute derivations. For a growth rate, ratio, or margin change, pull the underlying levels and compute yourself.
- `tako_search`: reach for it when you want **breadth or a chart**, not a number: fanning out across several companies or metrics to see what exists, or pulling the card when the chart itself is the deliverable. Its cards are captions — S&P Global and Visible Alpha rows are license-gated, so a search that returns the right card still owes you a `tako_answer` call for the value. One card renders inline (see Pick the right card).
- `tako_available_data`: FREE, and the right tool when the question is **what Tako covers**: does this metric exist, under what exact name, for which entity. It also surfaces entity ambiguity early (`"Costco"` matches both Costco Wholesale Corporation and Costco Wholesale Australia). Not a warm-up before every lookup. Go straight to `tako_answer` when you just want the number.
- Protected sources are read-only: S&P Global, FactSet, Visible Alpha, and CoinMarketCap cards come back not exportable, with NO inline preview rows, and `tako_contents` cannot export their CSV. This is a licensing wall, not an error, so never retry the export. Read the headline value from the card's `description`, cite the chart, or ask `tako_answer` for the number. (Fiscal.ai cards export normally.)
- Cohort/ranking asks ("which of the largest US chipmakers grew revenue fastest since 2020?") → resolve the cohort yourself, fire one narrow call per member in parallel, and rank from the results. This is search's home ground when you only need to see what exists; use `tako_answer` per member when you need the actual figures.

## Query patterns (Critical)
- Query is ENTITY + METRIC: `"Nvidia revenue"`, `"Tesla free cash flow"`, `"Coca-Cola dividend yield"`. One entity + one metric per call, plus a cadence word (`quarterly`/`annual`) to steer the period.
- Multi-metric or multi-company asks → fire PARALLEL narrow searches and synthesize yourself. Do not send a multi-part question as one query; a compound query returns cards for some metrics and silently misses others.
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The card grounds the number while the web results carry the qualitative half of the research and the facts the graph doesn't hold, and web is the built-in fallback when no card comes back, so every query returns something answerable. Price is identical either way, and web does not degrade card selection. Narrow to `["data"]` only when you already know Tako has the metric (`tako_available_data` confirmed it, or you're pinning `node_ids`) and want just the number, or in a parallel fan-out where ~10 web results per call would swamp context.
- Empty result (zero cards): do NOT reword and retry blind. Every search is billed. Recover in exactly this order: (1) `tako_available_data` (free) for the exact metric name; (2) if it reports coverage, ONE more search using that exact name and NO `node_ids` — the canonical NAME is what recovers cards; a pin is a hard filter and returned FEWER cards than the same query unpinned on 11 of 20 pairs measured, because the graph holds near-duplicate metric nodes where only one twin carries cards; (3) if not covered, stop searching Tako and answer from the web results already in the response. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query has its own budget). Pin a METRIC `node_id` with `strict: true` only to disambiguate when an unpinned retry returned the wrong near-duplicate metric — and if a pinned call comes back empty, drop the pin rather than concluding Tako has no data.
- Empty is usually genuine non-coverage but has been observed transient — the same query returning zero cards once and real cards minutes later. That is exactly why the free `tako_available_data` check sits between the two priced calls: let it, not a hunch, decide whether a retry is justified.
- Empty also means "not covered in Tako," NOT that the fact is false. The response is identical for an uncovered metric and a genuinely-nonexistent one, so never infer a business fact from silence (no dividend card ≠ pays no dividend).

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts: whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
A search returns several cards and **#0 is frequently not what was asked for**. The relevance fact does not rescue you: the correct card is routinely tagged `Low` while an off-intent card is `High`. Tako auto-renders #0, so if the right card is elsewhere, reference it explicitly by linking its title to the card's chart URL and say it is the authoritative one. Walk this checklist before quoting any number:

1. **Right shape?** Prefer a card whose type is `chart` and whose title is the bare metric. Overview cards — "Earnings & Estimates Overview", "Ratios Overview", "Stock Overview" — routinely take #0 and lead with an estimate-vs-actual narrative rather than the value asked for. Skip them unless the question was about estimates. Precision in the query does not save you: `"Apple Gross Margin (%)"`, the exact metric name, still ranks the Overview at #0 and the real chart at #2.
2. **Right scope?** Segment- and geography-scoped variants outrank the company-wide metric, especially Visible Alpha cards. `"Apple gross margin"` puts "Gross margin - Products" (38.7%) above company-wide gross margin (46.9%); `"JPMorgan net interest income"` returns only "- Corporate & investment banking" cards; every top card for `"Airbnb gross bookings"` is a segment card. If no company-wide card appears, say so — never pass a segment off as the total.
3. **Right unit?** Asking for a rate can return the level. `"Microsoft operating margin quarterly"` ranks Operating Income ($38.4B) above EBIT Margin (46.3%). Check the units in `description` match the question.
4. **Actual, not projection?** The as-of date must not be in the future. A future date is NOT confined to cards titled "Analyst Estimates" — a plainly-titled "Toyota Revenues (Normalized) (Annual)" card carried a 2026-12-31 as-of. Trust the as-of date; the title is not a reliable signal.
5. **Right entity?** Related listed entities compete for the same query: `"Coca-Cola dividend yield"` returns The Coca-Cola Company, Coca-Cola HBC, Coca-Cola Europacific, and Coca-Cola FEMSA — four different companies with different numbers. Confirm the card's `nodes` names the one asked about, and note some cards (Fiscal.ai charts, Stock/Ratios Overviews) carry no nodes at all, so fall back to the title there.

## Comparisons and rendering
- A true comparison card (2 series, all entities in `nodes`) exists but is **not guaranteed**. `"Coca-Cola vs PepsiCo revenue"` and `"Toyota vs Ford revenue"` return one at #0; `"Intel vs Nvidia revenue"` reproducibly returns two separate single-entity cards instead. Always verify every compared entity appears in the chosen card's `nodes`/title — if none has them all, use the per-entity cards and synthesize. Comparisons default to annual; say `quarterly` for quarterly.
- On a comparison card, the as-of date is the QUERY date, not the data date — the Toyota/Ford card reported the day it was run while its latest point is Dec 31, 2025. Cite the period from the card's `description`, not that fact.
- Cross-currency comparisons are a correctness trap: a two-series chart can plot different currencies on one axis unnormalized (Toyota 43.6T JPY beside Ford's USD reads as ~250× raw, but ≈1.7× once converted). State each series' currency and convert before comparing — never present the raw chart as apples-to-apples.
- Period labels are calendar-normalized (Apple's annual points show "Dec 31" though its fiscal year ends in late September). Don't cite a label as the issuer's fiscal period; flag the normalization when precision matters.
- Cite the card's actual source name and as-of date. The source varies by metric — the same company can come back from S&P Global on one card and Fiscal.ai on another.
- Reference the chart in prose ("as the chart above shows"); do NOT re-post the card's image URL as a markdown image — that double-renders the inline chart.
- `tako_answer` prose may cite a different fiscal period than the embedded card's latest point — reconcile them so text and chart agree.

## Examples
- Single metric (the common case) → tako_answer {"query": "What was Nvidia's most recent quarterly revenue?", "sources": ["data", "web"]} — the figure, its cited chart, and the earnings release in one call
- Comparison → tako_answer {"query": "How do Coca-Cola and PepsiCo compare on annual revenue?", "sources": ["data", "web"]} → check both entities appear in the cited card's `nodes` before treating it as a comparison
- Chart is the deliverable → tako_search {"query": "Coca-Cola vs PepsiCo revenue", "sources": ["data", "web"]} → embed the card; ask `tako_answer` if you also need the values
- Coverage question (free; note the arg is `q`) → tako_available_data {"q": "Costco"} → then pin what it returns: tako_answer {"query": "Costco Wholesale Corporation annual revenue", "sources": ["data"]}
- Growth rate / ratio → pull the levels, then compute: tako_answer {"query": "Apple annual revenue for FY24 and FY25", "sources": ["data", "web"]} → compute the % change yourself
- Breadth recon → one narrow `tako_search` per company in parallel with `"sources": ["data"]` to see what exists; switch to `tako_answer` per company once you need the figures
- Not in the graph → tako_answer {"query": "When is Nvidia's next earnings date?", "sources": ["data", "web"]} → no card carries it; the answer comes from the web citations, so say the figure is web-sourced

## Output (tight and structured)
1) A 1–2 line read of the finding, referencing the intent-matched chart
2) Source name — as-of date, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the card you embedded
