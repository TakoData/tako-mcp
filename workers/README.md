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
| `FREE_TIER_GLOBAL_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per-colo burst shaping: 120 anonymous requests / 60 s / colo, all callers |
| `NATIVE_CARD_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per-IP bucket for the two native-card proxy routes: 200 / 60 s. Separate from the free-tier bucket because one card render is ~10 browser subresource fetches — sharing it made the render 429 its own assets |

Declare every limiter under the first-class `ratelimits` key. **Never under
`unsafe.bindings`** — that path is a raw passthrough: the API accepts it,
`wrangler versions view` renders the limits correctly, and `limit()`
resolves without throwing, but it never counts, so every call returns
`{success: true}`. No unit test catches it (the suite injects fake
limiters); the only proof is a live burst against a deployed Worker.

Neither Worker bucket is the platform-wide spend bound. Cloudflare's
ratelimit binding counts per colo (no global mode), so the constant-key
bucket enforces `120/min × colos reached` — it exists to shape per-colo
floods, including the otherwise-unmetered handshake methods. Per-IP
keying means little for hosted MCP hosts (claude.ai, ChatGPT, and
similar egress from a handful of platform IPs); it's a fairness layer.
The **genuinely global ceiling is Django's Redis-backed per-user
throttling on the free-tier account** — every anonymous request
authenticates as that one user. Anonymous traffic can only reach one
tool, so it lands on one policy: `tako_search` on `/api/v3/search/`.
It makes NO graph requests: `tako_available_data` left
`FREE_TIER_TOOL_NAMES` because one call fans out into up to ~9 credit-free
`/api/v1/graph/*` requests, and graph is bounded by a per-USER rate limit
(180/minute) that every anonymous caller shared — about twenty anonymous
coverage checks a minute exhausted it for everyone.

**Read the live numbers from `app/backend/api/throttling/policy.py` in the
monorepo, not from here.** The table that used to sit in this paragraph
went stale the moment `tako_answer` moved behind `?tools=answer`: it named
`_DRF_USER` (`/api/v1/answer/`), an endpoint no anonymous connection can
reach. That tool has since been deleted, which would have staled the copy a
second time — `/api/v1/answer/` is now reached only through `include_answer`
on `tako_search_advanced`, which is opt-in AND absent from
`FREE_TIER_TOOL_NAMES`. `freetier.ts` carries the same pointer for the
same reason. No policy weighs tool cost — which is why a fan-out tool
cannot be free: the worst case is that many `tako_search` calls.

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

**The per-colo bucket has NOT been measured.** Every row above varies the
per-IP bucket. Sustained bursts showed per-colo rejections rising while
per-IP rejections fell, so the per-colo bucket is the one that clamps under
load — but no measurement supports any particular value for it, and 120 is
not tuned. Lowering it was tried in this branch and reverted for that
reason.

Before changing it, note what it gates. `checkFreeTierRateLimit` hits the
per-colo bucket **before** the batch check and before the metering decision,
so `initialize` and `tools/list` count against it even though they spend
nothing. A connector opening a new session costs roughly three requests, so
the ceiling divided by three is the rough budget of new anonymous sessions
per minute per colo. Past it, a handshake gets a plain 429 — not a 401, so
an OAuth-capable host shows no sign-in prompt, and not a tool result, so the
model reads nothing. It just looks broken. Any retune therefore needs a
measurement of **sessions per minute per colo until handshakes fail**, not
just admitted-call counts, which cannot see a rejected handshake at all.

Per-call cost is bounded by the tool schema: `tako_search` cannot select
the expensive `deep` tier (it constrains `effort` to `["fast", "instant"]`)
and takes no `include_contents`, so anonymous calls never inline billed
rows.

Behavior when active (the free tier serves `/mcp` only — `/mcp/chatgpt`
401s anonymous requests before admission):

- Anonymous connections can EXECUTE exactly one tool: `tako_search`
  (`FREE_TIER_TOOL_NAMES`). The LISTING is auth-invariant — the same four
  default tools as an authenticated connection — so `tako_available_data`,
  `tako_contents` and `tako_graph_related` are listed anonymously and
  answer sign-in instructions plus an `_meta["mcp/www_authenticate"]`
  challenge at dispatch instead of executing. The `initialize`
  instructions are ALSO auth-invariant: the host loads them once, and a
  sign-in mid-conversation does not reliably refresh them, so the
  dispatch-time result is the only place the tier is ever stated.
