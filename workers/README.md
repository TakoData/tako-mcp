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

## Anonymous access

`/mcp` requests with **no** `Authorization` header are served as a
rate-limited anonymous tier instead of a 401 — but only in environments that
opt in. Three bindings gate it (fail-closed: with any missing, anonymous
requests 401 exactly as before):

| Binding | Kind | Purpose |
|---|---|---|
| `FREE_TIER_API_KEY` | secret | Tako API key of the dedicated free-tier account, forwarded to Django as `X-API-Key` (trimmed, so a piped `wrangler secret put` newline can't break it) |
| `FREE_TIER_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per-IP fairness bucket: 10 free-tool `tools/call`s / 60 s |
| `FREE_TIER_GLOBAL_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per-colo burst shaping: 60 anonymous requests / 60 s / colo, all callers |

Declare both under the first-class `ratelimits` key. **Never under
`unsafe.bindings`** — that path is a raw passthrough: the API accepts it,
`wrangler versions view` renders the limits correctly, and `limit()`
resolves without throwing, but it never counts, so every call returns
`{success: true}`. No unit test catches it (the suite injects fake
limiters); the only proof is a live burst against a deployed Worker.

Neither Worker bucket is the platform-wide spend bound. Cloudflare's
ratelimit binding counts per colo (no global mode), so the constant-key
bucket enforces `60/min × colos reached` — it exists to shape per-colo
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

### Measured behaviour

The rate-limit binding is a burn-rate **dampener, not a bound**. Measured
against deployed staging with the secret set and the bindings confirmed
present:

| Per-IP config | Cold first burst (of 200) | Sustained, converged | Slow drip, 20 requests at 3 s |
|---|---|---|---|
| `limit: 10` | 104-118 admitted | ~53-64 per 200 | 20/20 admitted, 0 limited |
| `limit: 1` | ~118 admitted | ~19-25 per 200 | 13/20 admitted, 7 limited |

1. The configured limit controls **sustained** admission, not burst
   admission. Changing it moves the converged figure, not the first burst.
2. **Cold start leaks about 115 requests regardless of the limit.** A caller
   who pauses for one period gets a fresh leak. The limit cannot close this.
3. **Normal-paced traffic is never limited** at `limit: 10`. This is the path
   a real client takes.

One IP had 292 requests admitted in about 16 seconds. Cloudflare documents
the binding as "permissive, eventually consistent, and intentionally
designed to not be used as an accurate accounting system", with counters
"cached on the same machine and updated asynchronously".

Two conclusions follow. First, no user-facing string states a rate; a test
enforces this. Second, the pre-paid credit balance on the shared account is
the real bound.

Do NOT reach for `unsafe.bindings` or a shorter `period` to fix this.
`unsafe.bindings` was tried and changed nothing. A shorter period resets the
counter more often, and because the cold-start leak recurs per period, it
admits MORE traffic.

Per-call cost is bounded by the tool schemas: the anonymous toolset cannot
select the expensive `deep` tier. `tako_answer` does not expose `effort` and
`tako_search` constrains it to `["fast", "instant"]`.

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
  pointing at https://tako.com/account/ — deliberately not a 429,
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
  header selects the anonymous tier.
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
2. **Create the dedicated Tako account for anonymous access** and generate
   its API key from the account page. All anonymous traffic spends this one
   account's credits. Create it in the SAME environment the Worker points
   at: a production key returns 401 against `staging.tako.com` and vice
   versa, which is indistinguishable from a wrong key.
3. **Fund the account and leave no card on file.** The pre-paid credit
   balance is the abuse bound: the Worker limiters only dampen the burn
   rate, so exhaustion is the real backstop. `@meters_api_credits`
   pre-gates each request and returns 402 when `balance_cents <= 0` (see
   `backend/subscriptions/decorators.py`). The hazard is **auto-reload**,
   not the billing mode: `maybe_auto_reload` refills the balance when
   auto-reload is enabled AND a card is attached, which would turn the cap
   into a soft one. Keep auto-reload off. Monitor the balance and allocate
   more as needed with `add_api_credit --email <account> --amount <n>` or
   the `add-api-credit.yaml` Action.

   **Do not read the balance from the legacy `credit_balance` endpoint.**
   `GET /api/v1/credit_balance/` — and therefore the `get_credit_balance`
   MCP tool — reads the legacy Metronome/Redis ledger via
   `BillingServiceSingleton.get_remaining_credit_balance`, NOT
   `ApiCreditAccount.balance_cents`. It reported $0.00 for an account that
   actually held $24.41. To check this mechanically instead of by eye, call
   `GET /api/v1/billing/api_credits/` (`ApiCreditBalanceView`,
   `backend/subscriptions/api_credit_views.py`). It returns the authoritative
   `balance_cents`, plus `has_saved_card` and `auto_reload.enabled` — the
   three facts this step asks you to confirm.
4. **Enable staging first:**
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env staging   # paste the API key
   ```
5. **Verify on staging:** connect an MCP client to
   `mcp.staging.tako.com/mcp` with no auth. Expect `tools/list` to show
   exactly the three tools, and a `tako_search` call to return real
   results. Do NOT expect a specific call to be rate limited — see
   "Measured behaviour". To confirm the limiter is wired at all, send a
   sustained burst (a few hundred metered calls at concurrency 8) and check
   that rejections appear.
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
`FREE_TIER_RATE_LIMITER` blocks in `wrangler.jsonc` and the global ceiling
in the three `FREE_TIER_GLOBAL_RATE_LIMITER` blocks. Do NOT add the number
to any user-facing message — a test in `src/freetier.test.ts` fails if you
do, because the binding cannot enforce it. Edit, then redeploy — then
confirm against the DEPLOYED Worker with a burst of more than `limit`
metered calls inside one period. The
unit suite injects fake limiters, so it passes whether or not the real
binding counts. Counting is per-Cloudflare-colo and approximate (an IP
whose traffic hits two colos can see roughly 2× the limit) — acceptable
for abuse protection, not billing.

**Operator warning:** OAuth-capable hosts (claude.ai and similar) decide
whether to run their OAuth sign-in flow based on getting a 401 from the
*first* request to `/mcp`. With anonymous access active, that first request
succeeds anonymously instead — so any newly added connector on such a
host starts out running against the shared free-tier account (3 tools,
shared quota) rather than prompting the user to sign in for their own
account. Users must explicitly connect/re-authenticate to get off the
anonymous tier. Consciously accept this onboarding change before setting
`FREE_TIER_API_KEY` in production.
