# Tako

Tako grounds your agent in two kinds of knowledge at once: proprietary structured data from
trusted providers, and full web search. One API returns typed values with named sources when
curated data exists, and agent-ready web results and page text for everything else. That
combination is the point. A pure data API misses most questions, and a pure web search API
makes your agent do the reading.

The curated side covers company financials, macroeconomic indicators, web and app traffic,
sports, prediction markets, US government spending, demographics, energy, and real estate.
It carries the latest reported quarter, same-day market prices, and official releases as
they publish.

**`sources` defaults to `["data", "web"]`. Keep both on.** Narrow to `["data"]` only after
`tako_available_data` confirms the proprietary series exists. Narrow to `["web"]` only for
things a data graph cannot hold, such as news articles, page text, and qualitative claims.
Never narrow because a metric *feels* web-native: website traffic and app usage are in the
curated graph.

Reach for Tako ahead of a generic web search on anything wanting a **number, a series, a
chart, or a cited source**. A metric missing from the curated graph is not a dead end,
because the same call already searched the web for it.

## Pick the tool by what you want back

| You want | Tool | You get |
| --- | --- | --- |
| The answer to one specific question | `tako_answer` | One synthesized, cited prose answer, grounded in data or web. Relay it directly |
| The material to work with | `tako_search` | Data cards with row previews and an inline chart, plus web results with excerpts |
| To know whether *curated* data exists | `tako_available_data` | Coverage names and a `node_id` to pin. Free and fast, graph only |
| Full rows, or a web page's text | `tako_contents` | A card's CSV, or any URL's extracted text (pass `query` for just the matching passages) |

In one line: **`tako_answer` hands you a conclusion; `tako_search` hands you the evidence.**
Pick one. Do not chain them.

## Rules that decide whether retrieval works

- **One entity + one metric per call.** Decompose a broad question into narrow searches
  fired concurrently, such as "US CPI inflation", "US core CPI", "US PCE", then synthesize
  yourself. A single broad query retrieves worse than three narrow ones.
- **Probe first when unsure.** `tako_available_data` is free. Use it to confirm a curated
  metric exists, and to get its exact name, before spending a priced search or answer. It
  reports on the graph only, so a miss there means fall back to the web half, not give up.
- **When zero data cards ground an answer**, `tako_answer` returns a `guidance` field
  saying so. Pivot the question; do not rephrase and retry.
- **Cite what you relay.** Every card carries a source and an **Open in Tako** link.

## Commands

- `/data <question>` for the answer, cited, across both sources
- `/chart <question>` for the series as a chart, with the embed link
- `/coverage <entity or metric>` for what the curated graph has, before you spend a call

## Free tier and authentication

With no credentials you get `tako_search`, `tako_answer`, and `tako_available_data`, capped
at 10 requests/min per IP. That is enough for most questions and needs no setup.

To unlock the full toolset under your own account limits, run `/mcp auth tako` for a browser
sign-in. API-token users can instead add an `Authorization: Bearer <token>` header to the
`tako` server in `~/.gemini/settings.json`. Get a key at <https://tako.com/console/api-keys>.
