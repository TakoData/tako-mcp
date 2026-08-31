# ChatGPT app review — compliance notes

Companion to [`chatgpt-app-submission.json`](../chatgpt-app-submission.json). That file
holds the machine-checked metadata (tool list, annotations, justifications — kept honest by
`assertChatgptSubmissionParity` in `workers/scripts/gen-registry.ts`). This file holds the
prose a reviewer asks for and the record of what was changed to satisfy each policy, so the
answers are the same next time somebody is asked.

Everything below was verified against **production**, not assumed. Where a claim has a test
behind it, the test is named.

## What the submission file does NOT carry

**The MCP URL lives only in OpenAI's portal.** `chatgpt-app-submission.json` follows
OpenAI's `chatgpt-app-submission.v1.json` schema, which has no URL field, and
`assertChatgptSubmissionParity` reads only its `tools` object. So nothing in this repo
records or checks which endpoint the app points at. Set it by hand at resubmission:

- **MCP URL:** `https://mcp.tako.com/mcp/chatgpt` (not `/mcp` — that is the generic
  surface, which serves the anonymous tier and no widget).
- **Auth:** OAuth only. The `noauth` scheme is gone from this surface; an anonymous
  request gets 401 + `WWW-Authenticate`.

`app_info.description` is unchecked too. Keep it to what the four submitted tools actually
do — it claimed "citation-backed answers" after `tako_answer` left the submitted set.

---

## 1. No commerce, no upsells in model-visible text

**Policy:** apps may not promote or sell digital services, subscriptions, tokens, or
credits. Existing paid-account functionality is fine; advertising it is not.

Four anonymous-tier messages used to end with "get an API key at
`https://tako.com/account/` …". Each is delivered as tool-result *text*, so each reached the
model and could be relayed to the user. All four are now pure capacity/retry statements
with no link, no pricing, and no mention of accounts or upgrades — for every client, on
every surface (`workers/src/freetier.ts`):

| Constant | Now reads |
| --- | --- |
| `FREE_TIER_LIMIT_MESSAGE` | Rate limit reached for anonymous access. Try again in a minute. |
| `FREE_TIER_GLOBAL_LIMIT_MESSAGE` | Anonymous access is at capacity right now. Try again shortly. |
| `FREE_TIER_BATCH_MESSAGE` | Batch requests are not supported for anonymous access. Send one JSON-RPC request per POST. |
| `FREE_TIER_CREDITS_MESSAGE` | Anonymous access is temporarily out of shared capacity. Try again later. |

Enforced by `freetier.test.ts` → "no user-facing message promotes an account, a purchase,
or an upgrade", which bans URLs and account/pricing/upgrade wording across every BASE
message the module can emit (`ALL_FREE_TIER_MESSAGES` — a new base message is covered by
adding one line there). One suffix is deliberately outside that ban, gated by SURFACE (the
request path) and never by the client's User-Agent:

- `FREE_TIER_COMMERCE_UPSELL` (`workers/src/freetier.ts`) — "Sign in with your client's
  MCP authentication for up to 2,000 free requests on a new account, or connect with a
  Tako API key (tako.com)." Appended to the two rate-limit messages and the
  shared-capacity message on the GENERIC surface (`/mcp`) only. The ChatGPT app surface
  (`/mcp/chatgpt`) never carries it — and never reaches those messages, because it serves
  no anonymous tier (anonymous requests 401 before admission). Enforced by
  `freetier.test.ts` → the "commerce-gated upsell" describe (default-off for every
  producer) and the `/mcp/chatgpt` 401 case in `index.test.ts`.

One more model-visible string lives OUTSIDE `freetier.ts` and is likewise gated by
SURFACE instead of banned outright (`workers/src/mcp.ts`):

