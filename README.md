# Tako MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)
[![Python](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that gives AI agents the ability to search, create, and interact with data visualizations via [Tako](https://tako.com).

## Connect

Point your MCP client to the hosted server:

```
https://mcp.tako.com/sse
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tako": {
      "url": "https://mcp.tako.com/sse"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tako": {
      "url": "https://mcp.tako.com/sse"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `knowledge_search` | Search 100K+ curated charts on any topic |
| `explore_knowledge_graph` | Discover available entities, metrics, and cohorts |
| `get_chart_image` | Get a static PNG preview of a chart |
| `get_card_insights` | Get AI-generated analysis of a chart |
| `list_chart_schemas` | List available chart templates (15+ types) |
| `get_chart_schema` | Get the data format for a chart type |
| `create_chart` | Create a new chart from raw data |
| `open_chart_ui` | Render an interactive chart via MCP-UI |

## Example: Create a Bar Chart

```json
{
  "schema_name": "bar_chart",
  "api_token": "your-api-token",
  "source": "Company Reports",
  "components": [
    {
      "component_type": "header",
      "config": { "title": "Revenue by Region", "subtitle": "Q4 2024" }
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

## Chart Types

| Type | Schema | Use Case |
|------|--------|----------|
| Line/Area | `timeseries_card` | Trends over time |
| Stock | `stock_card` | Financial data with ticker boxes |
| Bar | `bar_chart` | Categorical comparisons |
| Grouped Bar | `grouped_bar_chart` | Multi-series comparisons |
| Pie | `pie_chart` | Proportional data |
| Scatter | `scatter_chart` | 2-variable correlations |
| Bubble | `bubble_chart` | 3-variable data |
| Histogram | `histogram` | Frequency distributions |
| Box Plot | `boxplot` | Statistical distributions |
| Map | `choropleth` | Geographic data (US/World) |
| Treemap | `treemap` | Hierarchical data |
| Heatmap | `heatmap` | 2D matrices |
| Waterfall | `waterfall` | Sequential changes |
| KPI Boxes | `financial_boxes` | Key metrics |
| Table | `table` | Tabular data |

## Architecture

```
AI Agent (Claude, Cursor, LangGraph, etc.)
    |
  MCP Protocol (SSE or Streamable HTTP)
    |
Tako MCP Server (port 8001)
    |
Tako API
```

### Transports

| Transport | Endpoint | Status |
|-----------|----------|--------|
| SSE | `/sse` | Supported |
| Streamable HTTP | `/mcp` | Supported |

### Discovery Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /health/detailed` | Detailed status with version |
| `GET /.well-known/mcp` | MCP Server Card (SEP-1649) |

## Authentication

All tool calls require a Tako API token passed as the `api_token` parameter. Get your token at [tako.com](https://tako.com) in account settings.

## Development

```bash
pip install -e ".[dev]"
tako-mcp
```

Or with Docker:

```bash
docker compose up
```

### Testing

```bash
python -m tests.test_client --api-token YOUR_API_TOKEN
```

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TAKO_API_URL` | Tako API endpoint | Required |
| `PUBLIC_BASE_URL` | Public URL for chart embeds | `https://tako.com` |
| `PUBLIC_API_URL` | Public API URL for image URLs | Falls back to `TAKO_API_URL` |
| `PORT` | Server port | `8001` |
| `HOST` | Server host | `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | Additional allowed hosts (comma-separated) | |
| `MCP_ENABLE_DNS_REBINDING` | Enable DNS rebinding protection | `true` |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [Tako](https://tako.com)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [MCP-UI](https://mcpui.dev/)
