---
name: tako-web-traffic
description: Website and app traffic via Tako (source: SimilarWeb). Monthly visits, traffic trends, and top-sites rankings for any domain as citation-backed charts. Use for competitive traffic analysis, share-of-attention, or any "how much traffic does <site> get" question.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as interactive, citation-backed charts. All tools below live on the Tako MCP server (server name `tako`).

## Query patterns (Critical)
- Query by DOMAIN, not brand. Brand names resolve to the wrong concept — under `sources: ["data"]` a brand query returns zero cards, and with `"web"` on it mis-resolves to subscriber counts or CDN/network-traffic articles. Always use the bare domain: `"netflix.com monthly visits"`, `"youtube.com"`, `"chatgpt.com"`.
- The core metric is Visits (monthly, with ~1-month lag).
- Comparisons: `"youtube.com vs netflix.com monthly visits"`. Rankings: `"top websites by visits"` returns a ranked card.
- Ground in Tako data with `sources: ["data"]` (SimilarWeb is proprietary).
- Empty result (zero cards) — HARD STOP on freeform retries; every search is billed (even an empty one) and rewording almost never helps. The #1 cause here is a brand-name query: if the query wasn't a bare DOMAIN, fix it to one (`"Netflix traffic"` → `"netflix.com monthly visits"`) and retry ONCE — that is the recovery. If a domain-shaped query still came back empty, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each domain query is its own question with its own budget).
- Do NOT use `tako_available_data` to rule a domain out: its graph is entity-based and misses long-tail domains SimilarWeb still covers (it reports `found: false` for kagi.com while `"kagi.com monthly visits"` returns a real card). It is still useful for resolving a brand to its entity `node_id` (e.g. tako_available_data {"q": "Netflix"} — note the arg is `q`) to pin into a search.
- Empty also means "not covered in Tako," NOT that the domain has no traffic — don't infer a fact from silence.

## Pick the tool
- `tako_search` — traffic as a chart (default; top result renders inline).
- `tako_answer` — one number, in prose ("How many monthly visits does netflix.com get?").
- `tako_available_data` — FREE brand→entity resolver (see the empty-result bullet for its limits on domains).
- Cohort/growth asks ("top 5 streaming domains by visits, and which is growing fastest") → get the ranked card with `tako_search`, then one narrow search per domain in parallel and compute growth yourself.

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