- `PAYMENT_REQUIRED_MESSAGE` (+ remedy splice) — an AUTHENTICATED caller's own account out
  of credits (Django 402). Every client gets the factual cause-only message. The remedy
  sentence (spliced from Django's own 402 body — "Upgrade your plan…" / "Add credits…") is
  commerce copy, so it appears ONLY on the generic surface (`/mcp`): the ChatGPT app
  surface (`/mcp/chatgpt`) gets the cause-only text, keyed on the request PATH — no
  User-Agent classification is involved, so a reviewer or crawler cannot land on the
  wrong side of it. Enforced by `mcp.test.ts` → "omits ALL remedy copy when commerce
  copy is not allowed" and the `/mcp` vs `/mcp/chatgpt` 402 case in `freetier.test.ts`.

The `initialize` instructions carry no such string any more. There is no anonymous
variant: the `initialize` text is identical on every tier, because a host loads it once
and a mid-conversation sign-in does not reliably refresh it — see
`workers/src/instructions.ts`. A connection's anonymous state is stated only in the
dispatch-time `authRequiredToolResult`.

Paid functionality on the ChatGPT surface is untouched.

## 2. No internal identifiers in tool responses

**Policy:** request ids, trace ids, session ids and debug identifiers should not be
returned unless strictly necessary.

- `tako_search` / `tako_answer` no longer advertise `request_id` in `outputSchema` and no
  longer print it in the markdown footer (`workers/src/tools/_render_markdown.ts`).
  Dropping it from the advertised schema is what actually removes it from
  `structuredContent`, because `pickDeclared` in `mcp.ts` strips undeclared keys.
- `tako_visualize` no longer returns `card_id`. It carried the same string as `pub_id`,
  which the widget needs. On `/mcp/chatgpt` the caller gets that id once, plus `url`
  and `embed_url`. On `/mcp` no id is advertised at all: `pub_id` is a widget field,
  the widget is suppressed there, and `pickDeclared` strips it.
- The id is **not** lost operationally: `logToolRequestId` (`workers/src/tools/_log.ts`)
  records it server-side per call, which is where a support question is answered from.
  Runbook: `wrangler tail <worker> --search "request_id="`.
- Enforced surface-wide by `mcp.conformance.test.ts` → "publishes no server-side debug
  identifier", which reads the real `tools/list` output and rejects any
  `request_id` / `trace_id` / `correlation_id` / `session_id` / `debug_id`.

**Deliberately kept:** `run_id` and `thread_id` on the agent tools (opt-in, not on the
submitted surface). A caller cannot poll a run to completion without `run_id` or continue a
conversation without `thread_id` — these are the caller's control flow, not our debugging.

### This is a breaking wire change

`request_id` was a **required** declared field on the `tako_search` and `tako_answer`
`outputSchema`s, and `card_id` a declared field on `tako_visualize`. Removing them is
visible to any programmatic MCP client, and it fails **silently** rather than loudly: the
responses stay schema-valid, so a client reading `structuredContent.request_id` starts
seeing `undefined` instead of an error. Nothing warns it.

Released with a `BREAKING CHANGE:` footer so the version and the generated CHANGELOG carry
the signal. Pre-1.0 with `bump-minor-pre-major`, that is a **minor** bump, not a major one.

Migration for anyone who was reading these fields:

| Was | Now |
| --- | --- |
| `structuredContent.request_id` | no client-side equivalent — ids are server-side only, see the runbook above |
| `tako_visualize` → `card_id` | `pub_id` (it carried the identical string) |

A model-facing consumer needs no migration: neither field was ever referenced in tool
descriptions or instructions, and the markdown footer that printed `request_id` is gone
with it.

## 3. Public chart creation is stated plainly

`tako_visualize` is the one tool on the surface that writes, and what it writes is
world-readable. Its description now leads with the consequence rather than the mechanism
(`workers/src/tools/tako_visualize.ts`):

- the supplied data is sent to and stored by Tako;
- the card is persistent (it does not expire);
- anyone with the returned link can view it without signing in;
- the model is instructed to confirm the user wants a public chart first, and never to put
  passwords, API keys/tokens, payment-card or bank details, health information, government
  identifiers, precise home addresses, or third-party personal data into `components`.

This matches the annotations the tool already ships — `readOnlyHint: false` plus
`openWorldHint: true` for ChatGPT, which makes the call confirmation-worthy — and the
`tako_visualize` justifications in the submission file.

## 4. Iframe: why it is needed, and what is inside it

**Why an iframe at all.** The deliverable of a data query is an interactive chart, and the
interaction is the product: hover tooltips carrying the exact value and as-of date per
point, per-series legend toggling on multi-series comparisons, time-range and interval
switching, and drill-in on tabbed/table cards. A baked PNG can show the shape of a series
but cannot answer "what was Q3 2025 exactly?" without another round-trip to the model — and
the numbers, not the picture, are what Tako is for. The chart is also a live render of the
card, so it reflects the current vintage of a revised series rather than a snapshot.

**Scope of the frame.** `frameDomains` is exactly one origin — the public Tako web origin
(`https://tako.com` in production), the same origin the tool writes into `embed_url`, so
the declaration and the URL cannot drift. No wildcards, no third-party frames, one path
(`/embed/{pub_id}/`).

**What the framed page contains** (measured on production, `pub_id`
`VKd7qE8K9Ba16kMFENNQ`, 2026-08-04; re-measured 2026-08-13 with `showShare=true`): the
chart, its title, source attribution, and — since the share opt-in — a share control in the
card's action cluster, opening a dialog of copyable Tako URLs for this same card (copy
fields, not navigation; the control mounts client-side and is Tako PR #28735's opt-in
surface). Three external origins are referenced — Tako's own asset CDN
(`d12w4pyrrczi5e.cloudfront.net`, 16 refs: `Card.js`, its chunks, fonts, card images),
`www.spglobal.com` (4 refs, all inside the card's own JSON island as the
`source_details.url` for an S&P-sourced series), and — before this change —
`www.googletagmanager.com`. There are **no advertisements, no checkout, no signup, no
sign-in, and no upgrade UI**: the served markup contains zero `<a>` elements (re-verified
with `showShare=true`, 2026-08-13), and no occurrence of "sign up", "log in", "upgrade",
"pricing", "subscribe" or "checkout".