- Every anonymous request counts against the global ceiling; the per-IP
  bucket counts only `tools/call`s naming the free tool
  (the only request that spends Tako credits). A `tools/call` for any
  other tool burns no per-IP quota: a listed tool answers the sign-in
  result without ever reaching Django, an unlisted one gets "tool not
  found"; `initialize` / `tools/list` never burn it. IPv4 clients are
  keyed by address, IPv6 by /64 prefix.
- An over-limit `tools/call` (either bucket) returns **HTTP 200 with a
  JSON-RPC tool result** (`isError: true`) carrying a neutral
  capacity/retry message — deliberately not a 429, which MCP SDK clients
  surface as a transport error the model never reads.
  Non-`tools/call` requests over the per-colo ceiling get a plain 429 (no
  valid readable shape exists for them).
- If the shared account itself runs out of Tako credits (Django 402),
  the tool result carries the same style of capacity message instead of
  the raw billing error.
- The BASE messages link to no account page, quote no price, and suggest
  no API key, and a guard test in `freetier.test.ts` keeps it that way.
  Commerce copy keys on the SURFACE: on `/mcp` (the only surface that
  serves the free tier) the limit/capacity messages append
  `FREE_TIER_COMMERCE_UPSELL` — "Sign in with your client's MCP
  authentication for up to 2,000 free requests on a new account, or
  connect with a Tako API key (tako.com)." — for every client. The
  chatgpt surface never carries commerce copy (OpenAI's app guidelines
  ban purchase-promoting text in model-visible output); it never reaches
  these messages anyway, since it 401s anonymous requests.
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
3. **Put the account on PAYG, fund it, and leave no card on file.** The
   pre-paid credit balance is the abuse bound: the Worker limiters only
   dampen the burn rate, so exhaustion is the real backstop. Three
   conditions must all hold, and the first is easy to miss:

   - **`billing_mode` must be `PAYG`.** The 402 gate runs only for metered
     requests, and `is_metered_request` (`backend/subscriptions/api_metering.py`)
     returns true for an API-key request **only** when
     `ent.billing_mode == BillingMode.PAYG`. On a `CONTRACT` org
     (`credit-exempt, externally billed`) `@meters_api_credits` returns the
     view before `balance_cents` is ever read: no 402, and the funded
     balance is never drawn down. `is_metered_request` also short-circuits
     on `request.is_mpp`. A CONTRACT or MPP account therefore has **no
     credit bound at all**.
   - **The balance must be funded.** `@meters_api_credits` pre-gates each
     request and returns 402 when `balance_cents <= 0` (see
     `backend/subscriptions/decorators.py`).
   - **Auto-reload must be off, with no card attached.**
     `maybe_auto_reload` refills the balance when auto-reload is enabled
     AND a card is on file, which turns the cap into a soft one.

   Monitor the balance and allocate more as needed with
   `add_api_credit --email <account> --amount <n>` or the
   `add-api-credit.yaml` Action.

   **The floor that holds either way.** Even when the credit gate is
   bypassed, Django's per-user *rate* throttles still apply to the shared
   account on every billing mode: `_SEARCH_USER` and `_DRF_USER` at
   720/min, `_GRAPH_TIER` at 180/min plus 10,000/day
   (`backend/api/throttling/policy.py`). Those bound request volume, not
   spend.

   **Do not read the balance from the legacy `credit_balance` endpoint.**
   `GET /api/v1/credit_balance/` reads the legacy Metronome/Redis ledger via
   `BillingServiceSingleton.get_remaining_credit_balance`, NOT
   `ApiCreditAccount.balance_cents`. It reported $0.00 for an account that
   actually held $24.41. To check this mechanically instead of by eye, call
   `GET /api/v1/billing/api_credits/` (`ApiCreditBalanceView`,
   `backend/subscriptions/api_credit_views.py`). It returns
   `balance_cents`, `billing_mode`, `has_saved_card`, and
   `auto_reload.enabled` — every fact this step asks you to confirm.

   **Read `billing_mode` before you trust the balance.** That view returns
   a hardcoded `balance_cents: 0` with `billing_mode: null` when the user
   has no `enterprise_account` at all, which is indistinguishable from a
   genuinely depleted account. Treat `billing_mode: null` as "not wired
   up", not as "out of credits", and treat anything other than `PAYG` as
   "no credit bound".
4. **Enable staging first:**
   ```bash
   wrangler secret put FREE_TIER_API_KEY --env staging   # paste the API key
   ```
5. **Verify on staging:** run `SMOKE_BASE_URL=https://mcp.staging.tako.com
   TAKO_SMOKE_API_TOKEN=... npm run smoke` — it asserts the whole surface
   split: anonymous `/mcp` lists the four default tools (the User-Agent
   changes nothing); anonymous `tako_available_data`, `tako_contents` and
   `tako_graph_related` return the `auth_required` tool error, not
   results; anonymous `/mcp/chatgpt` is a
   401 with a `www-authenticate` challenge; an authenticated
   `/mcp/chatgpt` listing carries top-level `securitySchemes` and logs
   `[mcp] tools/list securitySchemes injected` in `wrangler tail`. Do NOT
   expect a specific call to be rate limited — see
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

