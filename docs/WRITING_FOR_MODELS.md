# Writing for models

Tako reaches a model through four kinds of text: the bundled skill, the server
instructions, the tool descriptions, and the tool results. Hand-written copies
restate them for other hosts and readers. Each has one job.
Read this before you change any of them, and measure a change to the skill or
the descriptions before you ship it.

## What each surface does

| Surface | Where it lives | When the model reads it | Its job |
|---|---|---|---|
| Skill | `skills/tako-search/SKILL.md` and `skills/tako-agent/SKILL.md` | The description before every task; the body only after the model opens the skill | Decide whether the model calls Tako, then carry the workflow and the report template |
| Server instructions | `workers/src/instructions.ts` | Whenever the host puts them in context; not every host does | Describe the server for hosts without the skill |
| Tool descriptions | `workers/src/tools/*.ts`, rendered in `docs/TOOLS.md` | When the model plans a call | Say how to call the tool and how to read its result |
| Results | The tool's output and `guidance` | After a call | Report what this call found and what it cost |
| Hand-written copies | `docs/gemini/GEMINI.md`, `commands/*.toml`, `llms-full.txt`, `agent.json`, `README.md`, and the test cases in `chatgpt-app-submission.json` | The Gemini context file in every Gemini session; the rest when an agent or a reviewer opens them | Restate the skill and the descriptions. No check compares their advice with the descriptions, so update them in the same change |

The skills reach only hosts that install the plugin: the Claude plugin, the
Gemini extension, and the ChatGPT plugin package. A host connected to bare
`/mcp` sees only the instructions, the descriptions, and the results, so each
tool description must still stand on its own.

## The skill decides whether the model calls Tako

Write the skill description to trigger on the task, not on a list of what Tako
covers.

