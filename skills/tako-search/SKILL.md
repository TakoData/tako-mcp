---
name: tako-search
description: >-
  Use when you need to look something up: current events, facts, figures, or pages on any topic. Tako searches the live web and a knowledge graph of licensed data in one call, and returns web results, plus a structured, cited card when the graph has one.
---

# Tako

Tako searches the live web and a knowledge graph of licensed and public data in one call. The graph covers companies, markets, economies, sports, weather, prediction markets, websites, and more, and refreshes much of it during the day. When the graph has the answer, the result leads with a card: a headline value, its source, and a chart. Every search also returns web results. All tools below live on the Tako MCP server (server name `tako`).

## Look something up

1. Search first. Call `tako_search` once per question, naming the entity and what you want: "Apple revenue", "Lakers last game score", "US CPI inflation", "EU AI Act timeline". For a comparison, name both entities in one query: "Nvidia vs AMD gross margin". Run independent searches in parallel.
2. Query website traffic by domain: "netflix.com monthly visits", not "Netflix website visits".
3. If a card comes back, check that it answers the question: the same entity, metric, and unit. For example, operating income isn't operating margin. Read the value from the card's `description`.
4. If no card answers the question, answer from the web results. To read a page in full, pass its url to `tako_contents`.
5. If a name is ambiguous, such as "Costco" or "Coca-Cola", and the question doesn't settle which entity, ask before quoting a number.

## Explore what Tako has

For questions about coverage or relationships, such as "What does Tako track for Tesla?", "Who competes with Nvidia?", or "Which countries are in the G7?", resolve the entity with `tako_available_data`. Then call `tako_graph_related` on the node id it returns.

## Report

- Lead with the answer in one or two lines. The top card renders inline as a chart, so refer to it in prose; don't re-post its image URL.
- Name the source: the card's `source`, or the web page you used.
- Link the card you used: `[Open in Tako](url)`.
- If the series ended well before today, give its as-of date from `coverage_end`.
