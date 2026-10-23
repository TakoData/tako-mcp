---
name: tako-agent
description: >-
  Use when the user asks for research that a lookup can't answer: a ranking, screen, or total across a set of entities the question describes rather than names, a calculation across several metrics or periods, or a list of companies or people that match criteria. Tako's agents plan the steps, search the web, compute rankings, totals, and growth rates from licensed data, and return a cited answer with charts or lists. For a single figure or a comparison of named entities, use tako-search.
---

# Tako agents

Tako's agents answer research questions that one search can't. An agent plans its own steps, searches the web and Tako's licensed data, computes what the question asks for, and returns a cited answer with charts or lists. All tools below live on the Tako MCP server (server name `tako`).

## When not to use an agent

If one `tako_search` call can answer the question, use `tako-search` instead. That covers a single figure, a series for one entity, and a comparison of entities the question names, such as "Nvidia vs AMD revenue since 2020". Don't start an agent for a task that needs no data, such as writing, editing, or explaining a concept.

## Choose the agent

- Use `tako_company_agent` when the answer is a list of companies or people: a screen by location, industry, status, founding date, funding, or size; officers, directors, or owners; or companies ranked or filtered by a financial metric, such as "the 10 largest UK software companies by revenue".
- Use `tako_agent` for a ranking, trend, total, or calculation whose answer isn't a list of companies or people: countries ranked by GDP, a growth rate across several periods, or a figure computed from several metrics.

## Run an agent

1. Send the user's question in `query`, one question per call. The agent plans its own steps, so don't split the question.
2. If `status` is `running`, call the same tool again with that `run_id` and no `query`. Don't start a new run for the same question.
3. If a call fails before it returns a `run_id`, ask the user before you start another run.
4. For a follow-up in the same conversation, pass the `thread_id` from the earlier run with the new `query`.

## Effort

`tako_company_agent` takes `effort`. Leave it unset for the default, `medium`. Use `high` only when the user asks for a thorough answer. Don't use `low` when the question filters or ranks by a financial metric such as revenue or headcount, because `low` can't. A thread keeps its effort, so omit `effort` on a follow-up.

## Report

- Lead with the agent's answer in a few lines, and keep its numbered citations.
- Link each card the agent returns: `[Open in Tako](url)`. The full chart or list lives on that page.
- If the agent says it couldn't answer part of the question, say so.