- **Don't list coverage.** The graph covers more than any description can name,
  and a listed domain pulls the model toward that list. A description that
  framed Tako as general search ("Use when you need to look something up:
  current events, facts, figures, or pages on any topic") beat one that added
  "especially when the answer is a figure, result, schedule, standing, or
  forecast", on data questions as well as web lookups.
- **Don't patch a miss by adding a word.** Adding "result, schedule, standing"
  fixed the sports prompts it was written for, and a word list tuned to one set
  of prompts fails on the next. Treat the remaining misses as the measured cost
  of a general trigger.
- **Put the workflow in the body.** The body loads only after the model opens
  the skill, so it doesn't change triggering. Use it for query shapes, the
  card checks, and the report template.
- **Trigger an agent on an explicit ask.** An agent run costs more than a
  search, so a lookup that starts one is the failure to avoid. A description
  that names the shape of a research question also matches lookups that
  resemble it, such as one entity's change over time. `tako-agent` fires only
  when the user asks for Tako's agent or for deep research with Tako.

### Evidence

Codex trigger runs in October 2026 (TAKO-4968), against a stub MCP server that
served the production `tools/list` and logged every call:

| Arm | Data questions | Web-only lookups | No-lookup tasks |
|---|---|---|---|
| No skill | 1 of 268 | 0 of 30 | 0 of 30 |
| Three domain skills on `main` (finance, macroeconomics, web traffic) | 78 of 268 | 0 of 30 | 1 of 30 |
| General search ("look something up… on any topic") | 167 of 268 | 16 of 30 | 1 of 30 |
| General search plus "especially when the answer is a figure…" | 124 of 268 | 5 of 30 | 0 of 30 |

That run used `gpt-6-luna` on Codex 0.164.0, with one question for each
production-ready data manager spec family, asked twice. The three-skill arm
ran a day after the others. Its one no-lookup trigger was "Explain the
difference between CPI and PCE inflation.", and the general-search arm's was
"What does it mean when the yield curve inverts?".

Codex over-trigger runs on 2026-10-23 (TAKO-5267) measured how often a lookup
starts an agent once the plugin lists `tako_agent` and `tako_company_agent`.
Each arm ran 68 lookups and 15 no-lookup tasks, twice each, against a stub
that served the arm's captured listing:

| Arm | Lookups that start an agent first | Lookups that start with `tako_search` | No-lookup tasks that call Tako |
|---|---|---|---|
| Plugin today: four tools, `tako-search` | 0 of 136 | 55 of 136 | 0 of 30 |
| Six tools, `tako-search` only | 3 of 136 | 64 of 136 | not run |
| Six tools, `tako-agent` triggered by the shape of the question | 8 of 136 | 52 of 136 | 0 of 30 |
| Same, without "periods" and "growth rates", and handing one entity's change over time to `tako-search` | 4 of 136 | 56 of 136 | 0 of 30 |
| Six tools, `tako-agent` triggered by an explicit ask (shipped) | 3 of 136 | 67 of 136 | 1 of 30 |

The gate was at most 1 in 20 lookups. Most of the shape-triggered agent calls
came on lookups about one entity's change over time. The listing alone starts
an agent on some registry and change-over-time lookups, from the agent tool
descriptions, and no skill wording removes those calls. That run used
`gpt-6-luna` on Codex 0.164.0. It didn't measure how often a research question
reaches an agent.

An earlier run on `gpt-6-astra` (Codex 0.155.1) tested the tool description
instead. Rewriting the `tako_search` description to list its domains and
sources left triggering unchanged (12 of 26 against 13 of 26), and so did adding
"Prefer this over a general web search…" (13 of 26). Adding a skill for the
same domains raised it to 24 of 26.

## Tool descriptions say how to call the tool

- Lead with what the tool does in one line, then a `Best for:` line. See the
  tool-description rule in `AGENTS.md`.
- Describe the tool's own scope. OpenAI's plugin guidelines bar descriptions
  that favor or disparage other plugins or services, or that recommend
  triggering beyond the plugin's purpose
  (https://developers.openai.com/apps-sdk/app-submission-guidelines). "Prefer
  this over web search" fails that rule, and it didn't work anyway.
- Don't make one tool a step before another. `tako_search` used to tell the
  model to run `tako_available_data` first. The model searched first in 122 of
  127 runs that called Tako, and a search that misses still returns web
  results. `tako_available_data` is for questions about coverage.
- A description change reaches ChatGPT users after the next production
  release, when OpenAI's daily scan picks it up. Keep a changed input schema
  compatible with the approved one until the new definition is live.

## Results report what came back

- **Let an empty search result speak for itself.** A `tako_search` or
  `tako_search_advanced` call with no card returns an empty `cards` list beside
  its `web_results`, and nothing else. TAKO-5260 removed the zero-card
  `guidance`. It went in to stop billed reword-and-retry loops: it said
  rewording wouldn't help and allowed one retry on the canonical name from
  `tako_available_data`. Models don't loop without it. In the TAKO-4968 runs,
  the stub answered every search with "No results" and no guidance. In the two
  arms whose skill had today's `tako-search` step 4 and no retry rule, 8 of 312
  runs that searched tried one reworded query, and none searched a third time.
  Every one of those runs had a skill loaded, so a bare `/mcp` host without the
  skill is still unmeasured. The skill and the `tako_available_data`
  description already cover a miss.
- **On the search tools, add `guidance` only for a fact the model can't see in
  the result.** `STRICT_PIN_GUIDANCE` covers a `strict: true` pin that returned
  no cards, where zero cards says something about the filter and not about
  coverage. `withheldDataGuidance` covers a placeholder card a keyless caller
  can unlock by signing in. This rule doesn't cover the `tako_available_data`
  verdicts; nobody has measured them either.

## Cost belongs in results, not descriptions

- **Keep prices out of tool descriptions.** None of the comparable paid servers
  we checked in October 2026 puts prices there: Exa, Parallel, Tavily,
  Firecrawl, Brave, Perplexity, SerpAPI, Apify, Bright Data, and others. Prompt
  wording that discourages tool calls also suppresses the calls a task needs
  (When2Tool, https://arxiv.org/abs/2605.09252).
- **Allow a neutral clause on a parameter whose value changes the charge.** For
  example, `max_rows` on `tako_contents` says "Charges scale with rows returned,
  so lower it when the recent rows are enough." Apify, Firecrawl,
  and Bright Data do the same on their budget parameters.
- **Report the actual charge in the result.** `tako_search` returns
  `usage.total_cost_usd`, and `tako_contents` returns a `cost` on each item.
  Cost feedback after each call cut searches by 40% with no loss in accuracy
  (BATS, https://arxiv.org/abs/2511.17006).
- **Keep exact prices where a paying agent decides.** Agents that pay per call
  over MPP read prices from `agent.md` and the 402 response before they pay.
- **Keep pricing out of the ChatGPT listing.** OpenAI's guidelines say "Do not
  advertise pricing, subscriptions, free trials, discounts, or promotions."

## Measuring a change

To test a skill or description change, run Codex against a stub MCP server.
The stub serves the production `initialize` and `tools/list` and answers every
call with "No results." Log each `tools/call` with the run's id, and give each
arm its own `CODEX_HOME` and `HOME` so only that arm's skills load.

- Run `codex --search exec --ignore-user-config --ephemeral --json` with
  `mcp_servers.tako.url` pointing at the stub.
- On Codex 0.164.0 and later, also set `features.apps=false`,
  `features.plugins=false`, and `features.remote_plugin=false`, and clear
  `plugins/` and `cache/` from each `CODEX_HOME`. Otherwise Codex connects your
  account's ChatGPT apps and installs its remote plugins, including the
  published Tako plugin, into every arm. `--ignore-user-config` doesn't stop
  either one.
- Count a run as complete only when it emits `turn.completed`. Codex sends an
  agent message before it acts, and a spend-cap failure arrives after it.
- Draw data prompts from the data manager specs, not from a hand-picked list,
  and include web-only lookups and no-lookup tasks as controls.
- Run each prompt at least twice. Single prompts flip between runs, so compare
  totals.
