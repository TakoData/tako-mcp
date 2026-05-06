# ChatGPT Connector Submission — Regular Directory

Working doc for the **regular ChatGPT connector directory** (the one accessed
from any conversation via the Connectors menu). Edit before submission; keep
the final submitted version on `main` so we have a record of what OpenAI
reviewed.

The **Deep Research connector directory** is a separate listing with its own
endpoint (`/deepresearch/mcp`) and will have its own copy + suggested prompts
under `chatgpt-deep-research.md` once that connector ships. See the spec at
`docs/superpowers/specs/2026-05-06-deep-research-connector-design.md`.

Companion artifacts:

- Branding assets (icon + wordmark) — `docs/branding/`
- Tool surface (auto-generated) — `registry/server.json`
- Test script for OpenAI's reviewer — `chatgpt-test-script.md`

---

## App name

**Tako**

---

## Short description

One-sentence pitch for the directory tile. Aim for ~80–120 characters.

**Current pick:**

> Real-time charts, data, and research from Tako's curated knowledge graph — sports, finance, markets, and more.

**Alternates considered:**

- Live answers and interactive charts on stocks, sports, prediction markets, economics, and current events.
- Curated, citable data and deep research — finance, sports, markets, demographics, polls, and forecasts.

---

## Long description

Three short paragraphs. Tunable knobs called out below.

```
Tako brings curated, real-time data into your conversation as interactive charts
and research reports.

Ask about stocks, crypto, sports schedules and scores, prediction markets,
economic indicators, polls and elections, demographics, real estate, energy,
weather, and more — Tako answers from its curated knowledge graph or runs deep
research live when the question is fresh. Every answer comes with an
interactive chart you can open, share, or embed.

For deeper questions, Tako can generate a full research report — narrative
analysis with multiple charts, exportable to PDF, PPTX, Markdown, or JSON. Data
is sourced from trusted providers (e.g. Polymarket, SimilarWeb, public market
data, government statistics) and every chart links back to its source.

Sign in with your Tako account at tako.com to get started.
```

**Tunable knobs (decide before submission):**

- Drop the explicit data-source name-drops (Polymarket, SimilarWeb) if
  legal/marketing prefers a generic phrasing.
- Add a "free tier" line if Tako has one we want to advertise.
- Trim paragraph 3 if the directory truncates aggressively (some directories
  cap at ~300 chars).

---

## Suggested prompts

The directory shows these as one-tap starter prompts on the connector tile.
OpenAI's reviewer will run them verbatim during submission review.

### Submitting these three (Juan's picks)

| Prompt                                          | Tool flow            | What it demos                  |
| ----------------------------------------------- | -------------------- | ------------------------------ |
| Who will win the 2026 FIFA World Cup?           | `knowledge_search`   | Prediction markets, fresh data |
| Show me NVIDIA's latest earnings                | `knowledge_search`   | Finance, structured data       |
| What are today's top performing stocks?         | `knowledge_search`   | Real-time market data          |

### Optional additions (if directory allows 4–5)

All three above route through `knowledge_search`. Adding one of these
diversifies the demo so reviewers see more of the tool surface:

| Prompt                                                    | Tool flow                                               | Why add                                              |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Compare Apple and Microsoft revenue over the last 5 years | `knowledge_search`                                      | Comparative chart, time series                       |
| Generate a research report on the EV market in 2026       | `create_report` → `get_report` → `export_report`        | Only way reviewers see the report-generation flow    |
| When is the next NBA Finals game?                         | `knowledge_search`                                      | Schedule lookup, different vertical                  |

**Recommendation:** add the research-report prompt. It's the only way to
showcase report generation, which is a major differentiator vs. generic search
connectors.

---

## Open questions before submission

- [ ] Final short-description copy approved by marketing
- [ ] Long-description paragraph 3 — keep or trim?
- [ ] Data-source name-drops — keep or generic?
- [ ] Add the report-generation prompt? (4 prompts vs 3)
- [ ] Free-tier line — include?
