---
name: tako-web-traffic
description: >-
  Website and app traffic via Tako (source: SimilarWeb). Monthly visits, app active users, traffic trends, and top-sites rankings for any domain as citation-backed charts. Use for competitive traffic analysis, share-of-attention, or any "how much traffic does <site> get" question.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as interactive, citation-backed charts. All tools below live on the Tako MCP server (server name `tako`).

## What's in range
- **Monthly Visits** per domain — the core metric, with roughly a one-month lag.
- **Head-to-head domain comparisons** and **ranked top-sites** cards.
- **App usage**: `"Spotify app monthly active users"` returns a SimilarWeb "Monthly Active Users" card keyed by the bare app name (`spotify`), not a domain.
- Coverage reaches well into the long tail: `"kagi.com monthly visits"` returns a real card (4.68M visits).

## Query patterns (Critical)
- **Query by DOMAIN, not brand**: this is the single highest-leverage rule here, and getting it wrong produces a confident wrong answer rather than an obvious failure. Use the bare domain: `"netflix.com monthly visits"`, `"youtube.com"`, `"chatgpt.com"`. For app usage, use the app name plus the metric.
- What a brand-shaped query actually does, and why it is dangerous: `"Netflix traffic"` on data returns three Netflix **subscriber** cards (84.0M average streaming subscribers), plausible-looking numbers that are not web traffic at all — while on web it returns CDN and BGP network-engineering articles about Netflix Open Connect. `"Netflix website traffic"` returns no card either way. None of these is the answer; only the bare domain produces a Visits card. If a traffic answer isn't backed by a card whose title is `<domain> Monthly Visits`, you do not have the traffic number yet.
- Comparisons: `"youtube.com vs netflix.com monthly visits"` returns a real 2-series card. Rankings: `"top websites by visits"` returns a ranked card (google.com 84.9B, youtube.com 28.8B, …).
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The SimilarWeb card grounds the number and web results add context (competitive write-ups, ranking roundups) that turn a figure into analysis. Price is identical either way, and web does not degrade card selection on a well-formed domain query. Narrow to `["data"]` when you only want the number for a domain you know is covered, or in a parallel fan-out.
- Empty result (zero cards): do NOT reword and retry blind; every search is billed. The #1 cause is a brand-name query: if the query wasn't a bare DOMAIN, fix it to one (`"Netflix traffic"` → `"netflix.com monthly visits"`) and retry ONCE. That is the recovery. If a domain-shaped query still comes back empty, stop searching Tako and answer from the web results already in the response, labelling the figure web-sourced.
- Do NOT use `tako_available_data` to rule a domain out. Its graph is entity-based and misses long-tail domains SimilarWeb covers: it reports `found: false` for `kagi.com` while the search returns a real card. It is still useful for resolving a brand to its entity `node_id` (`tako_available_data {"q": "Netflix"}` → `ent::netflix_inc::…`; note the arg is `q`), though pinning an entity `node_id` alone does not steer retrieval: only a METRIC `node_id` with `strict: true` does.
- Empty also means "not covered in Tako," NOT that the domain has no traffic — don't infer a fact from silence.

## Pick the tool
- `tako_answer`: **the default for "how much traffic does <domain> get".** Returns the number in prose with its cited chart attached. This matters more here than anywhere: SimilarWeb is licensed, so a search card carries NO rows. The figure lives in the card's `description` or comes from here.
- `tako_search`: reach for it when you want **breadth or a chart**, e.g. the ranked top-sites card, a head-to-head embed, or scanning several domains to see which are covered. Its cards are captions, never rows.
- `tako_available_data`: FREE brand→entity resolver, and the right tool when the question is what Tako covers. Do NOT use it to rule a domain out (see the empty-result bullet).
- SimilarWeb is a protected source, so EVERY traffic card is read-only: not exportable, no inline preview rows, and `tako_contents` cannot export the CSV. This is a licensing wall, not an error, so never call `tako_contents` on a traffic card. The numbers live in the card's `description` (latest value + % change over the period) and the chart; for one specific figure use `tako_answer`. (Web-result urls remain fetchable.)
- Cohort/growth asks ("top 5 streaming domains by visits, and which is growing fastest") → get the ranked card with `tako_search` (breadth is its job), then one `tako_answer` per domain in parallel and compute growth from the figures.

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts: whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
- **Verify by title, not by `nodes`.** Traffic cards list only the metric in `nodes` (`Visits`); the domain never appears there, so the entity check that works elsewhere in Tako is useless here. Confirm the domain in the card's title.
- **Comparison vs. single-series.** On a `"A vs B"` card the description reports each series as a **% change over the period**, not absolute visits (the youtube/netflix card leads with `-0.95%`). For absolute monthly visits, read the per-domain single-series card, which the same search usually also returns at #1 and #2.
- **A comparison card's as-of date is the QUERY date, not the data date**: the youtube/netflix comparison reported the day it was run while the single-domain cards correctly report the June 2026 data month. Cite the month from the single-series card or its `description`.
- **Watch for a different metric family.** SimilarWeb app "Monthly Active Users" and a company's own reported MAU are different numbers from different sources: `"Spotify app monthly active users"` returns SimilarWeb at 338.0M alongside Visible Alpha company-reported MAU at 479.5M. Say which one you're quoting.

## Rendering
- The top result renders inline automatically: an interactive widget on ChatGPT, a chart image on other hosts. Reference it in prose; do NOT re-post the card's image URL as a markdown image — that double-renders it.
- Cite SimilarWeb + the as-of month (read it from the single-series card).
- Point at any extra cards by linking their titles to their chart URLs — embed only the top card.

## Examples
- Single domain (the common case) → tako_answer {"query": "How many monthly visits does netflix.com get?", "sources": ["data", "web"]} — the figure plus its cited SimilarWeb chart
- Head-to-head → tako_answer {"query": "How do youtube.com and netflix.com compare on monthly visits?", "sources": ["data", "web"]} → absolute visits come from the per-domain figures, not a comparison card's % change
- Chart or ranking is the deliverable → tako_search {"query": "top websites by visits", "sources": ["data", "web"]} → embed the ranked card
- App usage → tako_answer {"query": "How many monthly active users does the Spotify app have?", "sources": ["data", "web"]} → say whether you quoted SimilarWeb or company-reported MAU
- Cohort fan-out → `tako_search` with `"sources": ["data"]` to see which domains are covered, then one `tako_answer` per domain for the figures
- Brand-shaped ask ("how much traffic does Netflix get?") → resolve to the domain yourself and ask about `netflix.com`; never answer from a subscriber card

## Output (tight and structured)
1) A 1–2 line read of the traffic, referencing the inline chart
2) SimilarWeb — as-of month, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the top card
