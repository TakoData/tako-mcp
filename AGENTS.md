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
- **CI**: `.github/workflows/workers-ci.yml` (typecheck + tests on PRs), `workers-deploy.yml` (staging on push to `main`; production on published GitHub Release, gated by the `production` environment; manual `workflow_dispatch` for either env), `workers-smoke.yml` (auto-smoke after successful staging deploys)

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

1. `tako_search` — Fast retrieval of a **list of structured cards** (top renders as an inline chart); `effort: fast | instant`, `count` up to 20/source. Reach for it when you want data *outputs* to work with, or when fanning out queries in parallel to gather lots of results.
2. `tako_answer` — Get **one** synthesized, citation-backed prose answer (arbiter over data + web) to a specific data question; ground in `["data"]`, `["web"]`, or both. Use when you want a direct written answer in a single call rather than a list of cards.
3. `tako_contents` — Fetch underlying content (CSV or text) behind a result URL
4. `tako_available_data` — Find **what proprietary, structured data exists** on an entity or metric, and confirm a specific figure exists (and its exact name) before spending a priced `tako_search` / `tako_answer`. Summarizes the available metrics in one free call. Each match carries a `node_id` to pin into a follow-up `tako_search` / `tako_answer`.
5. `tako_agent` — Answer Agent for multi-step data questions (on ChatGPT split into `tako_agent_start` / `tako_agent_wait`). **Opt-in** — off by default; enabled per-connection via `?tools=agent` (see `workers/src/tools/_optional.ts`).
6. `tako_visualize` — Create an embeddable chart/card from your own structured data. **Opt-in** — `?tools=visualize`; stays default-on for ChatGPT (it powers the widget — see `CHATGPT_DEFAULT_ON_TOOL_NAMES` in `workers/src/mcp.ts`).
7. `get_credit_balance` — Current credit balance. **Opt-in** — `?tools=credits`.
8. `tako_graph_search` / `tako_graph_related` / `tako_graph_node` — Low-level graph primitives behind `tako_available_data`, for power users who need traversal relations (siblings, members, `rel:*` edges), in-relation `q` filtering, cursor paging, or full node detail. **Opt-in** — `?tools=graph` enables all three.

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

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).

- **Conventional Commits are required.** Merges are **squash-only** and the squash
  commit uses the **PR title**, which `pr-title-lint` validates. Use `feat:` (minor),
  `fix:` (patch), `chore:`/`docs:`/`refactor:`/etc. Below 1.0, breaking changes bump
  the minor, not the major.
- **Do not hand-edit the version.** release-please owns it across `version.txt` (the anchor) and the seven tracked files:
  `server.json`, `agent.json`, `workers/package.json`, `workers/src/mcp.ts`
  (`SERVER_VERSION`), `registry/metadata.json`, `registry/server.json`, and
  `registry/smithery.yaml`. (`registry/server.json` is generated from
  `registry/metadata.json`; release-please bumps its `version` directly so
  `npm run registry:check` stays green.)
- **How a release flows:** release-please keeps a "release: X.Y.Z" PR open on `main`.
  Merging it bumps the versions + `CHANGELOG.md`, tags `vX.Y.Z`, and publishes a
  GitHub Release. That merge also: publishes to the MCP registry (`publish-mcp.yml`,
  on the `server.json` bump) and deploys the Worker to **staging**
  (`workers-deploy.yml`). The GitHub Release then triggers the **production** deploy,
  which waits for one approval on the `production` environment.
