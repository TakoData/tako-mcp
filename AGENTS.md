# AGENTS.md

## Project Overview

Tako MCP Server — an MCP (Model Context Protocol) server that provides AI agents access to Tako's knowledge base of 100K+ data visualizations and the ThinViz API for creating custom charts.

The repo currently houses **two implementations** in parallel:

- **`workers/`** — TypeScript on Cloudflare Workers, streamable HTTP transport, Bearer auth. **This is the canonical hosted deployment** at `mcp.tako.com` (prod) and `mcp.staging.tako.com` (staging). All future tool work lands here first.
- **`src/tako_mcp/`** — original Python implementation, FastMCP/Starlette + SSE transport, `pip install tako-mcp`. Maintained for self-hosted, air-gapped, and Smithery-marketplace use cases. The hosted Worker eventually supersedes this for most users; the Python version stays as the self-host path.

## Build & Run

### Hosted Worker (TypeScript)

```bash
cd workers

# Install
npm ci

# Local dev (in-memory, no Cloudflare deploy)
npm run dev

# Deploy (requires CF auth)
npm run deploy:staging
npm run deploy:production

# Verification
npm run typecheck
npm test
npm run registry:check     # validate registry/server.json + _registry.ts have no drift
SMOKE_BASE_URL=https://mcp.staging.tako.com TAKO_SMOKE_API_TOKEN=... npm run smoke
```

### Self-hosted Python

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

Two transport stacks, same Django backend.

### Hosted (Cloudflare Workers) — `workers/`

- **Framework**: `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`
- **Runtime**: Cloudflare Workers (TypeScript, `nodejs_compat` flag)
- **Endpoint**: `POST /mcp` (single-route streamable HTTP), plus `GET /health`
- **Auth**: `Authorization: Bearer <TAKO_API_TOKEN>` extracted at request boundary, forwarded to Django as `X-API-Key`
- **Tool registry**: auto-generated from `workers/src/tools/*.ts` via `workers/scripts/gen-registry.ts`; outputs `workers/src/tools/_registry.ts` + `registry/server.json` in lockstep (CI checks for drift)
- **CI**: `.github/workflows/workers-ci.yml` (typecheck + tests on PRs), `workers-deploy.yml` (auto-deploy staging on push to `main`, manual prod), `workers-smoke.yml` (auto-smoke after successful staging deploys)

### Self-hosted (Python) — `src/tako_mcp/`

- **Framework**: FastMCP (from `mcp` package) with SSE transport
- **Server**: Starlette ASGI app served by Uvicorn on port 8001
- **API**: Proxies requests to Tako's REST API (configured via `TAKO_API_URL` env var)
- **Auth**: API key passed per-tool-call as `api_token` parameter, forwarded as `X-API-Key` header
- **UI**: MCP-UI resources for interactive chart embedding via `mcp-ui-server`

### Key Files

| File | Purpose |
|------|---------|
| `workers/src/index.ts` | Worker entrypoint — routes `/health` and `/mcp` POST |
| `workers/src/mcp.ts` | MCP server wrapper, tool dispatch, `djangoErrorToToolResult` |
| `workers/src/django.ts` | Typed HTTP client with `DjangoError` hierarchy |
| `workers/src/auth.ts` | Bearer token extraction |
| `workers/src/tools/*.ts` | One file per tool (`ToolModule` contract from `types.ts`) |
| `workers/src/tools/_registry.ts` | Auto-generated barrel — DO NOT edit by hand; run `npm run registry:gen` |
| `workers/scripts/gen-registry.ts` | Codegen for `_registry.ts` + `registry/server.json` |
| `workers/scripts/smoke.ts` | Post-deploy MCP smoke test (TAKO-2611) |
| `workers/wrangler.jsonc` | Cloudflare deploy config (per-env names, custom-domain routes, env vars) |
| `src/tako_mcp/server.py` | Python MCP server — ASGI app, tool definitions, health endpoints |
| `src/tako_mcp/smithery/server.py` | Smithery marketplace integration wrapper |
| `tests/test_client.py` | Python integration test client |
| `Dockerfile` | Self-hosted container build (Python 3.11-slim, port 8001) |
| `registry/server.json` | Public MCP registry discovery card (auto-generated from Workers tools) |

### Tools (Workers — current)

Source of truth: `workers/src/tools/*.ts`. The Python implementation has a different surface (see TAKO-2599 audit).

1. `tako_search` — Search charts by natural-language query (renamed from `knowledge_search`)
2. `tako_answer` — Get a grounded prose answer (renamed from `grounding`; GA `/api/v1/answer`)
3. `tako_contents` — Fetch underlying content (CSV or text) behind a result URL
4. `tako_agent` — Deep research agent for multi-step data questions
5. `get_chart_image` — Get static PNG preview URL
6. `open_chart_ui` — Render interactive chart via MCP-UI
7. `create_chart` — Create chart from components
8. `create_report` — Kick off async report generation
9. `export_report` — Export a completed report (PDF/Markdown/JSON/PowerPoint)
10. `get_report` — Fetch a report by ID
11. `list_reports` — List the user's reports
12. `get_credit_balance` — Current credit balance

`explore_knowledge_graph` was retired in PR #47 (endpoint removed upstream).

### Endpoints

#### Workers (`mcp.tako.com`)

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC over streamable HTTP |
| `/health` | GET | Simple `200 ok` |

#### Python (self-hosted, port 8001)

| Path | Method | Description |
|------|--------|-------------|
| `/sse` | GET | SSE transport connection |
| `/messages/` | POST | MCP JSON-RPC messages |
| `/health` | GET | Simple health check |
| `/health/detailed` | GET | Detailed health status |
| `/.well-known/mcp` | GET | MCP Server Card (SEP-1649) |

## Code Conventions

### Workers (`workers/`)

- TypeScript 5+, ESM, Node 22 (matches Cloudflare Workers runtime)
- Strict TS — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- One file per tool under `workers/src/tools/`; each exports a `ToolModule` (see `types.ts`)
- Vitest for unit tests, `@cloudflare/vitest-pool-workers` for Worker-context tests
- Never edit `workers/src/tools/_registry.ts` or `registry/server.json` by hand — run `npm run registry:gen`
- Errors: handlers throw `DjangoError`; `mcp.ts` catches and maps via `djangoErrorToToolResult`

### Python (`src/tako_mcp/`)

- Python 3.11+, async/await throughout
- Ruff for linting (line length 100, rules: E, F, I, N, W, UP)
- All tool functions are async, decorated with `@mcp.tool()`
- Error responses return JSON with `error`, `message`, and `suggestion` keys
- Timeouts: 30s for schema ops, 60s for search/create, 90s for insights

Both: environment variables for configuration (see README).

## PR Guidelines

### Workers PRs

- Run `cd workers && npm run typecheck && npm test && npm run registry:check` before submitting
- New tools: add a `workers/src/tools/<name>.ts` exporting a `ToolModule`, then `npm run registry:gen` to refresh the registry
- Smoke locally: `SMOKE_BASE_URL=https://mcp.staging.tako.com TAKO_SMOKE_API_TOKEN=... npm run smoke`

### Python PRs

- Run `ruff check src/` before submitting
- Test with `python -m tests.test_client --api-token TOKEN`

### Both

- Keep tool descriptions agent-optimized (lead with "Use this when...")
- Never commit API keys or tokens

## Safety Rules

- Never commit API keys, tokens, or credentials
- Never modify production infrastructure configs without an explicit ticket
- All tool functions must validate inputs before making API calls
- Error responses must never expose internal URLs or stack traces
