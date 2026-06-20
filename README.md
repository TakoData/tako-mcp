# Tako MCP Server

An MCP (Model Context Protocol) server that provides access to Tako's knowledge base and interactive data visualizations.

## What is this?

This MCP server enables AI agents to:

- **Search** Tako's knowledge base for charts and data visualizations
- **Fetch** chart preview images and AI-generated insights
- **Render** fully interactive Tako charts via MCP-UI

## Quick start

**Use the hosted endpoint at `https://mcp.tako.com`.** Three lines, no install:

```bash
export TAKO_API_TOKEN='<your-token-from-tako.com>'
claude mcp add tako-mcp --transport http https://mcp.tako.com/mcp \
  --header "Authorization: Bearer $TAKO_API_TOKEN"
```

That's it for new users. Detailed configs for Claude Code / Claude Desktop / Cursor / Windsurf are in the next section.

> Looking for the Python `pip install tako-mcp` server, or the Docker image, or the Smithery listing? Those are the **legacy Python implementation** — see [Self-hosting (legacy)](#self-hosting-legacy-python-server) at the bottom. They're kept for air-gapped, custom-fork, and pre-existing deployments, but the hosted Workers endpoint is where all new tool work ships first and has the current tool surface.

## Hosted (Cloudflare Workers)

The fastest path: point your MCP client at `https://mcp.tako.com` with a Bearer token. No install, no local server.

**Endpoints:**

| Environment | URL |
|---|---|
| Production | `https://mcp.tako.com/mcp` |
| Staging (testing only) | `https://mcp.staging.tako.com/mcp` |

**Authentication:** every request needs `Authorization: Bearer <TAKO_API_TOKEN>`. Get a token at [tako.com](https://tako.com) → account settings → API tokens.

### Claude Code

```bash
export TAKO_API_TOKEN='<your-token>'

claude mcp add tako-mcp --transport http https://mcp.tako.com/mcp \
  --header "Authorization: Bearer $TAKO_API_TOKEN"
```

Verify with `claude mcp list` (should show `tako-mcp` connected) or `/mcp` inside a session.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
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

Restart Claude Desktop. `Tako MCP` should appear in the available tools list.

### Cursor / Windsurf

Add to `~/.cursor/mcp.json` (Cursor) or the equivalent Windsurf config:

```jsonc
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

### Notes

- **Tools are discovered automatically** via the MCP `tools/list` handshake on connect — your client always sees the current tool surface, no manual list to keep in sync.
- **Hosted uses Bearer auth on the connection**, not the `api_token` per-tool-call argument shown in the self-hosted examples below. Once authenticated, tool inputs match exactly across both transports.
- **Use the staging endpoint** (`mcp.staging.tako.com`) for testing changes against an unstable build before they reach `mcp.tako.com`.

## Consumer hosts (OAuth)

Use this if you're connecting Tako from **Claude.ai** or **ChatGPT** — the consumer chat hosts that don't accept Bearer tokens. The hosted endpoint at `https://mcp.tako.com/mcp` runs an OAuth 2.1 flow that signs you in with your Tako account and connects on your behalf, no JSON config or CLI required.

> If you're using Claude Code, Claude Desktop, Cursor, or Windsurf, see the Bearer-auth instructions [above](#hosted-cloudflare-workers) — those clients accept a static `Authorization: Bearer` header and don't need OAuth.

### Prerequisites

Before connecting from Claude.ai or ChatGPT:

1. **Sign up or sign in at [tako.com](https://tako.com).**
2. **Mint an API token** at tako.com → settings → API tokens.

Step 2 is mandatory: the consent flow looks up your existing token and surfaces a "Your Tako account does not have an API token yet" page if it doesn't find one. Tako does not auto-mint a token during the OAuth dance, because rotating an existing one would break any Claude Code / Cursor wiring you already have on the same account.

![tako.com Settings → API Key with Regenerate button](docs/images/tako-api-token-generate.png)

### What you'll see during connect

The same three Tako-hosted screens appear regardless of which host (Claude.ai or ChatGPT) you're connecting from:

1. **Tako sign-in page.** Two options: **Continue with Google** or send yourself an **email magic-link**. Use the same identity you signed up with at tako.com.

   ![mcp.tako.com sign-in page showing Google + email magic-link options](docs/images/mcp-tako-signin.png)

2. **Tako consent page.** Reads *"Connect [host name] to Tako — Signed in as you@example.com — Allow / Cancel"*. Click **Allow** to authorize the connection.

   ![mcp.tako.com consent page showing client name + signed-in identity](docs/images/mcp-tako-consent.png)

3. **Bounce back to the host.** The connector is now listed and tools are callable.

The host itself (Claude.ai or ChatGPT) may also display its own consent prompt before or after Tako's. That's normal — Tako confirms it's safe to share your account; the host confirms it's safe to invoke an external connector.

### Claude.ai

*Requires Claude.ai Pro, Max, Team, or Enterprise.*

1. Open Claude.ai → **Settings → Connectors**.

   ![Claude.ai Settings → Connectors landing page](docs/images/claude-connectors-landing.png)

2. Click **Add custom connector**.

   > _[Screenshot: Claude.ai "Add custom connector" dialog]_

3. Paste `https://mcp.tako.com/mcp` and click **Connect**.

4. You'll be taken through the Tako sign-in flow described above.

5. After consent, **Tako** appears in your connector list as connected.

   ![Claude.ai connector list showing Tako connected](docs/images/claude-connectors-landing.png)

### ChatGPT

*Requires ChatGPT Pro, Business, or Enterprise. Developer Mode must be enabled.*

1. Open ChatGPT → **Settings → Connectors → Developer Mode** and toggle it on if it isn't already.

   ![ChatGPT Settings → Connectors with the Developer Mode toggle](docs/images/chatgpt-connectors-developer-mode.png)

2. Click **Create custom connector**.

   ![ChatGPT "Create custom connector" dialog](docs/images/chatgpt-create-custom-connector.png)

3. Paste `https://mcp.tako.com/mcp` and click **Connect**.

4. You'll be taken through the Tako sign-in flow described above.

5. After consent, the connector is listed and ready to use.

   ![ChatGPT connector list showing Tako connected](docs/images/chatgpt-tako-connected.png)

### Verify it's working

In a fresh conversation, ask:

> Show me Tako's chart on Intel vs Nvidia headcount.

A successful response includes a chart link or an inline chart render (depending on host) within a few seconds. If you instead see an authentication error, jump to *Disconnecting & re-authorizing* below.

### Disconnecting & re-authorizing

There are two ways to break the connection, and they have different blast radius. Pick the one that matches what you actually want.

**Per-host disconnect** (Claude.ai or ChatGPT settings → remove the Tako connector). Stops *that host* from making MCP calls. Does **not** revoke the underlying Tako API token. Other connected hosts — and any Claude Code / Cursor Bearer-auth wiring on the same account — keep working unchanged.

**Rotate the API token at [tako.com](https://tako.com) → settings → API tokens.** This is the hard kill switch. Rotating creates a new token and invalidates the old one server-side, which means every previously-issued OAuth grant — across every host — stops authenticating immediately. To resume from any host, disconnect and reconnect; the new consent flow picks up your fresh token.

> This kill-switch behavior is by design for v1. Per-grant scoped tokens (revoke a single host without touching the others) are tracked under [TAKO-2679](https://linear.app/tako/issue/TAKO-2679)'s known limitations.

## Self-hosting (legacy Python server)

> ⚠️ **The pip / Docker / Smithery paths described in this section are the original Python implementation in `src/tako_mcp/`.** They are *not* the current canonical Tako MCP — that's the hosted Cloudflare Worker at `mcp.tako.com` documented above. The Python server still works and is maintained for self-hosted, air-gapped, and Smithery-marketplace deployments, but it ships an older tool surface and an older transport (SSE, per-tool `api_token` argument) than the hosted version. New tool work lands in `workers/` first; the Python server may diverge over time.
>
> If you don't have a specific reason to self-host, use the hosted endpoint above.

### Installation

```bash
pip install tako-mcp
```

Or install from source:

```bash
git clone https://github.com/anthropics/tako-mcp.git
cd tako-mcp
pip install -e .
```

### Run the Server

```bash
tako-mcp
```

Or with Docker:

```bash
docker build -t tako-mcp .
docker run -p 8001:8001 tako-mcp
```

### Connect Your Agent

Point your MCP client to `http://localhost:8001`.

### Configuration (self-hosted only)

Environment variables apply to the Python server. The hosted Worker has its own configuration baked into `workers/wrangler.jsonc` and is not user-tunable.

| Variable | Description | Default |
|----------|-------------|---------|
| `TAKO_API_URL` | Tako API endpoint | `https://api.tako.com` |
| `PUBLIC_BASE_URL` | Public URL for chart embeds | `https://tako.com` |
| `PORT` | Server port | `8001` |
| `HOST` | Server host | `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | Additional allowed hosts (comma-separated) | |
| `MCP_ENABLE_DNS_REBINDING` | Enable DNS rebinding protection | `true` |

### Testing the self-hosted server

```bash
python -m tests.test_client --api-token YOUR_API_TOKEN
```

This verifies:
- MCP handshake and initialization
- Tool discovery
- Search, images, and insights
- MCP-UI resource generation

## Breaking changes (v0.2.0)

- `knowledge_search` → **`tako_search`** (endpoint unchanged).
- `grounding` → **`tako_answer`** (now backed by GA `/api/v1/answer`; result is `{answer, cards, web_results, request_id}`).
- New: **`tako_contents`**, **`tako_agent`**.

Update any client config or agent prompts that referenced the old tool names.

## Available Tools

> **Note on the JSON examples below:** these show the input shape used by the **legacy Python server** (`api_token` passed as a per-tool argument). If you're using the hosted endpoint at `mcp.tako.com`, drop the `api_token` field — auth flows via the connection-level `Authorization: Bearer …` header instead. Tool *inputs* are otherwise compatible across both transports, and your MCP client discovers the live tool surface automatically via `tools/list`. The hosted Worker also ships a different tool surface than the Python server: current Workers tools are `tako_search`, `tako_answer`, `tako_contents`, `tako_agent`, `get_chart_image`, `open_chart_ui`, `create_chart`, `create_report`, `get_report`, `list_reports`, `export_report`, and `get_credit_balance`.

### `tako_search`

Search Tako's knowledge base for charts and data visualizations.

```json
{
  "query": "Intel vs Nvidia headcount",
  "api_token": "your-api-token",
  "count": 5,
  "search_effort": "deep"
}
```

Returns matching charts with IDs, titles, descriptions, and URLs.

### `get_chart_image`

Get a preview image URL for a chart.

```json
{
  "pub_id": "chart-id",
  "api_token": "your-api-token",
  "dark_mode": true
}
```

### `get_card_insights`

Get AI-generated insights for a chart.

```json
{
  "pub_id": "chart-id",
  "api_token": "your-api-token",
  "effort": "medium"
}
```

Returns bullet-point insights and a natural language description.

## ThinViz API - Create Custom Charts

ThinViz lets you create charts with your own data using pre-configured templates.

### `list_chart_schemas`

List available chart templates.

```json
{
  "api_token": "your-api-token"
}
```

Returns schemas like `stock_card`, `bar_chart`, `grouped_bar_chart`.

### `get_chart_schema`

Get detailed info about a schema including required components.

```json
{
  "schema_name": "bar_chart",
  "api_token": "your-api-token"
}
```

### `create_chart`

Create a chart from a template with your data.

```json
{
  "schema_name": "bar_chart",
  "api_token": "your-api-token",
  "source": "Company Reports",
  "components": [
    {
      "component_type": "header",
      "config": {
        "title": "Revenue by Region",
        "subtitle": "Q4 2024"
      }
    },
    {
      "component_type": "categorical_bar",
      "config": {
        "datasets": [{
          "label": "Revenue",
          "data": [
            {"x": "North America", "y": 120},
            {"x": "Europe", "y": 98},
            {"x": "Asia", "y": 156}
          ],
          "units": "$M"
        }],
        "title": "Revenue by Region"
      }
    }
  ]
}
```

Returns the new chart's `card_id`, `embed_url`, and `image_url`.

## MCP-UI - Interactive Charts

### `open_chart_ui`

Open an interactive chart in the UI (MCP-UI).

```json
{
  "pub_id": "chart-id",
  "dark_mode": true,
  "width": 900,
  "height": 600
}
```

Returns a UIResource for rendering an interactive iframe.

## Example Flow

1. User asks: "Show me a chart about Intel vs Nvidia headcount"
2. Agent calls `tako_search` with the query
3. Agent receives chart results with IDs
4. Agent can:
   - Call `tako_answer` to get a grounded prose answer
   - Call `get_chart_image` for a preview
   - Call `open_chart_ui` to render an interactive chart

## Health Checks

- `GET /health` - Simple "ok" response
- `GET /health/detailed` - JSON with status and timestamp

## Architecture

Tako MCP runs in two modes depending on which distribution path you chose. Both speak the same MCP tool protocol; only the transport and host differ.

**Hosted mode (`mcp.tako.com`)** — the recommended path:

```
AI Agent (Claude Code/Desktop, Cursor, etc.)
    ↓
  MCP Protocol (Streamable HTTP, POST /mcp)
    ↓
Cloudflare Worker  ──  Bearer auth, tool dispatch
    ↓
Tako Django API  (api.tako.com)
```

The Cloudflare Worker is a thin TypeScript proxy: it extracts the Bearer token, validates the MCP request, calls the appropriate Django endpoint with the user's token forwarded as `X-API-Key`, and returns structured tool results. Code lives in `workers/` of this repo.

**Self-hosted mode (`pip install` / Docker)** — same proxy idea, run locally:

```
AI Agent
    ↓
  MCP Protocol (SSE)
    ↓
Local tako-mcp process  (Python, Starlette/Uvicorn)
    ↓
Tako Django API
```

Use this when you need to run inside a private network, modify the server, or pin a specific version. Code lives in `src/tako_mcp/`.

In both modes the server:
1. Authenticates with your Tako API token (Bearer header for hosted; `api_token` per-tool argument for SSE)
2. Translates MCP tool calls to Tako API requests
3. Returns formatted results and UI resources

## MCP-UI Support

The `open_chart_ui` tool returns an MCP-UI resource that clients can render as an interactive iframe. The embedded chart supports:

- Zooming and panning
- Hover interactions
- Responsive resizing via `postMessage`
- Light and dark themes

Clients that support MCP-UI (like CopilotKit) will automatically render these resources.

## MCP Registry (maintainers)

Tako is published to the official [MCP Registry](https://registry.modelcontextprotocol.io)
as a remote server under the name `io.github.TakoData/tako-mcp`.

- **`server.json`** (repo root) is the registry descriptor: a remote
  `streamable-http` entry pointing at `https://mcp.tako.com/mcp`. The registry
  schema does not list tools — hosts discover them at runtime via `tools/list`.
  (This is distinct from `registry/server.json`, the generated in-repo tool
  catalog used by `npm run registry:gen` / `registry:check`.)
- **Publishing** is automated by `.github/workflows/publish-mcp.yml`. It
  authenticates with the registry via **GitHub OIDC** (no secret — the
  `io.github.TakoData/*` namespace is authorized because this repo lives in the
  TakoData org) and runs `mcp-publisher publish`. **The version lives in code:**
  bump `server.json`'s `version` and merge to `main` and it publishes
  automatically. A merge that touches `server.json` without changing the version
  is a no-op (the workflow skips, so the registry never sees a duplicate). Manual
  `workflow_dispatch` publishes the checked-in version on demand.
- **Branded namespace (`com.tako/tako-mcp`)** is an optional future upgrade. It
  requires DNS authentication: generate an Ed25519 key, add a `TXT` record on
  `tako.com`, and swap the workflow's `login github-oidc` step for
  `login dns --domain tako.com --private-key ${{ secrets.MCP_PRIVATE_KEY }}`.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [Tako](https://tako.com) - Data visualization platform
- [MCP Specification](https://spec.modelcontextprotocol.io/) - Model Context Protocol
- [MCP-UI](https://mcpui.dev/) - MCP UI rendering standard
