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
opt in. Three bindings gate it (fail-closed: with any missing, anonymous
requests 401 exactly as before):

| Binding | Kind | Purpose |
|---|---|---|
| `FREE_TIER_API_KEY` | secret | Tako API key of the dedicated free-tier account, forwarded to Django as `X-API-Key` (trimmed, so a piped `wrangler secret put` newline can't break it) |
| `FREE_TIER_RATE_LIMITER` | `unsafe.bindings` ratelimit in `wrangler.jsonc` | per-IP fairness bucket: 10 free-tool `tools/call`s / 60 s |
| `FREE_TIER_GLOBAL_RATE_LIMITER` | `unsafe.bindings` ratelimit in `wrangler.jsonc` | per-colo burst shaping: 1000 anonymous requests / 60 s / colo, all callers |

Neither Worker bucket is the platform-wide spend bound. Cloudflare's
ratelimit binding counts per colo (no global mode), so the constant-key
bucket enforces `1000/min × colos reached` — it exists to shape per-colo
floods, including the otherwise-unmetered handshake methods. Per-IP
keying means little for hosted MCP hosts (claude.ai, ChatGPT, and
similar egress from a handful of platform IPs); it's a fairness layer.
The **genuinely global ceiling is Django's Redis-backed per-user
throttling on the free-tier account** — every anonymous request
authenticates as that one user, landing on `_SEARCH_USER` (720/min,
`/api/v3/search/`), `_DRF_USER` (720/min, `/api/v1/answer/`), and
`_GRAPH_TIER` (180/min + 10,000/day, `/api/beta/graph/*`) in
`app/backend/api/throttling/policy.py`. Note none of these weighs tool
cost: the worst case is that many `tako_answer` calls.

Behavior when active:

- Anonymous connections see exactly three tools: `tako_available_data`,
  `tako_search`, `tako_answer`. Everything else is hidden.
- Every anonymous request counts against the global ceiling; the per-IP
  bucket counts only `tools/call`s naming one of the three free tools
  (the only requests that spend Tako credits). A `tools/call` for a
  hidden tool returns "tool not found" without burning per-IP quota;
  `initialize` / `tools/list` never burn it. IPv4 clients are keyed by
  address, IPv6 by /64 prefix.
- An over-limit `tools/call` (either bucket) returns **HTTP 200 with a
  JSON-RPC tool result** (`isError: true`) carrying an upsell message
  pointing at https://trytako.com/account/ — deliberately not a 429,
  which MCP SDK clients surface as a transport error the model never
  reads. Non-`tools/call` requests over the per-colo ceiling get a plain
  429 (no valid readable shape exists for them).
- If the shared account itself runs out of Tako credits (Django 402),
  the tool result carries the same style of upsell copy instead of the
  raw billing error.
- Each per-IP-metered request logs one line:
  `[free-tier] ip=<key> allowed|limited`.
- JSON-RPC batch requests (array bodies) are rejected outright with an
  HTTP 400 — never metered, never forwarded to Django. Batching was
  removed from the MCP spec in 2025-06-18, and metering a batch as a
  single limiter hit would let it stand in for unlimited `tools/call`s.
- Anonymous request bodies are capped at 128 KiB (HTTP 413 past that) —
  the body peek is new unauthenticated surface and its read is bounded,
  so a lying `Content-Length` doesn't help.
- A malformed `Authorization` header still 401s — only a fully absent
  header selects the free tier.
- Limiter runtime failures fail open (the shared account's Django-side
  limits are the spend backstop); missing configuration fails closed.

### Rollout checklist

Setting the `FREE_TIER_API_KEY` secret is the on/off switch — until it is
set on an environment, anonymous requests 401 exactly as before. There is
nothing to configure in the Cloudflare dashboard: both rate limiters are
config-as-code in `wrangler.jsonc` and deploy with the Worker.

1. **Deploy the Worker** (normal deploy flow). The
   `FREE_TIER_RATE_LIMITER` and `FREE_TIER_GLOBAL_RATE_LIMITER` bindings
   ship with it.
2. **Create the dedicated free-tier Tako account** and generate its API
   key from the account page. All anonymous traffic spends this one
   account's credits.
3. **Put the account on a plan where the credit ceiling actually
   enforces.** This is the total spend backstop (the Worker limiters
   fail *open* on runtime errors and are per-colo anyway), and the
   mechanism matters: Django's credit throttles (`_ANSWER_CREDIT`,
   `_V3_CREDIT`, `_CONTENTS_CREDIT`) are **bypassed** for PAYG billing
   (spend meters in USD forever and never 402s — unbounded dollars),
   and for Enterprise/MPP accounts. So the free-tier account must be a
   standard credit-capped plan with a budget you can afford to lose.
   The per-user *rate* throttles (720/min search+answer, 180/min graph)
   apply on every billing mode and are the floor either way.
4. **Enable staging first:**
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env staging   # paste the API key
   ```
5. **Verify on staging:** connect an MCP client to
   `mcp.staging.tako.com/mcp` with no auth → `tools/list` shows exactly
   the three free tools; make 11 free-tool `tools/call`s inside a minute
   → the 11th returns a tool error carrying the upsell message.
6. **Enable production** — after consciously accepting the operator
   warning below:
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env production
   ```

**Kill switch (rollback):** deleting the secret instantly reverts the
environment to the pre-free-tier behavior (anonymous → 401), no code
change or redeploy needed:

```bash
wrangler secret delete FREE_TIER_API_KEY --env production
```

**Key rotation:** `wrangler secret put` over the top swaps what the
Worker forwards, but the OLD key remains a valid full-privilege Tako API
key until it is revoked/regenerated on the Tako account itself — do both.
The three-tool restriction is Worker-side filtering, not an authorization
boundary on the key, so treat the key's blast radius as the whole
account.

**Runbook — detecting fail-open:** the only signal that a limiter outage
has the tier failing open is the Worker error log line. Check for it
with:

```bash
wrangler tail tako-mcp-production --search "failing open"
```

Before production enablement, set up a Cloudflare Workers
error-rate notification (Account → Notifications → Workers) so a
sustained burst of these isn't something you discover by accident an
hour later. The Django-side account cap (step 3) bounds the damage in
the meantime.

To change the limits later: the per-IP limit lives in the three
`FREE_TIER_RATE_LIMITER` blocks in `wrangler.jsonc` AND in
`FREE_TIER_LIMIT_MESSAGE` in `src/freetier.ts` (a drift test in
`src/freetier.test.ts` fails if the message and bindings disagree); the
global ceiling lives in the three `FREE_TIER_GLOBAL_RATE_LIMITER`
blocks. Edit, then redeploy. Counting is per-Cloudflare-colo and
approximate (an IP whose traffic hits two colos can see roughly 2× the
limit) — acceptable for abuse protection, not billing.

**Operator warning:** OAuth-capable hosts (claude.ai and similar) decide
whether to run their OAuth sign-in flow based on getting a 401 from the
*first* request to `/mcp`. With the free tier active, that first request
succeeds anonymously instead — so any newly added connector on such a
host starts out running against the shared free-tier account (3 tools,
shared quota) rather than prompting the user to sign in for their own
account. Users must explicitly connect/re-authenticate to get off the
anonymous tier. Consciously accept this onboarding change before setting
`FREE_TIER_API_KEY` in production.
