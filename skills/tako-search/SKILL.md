---
name: tako-search
description: >-
  Use when you need to look something up: current events, facts, figures, or pages on any topic. Also use it when the answer needs a calculation over real-world data. Tako searches the web and a knowledge graph of licensed data in one call, and returns web results, plus a structured, cited card when the graph has one.
---

# Tako

Tako searches the web and a knowledge graph of licensed and public data in one call. The graph covers companies, business professionals, markets, economies, sports, weather, prediction markets, websites, and more, and refreshes much of it during the day. When the graph has the answer, the result leads with a card: a headline value, its source, and a chart. Every search also returns web results. All tools below live on the Tako MCP server (server name `tako`).

## Look something up

1. Search first. Call `tako_search` once per question, naming the entity and what you want: "Apple revenue", "Lakers last game score", "US CPI inflation", "EU AI Act timeline". For a comparison, name both entities in one query: "Nvidia vs AMD gross margin". Run independent searches in parallel.
2. Query website traffic by domain: "netflix.com monthly visits", not "Netflix website visits".
3. If a card comes back, check that it answers the question: the same entity, metric, and unit. For example, operating income isn't operating margin. Read the value from the card's `description`. To compute something from the card's rows, such as a growth rate, an average, or a correlation, follow **Compute over a series**.
4. If no card answers the question, answer from the web results. To read a page in full, pass its url to `tako_contents`.
5. If a name is ambiguous, such as "Costco" or "Coca-Cola", and the question doesn't settle which entity, ask before quoting a number.

If the user asks for Tako's agent and the `tako-agent` skill is installed, follow `tako-agent` instead.

## Find professionals and companies

`tako_search` finds business professionals and companies for B2B research, prospecting, and recruiting, and returns them as a list card. Each row is one professional or company, with their title, employer, location, LinkedIn, and a `tako_url` to their own page. Use it when the user wants the professionals or companies themselves: a list of prospects or candidates, or the professional record of someone they name.

**Professionals by role and place.** Name who and where.

- Who: a role or title ("engineers", "CFO", "VPs of sales", "head of marketing", "founders", "interns"), or a word for a company's people ("employees", "staff", "leadership team"). "Executives", "leadership", and "management" return C-suite and VP-level people.
- Where: an employer, a place, or both: "engineers at Stripe", "CFOs in Austin", "engineers at Google in London". A place needs a role, so "people in Austin" returns no list. A role alone ("CFOs") and an employer alone ("Stripe") also return no list.
- To find who holds a role at one company, search the role and the company: "Airbnb CFO" or "who is the CFO of Airbnb".
- Give a city its state or country: "engineers in Portland, OR". A bare city name matches every place with that name.

**A professional by name.** Search the full name alone, such as "Jane Doe". The list holds everyone with that name.

- Leave out everything else the user told you, such as the employer or title. Search reads every word as part of the name, so "Jane Doe Stripe" returns no list. Use those details to pick the person from the rows.
- Search doesn't match nicknames: "Tim Cook" and "Timothy Cook" return different people. If no row fits, try the other form of the name.
- A common name can match hundreds of people, and the rows can't be filtered by employer. If the person isn't in the first rows, fetch more and match on employer, title, and location.

**Companies by industry or type**, plus a place, a size, a funding stage, public or private, or a founding year: "fintechs in London", "SaaS companies with 50–500 employees", "Series B startups in Berlin", "AI startups founded since 2020".

Then read the list:

1. The card's `description` doesn't name the matches. To see them, pass the card's url to `tako_contents` with `max_rows` set to the rows the answer needs, such as 25. Fetch the full list, up to 1,000 rows, only when the user asks for it.
2. Check each row before you use it. A name list holds everyone with that name, and a company name can match more than one company. If more than one row fits the person the user means, ask which one.
3. Each row's `tako_url` opens that one person or company in Tako. Link it.
4. Tako withholds premium cells, such as business contact fields. A list card shows each one as 🔒, and the result's `note` names the withheld columns. Don't tell the user that a withheld field is empty. When the user asks for those fields, call `tako_contents` again with `premium: true` for only the rows they want, because Tako bills each of those rows. For one row, pass that row's `tako_url` with `max_rows: 1`, and Tako returns only that row. For several rows, set `offset` and `max_rows` instead. The row order can change between calls, so check the name on each row you get.
5. A list can't filter on revenue, investors, registry status, or a company's officers and directors. If the question needs one of those, say so. If the `tako-agent` skill is installed, offer Tako's company agent.
6. If no list card comes back, tell the user that Tako found no list. If the `tako-agent` skill is installed, offer Tako's company agent.

## Compute over a series

Compute in code, never in your head: growth rates, averages, CAGR, correlations, and rankings. Report what the code prints. Only a card marked `exportable: true` has rows to fetch.

1. **If you can run shell commands**, call `tako_contents` with `delivery: "link"`, then download the file right away: `curl -sfL -o <name>.csv "<url>"`. The link expires 5 minutes after the call. Analyze the file in a script and read only the result, so the rows never enter your context. If the result says `truncated`, call again with a higher `max_rows`, up to 100,000.
2. **If the download fails**, your shell may have no network access. Call `tako_contents` again without `delivery`, with `max_rows` at 2,000 or less, and pass the inline rows to your code tool.
3. **If you have no shell**, or `tako_contents` has no `delivery` input, fetch the rows inline and pass them to your code tool. With no code tool at all, show each step of the arithmetic so the user can check it.
4. **If `tako_contents` has a `format` input**, set `format: "card"` for a card's own structure, such as a company card's tabs.

## Explore what Tako has

For questions about coverage or relationships, such as "What does Tako track for Tesla?", "Who competes with Nvidia?", or "Which countries are in the G7?", resolve the entity with `tako_available_data`. Then call `tako_graph_related` on the node id it returns.

## Report

- Lead with the answer in one or two lines. The top card renders inline as a chart, so refer to it in prose; don't re-post its image URL.
- Name the source: the card's `source`, or the web page you used.
- Link the card you used: `[Open in Tako](url)`.
- If the series ended well before today, give its as-of date from `coverage_end`.
