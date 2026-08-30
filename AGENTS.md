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
- **Endpoints**: two path-selected MCP surfaces — `POST /mcp` (generic, anonymous tier allowed) and `POST /mcp/chatgpt` (OAuth-only, the surface submitted to OpenAI) — plus `GET /health`. The request path picks the surface; nothing reads the client User-Agent (`workers/src/surface.ts`).
- **Auth**: `Authorization: Bearer <TAKO_API_TOKEN>` extracted at request boundary, forwarded to Django as `X-API-Key`; OAuth 2.1 flow for Claude.ai / ChatGPT
- **Tool registry**: auto-generated from `workers/src/tools/*.ts` via `workers/scripts/gen-registry.ts`; outputs `workers/src/tools/_registry.ts`, `registry/server.json`, `registry/lhm.plugin.json` and `docs/TOOLS.md` in lockstep (CI checks all four for drift)
- **CI**: `.github/workflows/workers-ci.yml` (typecheck + tests on PRs), `workers-deploy.yml` (staging on push to `main`; production on published GitHub Release, gated by the `production` environment; manual `workflow_dispatch` for either env), `workers-smoke.yml` (auto-smoke after successful staging deploys)

### Key Files

| File | Purpose |
|------|---------|
| `workers/src/index.ts` | Worker entrypoint — resolves the MCP surface from the request path, routes `/health` |
| `workers/src/surface.ts` | `MCP_PATHS` + `surfaceForPath` — the only thing that decides which surface a request gets |
| `workers/src/tools/_surface.ts` | Per-surface tool membership (`isToolOnSurface`) and annotation overrides |
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

Two path-selected surfaces, no User-Agent sniffing (`workers/src/surface.ts`): `/mcp` is the generic surface every client shares (anonymous tier allowed; charts as inline PNG); `/mcp/chatgpt` is the OAuth-only surface submitted to OpenAI's app directory (MCP Apps widget, top-level `securitySchemes`, Apps-review annotation overrides via `annotationsBySurface`). Membership per surface: `workers/src/tools/_surface.ts` — two constant name sets plus `resolveToolSet(surface, requested)`. `?tools=` is an allowlist of tool names that REPLACES the generic default listing (`workers/src/tools/_tools_param.ts`; the `tako_` prefix is optional) and is ignored on the chatgpt surface, whose listing is fixed at submission. The tool LISTING never varies by auth state; anonymous EXECUTION is gated at dispatch in `mcp.ts` to `FREE_TIER_TOOL_NAMES` (`tako_search` alone). No tool declares an `anonymousInputRejects` gate any more: `tako_search`'s `include_contents` was the only one, and rows moved to `tako_contents`, which is auth-required outright.

1. `tako_search` — Fast retrieval of a **list of structured cards** (top renders as an inline chart). Four parameters — `query`, `sources`, `country_code`, `locale` — and no defaults of its own, so an omitted field takes the v3 API's. It finds data; `tako_contents` fetches it. Reach for it when fanning out queries in parallel to see what exists, or when the chart is the deliverable. Default.
2. `tako_contents` — Fetch underlying content (CSV or text) behind a result URL. Requires a signed-in connection. Default.
3. `tako_available_data` — Find **what proprietary, structured data exists** on an entity or metric, and confirm a specific figure exists (and its exact name) before spending a priced `tako_search`. Summarizes the available metrics in one free call. Each match carries its canonical name — search on that name, since `tako_search` takes no pin — plus a `node_id` for `tako_graph_related` traversal. Ambiguous `q` returns the top entity and top metric as candidates; `metric` is the substring browse filter; `limit` (max 20) widens the list. Default.
4. `tako_graph_related` — Explore a node's relations (metrics, entities, `rel:competes_with`, `part_of`, `members`, sources) as a compact overview or one paged relation, slimmed to id/name/type/subtype/label; `q` is a substring filter. Drill into a node `tako_available_data` already resolved. Default.
5. `tako_search_advanced` — The WHOLE v3 `SearchRequest` body plus `include_answer` and `output_schema`, derived from `workers/src/generated/schemas.ts` so the set cannot drift (parity is tested, not asserted in a header). `include_answer: true` runs `POST /api/v1/answer` instead of `/api/v3/search`: one synthesized, citation-backed answer with the retrieval as its citations. Every level is `.strict()`, and `mcp.ts` registers the full schema object, so an unknown key is a -32602 on the wire. It is the only pin-capable tool, so the license-gated values path (METRIC node id alone + `strict: true` + `include_answer` + `data.include_contents`) lives here. Opt-in via `?tools=search_advanced`; `?tools=answer` resolves to it.
6. `tako_agent` — Answer Agent for multi-step data questions (~30–90s, polled). Opt-in; off the chatgpt surface, which sends no progressToken.
7. `tako_visualize` — Create an embeddable chart/card from your own structured data. Opt-in on `/mcp`, listed by default on `/mcp/chatgpt`, the host that renders the widget inline.

Items 5-7 are opt-in: name the tool in `?tools=` (an allowlist that replaces the defaults; see `workers/src/tools/_tools_param.ts` and `_surface.ts`). The generated reference is `docs/TOOLS.md`; `registry:check` fails when it is stale.

### Endpoints

#### Workers (`mcp.tako.com`)

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC over streamable HTTP — the generic surface every client shares |
| `/mcp/chatgpt` | POST | Same protocol, ChatGPT app surface. OAuth required: an anonymous request gets 401 + `WWW-Authenticate`, never the free tier |
| `/health` | GET | Simple `200 ok` |

## Code Conventions

### Workers (`workers/`)

- TypeScript 5+, ESM, Node 22 (matches Cloudflare Workers runtime)
- Strict TS — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- One file per tool under `workers/src/tools/`; each exports a `ToolModule` (see `types.ts`)
- Vitest for unit tests, `@cloudflare/vitest-pool-workers` for Worker-context tests
- Never edit `workers/src/tools/_registry.ts` or `registry/server.json` by hand — run `npm run registry:gen`
- `chatgpt-app-submission.json` is what we INTEND to submit next, not what OpenAI currently holds. OpenAI snapshots names, descriptions and input schemas at submission and does not update them live, so between submissions this file and OpenAI's copy disagree by exactly the changes waiting to ship — `tako_graph_related` was added to it before any resubmission. `chatgpt-app-snapshot.json` is the sha256 parity record of the same surface as last ACCEPTED here; `registry:check` compares the live tools against it and `registry:gen --accept` is the only thing that moves it. Before resubmitting, diff the submission file against what was actually last sent.
- Errors: handlers throw `DjangoError`; `mcp.ts` catches and maps via `djangoErrorToToolResult`

## PR Guidelines

- Run `cd workers && npm run typecheck && npm test && npm run registry:check` before submitting
- New tools: add a `workers/src/tools/<name>.ts` exporting a `ToolModule`, then `npm run registry:gen` to refresh the registry
- Smoke locally: `SMOKE_BASE_URL=https://mcp.staging.tako.com TAKO_SMOKE_API_TOKEN=... npm run smoke`
- Keep tool descriptions agent-optimized: lead with what the tool DOES in one
  line, then a `Best for:` line naming when to reach for it. (Not "Use this
  when..." — no tool has led with that phrasing for a long time, and the
  generated `docs/TOOLS.md` is the place to check what the model actually reads.)
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
