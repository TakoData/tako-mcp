# tako-mcp workers

[![workers-ci](https://github.com/TakoData/tako-mcp/actions/workflows/workers-ci.yml/badge.svg?branch=main&event=push)](https://github.com/TakoData/tako-mcp/actions/workflows/workers-ci.yml?query=branch%3Amain+event%3Apush)

This subdirectory hosts the TypeScript Cloudflare Workers port of the Tako MCP server, tracked under the [tako-mcp Linear project](https://linear.app/trytako/project/tako-mcp-635ac07fae22).

## Local dev

Node version is pinned via `.nvmrc` (`nvm use` to match CI).

```sh
nvm use
npm ci
npm test
npm run typecheck
npm run dev
```

## Anonymous free tier

`/mcp` requests with **no** `Authorization` header are served as a
rate-limited free tier instead of a 401 — but only in environments that
opt in. Two bindings gate it (fail-closed: with either missing, anonymous
requests 401 exactly as before):

| Binding | Kind | Purpose |
|---|---|---|
| `FREE_TIER_API_KEY` | secret | Tako API key of the dedicated free-tier account, forwarded to Django as `X-API-Key` |
| `FREE_TIER_RATE_LIMITER` | `unsafe.bindings` ratelimit in `wrangler.jsonc` | 10 metered requests / 60 s per client IP |

Behavior when active:

- Anonymous connections see exactly three tools: `tako_available_data`,
  `tako_search`, `tako_answer`. Everything else is hidden.
- Only `tools/call` is metered (per `CF-Connecting-IP`); `initialize` /
  `tools/list` are always free. Over-limit calls get an HTTP 429 with an
  upsell message pointing at https://trytako.com/account/. Each metered
  request logs one line: `[free-tier] ip=<ip> allowed|limited`.
- JSON-RPC batch requests (array bodies) are rejected outright with an
  HTTP 400 — never metered, never forwarded to Django. Batching was
  removed from the MCP spec in 2025-06-18, and metering a batch as a
  single limiter hit would let it stand in for unlimited `tools/call`s.
- A malformed `Authorization` header still 401s — only a fully absent
  header selects the free tier.
- Limiter runtime failures fail open (the shared account's Django-side
  limits are the spend backstop); missing configuration fails closed.

Enabling on an environment:

```bash
# 1. Create/choose the free-tier Tako account, then:
wrangler secret put FREE_TIER_API_KEY --env staging   # paste the API key
wrangler secret put FREE_TIER_API_KEY --env production
# 2. The FREE_TIER_RATE_LIMITER binding is already in wrangler.jsonc;
#    deploy as usual. To change the limit, edit `simple.limit` there AND
#    the FREE_TIER_LIMIT_MESSAGE copy in src/freetier.ts.
```

**Operator warning:** OAuth-capable hosts (claude.ai and similar) decide
whether to run their OAuth sign-in flow based on getting a 401 from the
*first* request to `/mcp`. With the free tier active, that first request
succeeds anonymously instead — so any newly added connector on such a
host starts out running against the shared free-tier account (3 tools,
shared quota) rather than prompting the user to sign in for their own
account. Users must explicitly connect/re-authenticate to get off the
anonymous tier. Consciously accept this onboarding change before setting
`FREE_TIER_API_KEY` in production.
