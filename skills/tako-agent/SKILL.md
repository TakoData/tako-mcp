---
name: tako-agent
description: >-
  Use when the user explicitly asks for Tako's research agent or for deep, multi-step research with Tako, such as "use the Tako agent to…", "have Tako research…", or "use Tako to build a list of companies that…". Tako's agents plan the steps, search the web and licensed data, and return a cited answer with charts or lists. For any other question, use tako-search, even one that needs a ranking or a calculation.
---

# Tako agents

Tako's agents run multi-step research. An agent plans its own steps, searches the web and Tako's licensed data, computes what the question asks for, and returns a cited answer with charts or lists. All tools below live on the Tako MCP server (server name `tako`).

## When to use an agent

Start an agent only when the user asks for one: they name Tako's agent, ask for deep or multi-step research with Tako, or ask Tako to build a list of companies or people. Otherwise, use `tako-search`, even when the question needs a ranking, a trend, or a calculation. Don't start an agent for a task that needs no data, such as writing, editing, or explaining a concept.

## Choose the agent

- Use `tako_company_agent` to find which companies or people match a set of facts: a screen by location, industry, status, founding date, funding, or size; officers, directors, or owners; or companies filtered by a financial metric, such as "UK software companies with more than £10 million in revenue".
- Use `tako_agent` for a ranking, trend, total, or calculation, including companies ranked by a metric: "the 10 largest UK software companies by revenue", countries ranked by GDP, a growth rate across several periods, or a figure computed from several metrics.

## Run an agent

1. Send the user's question in `query`, one question per call. The agent plans its own steps, so don't split the question.
2. If `status` is `running`, call the same tool again with that `run_id` and no `query`. Don't start a new run for the same question.
3. If a call fails before it returns a `run_id`, follow its guidance. If the guidance says the run may have started, ask the user before you retry.
4. For a follow-up in the same conversation, pass the `thread_id` from the earlier run with the new `query`.

## Effort

`tako_company_agent` takes `effort`. Leave it unset for the default, `medium`. Use `high` only when the user asks for a thorough answer. Don't use `low` when the question filters by a financial metric such as revenue or headcount, because `low` can't. A thread keeps its effort, so omit `effort` on a follow-up.

## Report

- Lead with the agent's answer in a few lines, and keep its numbered citations.
- Link each card the agent returns: `[Open in Tako](url)`. The full chart or list lives on that page.
- If the agent says it couldn't answer part of the question, say so.
