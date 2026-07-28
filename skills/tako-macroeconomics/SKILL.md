---
name: tako-macroeconomics
description: Macroeconomic indicators via Tako (sources: FRED, OECD, BIS). Inflation (CPI/PCE), unemployment, GDP, interest and policy rates, and cross-country comparisons as citation-backed charts. Use for macro monitoring, economic briefings, or any "what is/was <country>'s <indicator>" question.
---

# Macroeconomics (Tako)

Tako serves macro indicators (sources: FRED / St. Louis Fed, OECD, BIS) as interactive, citation-backed charts. All tools below live on the Tako MCP server (server name `tako`).

## Query patterns (Critical)
- Query is COUNTRY + INDICATOR: `"US CPI inflation"`, `"US unemployment rate"`, `"US federal funds rate"` (which resolves to the Effective Federal Funds Rate, not the FOMC target range).
- Be specific — many variants exist (CPI all-items vs CPI-W vs core; unemployment headline vs U-6 vs by age/race). If intent is precise, name the variant; if unsure, use `tako_available_data` to list exact metric names first.
- PCE is a trap: `"US PCE inflation"` / `"US core PCE inflation"` silently substitute a DIFFERENT metric — observed returning a Core CPI card outright, and price-INDEX levels (~130 index points) instead of a rate. The numbers look plausible either way, so verify the chosen card's title actually says `PCE` and `(% Change)` with values in percent. For the rate, query the year-over-year variant (`"US core PCE price index % change"`). Run `tako_available_data` FIRST (mandatory here) to grab the exact `(% Change)` metric + `node_id`.
- Parallelize multi-part asks: send each metric as its own narrow concurrent `tako_search`, then synthesize — not one query.
- Cross-country comparison is built in: `"US vs China inflation"` returns a comparison card. For currency-denominated indicators (GDP, wages), a cross-country chart may plot different currencies on one axis unnormalized — state each series' currency and convert before comparing.
- Ground in Tako data with `sources: ["data"]`.
- Empty result (zero cards) — HARD STOP on retries. Every search is billed, and rewording almost never flips an empty result to a hit. Recover in exactly this order: (1) `tako_available_data` (free) for the exact indicator name + `node_id`; (2) if covered, ONE more search with that exact name and pinned `node_ids`; (3) if not covered, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query is its own question with its own budget).
- Empty also means "not covered in Tako," NOT that the indicator doesn't exist — don't infer a fact from silence.

## Pick the tool
- `tako_search` — indicator as a chart (default).
- `tako_answer` — one known value, in prose ("What is the current US unemployment rate?"). Relay verbatim.
- `tako_available_data` — FREE: resolve the exact indicator name + `node_id`. When the target is unambiguous, its `next_call` output is the follow-up search prewritten — run it verbatim.
- Cohort/ranking asks ("which G7 economy has the highest inflation right now?") → fire one narrow `tako_search` per country in parallel and rank from the results.

## Rendering (Critical)
- Match the card to intent — don't blindly trust index 0. Tako auto-renders the #0 card, but the least-specific card often ranks first: `"US CPI inflation"` can rank a broad BIS country card (a different headline number) above the labeled FRED CPI card, and stale vintages can sneak in. Scan the cards and use the one whose title matches the exact variant with the freshest `data_as_of`; if it isn't #0, reference it with `[Title](webpage_url)` and say it is the authoritative one.
- Reference the chart in prose; do NOT paste `![](image_url)` for a card — that double-renders the inline chart.
- Cite the source (FRED / OECD / BIS) + `data_as_of` date.

## Examples
- Single → tako_search {"query": "US CPI inflation", "sources": ["data"]}
- Parallel multi-metric → four calls: "US CPI inflation", "US core CPI inflation", "US core PCE price index % change", "US PCE price index % change" (pick each card titled "(% Change)" — the plain "PCE Price Index" cards are index levels, not rates)
- Cross-country → tako_search {"query": "US vs China inflation", "sources": ["data"]}
- Indicator-name pre-check (free; note the arg is `q`) → tako_available_data {"q": "US core PCE"}
- Known value, prose → tako_answer {"query": "What is the current US federal funds rate?", "sources": ["data"]}

## Output (tight and structured)
1) A 1–2 line read of the indicator, referencing the intent-matched chart
2) Source (FRED / OECD / BIS) — `data_as_of` date
3) A single `[Open in Tako](embed_url)` for the card you embedded
