---
name: tako-web-traffic
description: >-
  Use when the user asks how much traffic a website gets, compares sites' visits, wants a top-sites ranking, asks which sites compete with a brand for attention, or asks about an app's monthly active users — including when they name the brand rather than the domain ("how much traffic does Netflix get"). Returns SimilarWeb figures as structured, citation-backed data from Tako, each with a chart. Not for company financials such as subscribers or revenue.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as structured, cited data: each result is a card carrying the headline value and a chart of the series. All tools below live on the Tako MCP server (server name `tako`). The tool descriptions and every result already carry the card fields, the `sources` guidance and the zero-card recovery; this skill covers how to shape a traffic query, how to check a card against the question, and how to report.

## Workflow

1. **Query by domain**: `"netflix.com monthly visits"`, `"chatgpt.com"`. Traffic data is keyed by domain, so resolve a brand to its domain yourself. For app usage, query app name + metric: `"Spotify app monthly active users"`; app cards are keyed by the bare app name.
2. **Call `tako_search`** with the default sources. Web results add competitive write-ups and ranking roundups.
3. **Check the top card against the question** with the list below. You have the traffic number only when the card's title is `<domain> Monthly Visits`, or the app's active-users card.
4. **Read the figure from `description`**: the latest monthly value and the % change over the period. Traffic cards are licensed and don't export (`exportable: false`), so the description and the chart are the data; don't call `tako_contents` on one. Web-result urls remain fetchable.
5. **Zero cards?** If the query wasn't a bare domain, make it one and retry once. If a domain query is still empty, answer from the web results and label the figure web-sourced. Don't use `tako_available_data` to rule a domain out: the graph resolves brands to companies, not to domains, so a domain it doesn't know can still have a traffic card.
6. **Competitive asks** ("who competes with Netflix for attention", "Netflix vs its rivals")? Resolve the brand with `tako_available_data` to get its company node id, call `tako_graph_related` with `relation: "rel:competes_with"`, map the competitors to their domains yourself, and run one domain search per site in parallel.

## Checking a card against the question

1. **Domain, from the title.** Traffic cards list only the metric in `nodes`; the domain never appears there, so the entity check that works elsewhere doesn't apply.
2. **Absolute vs relative.** An `"A vs B"` card's description reports each series as a % change over the period. For absolute visits, read each domain's single-series card; run a per-domain search if the comparison result didn't include them.
3. **Ranking scope.** Ranking cards exist per category and per measure ("Top Websites by Visits", "Top Arts and Entertainment Websites by Visits", "… by Average Visit Duration"). The title names both; confirm they match the question.
4. **Metric family.** SimilarWeb app "Monthly Active Users" and a company's own reported MAU are different numbers from different sources, and both can appear in one result. Say which you're quoting.
5. **Month.** `coverage_end` is the data month. Cite it.

## Output

1. One or two lines on the traffic, referencing the inline chart in prose. Never re-post the image URL: it double-renders the chart.
2. "SimilarWeb" and the `coverage_end` month. Say plainly when a figure is web-sourced.
3. One `[Open in Tako](url)` link for the top card; point at extra cards by linking their titles to their `url`.
