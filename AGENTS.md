# AGENTS.md

## Project Overview

Tako MCP Server — an MCP (Model Context Protocol) server that provides AI agents access to Tako's knowledge base of 100K+ data visualizations.

The implementation is a **single Cloudflare Workers TypeScript server** (`workers/`) deployed at `mcp.tako.com` (prod) and `mcp.staging.tako.com` (staging). This is the canonical Tako MCP — all tool work lands here.

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

## Architecture

### Hosted (Cloudflare Workers) — `workers/`

- **Framework**: `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`
- **Runtime**: Cloudflare Workers (TypeScript, `nodejs_compat` flag)
- **Endpoint**: `POST /mcp` (single-route streamable HTTP), plus `GET /health`
- **Auth**: `Authorization: Bearer <TAKO_API_TOKEN>` extracted at request boundary, forwarded to Django as `X-API-Key`; OAuth 2.1 flow for Claude.ai / ChatGPT
- **Tool registry**: auto-generated from `workers/src/tools/*.ts` via `workers/scripts/gen-registry.ts`; outputs `workers/src/tools/_registry.ts` + `registry/server.json` in lockstep (CI checks for drift)
- **CI**: `.github/workflows/workers-ci.yml` (typecheck + tests on PRs), `workers-deploy.yml` (auto-deploy staging on push to `main`, manual prod), `workers-smoke.yml` (auto-smoke after successful staging deploys)

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
| `registry/server.json` | Public MCP registry discovery card (auto-generated from Workers tools) |

### Tools

Source of truth: `workers/src/tools/*.ts`. Tools are discovered at runtime via the MCP `tools/list` handshake.

1. `tako_search` — Search charts by natural-language query; supports `search_effort: fast | deep`
2. `tako_answer` — Get a grounded prose answer; ground in `["data"]`, `["web"]`, or both
3. `tako_contents` — Fetch underlying content (CSV or text) behind a result URL
4. `tako_agent` — Deep research agent for multi-step data questions (on ChatGPT split into `tako_agent_start` / `tako_agent_wait`)
5. `get_credit_balance` — Current credit balance

### Endpoints

#### Workers (`mcp.tako.com`)

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC over streamable HTTP |
| `/health` | GET | Simple `200 ok` |

## Code Conventions

### Workers (`workers/`)

- TypeScript 5+, ESM, Node 22 (matches Cloudflare Workers runtime)
- Strict TS — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- One file per tool under `workers/src/tools/`; each exports a `ToolModule` (see `types.ts`)
- Vitest for unit tests, `@cloudflare/vitest-pool-workers` for Worker-context tests
- Never edit `workers/src/tools/_registry.ts` or `registry/server.json` by hand — run `npm run registry:gen`
- Errors: handlers throw `DjangoError`; `mcp.ts` catches and maps via `djangoErrorToToolResult`

## PR Guidelines

- Run `cd workers && npm run typecheck && npm test && npm run registry:check` before submitting
- New tools: add a `workers/src/tools/<name>.ts` exporting a `ToolModule`, then `npm run registry:gen` to refresh the registry
- Smoke locally: `SMOKE_BASE_URL=https://mcp.staging.tako.com TAKO_SMOKE_API_TOKEN=... npm run smoke`
- Keep tool descriptions agent-optimized (lead with "Use this when...")
- Never commit API keys or tokens

## Safety Rules

- Never commit API keys, tokens, or credentials
- Never modify production infrastructure configs without an explicit ticket
- All tool functions must validate inputs before making API calls
- Error responses must never expose internal URLs or stack traces
