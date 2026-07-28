# Tako MCP Server

[![Full Documentation](https://img.shields.io/badge/Docs-docs.tako.com-6E56CF?style=flat-square)](https://docs.tako.com/documentation/integrations/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.TakoData%2Ftako--mcp-000000?style=flat-square)](https://registry.modelcontextprotocol.io)
[![Smithery](https://img.shields.io/badge/Smithery-tako%2Ftako-4B8BF5?style=flat-square)](https://smithery.ai/servers/tako/tako)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Benchmarks: +21% on VerticalRTK](https://img.shields.io/badge/Benchmarks-%2B21%25_on_VerticalRTK-6E56CF?style=flat-square)](https://tako.com/blog/evaluating-a-new-kind-of-search-api/)

Tako MCP gives your agent industry-leading live web search plus licensed data that the open web does not have. That includes company financials, macroeconomic indicators, web and app traffic, sports, US government spending, and more.

**[Full Documentation](https://docs.tako.com/documentation/integrations/mcp-server)** · **[Get your API key](https://tako.com/console/api-keys)** · **[MCP Registry](https://registry.modelcontextprotocol.io)**

Tako MCP lets an agent:

- **Search** Tako's knowledge graph and the live web — top result renders inline as a chart
- **Answer** a specific data question with grounded, citation-backed prose
- **Discover** exactly what proprietary data exists for an entity or metric — free and fast
- **Fetch** the underlying rows (CSV) or a page's text behind any result URL
- **Visualize** your own structured data as an embeddable chart _(opt-in)_
- **Run** Tako's Answer Agent for deep, multi-step research _(opt-in)_

> **Why a data-native search API?** On Tako's [VerticalRTK benchmark](https://tako.com/blog/evaluating-a-new-kind-of-search-api/) of real-time domain questions (finance, economics, sports, weather), Tako outperforms the next-best web search API by **21%** — while using **~75% fewer tool calls at up to one-tenth the cost**, and answering research tasks in **15.5s vs 124.2s** for OpenAI web search. It reaches parity with Exa, Parallel, Nimble, and Tavily on standard web benchmarks (SimpleQA, FRAMES) and pulls ahead where structured, real-time data matters. **[Read the evals →](https://tako.com/blog/evaluating-a-new-kind-of-search-api/)**

## Installation

Point your MCP client at the hosted endpoint — no install, no local server:

```
https://mcp.tako.com/mcp
```

**No token needed to start.** Connecting without credentials lands on the **free tier**: `tako_search`, `tako_answer`, and `tako_available_data`, rate-limited to 10 requests/min per IP. Authenticating unlocks the full toolset and your own account limits, two ways:

- **OAuth** (Claude Code plugin, Claude.ai, Claude Desktop, ChatGPT) — a browser sign-in with your Tako account; a per-host API key is minted for you automatically.
- **Bearer token** (config-file clients: Cursor, Windsurf, VS Code, …) — **[get your API key](https://tako.com/console/api-keys)** and paste it into the header.

Pick your client below.

<details>
<summary><b>Claude Code</b></summary>

**Plugin (recommended)** — installs the MCP connection plus Tako's bundled [research skills](#agent-skills) in one step, and works immediately on the free tier — no API key to mint or manage:

```bash
claude plugin marketplace add TakoData/tako-mcp
claude plugin install tako@tako
```

That's it — the core tools (`tako_search`, `tako_answer`, `tako_available_data`) work right away on the anonymous free tier. To unlock the full toolset and your own account limits, authenticate once with OAuth: run `/mcp` inside Claude Code, select **tako**, and choose **Authenticate**. A browser opens to sign you in with your Tako account and a per-host API key is minted for you automatically (visible and revocable at [tako.com/console/api-keys](https://tako.com/console/api-keys)). The same OAuth flow powers the plugin on Claude.ai — the plugin's Tako connector connects with a click, no token pasting.

If you previously added the server with `claude mcp add`, remove it first (`claude mcp remove tako-mcp`) so you don't end up with two copies of every tool.

> **Updating from an earlier plugin version?** Older releases asked for a Tako API key in the plugin config; that setting is gone, so after updating your connection silently lands on the free tier (the three core tools, 10 requests/min) — nothing errors, but the full toolset and your account limits are no longer active. Run `/mcp` → **tako** → **Authenticate** once (or use the Connect button on Claude.ai) to restore full authenticated access.

**Or add the MCP server directly:**

```bash
export TAKO_API_TOKEN='<your-token>'

claude mcp add tako-mcp --transport http https://mcp.tako.com/mcp \
  --header "Authorization: Bearer $TAKO_API_TOKEN"
```

Verify with `claude mcp list` (should show `tako-mcp` connected) or `/mcp` inside a session.
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tako-mcp": {
      "type": "http",
      "url": "https://mcp.tako.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-tako-api-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b></summary>

Add to your Windsurf MCP config:

```json
{
  "mcpServers": {
    "tako-mcp": {
      "type": "http",
      "url": "https://mcp.tako.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-tako-api-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json` (workspace) or your user `mcp.json`:

```json
{
  "servers": {
    "tako-mcp": {
      "type": "http",
      "url": "https://mcp.tako.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-tako-api-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Gemini CLI</b></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "tako-mcp": {
      "httpUrl": "https://mcp.tako.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-tako-api-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>OpenCode</b></summary>

Add to `opencode.json`:

```json
{
  "mcp": {
    "tako-mcp": {
      "type": "remote",
      "url": "https://mcp.tako.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <your-tako-api-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b></summary>

Codex connects to remote servers through the `mcp-remote` bridge. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.tako-mcp]
command = "npx"
args = ["-y", "mcp-remote", "https://mcp.tako.com/mcp", "--header", "Authorization: Bearer <your-tako-api-token>"]
```
</details>

<details>
<summary><b>Zed</b></summary>

Add to Zed `settings.json` (via the `mcp-remote` bridge):

```json
{
  "context_servers": {
    "tako-mcp": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.tako.com/mcp", "--header", "Authorization: Bearer <your-tako-api-token>"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude.ai, Claude Desktop &amp; ChatGPT (OAuth — no token needed)</b></summary>

The consumer chat hosts don't accept Bearer tokens. `claude_desktop_config.json` only validates stdio servers, so a remote `"type": "http"` entry there is silently dropped — Claude Desktop connects through Connectors like Claude.ai. The hosted endpoint runs an OAuth 2.1 flow that signs you in with your Tako account and mints a per-host key for you automatically.

**Prerequisites:** just [sign in at tako.com](https://tako.com) with the identity you'll authorize. You do **not** mint a token yourself — the consent flow creates a per-host key (named `MCP: <client>`, visible and revocable at [tako.com/console/api-keys](https://tako.com/console/api-keys)). Connecting a new host never rotates another host's key; Tako trims your oldest MCP key past ten.

![tako.com API keys](docs/images/tako-api-token-generate.png)

**Claude.ai** _(requires Pro, Max, Team, or Enterprise)_
1. Open Claude.ai → **Settings → Connectors**
2. Click **Add custom connector**
3. Paste `https://mcp.tako.com/mcp` and click **Connect**
4. Complete the Tako sign-in flow; **Tako** then appears as connected

![Claude.ai Settings → Connectors](docs/images/claude-connectors-landing.png)

**Claude Desktop** _(same plan requirement as Claude.ai)_
1. Open Claude Desktop → **Settings → Connectors**
2. Click **Add custom connector**
3. Paste `https://mcp.tako.com/mcp` and click **Connect**
4. Complete the Tako sign-in flow; **Tako** then appears as connected

**ChatGPT** _(requires Pro, Business, or Enterprise; Developer Mode enabled)_
1. Open ChatGPT → **Settings → Connectors → Developer Mode** and toggle it on
2. Click **Create custom connector**
3. Paste `https://mcp.tako.com/mcp` and click **Connect**
4. Complete the Tako sign-in flow; the connector is then listed and ready

![ChatGPT connector connected](docs/images/chatgpt-tako-connected.png)

**During connect** you'll see three Tako-hosted screens regardless of host: a sign-in page (Google or email magic-link), a consent page (*"Connect [host] to Tako — Allow / Cancel"*), then a bounce back to the host. The host may show its own consent prompt too — that's normal.

![mcp.tako.com sign-in](docs/images/mcp-tako-signin.png)
![mcp.tako.com consent](docs/images/mcp-tako-consent.png)

**Disconnecting.** A per-host disconnect (remove the connector in host settings) stops that host only; other hosts and Bearer-auth clients keep working. To hard-kill everything, rotate your key at [tako.com/console/api-keys](https://tako.com/console/api-keys) — every previously-issued grant across every host stops authenticating immediately.
</details>

**Endpoints:**

| Environment | URL |
|---|---|
| Production | `https://mcp.tako.com/mcp` |
| Staging (testing only) | `https://mcp.staging.tako.com/mcp` |

Tools are discovered automatically via the MCP `tools/list` handshake, so your client always sees the live surface. Auth is connection-level — once connected, tool inputs need no `api_token` argument.

## Available Tools

**Enabled by default:**

| Tool | Description |
| ---- | ----------- |
| `tako_search` | **Pull the data to work with.** Fast search over Tako's curated graph and the live web; each card inlines its most-recent rows (50 by default, `preview_rows` up to 250). Top result renders inline as a chart (an interactive MCP Apps widget on ChatGPT, a chart image elsewhere) with an **Open in Tako** link. Choose `sources` (`data`, `web`, or both) and `effort` (`fast` / `instant`). Parallelize broad questions into narrow single entity+metric searches for far better retrieval. |
| `tako_answer` | **Ask one specific data question, get the answer.** A single grounded, citation-backed prose answer, already written for you — relay it directly. Cited data cards inline their recent rows alongside the prose; when zero data cards ground the answer, a `guidance` field says so deterministically (pivot, don't rephrase-retry). Ground in `data`, `web`, or both. |
| `tako_contents` | Fetch the content behind a result URL: a Tako card returns a CSV, any other URL returns the page's extracted text — pass `query` to get just the matching passages of a long page. Cards must be marked `exportable: true` (web URLs are exempt). |
| `tako_available_data` | **Discover what proprietary, structured data exists** on an entity or metric in one call — and a cheap accuracy check to confirm a figure exists before spending a priced search/answer. Returns the coverage names, a `node_id` to pin, and a ready-to-run `next_call` (search query + pinned nodes) to fetch the confirmed series; `coverage_filter` hunts one specific metric server-side. Free and fast. |

**Free tier (no credentials):** an unauthenticated connection sees `tako_search`, `tako_answer`, and `tako_available_data` only, capped at 10 requests/min per IP. Authenticate (OAuth or Bearer) for the full surface above plus the opt-in tools below, under your own account limits.

On connect, the server also advertises [MCP server instructions](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization) that hosts like Claude.ai, Claude Desktop, and Claude Code place in the model's system prompt. They steer data and metric questions to `tako_search` ahead of the host's built-in web search, and note that `tako_search` covers the live web too, so one call can stand in for a separate web search on mixed questions. Built-in web search remains the fallback for queries outside Tako's coverage.

**Opt-in** — off by default to keep the tool surface small. Enable per-connection via the `?tools=` query parameter (comma-separated aliases):

| Alias | Tool(s) | What it's for |
| ---- | ---- | ----------- |
| `agent` | `tako_agent` (ChatGPT: `tako_agent_start` / `tako_agent_wait`) | Tako's **Answer Agent** — opinionated, multi-step research (~30–90s) across many retrievals, returning a synthesized answer plus chart cards |
| `visualize` | `tako_visualize` | Author an embeddable chart/card from your own typed `components` (timeseries, bar, table, financial boxes…). On by default for ChatGPT, where it powers the widget |
| `credits` | `get_credit_balance` | Check the connected account's API credit balance |
| `graph` | `tako_graph_search` / `tako_graph_related` / `tako_graph_node` | Low-level graph primitives behind `tako_available_data`: traversal relations, `q` filtering, cursor paging, full node detail |

The param rides on the connection URL, so how you set it depends on your client:

- **Claude.ai, Claude Desktop, ChatGPT (connectors):** include it in the URL you paste when adding the connector — e.g. `https://mcp.tako.com/mcp?tools=agent`. OAuth is unaffected (the server canonicalizes the resource, query string included). ChatGPT gets `visualize` automatically, no param needed.
- **Config-file clients (Cursor, Windsurf, VS Code, …) and `claude mcp add`:** put it on the URL in your config:

```bash
# Aliases compose as a comma-separated list on the MCP URL
claude mcp add tako-mcp --transport http "https://mcp.tako.com/mcp?tools=agent,visualize" \
  --header "Authorization: Bearer $TAKO_API_TOKEN"
```

- **Claude Code plugin:** the plugin pins the default surface (its URL isn't user-editable). If you want opt-in tools, add the server yourself with `claude mcp add` and the `?tools=` param as above — keep only one Tako connection active so you don't get two copies of every tool (the plugin's bundled skills keep working regardless of which connection serves the tools).

Only alias names are recognized; unknown values are ignored, so a typo never breaks the connection. Omit the parameter for the default surface.

<details>
<summary><b>Answer vs. Search — the core distinction</b></summary>

`tako_answer` and `tako_search` look similar but serve **opposite** needs. Pick by *what you want back*:

| You want… | Use | What you get back |
|---|---|---|
| **The answer** to one specific, self-contained data question | `tako_answer` | A single synthesized, citation-backed prose answer — already written for you. Relay it directly. |
| **The data itself** — rows/time-series to compute over or chart | `tako_search` | Structured cards (each with a free row preview) + an inline chart. *You* do the synthesis. |

- **One narrow, known question → `tako_answer`.** e.g. *"What was US GDP in 2024?"* — surface the `answer` field as-is.
- **Broad or multi-part → `tako_search`, parallelized.** Decompose into narrow single entity+metric searches fired concurrently — e.g. *"US CPI inflation"*, *"US core CPI inflation"*, *"US PCE inflation"* — then synthesize yourself.
- In one line: **`tako_answer` hands you a conclusion; `tako_search` hands you the evidence.**
</details>

<details>
<summary><b>Example flows</b></summary>

**Specific question → `tako_answer` (relay the answer):**
1. User asks: *"What was US GDP in 2024?"*
2. Agent calls `tako_answer` with the question
3. Agent receives a synthesized, citation-backed `answer` — and surfaces it directly

**Data to work with → parallel `tako_search` (synthesize yourself):**
1. User asks: *"Compare US CPI, core CPI, PCE, and core PCE inflation."*
2. Agent fires **four** narrow `tako_search` calls concurrently — one per entity+metric
3. Each returns a card with a free row preview (top result renders inline as a chart)
4. Agent synthesizes the four results, calling `tako_contents` on a card's `webpage_url` if it needs full rows (when the card is `exportable: true`)
</details>

## Agent Skills

Ready-to-use skills for Claude Code. Each teaches Claude how to use Tako for a specific kind of data work. Copy the block inside a dropdown and paste it into Claude Code — it sets up the connection and skill for you.

<details>
<summary><b>Financial Research</b></summary>

Copy the block below and paste it into Claude Code. It will set up the MCP connection and skill for you.

````
Step 1: Install or update Tako MCP

If Tako MCP already exists in your config, update it to this endpoint. Run this in your terminal:

claude mcp add tako-mcp --transport http "https://mcp.tako.com/mcp" --header "Authorization: Bearer $TAKO_API_TOKEN"


Step 2: Add this Claude skill

---
name: tako-financial-research
description: >-
  Company financials and markets via Tako (sources vary by metric — S&P Global, Fiscal.ai, Xignite, Visible Alpha, and others). Revenue, earnings vs. estimates, margins, valuation, stock performance, and head-to-head company comparisons as citation-backed charts. Use for equity research, company deep-dives, competitor financial comparison, or any "what are/were <company>'s <financial metric>" question.
---

# Financial Research (Tako)

Tako serves proprietary company financials (sources vary by metric — S&P Global, Fiscal.ai, Xignite, Visible Alpha, and others) as interactive, citation-backed charts. Always cite the source the card actually returns, not a fixed name. All tools below live on the Tako MCP server installed in Step 1.

## Pick the tool by what you want back
- `tako_search` — the data as a chart. Default for "<company> <metric>" and "<A> vs <B> <metric>". The intent-matched card renders inline (see Rendering).
- `tako_answer` — one specific STATED value, in prose ("What was Apple's FY24 revenue?"). Relay the `answer` verbatim. It retrieves reported values; it does NOT compute derivations — for a growth rate, ratio, or margin change, pull the underlying levels (here or via `tako_search`) and compute it yourself.
- `tako_available_data` — FREE pre-check: confirm a metric exists and grab its exact name + `node_id` before spending a priced call. Its `next_call` output is that follow-up search prewritten (query + pinned `node_ids`) — run it verbatim.
- Protected sources are read-only: S&P Global, FactSet, Visible Alpha, and CoinMarketCap cards come back `exportable: false` with NO inline preview rows, and `tako_contents` cannot export their CSV — a licensing wall, not an error, so never retry the export. Read the headline value from the card's `description`, cite the chart, or ask `tako_answer` for the specific number. (Fiscal.ai cards export normally.)
- Cohort/ranking asks ("which of the largest US chipmakers grew revenue fastest since 2020?") → resolve the cohort yourself, fire one narrow `tako_search` per member in parallel, and rank from the results.

## Query patterns (Critical)
- Query is ENTITY + METRIC: `"Nvidia revenue"`, `"Apple gross margin"`, `"Tesla free cash flow"`. Keep it to one entity + one metric per call, and add a cadence word (`quarterly`/`annual`) to steer the period.
- Comparisons are first-class: `"Intel vs Nvidia revenue"` returns a two-series comparison card — but it is not always ranked first (see Rendering), and comparisons default to annual (say `quarterly` for quarterly). 3–4-way comparisons usually work, but verify EVERY entity appears in the chosen card's title/`nodes` — if one is missing, fall back to pairwise searches and synthesize.
- Multi-metric or multi-company asks → fire PARALLEL narrow searches and synthesize yourself. Do not send a multi-part question as one query (a compound query returns cards for some of the metrics and silently misses others — a 3-metric ask came back missing gross margin).
- Ground in Tako data with `sources: ["data"]` — this is the default for financials. The price is the same either way, but omitting `sources` also searches the web and pads the response with ~10 web results of IR/filings/MacroTrends clutter; add `"web"` only when you deliberately want news or qualitative context.
- Empty result (zero cards) — HARD STOP on retries. Every search is billed, and rewording the same query almost never flips an empty result to a hit. Recover in exactly this order: (1) `tako_available_data` (free) to get the exact metric name + `node_id`; (2) if covered, ONE more search with that exact name and pinned `node_ids`; (3) if not covered, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query is its own question with its own budget).
- Empty also means "not covered in Tako," NOT that the fact is false — the response looks identical for an uncovered metric and a genuinely-nonexistent one. Don't infer a business fact from silence (e.g. no dividend card ≠ pays no dividend).

## Rendering (Critical)
- Pick the card by intent — do NOT trust index 0. Tako auto-renders card #0, but it routinely ranks an "Overview" or "Earnings & Estimates" card above the plain metric chart (e.g. `"Lucid revenue"` puts "Lucid Group Earnings & Estimates Overview" at #0 and the actual "Lucid Revenues (Annual)" chart at #2), and a segment-scoped variant can outrank the overall metric (`"Apple gross margin"` ranks "Gross margin - Products" at #0, above the company-wide margin). Choose the card whose `card_type` is `"chart"` and whose title matches the bare metric asked for, at the scope asked for. Overview/Estimates cards lead with a beat/miss "estimate vs. actual" narrative — NOT the value asked for; skip them unless the user asked about estimates. For a comparison, the right card has ALL compared entities in its `nodes`/title. If the chosen card isn't #0, reference it with `[Title](webpage_url)` and say it is the authoritative one.
- Actuals vs. estimates vs. projections — before quoting a number, confirm it's a reported actual: `data_as_of` must NOT be in the future (a future date like `2035-12-31` = a forward analyst projection), and the metric name must not be "Analyst Estimates (Mean)" or similar. Never relay a projection as a reported figure.
- Cross-currency comparisons are a correctness trap: a `"<A> vs <B>"` chart can plot two currencies on one axis unnormalized (Toyota ¥43.6T vs Ford $174B reads as ~250× raw, but ≈1.7× once converted). For cross-border pairs, state each series' currency and convert before comparing — do NOT present the raw chart as apples-to-apples.
- Period labels are calendar-normalized (Apple's annual points show "Dec 31" though its fiscal year ends in late September; a series may even show a future "Dec 31, 2026" point). Don't cite a label as the issuer's fiscal period; flag the normalization when precision matters.
- Cite the card's actual `sources[].source_name` (S&P Global, Fiscal.ai, Xignite, Visible Alpha, …) and its `data_as_of` date — the source varies by metric; it is not always S&P Global.
- Reference the chart in prose ("as the chart above shows"); do NOT paste `![](image_url)` for a card — that double-renders the inline chart.
- `tako_answer` prose may cite a different fiscal period than the embedded card's latest point (e.g. the answer says FY24 while the card headline is FY25) — reconcile them so text and chart agree.

## Examples
- Single metric → tako_search {"query": "Nvidia quarterly revenue", "sources": ["data"]}
- Comparison → tako_search {"query": "Intel vs Nvidia revenue", "sources": ["data"]}
- Coverage pre-check (free; note the arg is `q`) → tako_available_data {"q": "Costco"}
- Known value, prose → tako_answer {"query": "What was Microsoft's FY2024 net income?", "sources": ["data"]}
- Growth rate / ratio → pull the levels, then compute yourself: tako_search {"query": "Apple annual revenue", "sources": ["data"]} → compute FY24 vs FY23 % change (tako_answer/tako_search return levels, not the rate)
- Ranking → resolve the cohort, then parallel narrow searches: tako_search {"query": "Nvidia annual revenue", "sources": ["data"]} + one per remaining company → compute growth and rank yourself

## Output (tight and structured)
1) A 1–2 line read of the finding, referencing the intent-matched chart
2) Source (`source_name`) — `data_as_of` date
3) A single `[Open in Tako](embed_url)` for the card you embedded


Step 3: Ask the user to restart Claude Code

Ask the user to restart Claude Code so the config change takes effect.
````

</details>

<details>
<summary><b>Website &amp; App Traffic</b></summary>

Copy the block below and paste it into Claude Code. It will set up the MCP connection and skill for you.

````
Step 1: Install or update Tako MCP

If Tako MCP already exists in your config, update it to this endpoint. Run this in your terminal:

claude mcp add tako-mcp --transport http "https://mcp.tako.com/mcp" --header "Authorization: Bearer $TAKO_API_TOKEN"


Step 2: Add this Claude skill

---
name: tako-web-traffic
description: >-
  Website and app traffic via Tako (source: SimilarWeb). Monthly visits, traffic trends, and top-sites rankings for any domain as citation-backed charts. Use for competitive traffic analysis, share-of-attention, or any "how much traffic does <site> get" question.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as interactive, citation-backed charts. All tools below live on the Tako MCP server installed in Step 1.

## Query patterns (Critical)
- Query by DOMAIN, not brand. Brand names resolve to the wrong concept — under `sources: ["data"]` a brand query returns zero cards, and with `"web"` on it mis-resolves to subscriber counts or CDN/network-traffic articles. Always use the bare domain: `"netflix.com monthly visits"`, `"youtube.com"`, `"chatgpt.com"`.
- The core metric is Visits (monthly, with ~1-month lag).
- Comparisons: `"youtube.com vs netflix.com monthly visits"`. Rankings: `"top websites by visits"` returns a ranked card.
- Ground in Tako data with `sources: ["data"]` (SimilarWeb is proprietary).
- Empty result (zero cards) — HARD STOP on freeform retries; every search is billed (even an empty one) and rewording almost never helps. The #1 cause here is a brand-name query: if the query wasn't a bare DOMAIN, fix it to one (`"Netflix traffic"` → `"netflix.com monthly visits"`) and retry ONCE — that is the recovery. If a domain-shaped query still came back empty, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each domain query is its own question with its own budget).
- Do NOT use `tako_available_data` to rule a domain out: its graph is entity-based and misses long-tail domains SimilarWeb still covers (it reports `found: false` for kagi.com while `"kagi.com monthly visits"` returns a real card). It is still useful for resolving a brand to its entity `node_id` (e.g. tako_available_data {"q": "Netflix"} — note the arg is `q`) to pin into a search.
- Empty also means "not covered in Tako," NOT that the domain has no traffic — don't infer a fact from silence.

## Pick the tool
- `tako_search` — traffic as a chart (default; top result renders inline).
- `tako_answer` — one number, in prose ("How many monthly visits does netflix.com get?").
- `tako_available_data` — FREE brand→entity resolver (see the empty-result bullet for its limits on domains).
- SimilarWeb is a protected source, so EVERY traffic card is read-only: `exportable: false`, no inline preview rows, and `tako_contents` cannot export the CSV — a licensing wall, not an error, so never call `tako_contents` on a traffic card. The numbers live in the card's `description` (latest value + % change over the period) and the chart; for one specific figure use `tako_answer`. (Web-result urls remain fetchable.)
- Cohort/growth asks ("top 5 streaming domains by visits, and which is growing fastest") → get the ranked card with `tako_search`, then one narrow search per domain in parallel and compute growth from each card's `description`.

## Rendering (Critical)
- The top result renders inline automatically — an interactive widget on ChatGPT, a chart image on other hosts. Reference it in prose; do NOT paste `![](image_url)` for the top card — that double-renders it.
- Cite SimilarWeb + the as-of month (it's in `data_freshness.data_as_of`).
- Comparison cards (`"A vs B"`) describe each series as a % change over the period — for absolute monthly visits, read the per-domain single-series card instead.
- Point at any extra cards by linking their titles as `[Title](webpage_url)` — embed only the top card.

## Examples
- Single domain → tako_search {"query": "netflix.com monthly visits", "sources": ["data"]}
- Head-to-head → tako_search {"query": "youtube.com vs netflix.com monthly visits", "sources": ["data"]}
- Ranking → tako_search {"query": "top websites by visits", "sources": ["data"]}

## Output (tight and structured)
1) A 1–2 line read of the traffic, referencing the inline chart
2) SimilarWeb — as-of month
3) A single `[Open in Tako](embed_url)` for the top card


Step 3: Ask the user to restart Claude Code

Ask the user to restart Claude Code so the config change takes effect.
````

</details>

<details>
<summary><b>Macroeconomics</b></summary>

Copy the block below and paste it into Claude Code. It will set up the MCP connection and skill for you.

````
Step 1: Install or update Tako MCP

If Tako MCP already exists in your config, update it to this endpoint. Run this in your terminal:

claude mcp add tako-mcp --transport http "https://mcp.tako.com/mcp" --header "Authorization: Bearer $TAKO_API_TOKEN"


Step 2: Add this Claude skill

---
name: tako-macroeconomics
description: >-
  Macroeconomic indicators via Tako (sources: FRED, OECD, BIS). Inflation (CPI/PCE), unemployment, GDP, interest and policy rates, and cross-country comparisons as citation-backed charts. Use for macro monitoring, economic briefings, or any "what is/was <country>'s <indicator>" question.
---

# Macroeconomics (Tako)

Tako serves macro indicators (sources: FRED / St. Louis Fed, OECD, BIS) as interactive, citation-backed charts. All tools below live on the Tako MCP server installed in Step 1.

## Query patterns (Critical)
- Query is COUNTRY + INDICATOR: `"US CPI inflation"`, `"US unemployment rate"`, `"US federal funds rate"` (which resolves to the Effective Federal Funds Rate, not the FOMC target range).
- Be specific — many variants exist (CPI all-items vs CPI-W vs core; unemployment headline vs U-6 vs by age/race). If intent is precise, name the variant; if unsure, use `tako_available_data` to list exact metric names first.
- PCE is a trap: `"US PCE inflation"` / `"US core PCE inflation"` silently substitute a DIFFERENT metric — observed returning a Core CPI card outright, and price-INDEX levels (~130 index points) instead of a rate. The numbers look plausible either way, so verify the chosen card's title actually says `PCE` and `(% Change)` with values in percent. For the rate, query the year-over-year variant (`"US core PCE price index % change"`). Run `tako_available_data` FIRST (mandatory here) to grab the exact `(% Change)` metric + `node_id`.
- Parallelize multi-part asks: send each metric as its own narrow concurrent `tako_search`, then synthesize — not one query.
- Cross-country comparison is built in: `"US vs China inflation"` returns a comparison card. For currency-denominated indicators (GDP, wages), a cross-country chart may plot different currencies on one axis unnormalized — state each series' currency and convert before comparing.
- Ground in Tako data with `sources: ["data"]`.
- Empty result (zero cards) — HARD STOP on retries. Every search is billed, and rewording almost never flips an empty result to a hit. Recover in exactly this order: (1) `tako_available_data` (free) for the exact indicator name + `node_id`; (2) if covered, ONE more search with that exact name and pinned `node_ids`; (3) if not covered, stop calling Tako for this question and fall back to the web. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query is its own question with its own budget).
- Empty also means "not covered in Tako," NOT that the indicator doesn't exist — don't infer a fact from silence.

## Pick the tool
- `tako_search` — indicator as a chart (default).
- `tako_answer` — one known value, in prose ("What is the current US unemployment rate?"). Relay verbatim.
- `tako_available_data` — FREE: resolve the exact indicator name + `node_id`. Its `next_call` output is the follow-up search prewritten — run it verbatim.
- Cohort/ranking asks ("which G7 economy has the highest inflation right now?") → fire one narrow `tako_search` per country in parallel and rank from the results.

## Rendering (Critical)
- Match the card to intent — don't blindly trust index 0. Tako auto-renders the #0 card, but the least-specific card often ranks first: `"US CPI inflation"` can rank a broad BIS country card (a different headline number) above the labeled FRED CPI card, and stale vintages can sneak in. Scan the cards and use the one whose title matches the exact variant with the freshest `data_as_of`; if it isn't #0, reference it with `[Title](webpage_url)` and say it is the authoritative one.
- Reference the chart in prose; do NOT paste `![](image_url)` for a card — that double-renders the inline chart.
- Cite the source (FRED / OECD / BIS) + `data_as_of` date.

## Examples
- Single → tako_search {"query": "US CPI inflation", "sources": ["data"]}
- Parallel multi-metric → four calls: "US CPI inflation", "US core CPI inflation", "US core PCE price index % change", "US PCE price index % change" (pick each card titled "(% Change)" — the plain "PCE Price Index" cards are index levels, not rates)
- Cross-country → tako_search {"query": "US vs China inflation", "sources": ["data"]}
- Indicator-name pre-check (free; note the arg is `q`) → tako_available_data {"q": "US core PCE"}
- Known value, prose → tako_answer {"query": "What is the current US federal funds rate?", "sources": ["data"]}

## Output (tight and structured)
1) A 1–2 line read of the indicator, referencing the intent-matched chart
2) Source (FRED / OECD / BIS) — `data_as_of` date
3) A single `[Open in Tako](embed_url)` for the card you embedded


Step 3: Ask the user to restart Claude Code

Ask the user to restart Claude Code so the config change takes effect.
````

</details>

## Architecture

Tako MCP is a Cloudflare Worker — a thin TypeScript proxy deployed at `mcp.tako.com`:

```
AI Agent (Claude Code/Desktop, Cursor, Claude.ai, ChatGPT, …)
    ↓  MCP Protocol (Streamable HTTP, POST /mcp)
Cloudflare Worker  ──  Bearer auth / OAuth, tool dispatch
    ↓  X-API-Key
Tako Django API  (tako.com)
```

The Worker extracts the Bearer (or OAuth-derived) token, validates the MCP request, calls the appropriate Django endpoint with the user's token forwarded as `X-API-Key`, and returns structured tool results. Code lives in `workers/`.

- **Health check:** `GET /health` returns a simple `ok`.

<details>
<summary><b>Breaking changes (v0.3.0)</b></summary>

- The default tool surface is **`tako_search`**, **`tako_answer`**, **`tako_contents`**, **`tako_available_data`**. Everything else is opt-in via `?tools=`: **`tako_agent`** (`agent`; ChatGPT split pair **`tako_agent_start`** / **`tako_agent_wait`**), **`tako_visualize`** (`visualize`; default-on for ChatGPT), **`get_credit_balance`** (`credits`), and graph primitives **`tako_graph_search`** / **`tako_graph_related`** / **`tako_graph_node`** (`graph`).
- The chart-image (`get_chart_image`), interactive-chart (`open_chart_ui`), chart-creation (`create_chart`), and report tools (`create_report`, `get_report`, `list_reports`, `export_report`) were removed.
- The self-hosted Python server (`pip install tako-mcp` / Docker) was removed in favor of the hosted Cloudflare Worker.

Update any client config or agent prompts that referenced the old tool names or the Python SSE endpoint.
</details>

<details>
<summary><b>MCP Registry &amp; releases (maintainers)</b></summary>

Tako is published to the official [MCP Registry](https://registry.modelcontextprotocol.io) as a remote server under `io.github.TakoData/tako-mcp`.

- **`server.json`** (repo root) is the registry descriptor: a remote `streamable-http` entry pointing at `https://mcp.tako.com/mcp`. The schema doesn't list tools — hosts discover them at runtime via `tools/list`. (Distinct from `registry/server.json`, the generated in-repo tool catalog used by `npm run registry:gen` / `registry:check`.)
- **Publishing** is automated by `.github/workflows/publish-mcp.yml`, authenticating via **GitHub OIDC** (no secret). The version lives in code: bump `server.json`'s `version`, merge to `main`, and it publishes automatically. A merge that doesn't change the version is a no-op.
- **Branded namespace (`com.tako/tako-mcp`)** is a future upgrade requiring DNS authentication (Ed25519 key + `TXT` record on `tako.com`).
- **Versioning & changelog** are automated via release-please. Contributors use Conventional Commit PR titles (squash-merge); maintainers cut a release by merging the bot's `release: X.Y.Z` PR. See `AGENTS.md` → Releases.
</details>

## Links

- **[Full Documentation](https://docs.tako.com/documentation/integrations/mcp-server)** — setup, tools, and integration guides
- **[Evaluating a new kind of Search API](https://tako.com/blog/evaluating-a-new-kind-of-search-api/)** — benchmarks vs. Exa, Parallel, Nimble, Tavily; why data-native search wins
- **[Get your API key](https://tako.com/console/api-keys)** — Tako console
- [Tako](https://tako.com) — the data visualization platform
- [Tako on Smithery](https://smithery.ai/servers/tako/tako) — MCP server listing
- [MCP Registry](https://registry.modelcontextprotocol.io) — `io.github.TakoData/tako-mcp`
- [MCP Specification](https://spec.modelcontextprotocol.io/) — Model Context Protocol

## License

MIT License — see [LICENSE](LICENSE) for details.
