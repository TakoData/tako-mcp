---
name: tako-web-traffic
description: >-
  Use when the user asks how much traffic a website gets, compares sites' visits, wants a top-sites ranking, or asks about an app's monthly active users — including when they name the brand rather than the domain ("how much traffic does Netflix get"). Returns SimilarWeb figures as structured, citation-backed data from Tako, each with a chart. Not for company financials such as subscribers or revenue.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as structured, cited data: each result is a card carrying the headline value and a chart of the series (the rows are licensed and don't export). All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields and the zero-card recovery; this skill covers the one rule that decides success here, which card to trust, and how to report.

## Workflow

1. **Query by DOMAIN, not brand**: `"netflix.com monthly visits"`, `"chatgpt.com"`. Traffic data is keyed by domain, so a brand query (`"Netflix traffic"`) returns the company's subscriber or revenue cards, plausible numbers that aren't traffic, while the web results return network-engineering articles. Resolve the brand to its domain yourself before searching. If no card titled `<domain> Monthly Visits` is in the result, you don't have the traffic number yet.
2. **For app usage, query app name + metric**: `"Spotify app monthly active users"`. SimilarWeb app cards are keyed by the bare app name, not a domain.
3. **Call `tako_search`** with the default sources; web results add competitive write-ups and ranking roundups. Narrow to `["data"]` in a parallel fan-out.
4. **Read the figure from `description`**: the latest monthly value and the % change over the period. Every SimilarWeb card is licensed and locked (`exportable: false`), so never call `tako_contents` on a traffic card; the description and the chart are the data. Web-result urls remain fetchable.
5. **Zero cards?** The cause is almost always a brand-shaped query: fix it to the bare domain and retry once. If a domain query is still empty, answer from the web results and label the figure web-sourced. Don't use `tako_available_data` to rule a domain out; its graph is entity-based and misses long-tail domains SimilarWeb covers. It is still the right free call to resolve a brand to its entity and `node_id` for `tako_graph_related`.

## Choosing the right card

1. **Verify the domain in the title, not in `nodes`.** Traffic cards list only the metric in `nodes`; the domain never appears there.
2. **Single-series for absolute visits, comparison for relative.** An `"A vs B"` card's description reports each series as a % change over the period, not absolute visits; the same search usually also returns each domain's single-series card. Read absolutes from those.
3. **Watch the metric family.** SimilarWeb app "Monthly Active Users" and a company's own reported MAU are different numbers from different sources, and both can appear in one result. Say which you're quoting.
4. **`coverage_end` is the data month**, about one month behind today. Cite it.

## Output

1. One or two lines on the traffic, referencing the inline chart in prose. Never re-post the image URL: it double-renders the chart.
2. "SimilarWeb" and the `coverage_end` month. Say plainly when a figure is web-sourced.
3. One `[Open in Tako](url)` link for the top card; point at extra cards by linking their titles to their `url`.
