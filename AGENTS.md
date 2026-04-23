# AGENTS.md

## Project Overview

Tako MCP Server — an MCP (Model Context Protocol) server that provides AI agents access to Tako's knowledge base of 100K+ data visualizations and the ThinViz API for creating custom charts.

## Build & Run

```bash
# Install dependencies
pip install -e ".[dev]"

# Run the server
tako-mcp

# Run with Docker
docker build -t tako-mcp .
docker run -p 8001:8001 tako-mcp

# Run tests
python -m tests.test_client --api-token YOUR_TOKEN
```

## Architecture

- **Framework**: FastMCP (from `mcp` package) with SSE transport
- **Server**: Starlette ASGI app served by Uvicorn on port 8001
- **API**: Proxies requests to Tako's REST API (configured via `TAKO_API_URL` env var)
- **Auth**: API key passed per-tool-call as `api_token` parameter, forwarded as `X-API-Key` header
- **UI**: MCP-UI resources for interactive chart embedding via `mcp-ui-server`

### Key Files

| File | Purpose |
|------|---------|
| `src/tako_mcp/server.py` | Main MCP server — ASGI app, 8 tools, OAuth 2.1, discovery endpoints |
| `src/tako_mcp/main.py` | Alternative implementation using Tako Python client (not the primary server) |
| `src/tako_mcp/smithery/server.py` | Smithery marketplace integration wrapper |
| `integrations/langchain_tako.py` | LangChain/LangGraph tool wrapper |
| `integrations/crewai_tako.py` | CrewAI tool wrapper |
| `integrations/autogen_tako.py` | AutoGen (Microsoft) tool wrapper |
| `integrations/vercel_ai_tako.ts` | Vercel AI SDK tool wrapper |
| `integrations/openai_actions.yaml` | OpenAI GPT Actions spec |
| `openapi.yaml` | OpenAPI 3.1.0 spec with agent hints |
| `tests/test_client.py` | Integration test client |
| `Dockerfile` | Container build (Python 3.11-slim, port 8001) |

### Tools (8)

1. `knowledge_search` — Search charts by natural language query
2. `explore_knowledge_graph` — Discover entities, metrics, cohorts
3. `get_chart_image` — Get static PNG preview URL
4. `get_card_insights` — Get AI-generated chart analysis
5. `list_chart_schemas` — List available ThinViz chart templates
6. `get_chart_schema` — Get schema details and data format
7. `create_chart` — Create chart from schema + data
8. `open_chart_ui` — Render interactive chart via MCP-UI

### Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | Streamable HTTP transport (recommended) |
| `/sse` | GET | SSE transport connection |
| `/messages/` | POST | SSE JSON-RPC messages |
| `/health` | GET | Simple health check |
| `/health/detailed` | GET | Detailed health status |
| `/.well-known/mcp` | GET | MCP Server Card (SEP-1649) |
| `/v1/tools` | GET | Agent-friendly tool descriptions |
| `/.well-known/oauth-authorization-server` | GET | OAuth 2.1 metadata |
| `/oauth/register` | POST | Dynamic client registration |
| `/oauth/authorize` | GET | Authorization endpoint |
| `/oauth/token` | POST | Token exchange endpoint |

## Code Conventions

- Python 3.11+, async/await throughout
- Ruff for linting (line length 100, rules: E, F, I, N, W, UP)
- All tool functions are async, decorated with `@mcp.tool()`
- Tools return Pydantic models for structured output (`structuredContent`)
- Errors raised as `TakoToolError` exceptions (converted to MCP error responses)
- Timeouts: 30s for schema ops, 60s for search/create, 90s for insights
- Environment variables for configuration (see README)

## PR Guidelines

- Run `ruff check src/` before submitting
- Test with `python -m tests.test_client --api-token TOKEN`
- Keep tool descriptions agent-optimized (lead with "Use this when...")
- Never commit API keys or tokens

## Safety Rules

- Never commit API keys, tokens, or credentials
- Never modify production infrastructure configs
- All tool functions must validate inputs before making API calls
- Error responses must never expose internal URLs or stack traces