**Analytics removed.** Every iframe load the widget performs now carries
`disable_tracking=true` (`withoutTracking` in `workers/src/tools/_chart_widget.ts`). On
Tako's embed route that flag suppresses the Google Tag Manager bootstrap and excludes the
load from Tako's own impression counters. Verified live: the same page fetched with the flag
references only the Tako CDN and the S&P attribution links, and contains zero
`googletagmanager` references. Asserted by `test/widget/chatgpt-path.test.ts`
(`renderedIframe`) and `test/widget/widget-dom.test.ts` (`EMBED_IFRAME_SRC`).

The shareable `embed_url` in `structuredContent` carries `showShare=true` (the card share
opt-in) but no tracking flag — a link a person clicks in their own browser is an ordinary
tako.com visit, now with the share control visible. `disable_tracking` applies only to
loads the widget itself performs.

**The nested-frame fallback exists.** On hosts whose CSP blocks the frame, the widget
renders the baked PNG instead (with the embed page as a click-through), so no host is left
without a chart. That path is the default everywhere except ChatGPT.

## 5. Still open — not code

Two items from review are not addressable in this repository and are tracked elsewhere:

- **Privacy policy.** `tako.com`'s policy (`app/frontend/src/pages/privacy-policy/` in the
  Tako web repo) does not state retention periods, and does not cover the plugin-specific
  categories: OAuth account identifiers, search/answer queries, IP and rate-limit data,
  public chart data and its retention, Stytch and Cloudflare as processors, or how a user
  deletes a chart and revokes the connection. It also needs to reconcile the site's
  zero-data-retention claim with `tako_visualize`, which creates persistent public charts
  on purpose.
- **Age policy.** OpenAI requires suitability for ages 13–17; Tako's terms require 18+ and
  the privacy policy states the service is not intended for anyone under 18. Needs counsel
  before attesting.
