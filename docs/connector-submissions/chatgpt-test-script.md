# ChatGPT Connector Submission — Test Script

Verbatim prompts, expected tool sequences, and pass criteria for OpenAI's
review of the **regular ChatGPT connector** at `https://mcp.tako.com/mcp`.

OpenAI's reviewer runs these prompts against a real Tako account during
submission review. Anything off the happy path can fail review — keep this
doc precise and test it end-to-end before submitting.

The Deep Research directory (`/deepresearch/mcp`) has its own test prompts
and will get a separate doc when that connector ships.

---

## Setup

The reviewer needs:

1. **A Tako account** with the demo data preloaded (see `chatgpt.md`'s
   "Demo account" section once that's set up).
2. **The connector configured** in ChatGPT: Settings → Connectors →
   Tako → Connect. OAuth redirects to `mcp.tako.com/authorize`, the
   reviewer signs in, ChatGPT receives a bearer token.
3. **A fresh ChatGPT conversation** with the Tako connector enabled.

Connection is verified when ChatGPT's tool palette shows Tako tools
(`knowledge_search`, `create_chart`, `create_report`, etc.) — currently
**11 tools** on `/mcp`. List from `registry/server.json`.

---

## Prompt 1 — Prediction markets / fresh data

**Prompt:**
> Who will win the 2026 FIFA World Cup?

**Expected tool sequence:**
1. `knowledge_search` with `query: "2026 FIFA World Cup winner"` (or
   similar). FAST mode returns prediction-market cards from Polymarket.
2. *(Possible escalation:)* if FAST returns zero cards, ChatGPT auto-calls
   `start_deep_knowledge_search` followed by `wait_for_knowledge_search`
   in a polling loop. Per PR #70, this escalation is automatic on ChatGPT.
3. `open_chart_ui` is **not** chained — `knowledge_search` already
   auto-renders the top card inline (`appUiResource` with the chart embed).

**Expected user-facing response:**
- An interactive Tako chart card rendered inline (Polymarket-shaped odds).
- Narrative text quoting the top candidates and their implied probabilities.
- A `[Open in Tako](<embed_url>)` markdown link at the end of the reply
  (per PR #70's uniform-host directive).

**Pass criteria:**
- ✅ Tool call(s) succeed without error
- ✅ Chart card visible in chat (not just an image, an interactive card)
- ✅ Reply mentions specific teams and their odds
- ✅ Reply contains a working `[Open in Tako](...)` link

**Common failure modes:**
- ❌ ChatGPT calls `web_search` instead of `knowledge_search` → connector
  isn't being prioritized; check tool descriptions in `registry/server.json`
- ❌ Chart not rendered, only text → host-specific widget issue, see
  `CHATGPT_NO_WIDGET_TOOL_NAMES` in `mcp.ts`

---

## Prompt 2 — Finance / earnings

**Prompt:**
> Show me NVIDIA's latest earnings

**Expected tool sequence:**
1. `knowledge_search` with `query: "NVIDIA latest earnings"` (or similar).
   Returns a card sourced from public market data.

**Expected user-facing response:**
- Chart card showing NVIDIA earnings (revenue, EPS, or similar).
- Narrative quoting the most recent quarter's figures + YoY change.
- `[Open in Tako](...)` link.

**Pass criteria:**
- ✅ Earnings figures match real recent NVIDIA quarterly data
- ✅ Chart visible inline
- ✅ Source/freshness implied or stated in the narrative

---

## Prompt 3 — Real-time market data

**Prompt:**
> What are today's top performing stocks?

**Expected tool sequence:**
1. `knowledge_search` with a market-movers query. Returns a card with
   today's top gainers (real-time provider data).

**Expected user-facing response:**
- Chart or table of top movers with ticker + percent change.
- Narrative summary (e.g. "X gained Y% on news of Z").
- `[Open in Tako](...)` link.

**Pass criteria:**
- ✅ Tickers + percentages present
- ✅ Data is *today's*, not stale (validates the real-time pipeline)
- ✅ Chart visible inline

---

## Prompt 4 (optional) — Report generation

This prompt is the only way reviewers see the long-running report flow. It
exercises four tools and is the strongest demo of Tako's differentiator vs.
generic search connectors. **Submit if the directory allows 4 prompts.**

**Prompt:**
> Generate a research report on the EV market in 2026

**Expected tool sequence:**
1. `create_report` with `report_type` resolved to a research template,
   `title: "EV Market 2026"` (or similar), and a research objective. Returns
   `report_id` + `webpage_url` immediately. Async generation kicks off.
2. ChatGPT shares the `webpage_url` as a markdown link and tells the user
   the report is generating (typical 5–20 min) and that they'll get an
   email when ready. **Per the create_report HARD RULE, ChatGPT must NOT
   write the report content itself or call web search.**
3. *(Later, if user asks "is my report ready?":)* `get_report` with the
   `report_id`. If `status: "completed"`, ChatGPT summarizes the `result`
   field and re-shares `webpage_url`.
4. *(Optional, if user asks for an export:)* `export_report` with the
   `report_id` and a format. Returns short-lived `download_url`.

**Expected user-facing response (immediately):**
- A clickable `[Open your report: EV Market 2026](https://tako.com/reports/<id>?from=library)` link.
- A line saying the report is generating and the user will get an email.
- **No** content from the report itself (it doesn't exist yet).
- **No** fallback to web search.

**Pass criteria:**
- ✅ ChatGPT shares the `webpage_url` verbatim from the tool response
- ✅ ChatGPT does NOT write report content from its own knowledge
- ✅ ChatGPT does NOT call `web_search` or any non-Tako research tool
- ✅ The link, when clicked, opens a real (eventually populated) Tako report

**Why this prompt matters for review:** if ChatGPT improvises content or
falls back to web search, the connector fails its core value prop. PR #60
hardened the description specifically to prevent this. If review fails
here, check whether the deployed `create_report` description matches main.

---

## Tool surface reviewer will see

For reference, the 11 tools registered on `/mcp` (from `registry/server.json`,
post PR #70):

| Tool                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `knowledge_search`            | Curated knowledge graph + auto-rendered chart    |
| `start_deep_knowledge_search` | (ChatGPT-only) async deep-search kickoff         |
| `wait_for_knowledge_search`   | (ChatGPT-only) status check for deep-search task |
| `open_chart_ui`               | Render a specific Tako chart by `card_id`        |
| `create_chart`                | Create a new chart from data                     |
| `get_chart_image`             | Fetch a chart's PNG                              |
| `create_report`               | Kick off async report generation                 |
| `get_report`                  | Check report status / read result                |
| `list_reports`                | List user's reports                              |
| `export_report`               | Mint short-lived download URL (PDF/PPTX/MD/JSON) |
| `get_credit_balance`          | Show user's remaining credits                    |

---

## Known limitations to flag in submission notes

- **Deep search latency.** If a query needs `start_deep_knowledge_search`
  escalation (FAST returned zero results), the full deep run takes 1–5
  minutes. ChatGPT will tell the user to wait; the reviewer should be
  patient. Do not test this with a query you expect to fail FAST.
- **Report generation latency.** Reports take 5–20 minutes typical. Don't
  expect inline content; the link is the deliverable.
- **Cold start.** First call after a long idle period may hit a cold
  Worker — typically <2s but can spike to 5s on the first request.

---

## Pre-submission checklist

Run this script end-to-end against `https://mcp.tako.com/mcp` (production)
with the demo account.

**Verified passing 2026-05-06** against current main (post PR #70):

- [x] Prompt 1 returns a chart + narrative + `[Open in Tako]` link
- [x] Prompt 2 returns NVIDIA earnings with current data
- [x] Prompt 3 returns today's top movers (validates real-time freshness)
- [x] Prompt 4 (if submitting) returns a `webpage_url` + waiting message,
      no improvised content, no `web_search` calls
- [x] `create_report` link, when clicked an hour later, opens a populated
      report (validates the async pipeline end-to-end)
- [x] All four prompts work in a single fresh conversation (validates
      session-stable OAuth)

Re-run before submitting if main has moved meaningfully (new tools, changed
descriptions, OAuth changes).

Capture screenshots of each successful run for the submission package.
