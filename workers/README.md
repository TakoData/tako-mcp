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

### Rollout checklist

Setting the `FREE_TIER_API_KEY` secret is the on/off switch — until it is
set on an environment, anonymous requests 401 exactly as before. There is
nothing to configure in the Cloudflare dashboard: the rate limiter is
config-as-code in `wrangler.jsonc` and deploys with the Worker.

1. **Deploy the Worker** (normal deploy flow). The
   `FREE_TIER_RATE_LIMITER` binding ships with it.
2. **Create the dedicated free-tier Tako account** and generate its API
   key from the account page. All anonymous traffic spends this one
   account's credits.
3. **Set Django-side limits/credits on that account.** This is the total
   spend backstop: the Worker limiter fails *open* on limiter runtime
   errors, so give the account a credit budget you can afford to lose.
4. **Enable staging first:**
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env staging   # paste the API key
   ```
5. **Verify on staging:** connect an MCP client to
   `mcp.staging.tako.com/mcp` with no auth → `tools/list` shows exactly
   the three free tools; make 11 `tools/call`s inside a minute → the
   11th returns 429 with the upsell message.
6. **Enable production** — after consciously accepting the operator
   warning below:
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env production
   ```

To change the per-IP limit later, edit `simple.limit` in **all three**
`unsafe.bindings` blocks in `wrangler.jsonc` (dev/staging/production)
AND the `FREE_TIER_LIMIT_MESSAGE` copy in `src/freetier.ts`, then
redeploy. Counting is per-Cloudflare-colo and approximate (an IP whose
traffic hits two colos can see roughly 2× the limit) — acceptable for
abuse protection, not billing.

**Operator warning:** OAuth-capable hosts (claude.ai and similar) decide
whether to run their OAuth sign-in flow based on getting a 401 from the
*first* request to `/mcp`. With the free tier active, that first request
succeeds anonymously instead — so any newly added connector on such a
host starts out running against the shared free-tier account (3 tools,
shared quota) rather than prompting the user to sign in for their own
account. Users must explicitly connect/re-authenticate to get off the
anonymous tier. Consciously accept this onboarding change before setting
`FREE_TIER_API_KEY` in production.
