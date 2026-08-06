# Tako MCP Server

[![MCP Toplist](https://mcptoplist.com/badge/io.github.TakoData%2Ftako-mcp.svg)](https://mcptoplist.com/server/io.github.TakoData%2Ftako-mcp)

[![Full Documentation](https://img.shields.io/badge/Docs-docs.tako.com-6E56CF?style=flat-square)](https://docs.tako.com/documentation/integrations/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.TakoData%2Ftako--mcp-000000?style=flat-square)](https://registry.modelcontextprotocol.io)
[![Smithery](https://img.shields.io/badge/Smithery-tako%2Ftako-4B8BF5?style=flat-square)](https://smithery.ai/servers/tako/tako)
[![LobeHub](https://lobehub.com/badge/mcp/takodata-tako-mcp)](https://lobehub.com/mcp/takodata-tako-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Benchmarks: +21% on VerticalRTK](https://img.shields.io/badge/Benchmarks-%2B21%25_on_VerticalRTK-6E56CF?style=flat-square)](https://tako.com/blog/evaluating-a-new-kind-of-search-api/)

Tako MCP gives your agent industry-leading live web search plus licensed data that the open web does not have. That includes company financials, macroeconomic indicators, web and app traffic, sports, US government spending, and more.

**[Full Documentation](https://docs.tako.com/documentation/integrations/mcp-server)** · **[Get your API key](https://tako.com/console/api-keys)** · **[MCP Registry](https://registry.modelcontextprotocol.io)**

Tako MCP lets an agent:

- **Search** Tako's knowledge graph and the live web — top result renders inline as a chart
- **Answer** one specific data question with citations — the top cited card renders inline as a chart too
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

**No token needed to start.** Connecting without credentials lands on the **free tier**: `tako_search`, `tako_answer`, and `tako_available_data`, rate-limited to 10 requests/min per IP. (On ChatGPT, `tako_contents` and `tako_visualize` also appear in the list, but prompt you to sign in before they run.) Authenticating unlocks the full toolset and your own account limits, two ways:

- **OAuth** (Claude Code plugin, Claude.ai, Claude Desktop, ChatGPT) — a browser sign-in with your Tako account; a per-host API key is minted for you automatically.
- **Bearer token** (config-file clients: Cursor, Windsurf, VS Code, …) — **[get your API key](https://tako.com/console/api-keys)** and paste it into the header.

### One-click install

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=tako&config=eyJ1cmwiOiJodHRwczovL21jcC50YWtvLmNvbS9tY3AifQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Tako-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=tako&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.tako.com%2Fmcp%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Tako-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=tako&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.tako.com%2Fmcp%22%7D&quality=insiders)

Claude Code installs with one command — the plugin brings the MCP connection plus Tako's bundled [research skills](#agent-skills):

```bash
claude plugin marketplace add TakoData/tako-mcp && claude plugin install tako@tako
```

Gemini CLI installs as an extension. Same one command, same bundled skills, plus `/data`, `/chart`, and `/coverage` commands:

```bash
gemini extensions install https://github.com/TakoData/tako-mcp
```

Each of these lands on the free tier immediately. Authenticate later to unlock the full toolset — see your client's section below.

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

**Extension (recommended)** installs in one command, and works immediately on the free tier with no API key to mint or manage:

```bash
gemini extensions install https://github.com/TakoData/tako-mcp
```

That installs the MCP connection, Tako's bundled [research skills](#agent-skills), and three commands:

| Command | What it does |
| --- | --- |
| `/data <question>` | The answer, cited, across proprietary data **and** the full web, since `sources` defaults to both. Routes to `tako_answer` for one specific value, or parallel `tako_search` for anything broad |
| `/chart <question>` | The series as a chart, with the **Open in Tako** embed link |
| `/coverage <entity or metric>` | What the proprietary graph has, before you spend a call. `tako_available_data` is free, and a miss there still leaves web search |

To unlock the full toolset and your own account limits, authenticate once: run `/mcp auth tako` inside Gemini CLI. A browser opens to sign you in with your Tako account, and a per-host API key is minted for you automatically (visible and revocable at [tako.com/console/api-keys](https://tako.com/console/api-keys)).

**Manual config**: if you'd rather not install the extension, or you want to pin a [`?tools=` surface](#available-tools) or use a Bearer token instead of OAuth, add to `~/.gemini/settings.json`:

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

Omit the `headers` block entirely to stay on the free tier. Gemini substitutes unset `${VAR}` references literally, and a malformed `Authorization` header is rejected rather than ignored, so a half-filled token breaks the connection where no token at all would have worked.
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

**During connect** you'll see three Tako-hosted screens regardless of host: a sign-in page (Google, or your Tako email and password), a consent page (*"Connect [host] to Tako — Allow / Cancel"*), then a bounce back to the host. The host may show its own consent prompt too — that's normal.

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
| `tako_search` | **Pull the data to work with.** Fast search over Tako's curated graph and the live web; each card inlines its most-recent rows free (the 20-row inline allowance; `preview_rows` caps it down, `tako_contents` exports more, priced). Top result renders inline as a chart (an interactive MCP Apps widget on ChatGPT, a chart image elsewhere) with an **Open in Tako** link. Choose `sources` (`data`, `web`, or both) and `effort` (`fast` / `instant`). Parallelize broad questions into narrow single entity+metric searches for far better retrieval. |
| `tako_answer` | **Ask one specific data question, get the answer.** A single grounded, citation-backed prose answer, already written for you — relay it directly. Cited data cards carry a rows-count pointer alongside the prose, with the rows themselves in `structuredContent` (`cards[].content`); when zero data cards ground the answer, a `guidance` field says so deterministically (pivot, don't rephrase-retry). The top cited card renders inline as a chart, the same as `tako_search`. Ground in `data`, `web`, or both. |
| `tako_contents` | Fetch the content behind result URLs (1-10 per call, batched): a Tako card returns a CSV, any other URL returns the page's extracted text — pass `query` to get just the matching passages of a long page. Cards must be marked `exportable: true` (web URLs are exempt). |
| `tako_available_data` | **Discover what proprietary, structured data exists** on an entity or metric in one call — and a cheap accuracy check to confirm a figure exists before spending a priced search/answer. Returns the coverage names, a `node_id` to pin, and — when the target is unambiguous — a ready-to-run `next_call` (search query + pinned nodes) to fetch the confirmed series. Free and fast. |

**Free tier (no credentials):** an unauthenticated connection can run `tako_search`, `tako_answer`, and `tako_available_data` only, capped at 10 requests/min per IP. Most clients list just those three; ChatGPT also lists `tako_contents` and `tako_visualize`, which return a sign-in prompt until the account is linked. Authenticate (OAuth or Bearer) for the full surface above plus the opt-in tools below, under your own account limits.

On connect, the server also advertises [MCP server instructions](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization) that hosts like Claude.ai, Claude Desktop, and Claude Code place in the model's system prompt. They steer data and metric questions to `tako_search` ahead of the host's built-in web search, and note that `tako_search` covers the live web too, so one call can stand in for a separate web search on mixed questions. Built-in web search remains the fallback for queries outside Tako's coverage.

**Opt-in** — off by default to keep the tool surface small. Enable per-connection via the `?tools=` query parameter (comma-separated aliases):

| Alias | Tool(s) | What it's for |
| ---- | ---- | ----------- |
| `agent` | `tako_agent` (ChatGPT: `tako_agent_start` / `tako_agent_wait`) | Tako's **Answer Agent** — opinionated, multi-step research (~30–90s) across many retrievals, returning a synthesized answer plus chart cards |
| `visualize` | `tako_visualize` | Author an embeddable chart/card from your own typed `components` (timeseries, bar, table, financial boxes…). **On by default for ChatGPT and Claude** — the hosts that render the chart widget inline; other clients opt in for the embed URL |
| `credits` | `get_credit_balance` | Check the connected account's API credit balance |
| `graph` | `tako_graph_search` / `tako_graph_related` / `tako_graph_node` | Low-level graph primitives behind `tako_available_data`: traversal relations, `q` filtering, cursor paging, full node detail |

The param rides on the connection URL, so how you set it depends on your client:

- **Claude.ai, Claude Desktop, ChatGPT (connectors):** include it in the URL you paste when adding the connector — e.g. `https://mcp.tako.com/mcp?tools=agent`. OAuth is unaffected (the server canonicalizes the resource, query string included). ChatGPT and Claude both get `visualize` automatically, no param needed.
- **Config-file clients (Cursor, Windsurf, VS Code, …) and `claude mcp add`:** put it on the URL in your config:

```bash
# Aliases compose as a comma-separated list on the MCP URL
claude mcp add tako-mcp --transport http "https://mcp.tako.com/mcp?tools=agent,visualize" \
  --header "Authorization: Bearer $TAKO_API_TOKEN"
```

- **Claude Code plugin:** the plugin pins the default surface (its URL isn't user-editable). Note that `tako_visualize`'s default-on status does **not** follow the plugin into the terminal: Claude Code is a CLI, not a widget host, so it is classified alongside other non-widget clients and gets charts as inline images. The same plugin used on Claude.ai does get `tako_visualize` by default, because that host renders the widget. For opt-in tools in Claude Code — `agent`, `visualize`, `credits`, `graph` — add the server yourself with `claude mcp add` and the `?tools=` param as above, and keep only one Tako connection active so you don't get two copies of every tool (the plugin's bundled skills keep working regardless of which connection serves the tools).

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
  Company financials and markets via Tako (sources vary by metric — S&P Global, Fiscal.ai, Visible Alpha, Xignite, and others). Revenue, earnings vs. estimates, margins, valuation, stock quotes, and head-to-head company comparisons as citation-backed charts. Use for equity research, company deep-dives, competitor financial comparison, or any "what are/were <company>'s <financial metric>" question.
---

# Financial Research (Tako)

Tako serves proprietary company financials as interactive, citation-backed charts. Sources vary by metric — S&P Global, Fiscal.ai, Visible Alpha, Xignite and others, so always cite the source the card actually returns, never a fixed name. All tools below live on the Tako MCP server installed in Step 1.

## What's in range
Broader than statutory financials, so assume coverage and check rather than talking yourself out of a search:
- **Income statement, balance sheet, cash flow** at annual and quarterly cadence, plus derived metrics (margins, ratios, per-share).
- **Valuation and market data**: `"Nvidia PE ratio"` returns P/E history; `"Apple stock price"` returns a Stock Overview card with price, market cap, P/E, and 52-week range.
- **Private companies**: coverage is not limited to listed issuers. `"SpaceX revenue"` returns real S&P Global and Visible Alpha cards. Never assume private means uncovered.
- **Segment and KPI detail** (Visible Alpha): bookings, subscribers, per-segment revenue and margin.
- **Analyst estimates and consensus**, alongside actuals.
- **Crypto spot rates** (CoinMarketCap) — `"Bitcoin price"` works.

Reliably NOT in the data graph, and where web carries the answer instead: forward-looking calendar facts (`"Nvidia next earnings date"` returns an Overview card with no date, while the web results have it), revenue for companies with no filings or analyst coverage (`"OpenAI annualized revenue"` returns zero cards), and anything qualitative (moat, strategy, management commentary).

## Pick the tool by what you want back
- `tako_answer`: **the default for any "<company> <metric>" question.** It returns the figure in prose ("What was Apple's FY25 revenue?" → "$416.2 billion") with its cited cards and their rows attached, so one priced call finishes the job. Relay the `answer` verbatim. It retrieves reported values; it does NOT compute derivations. For a growth rate, ratio, or margin change, pull the underlying levels and compute yourself.
- `tako_search`: reach for it when you want **breadth or a chart**, not a number: fanning out across several companies or metrics to see what exists, or pulling the card when the chart itself is the deliverable. Its cards are captions — S&P Global and Visible Alpha rows are license-gated, so a search that returns the right card still owes you a `tako_answer` call for the value. One card renders inline (see Pick the right card).
- `tako_available_data`: FREE, and the right tool when the question is **what Tako covers**: does this metric exist, under what exact name, for which entity. It also surfaces entity ambiguity early (`"Costco"` matches both Costco Wholesale Corporation and Costco Wholesale Australia). Not a warm-up before every lookup. Go straight to `tako_answer` when you just want the number.
- Protected sources are read-only: S&P Global, FactSet, Visible Alpha, and CoinMarketCap cards come back not exportable, with NO inline preview rows, and `tako_contents` cannot export their CSV. This is a licensing wall, not an error, so never retry the export. Read the headline value from the card's `description`, cite the chart, or ask `tako_answer` for the number. (Fiscal.ai cards export normally.)
- Cohort/ranking asks ("which of the largest US chipmakers grew revenue fastest since 2020?") → resolve the cohort yourself, fire one narrow call per member in parallel, and rank from the results. This is search's home ground when you only need to see what exists; use `tako_answer` per member when you need the actual figures.

## Query patterns (Critical)
- Query is ENTITY + METRIC: `"Nvidia revenue"`, `"Tesla free cash flow"`, `"Coca-Cola dividend yield"`. One entity + one metric per call, plus a cadence word (`quarterly`/`annual`) to steer the period.
- Multi-metric or multi-company asks → fire PARALLEL narrow searches and synthesize yourself. Do not send a multi-part question as one query; a compound query returns cards for some metrics and silently misses others.
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The card grounds the number while the web results carry the qualitative half of the research and the facts the graph doesn't hold, and web is the built-in fallback when no card comes back, so every query returns something answerable. Price is identical either way, and web does not degrade card selection. Narrow to `["data"]` only when you already know Tako has the metric (`tako_available_data` confirmed it, or you're pinning `node_ids`) and want just the number, or in a parallel fan-out where ~10 web results per call would swamp context.
- Empty result (zero cards): do NOT reword and retry blind. Every search is billed. Recover in exactly this order: (1) `tako_available_data` (free) for the exact metric name; (2) if it reports coverage, ONE more search using that exact name and NO `node_ids` — the canonical NAME is what recovers cards; a pin is a hard filter and returned FEWER cards than the same query unpinned on 11 of 20 pairs measured, because the graph holds near-duplicate metric nodes where only one twin carries cards; (3) if not covered, stop searching Tako and answer from the web results already in the response. Never send more than 2 priced searches for the same underlying question (in a fan-out, each entity+metric query has its own budget). Pin a METRIC `node_id` with `strict: true` only to disambiguate when an unpinned retry returned the wrong near-duplicate metric — and if a pinned call comes back empty, drop the pin rather than concluding Tako has no data.
- Empty is usually genuine non-coverage but has been observed transient — the same query returning zero cards once and real cards minutes later. That is exactly why the free `tako_available_data` check sits between the two priced calls: let it, not a hunch, decide whether a retry is justified.
- Empty also means "not covered in Tako," NOT that the fact is false. The response is identical for an uncovered metric and a genuinely-nonexistent one, so never infer a business fact from silence (no dividend card ≠ pays no dividend).

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts: whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
A search returns several cards and **#0 is frequently not what was asked for**. The relevance fact does not rescue you: the correct card is routinely tagged `Low` while an off-intent card is `High`. Tako auto-renders #0, so if the right card is elsewhere, reference it explicitly by linking its title to the card's chart URL and say it is the authoritative one. Walk this checklist before quoting any number:

1. **Right shape?** Prefer a card whose type is `chart` and whose title is the bare metric. Overview cards — "Earnings & Estimates Overview", "Ratios Overview", "Stock Overview" — routinely take #0 and lead with an estimate-vs-actual narrative rather than the value asked for. Skip them unless the question was about estimates. Precision in the query does not save you: `"Apple Gross Margin (%)"`, the exact metric name, still ranks the Overview at #0 and the real chart at #2.
2. **Right scope?** Segment- and geography-scoped variants outrank the company-wide metric, especially Visible Alpha cards. `"Apple gross margin"` puts "Gross margin - Products" (38.7%) above company-wide gross margin (46.9%); `"JPMorgan net interest income"` returns only "- Corporate & investment banking" cards; every top card for `"Airbnb gross bookings"` is a segment card. If no company-wide card appears, say so — never pass a segment off as the total.
3. **Right unit?** Asking for a rate can return the level. `"Microsoft operating margin quarterly"` ranks Operating Income ($38.4B) above EBIT Margin (46.3%). Check the units in `description` match the question.
4. **Actual, not projection?** The as-of date must not be in the future. A future date is NOT confined to cards titled "Analyst Estimates" — a plainly-titled "Toyota Revenues (Normalized) (Annual)" card carried a 2026-12-31 as-of. Trust the as-of date; the title is not a reliable signal.
5. **Right entity?** Related listed entities compete for the same query: `"Coca-Cola dividend yield"` returns The Coca-Cola Company, Coca-Cola HBC, Coca-Cola Europacific, and Coca-Cola FEMSA — four different companies with different numbers. Confirm the card's `nodes` names the one asked about, and note some cards (Fiscal.ai charts, Stock/Ratios Overviews) carry no nodes at all, so fall back to the title there.

## Comparisons and rendering
- A true comparison card (2 series, all entities in `nodes`) exists but is **not guaranteed**. `"Coca-Cola vs PepsiCo revenue"` and `"Toyota vs Ford revenue"` return one at #0; `"Intel vs Nvidia revenue"` reproducibly returns two separate single-entity cards instead. Always verify every compared entity appears in the chosen card's `nodes`/title — if none has them all, use the per-entity cards and synthesize. Comparisons default to annual; say `quarterly` for quarterly.
- On a comparison card, the as-of date is the QUERY date, not the data date — the Toyota/Ford card reported the day it was run while its latest point is Dec 31, 2025. Cite the period from the card's `description`, not that fact.
- Cross-currency comparisons are a correctness trap: a two-series chart can plot different currencies on one axis unnormalized (Toyota 43.6T JPY beside Ford's USD reads as ~250× raw, but ≈1.7× once converted). State each series' currency and convert before comparing — never present the raw chart as apples-to-apples.
- Period labels are calendar-normalized (Apple's annual points show "Dec 31" though its fiscal year ends in late September). Don't cite a label as the issuer's fiscal period; flag the normalization when precision matters.
- Cite the card's actual source name and as-of date. The source varies by metric — the same company can come back from S&P Global on one card and Fiscal.ai on another.
- Reference the chart in prose ("as the chart above shows"); do NOT re-post the card's image URL as a markdown image — that double-renders the inline chart.
- `tako_answer` prose may cite a different fiscal period than the embedded card's latest point — reconcile them so text and chart agree.

## Examples
- Single metric (the common case) → tako_answer {"query": "What was Nvidia's most recent quarterly revenue?", "sources": ["data", "web"]} — the figure, its cited chart, and the earnings release in one call
- Comparison → tako_answer {"query": "How do Coca-Cola and PepsiCo compare on annual revenue?", "sources": ["data", "web"]} → check both entities appear in the cited card's `nodes` before treating it as a comparison
- Chart is the deliverable → tako_search {"query": "Coca-Cola vs PepsiCo revenue", "sources": ["data", "web"]} → embed the card; ask `tako_answer` if you also need the values
- Coverage question (free; note the arg is `q`) → tako_available_data {"q": "Costco"} → then pin what it returns: tako_answer {"query": "Costco Wholesale Corporation annual revenue", "sources": ["data"]}
- Growth rate / ratio → pull the levels, then compute: tako_answer {"query": "Apple annual revenue for FY24 and FY25", "sources": ["data", "web"]} → compute the % change yourself
- Breadth recon → one narrow `tako_search` per company in parallel with `"sources": ["data"]` to see what exists; switch to `tako_answer` per company once you need the figures
- Not in the graph → tako_answer {"query": "When is Nvidia's next earnings date?", "sources": ["data", "web"]} → no card carries it; the answer comes from the web citations, so say the figure is web-sourced

## Output (tight and structured)
1) A 1–2 line read of the finding, referencing the intent-matched chart
2) Source name — as-of date, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the card you embedded

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
  Website and app traffic via Tako (source: SimilarWeb). Monthly visits, app active users, traffic trends, and top-sites rankings for any domain as citation-backed charts. Use for competitive traffic analysis, share-of-attention, or any "how much traffic does <site> get" question.
---

# Web & App Traffic (Tako)

Tako serves SimilarWeb traffic data as interactive, citation-backed charts. All tools below live on the Tako MCP server installed in Step 1.

## What's in range
- **Monthly Visits** per domain — the core metric, with roughly a one-month lag.
- **Head-to-head domain comparisons** and **ranked top-sites** cards.
- **App usage**: `"Spotify app monthly active users"` returns a SimilarWeb "Monthly Active Users" card keyed by the bare app name (`spotify`), not a domain.
- Coverage reaches well into the long tail: `"kagi.com monthly visits"` returns a real card (4.68M visits).

## Query patterns (Critical)
- **Query by DOMAIN, not brand**: this is the single highest-leverage rule here, and getting it wrong produces a confident wrong answer rather than an obvious failure. Use the bare domain: `"netflix.com monthly visits"`, `"youtube.com"`, `"chatgpt.com"`. For app usage, use the app name plus the metric.
- What a brand-shaped query actually does, and why it is dangerous: `"Netflix traffic"` on data returns three Netflix **subscriber** cards (84.0M average streaming subscribers), plausible-looking numbers that are not web traffic at all — while on web it returns CDN and BGP network-engineering articles about Netflix Open Connect. `"Netflix website traffic"` returns no card either way. None of these is the answer; only the bare domain produces a Visits card. If a traffic answer isn't backed by a card whose title is `<domain> Monthly Visits`, you do not have the traffic number yet.
- Comparisons: `"youtube.com vs netflix.com monthly visits"` returns a real 2-series card. Rankings: `"top websites by visits"` returns a ranked card (google.com 84.9B, youtube.com 28.8B, …).
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The SimilarWeb card grounds the number and web results add context (competitive write-ups, ranking roundups) that turn a figure into analysis. Price is identical either way, and web does not degrade card selection on a well-formed domain query. Narrow to `["data"]` when you only want the number for a domain you know is covered, or in a parallel fan-out.
- Empty result (zero cards): do NOT reword and retry blind; every search is billed. The #1 cause is a brand-name query: if the query wasn't a bare DOMAIN, fix it to one (`"Netflix traffic"` → `"netflix.com monthly visits"`) and retry ONCE. That is the recovery. If a domain-shaped query still comes back empty, stop searching Tako and answer from the web results already in the response, labelling the figure web-sourced.
- Do NOT use `tako_available_data` to rule a domain out. Its graph is entity-based and misses long-tail domains SimilarWeb covers: it reports `found: false` for `kagi.com` while the search returns a real card. It is still useful for resolving a brand to its entity `node_id` (`tako_available_data {"q": "Netflix"}` → `ent::netflix_inc::…`; note the arg is `q`), though pinning an entity `node_id` alone does not steer retrieval: only a METRIC `node_id` with `strict: true` does.
- Empty also means "not covered in Tako," NOT that the domain has no traffic — don't infer a fact from silence.

## Pick the tool
- `tako_answer`: **the default for "how much traffic does <domain> get".** Returns the number in prose with its cited chart attached. This matters more here than anywhere: SimilarWeb is licensed, so a search card carries NO rows. The figure lives in the card's `description` or comes from here.
- `tako_search`: reach for it when you want **breadth or a chart**, e.g. the ranked top-sites card, a head-to-head embed, or scanning several domains to see which are covered. Its cards are captions, never rows.
- `tako_available_data`: FREE brand→entity resolver, and the right tool when the question is what Tako covers. Do NOT use it to rule a domain out (see the empty-result bullet).
- SimilarWeb is a protected source, so EVERY traffic card is read-only: not exportable, no inline preview rows, and `tako_contents` cannot export the CSV. This is a licensing wall, not an error, so never call `tako_contents` on a traffic card. The numbers live in the card's `description` (latest value + % change over the period) and the chart; for one specific figure use `tako_answer`. (Web-result urls remain fetchable.)
- Cohort/growth asks ("top 5 streaming domains by visits, and which is growing fastest") → get the ranked card with `tako_search` (breadth is its job), then one `tako_answer` per domain in parallel and compute growth from the figures.

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts: whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
- **Verify by title, not by `nodes`.** Traffic cards list only the metric in `nodes` (`Visits`); the domain never appears there, so the entity check that works elsewhere in Tako is useless here. Confirm the domain in the card's title.
- **Comparison vs. single-series.** On a `"A vs B"` card the description reports each series as a **% change over the period**, not absolute visits (the youtube/netflix card leads with `-0.95%`). For absolute monthly visits, read the per-domain single-series card, which the same search usually also returns at #1 and #2.
- **A comparison card's as-of date is the QUERY date, not the data date**: the youtube/netflix comparison reported the day it was run while the single-domain cards correctly report the June 2026 data month. Cite the month from the single-series card or its `description`.
- **Watch for a different metric family.** SimilarWeb app "Monthly Active Users" and a company's own reported MAU are different numbers from different sources: `"Spotify app monthly active users"` returns SimilarWeb at 338.0M alongside Visible Alpha company-reported MAU at 479.5M. Say which one you're quoting.

## Rendering
- The top result renders inline automatically: an interactive widget on ChatGPT, a chart image on other hosts. Reference it in prose; do NOT re-post the card's image URL as a markdown image — that double-renders it.
- Cite SimilarWeb + the as-of month (read it from the single-series card).
- Point at any extra cards by linking their titles to their chart URLs — embed only the top card.

## Examples
- Single domain (the common case) → tako_answer {"query": "How many monthly visits does netflix.com get?", "sources": ["data", "web"]} — the figure plus its cited SimilarWeb chart
- Head-to-head → tako_answer {"query": "How do youtube.com and netflix.com compare on monthly visits?", "sources": ["data", "web"]} → absolute visits come from the per-domain figures, not a comparison card's % change
- Chart or ranking is the deliverable → tako_search {"query": "top websites by visits", "sources": ["data", "web"]} → embed the ranked card
- App usage → tako_answer {"query": "How many monthly active users does the Spotify app have?", "sources": ["data", "web"]} → say whether you quoted SimilarWeb or company-reported MAU
- Cohort fan-out → `tako_search` with `"sources": ["data"]` to see which domains are covered, then one `tako_answer` per domain for the figures
- Brand-shaped ask ("how much traffic does Netflix get?") → resolve to the domain yourself and ask about `netflix.com`; never answer from a subscriber card

## Output (tight and structured)
1) A 1–2 line read of the traffic, referencing the inline chart
2) SimilarWeb — as-of month, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the top card

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
  Macroeconomic and demographic indicators via Tako (sources vary — FRED, BLS, OECD, BIS, IMF, World Bank, Census). Inflation (CPI/PCE), unemployment, GDP, interest and policy rates, population, and cross-country comparisons as citation-backed charts. Use for macro monitoring, economic briefings, or any "what is/was <country>'s <indicator>" question.
---

# Macroeconomics (Tako)

Tako serves macro indicators as interactive, citation-backed charts. All tools below live on the Tako MCP server installed in Step 1.

## What's in range
- **Prices**: CPI (headline, core, seasonally adjusted and not), PCE price indices, country inflation rates.
- **Labor**: unemployment (headline, U-6, harmonised), employment measures.
- **Output and rates**: nominal and real GDP, GDP growth, policy and market interest rates.
- **Demographics**: population, population by age band, median age (Census, World Bank). These sit naturally in this skill's scope; don't send them elsewhere.
- **Prediction markets**: Polymarket contracts on macro outcomes are in the graph (`"Polymarket odds Fed rate cut 2026"` returns "How many Fed rate cuts in 2026?"). Useful when the question is genuinely about expectations, and a trap otherwise, see below.

**Coverage is country-keyed.** Individual countries resolve well (US, China, Japan, India). Multi-country blocs are weak: `"Eurozone inflation rate"` returns a Polymarket contract instead of an indicator, and `"Euro area CPI inflation rate"` returns nothing at all. For a bloc, query member countries and aggregate yourself, or take the figure from the web results and say so.

## Pick the tool
- `tako_answer`: **the default for any "<country> <indicator>" question.** Returns the value in prose with its cited chart and rows attached, so one priced call finishes the job. Relay the `answer` verbatim.
- `tako_search`: reach for it when you want **breadth or a chart** rather than a number, e.g. scanning several countries or indicator variants to see what exists, or pulling the card when the chart is the deliverable. FRED/OECD/BIS cards do export, so search is more useful here than in the licensed-data skills, but it still costs a round trip to turn a card into a figure.
- `tako_available_data`: FREE, and the right tool when the question is **what Tako covers**, or when many variants exist and you need the exact indicator name (mandatory for PCE — see below). Not a warm-up before every lookup.
- Cohort/ranking asks ("which G7 economy has the highest inflation right now?") → one narrow call per country in parallel, then rank. Use `tako_search` if you only need to see what exists, `tako_answer` when you need each figure.

## Query patterns (Critical)
- Query is COUNTRY + INDICATOR: `"US CPI inflation"`, `"US unemployment rate"`, `"US federal funds rate"` (which resolves to the Effective Federal Funds Rate, not the FOMC target range).
- Be specific — most indicators have many variants, and they carry materially different numbers. `"US unemployment rate"` returns BLS headline (4.2%), IMF (4.3%), OECD harmonised (4.2%), and U-6 (7.9%) together. Name the variant when intent is precise; run `tako_available_data` first when it isn't.
- PCE is the sharpest naming trap: `"US core PCE inflation"` silently returns a Core **CPI** card. Query the year-over-year variant by name instead — `"US core PCE price index % change"` returns the correct "Core PCE Price Index (% Change)" card. Verify the chosen card's title actually says `PCE` and `(% Change)`; a plain "PCE Price Index" card is an index level (~130 points), not a rate. Run `tako_available_data` FIRST here.
- Parallelize multi-part asks: send each metric as its own narrow concurrent `tako_search`, then synthesize — not one query.
- Cross-country comparison is built in: `"US vs China inflation"` returns a 2-series comparison card. For currency-denominated indicators (GDP, wages), a cross-country chart may plot different currencies on one axis unnormalized. State each series' currency and convert before comparing.
- `sources`: default to BOTH `["data", "web"]` (also the tool's default when omitted). The chart grounds the number, web results add the release commentary and context that make a briefing readable, and web is the built-in fallback when Tako lacks the indicator, including the bloc-level gaps above. Price is identical either way. Narrow to `["data"]` only when coverage is already confirmed (`tako_available_data`, pinned `node_ids`) or in a parallel fan-out where per-call web results would swamp context.
- Empty result (zero cards): do NOT reword and retry blind; every search is billed. Recover in order: (1) `tako_available_data` (free) for the exact indicator name; (2) if covered, ONE more search using that exact name and NO `node_ids` — the canonical NAME is what recovers cards; a pin is a hard filter and returned FEWER cards than the same query unpinned on 11 of 20 pairs measured, because the graph holds near-duplicate metric nodes where only one twin carries cards; (3) if not covered, stop searching Tako and answer from the web results already in the response. Never more than 2 priced searches per underlying question (in a fan-out, each country+indicator query has its own budget). Pin a METRIC `node_id` with `strict: true` only to disambiguate when an unpinned retry returned the wrong near-duplicate indicator — and if a pinned call comes back empty, drop the pin rather than concluding Tako has no data.
- Empty is usually genuine non-coverage but has been observed transient, which is why the free coverage check, not a hunch, decides whether a retry is justified. Empty also means "not covered in Tako," NOT that the indicator doesn't exist; don't infer a fact from silence.

## Reading a result
Every card carries a title, a `description` holding the headline value, and retrieval facts: whether it is exportable, its relevance, its card type, its as-of date, its `nodes` (the graph entities and metrics it was built from), its source name, and its chart/embed URLs.

Field names depend on the response format, so the checks below name the **concept** and you read whichever your response carries. A markdown response prints them on a facts line (`exportable · relevance · type · freshness · nodes · source · chart · embed`); a JSON response uses `exportable`, `relevance`, `card_type`, `data_freshness.data_as_of`, `nodes`, `sources[].source_name`, `webpage_url` and `embed_url`.

## Pick the right card (Critical)
Tako auto-renders #0, and for macro the **least-specific or stalest card often ranks first**. the relevance fact is unreliable: the correct card is frequently tagged `Low`. If the right card isn't #0, reference it by linking its title to the card's chart URL and say it is the authoritative one. Check, in order:

1. **Right variant?** `"US CPI inflation"` returns three different headline numbers at once — a BIS country card (4.2%), a FRED "Inflation Rate" series (2.9%), and FRED "CPI Inflation Rate (Seasonally Adjusted)" (3.5%). Pick the card whose title matches the variant asked for; don't average them or take whichever is first.
2. **Fresh, not a stale vintage?** Stale series rank high routinely: that FRED "Inflation Rate" card at #1 ends in Jan 2024, and `"US federal funds rate"` ranks "Fed Funds Target Rate (Historical)", a series that ends in Dec 2008, above the current one. Compare as-of dates across cards and take the freshest match. Freshness also varies by series: Core CPI runs to Jun 2026 while Core PCE stops at Jan 2026, so don't present them as the same vintage.
3. **Rate, not an index level?** A `(% Change)` card is a rate in percent; a bare "Price Index" card is index points. Confirm from the units in `description`.
4. **An indicator, not a prediction market?** A Polymarket card answers "what do traders expect," not "what was reported." `"Eurozone inflation rate"` returns exactly this. Only use one when the question is about expectations, and label it as market-implied odds.
5. **Right country?** Confirm the card's `nodes` names it. Country overview cards (type `card`) sometimes carry no nodes at all — fall back to reading the title.

## Rendering
- On a comparison card, the as-of date is the QUERY date, not the data date (the US-vs-China card reported the day it was run while its latest point is May 2026). Cite the period from the card's `description`, not that fact.
- Cite the card's source name and as-of date. The roster is wider than FRED alone: BIS, OECD, IMF, World Bank, BLS, Census and Polymarket all appear, and the same indicator arrives from different providers on different cards. Never cite from a fixed list.
- Reference the chart in prose; do NOT re-post the card's image URL as a markdown image — that double-renders the inline chart.

## Examples
- Single (the common case) → tako_answer {"query": "What is the current US CPI inflation rate?", "sources": ["data", "web"]} → check the cited card matches the variant asked for
- Cross-country → tako_answer {"query": "How does US inflation compare with China's?", "sources": ["data", "web"]}
- Chart is the deliverable → tako_search {"query": "US vs China inflation", "sources": ["data", "web"]} → embed the card
- Indicator-name question (free; note the arg is `q`) → tako_available_data {"q": "US core PCE"} → then pin the exact name: tako_answer {"query": "US core PCE price index % change", "sources": ["data"]}
- Parallel multi-metric → four calls for CPI, core CPI, core PCE (% change) and PCE (% change); `tako_search` with `"sources": ["data"]` to see what exists, `tako_answer` per metric when you need the values (take the "(% Change)" cards; plain "PCE Price Index" cards are index levels)
- Bloc-level ask → no Eurozone card exists; query member countries in parallel and aggregate, or take the figure from the web citations and label it web-sourced

## Output (tight and structured)
1) A 1–2 line read of the indicator, referencing the intent-matched chart
2) Source name — as-of date, and say so plainly when a figure came from the web rather than a card
3) A single `[Open in Tako]` link built from the card's embed URL, for the card you embedded

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

- The default tool surface is **`tako_search`**, **`tako_answer`**, **`tako_contents`**, **`tako_available_data`** — plus **`tako_visualize`** on ChatGPT and Claude, the hosts that render its chart inline. Everything else is opt-in via `?tools=`: **`tako_agent`** (`agent`; ChatGPT split pair **`tako_agent_start`** / **`tako_agent_wait`**), **`tako_visualize`** (`visualize`; needed only on clients that don't render widgets), **`get_credit_balance`** (`credits`), and graph primitives **`tako_graph_search`** / **`tako_graph_related`** / **`tako_graph_node`** (`graph`).
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