## Password sign-in (`POST /login/password`)

The OAuth sign-in page offers Google **and** email + password. The password
path is a plain server-side form POST, so the password never passes through
the CDN-delivered Stytch SDK. Two more `ratelimits` bindings gate it, and
unlike the free-tier ones these are **fail-closed**:

| Binding | Kind | Purpose |
|---|---|---|
| `LOGIN_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per client IP: 8 / 60 s. Charged for **every** attempt, including ones with missing fields |
| `LOGIN_EMAIL_RATE_LIMITER` | `ratelimits` entry in `wrangler.jsonc` | per hashed email: 30 / 60 s. Deliberately looser, and charged only once the fields are present |

Two axes because neither covers the other: per-IP misses one account sprayed
from many hosts, per-email misses one host walking a list. Separate *bindings*
because a `ratelimits` limit is per-binding. The email axis is the one an
attacker can aim at a victim, so it is both looser and unreachable without a
real credential attempt — otherwise 8 empty POSTs a minute would lock a known
address out of password sign-in for free.

**Neither is a hard bound**, and the fail-closed decision does not pretend
otherwise. Per "Measured behaviour" above, the binding counts per colo and a
cold burst admits ~115 requests regardless of the configured limit. What these
buy is a dampener plus a `wrangler tail` signal (`[login] password sign-in
rate-limited`). **The real bound on guessing one password is Stytch's own
per-user lockout**, configured in the Stytch dashboard, not here — if you
change these numbers, check that policy too, because it is what actually stops
a determined attacker.

**Disabling password sign-in.** There is no no-redeploy kill switch (unlike
`FREE_TIER_API_KEY`). Remove both `ratelimits` entries and deploy:
`handleLoginPassword` then 503s and `/login` stops rendering the form
altogether (`hasLoginLimiters`), leaving Google as the only option. Removing
just one of the two is enough to trip it, and removing them without a deploy
does nothing. Google sign-in is unaffected either way — that separation is why
the limiter check lives in the password handler rather than in `readConfig`.

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
host starts out running against the shared free-tier account (2
runnable tools, shared quota) rather than prompting the user to sign in
for their own account. Users must explicitly connect/re-authenticate to
get off the anonymous tier. The ChatGPT app is the exception by
construction: it connects to `/mcp/chatgpt`, which serves no anonymous
tier at all, so its first request 401s and the Apps SDK runs OAuth —
claude.ai and similar hosts on `/mcp` still land silently on the
anonymous tier.
Consciously accept this onboarding asymmetry before setting
`FREE_TIER_API_KEY` in production.

## Partner OAuth clients (`OAUTH_PARTNER_REGISTRATION_TOKEN`)

Managed-OAuth catalogs — the Microsoft Foundry Tools Catalog, Azure API
Center — embed **one** `client_id` that means "this catalog" and use it for
every customer they onboard. A public DCR registration expires after
`REGISTRATION_TTL_S` (1 year), which is right for a consumer host that
re-registers on demand and wrong here: the expiry would break every customer
the partner onboarded, at once, a year after anyone last touched it.

`/register` therefore has a second, authenticated path that mints client_ids
with **no expiry**.

| Binding | Kind | Purpose |
|---|---|---|
| `OAUTH_PARTNER_REGISTRATION_TOKEN` | secret | Unlocks the partner path on `/register`, presented as the `X-Tako-Partner-Token` header (trimmed, so a piped `wrangler secret put` newline can't break it). Must be ≥ 32 chars after trimming; shorter is treated as *not configured* |

**Unset, the feature is inert** — `/register` serves only ordinary public
DCR and any request carrying the header is rejected. That is the correct
state for any environment with no partner onboarding in flight.

Notes for whoever is holding this during an incident:

- It is a **mint-time** credential only. Nothing in the authorization flow
  consults it, so rotating it revokes no already-issued client_id — it only
  stops new partner clients being minted.
- Revoking an issued partner client means rotating `OAUTH_SIGN_KEY`, which
  signs out every user and voids every refresh token. See the runbook.
- The partner path logs both outcomes to Workers Logs (never the value):
  `wrangler tail <worker> --search "[oauth] /register"`.

Full runbook — minting, redirect-URI handling, scopes, rotation:
[`docs/partner-oauth-clients.md`](../docs/partner-oauth-clients.md).
