---
name: tako-web-traffic
description: Website and app traffic via Tako (source: SimilarWeb). Monthly visits, traffic trends, and top-sites rankings for any domain as citation-backed charts. Use for competitive traffic analysis, share-of-attention, or any "how much traffic does <site> get" question.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as interactive, citation-backed charts.

## Query patterns (Critical)
- Query by DOMAIN, not brand. Brand names resolve to the wrong concept — under `sources: ["data"]` a brand query returns zero cards, and with `"web"` on it mis-resolves to subscriber counts or CDN/network-traffic articles. Always use the bare domain: `"netflix.com monthly visits"`, `"youtube.com"`, `"chatgpt.com"`.
- The core metric is Visits (monthly, with ~1-month lag).
- Comparisons: `"youtube.com vs netflix.com monthly visits"`. Rankings: `"top websites by visits"` returns a ranked card.
- Ground in Tako data with `sources: ["data"]` (SimilarWeb is proprietary).
- Empty result (zero cards) means "not covered in Tako," NOT that the domain has no traffic — confirm coverage with `tako_available_data` or a web check; don't infer a fact from silence.

## Pick the tool
- `tako_search` — traffic as a chart (default; top result renders inline).
- `tako_answer` — one number, in prose ("How many monthly visits does netflix.com get?").
- `tako_agent` — a ranking/cohort to figure out ("top 5 streaming domains by visits, and which is growing fastest"). ~30–90s.
- `tako_available_data` — FREE check that a domain is covered before a priced call.

## Rendering (Critical)
- The top result renders inline automatically — an interactive widget on ChatGPT, a chart image on other hosts. Reference it in prose; do NOT paste `![](image_url)` for the top card — that double-renders it.
- Cite SimilarWeb + the as-of month (it's in `data_freshness.data_as_of`).
- Comparison cards (`"A vs B"`) describe each series as a % change over the period — for absolute monthly visits, read the per-domain single-series card instead.
- Point at any extra cards by linking their titles as `[Title](webpage_url)` — embed only the top card.

## Examples
- Single domain → tako_search {"query": "netflix.com monthly visits", "sources": ["data"]}
- Head-to-head → tako_search {"query": "youtube.com vs netflix.com monthly visits", "sources": ["data"]}
- Ranking → tako_search {"query": "top websites by visits", "sources": ["data"]}

## Output (tight and structured)
1) A 1–2 line read of the traffic, referencing the inline chart
2) SimilarWeb — as-of month
3) A single `[Open in Tako](embed_url)` for the top card
