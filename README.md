# Tako MCP Server

An MCP (Model Context Protocol) server that provides access to Tako's knowledge base and interactive data visualizations.

## What is this?

This MCP server enables AI agents to:

- **Search** Tako's knowledge base for charts and data visualizations
- **Fetch** chart preview images and AI-generated insights
- **Render** fully interactive Tako charts via MCP-UI

## Distribution Paths

| Path | Endpoint / Install | Best for | Trade-offs |
|------|---|---|---|
| **Hosted (Cloudflare)** | `https://mcp.tako.com` | Most users — fastest setup, zero infrastructure | Internet round-trip; requires a Tako API token (free) |
| **`pip install tako-mcp`** | local stdio / SSE | Local development, air-gapped environments, custom forks | You manage the process and updates |
| **Docker** | `docker run …` | Self-hosting, on-prem deploys, container orchestration | You manage the image and runtime |
| **Smithery** | [smithery.ai](https://smithery.ai/) | Discoverability via the Smithery marketplace | Same caveats as the underlying transport |

If you don't have strong opinions, **use the hosted option** — `mcp.tako.com` is the canonical endpoint and gets all updates first.

## Hosted (Cloudflare Workers)

The fastest path: point your MCP client at `https://mcp.tako.com` with a Bearer token. No install, no local server.

**Endpoints:**

| Environment | URL |
|---|---|
| Production | `https://mcp.tako.com/mcp` |
| Staging (testing only) | `https://mcp.staging.tako.com/mcp` |

**Authentication:** every request needs `Authorization: Bearer <TAKO_API_TOKEN>`. Get a token at [trytako.com](https://trytako.com) → account settings → API tokens.

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

## Installation

```bash
pip install tako-mcp
```

Or install from source:

```bash
git clone https://github.com/anthropics/tako-mcp.git
cd tako-mcp
pip install -e .
```

## Quick Start

### Get an API Token

Sign up at [trytako.com](https://trytako.com) and create an API token in your account settings.

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

## Available Tools

### `knowledge_search`

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

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `TAKO_API_URL` | Tako API endpoint | `https://api.trytako.com` |
| `PUBLIC_BASE_URL` | Public URL for chart embeds | `https://trytako.com` |
| `PORT` | Server port | `8001` |
| `HOST` | Server host | `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | Additional allowed hosts (comma-separated) | |
| `MCP_ENABLE_DNS_REBINDING` | Enable DNS rebinding protection | `true` |

## Testing

Run the test client:

```bash
python -m tests.test_client --api-token YOUR_API_TOKEN
```

This verifies:
- MCP handshake and initialization
- Tool discovery
- Search, images, and insights
- MCP-UI resource generation

## Example Flow

1. User asks: "Show me a chart about Intel vs Nvidia headcount"
2. Agent calls `knowledge_search` with the query
3. Agent receives chart results with IDs
4. Agent can:
   - Call `get_card_insights` to summarize the data
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
Tako Django API  (api.trytako.com)
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

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [Tako](https://trytako.com) - Data visualization platform
- [MCP Specification](https://spec.modelcontextprotocol.io/) - Model Context Protocol
- [MCP-UI](https://mcpui.dev/) - MCP UI rendering standard
