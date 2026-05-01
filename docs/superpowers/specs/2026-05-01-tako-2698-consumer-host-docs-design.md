# TAKO-2698 — Consumer host (Claude.ai / ChatGPT) connector docs

**Status:** Approved design, ready for implementation plan
**Date:** 2026-05-01
**Linear:** [TAKO-2698](https://linear.app/trytako/issue/TAKO-2698)
**Depends on:** [TAKO-2679](https://linear.app/trytako/issue/TAKO-2679) (OAuth shim — merged 2026-04-28, live at `mcp.tako.com`)

## Goal

Document the end-to-end "add Tako as a connector" flow for the two OAuth-only consumer hosts that the existing README does not cover: **Claude.ai** and **ChatGPT**. Today's README covers Bearer-token install for Claude Code / Claude Desktop / Cursor / Windsurf only.

## Non-goals

- No code changes. The OAuth surface (`/authorize`, `/token`, `/register`, login + consent pages) shipped in TAKO-2679.
- No `docs.tako.com` work. All docs live inline in the repo's root `README.md`.
- No screenshots in this PR — placeholder callouts only; whoever has Pro accounts captures them later.
- No marketing copy or directory-submission work (separate ticket).
- No internal operator runbook (separate ticket).

## Where it goes in `README.md`

A new top-level section **`## Consumer hosts (OAuth)`**, positioned between the existing **`## Hosted (Cloudflare Workers)`** (line 27) and **`## Self-hosting (legacy Python server)`** (line 95). The existing Bearer-flow content (Claude Code / Claude Desktop / Cursor / Windsurf) is **not** modified.

Six subsections, in this order:

1. Prerequisites
2. What you'll see during connect
3. Claude.ai
4. ChatGPT
5. Verify it's working
6. Disconnecting & re-authorizing

## Tone, voice, conventions

- Match the existing README — direct, technical, no marketing voice. No emoji.
- Step-numbered when the user is following along in a host UI; explanatory prose between.
- Each per-host walkthrough opens with a single-line tier callout in italics, e.g. *Requires Claude.ai Pro, Max, Team, or Enterprise.* Users on the wrong tier bounce out fast.
- The Tako endpoint URL is `https://mcp.tako.com/mcp` for both hosts.

### Screenshot placeholder convention

Placeholders are blockquotes in this exact form:

```markdown
> _[Screenshot: Claude.ai → Settings → Connectors, "Add custom connector" highlighted]_
```

Visually distinct from prose, easy to grep for (`grep '\[Screenshot:'`), and self-describing so whoever captures the image later doesn't need to ask. Total: ~5–7 placeholders (consent flow: 2, Claude.ai: 2–3, ChatGPT: 3 incl. Developer Mode toggle).

## Subsection contents

### Prerequisites

A two-step ordered list:

1. Sign up / sign in at [trytako.com](https://trytako.com).
2. Mint an API token at trytako.com → settings → API tokens.

Followed by one paragraph explaining *why* step 2 is mandatory: the consent flow looks up your existing token and surfaces a "no token" error if it doesn't find one. This is intentional — Tako does not auto-mint tokens for OAuth-connecting users (rotating an existing one would break Claude Code / Cursor wiring on the same account).

One screenshot placeholder for the API tokens settings page.

Approximate length: ~12 lines.

### What you'll see during connect

Shared three-step narration of the Worker-hosted flow, common to both hosts:

1. The host opens a Tako sign-in page hosted at `mcp.tako.com`. Two options: **Continue with Google** or **email magic-link**.
2. After sign-in, a Tako consent page: *"Connect [host name] to Tako — Signed in as you@example.com — Allow / Cancel"*.
3. Clicking Allow bounces you back into the host. The connector is now live and tools are callable.

Note that the host (Claude.ai / ChatGPT) may also display its own consent prompt before or after Tako's. Calling this out up front prevents the double-prompt confusion users will otherwise hit.

Two screenshot placeholders: Tako sign-in page, Tako consent page.

Approximate length: ~18 lines.

### Claude.ai

Tier callout: *Requires Claude.ai Pro, Max, Team, or Enterprise.*

Numbered steps:

1. Open Claude.ai → Settings → Connectors.
2. Click **Add custom connector**.
3. Paste `https://mcp.tako.com/mcp` and click Connect.
4. You'll be taken through the Tako sign-in flow described above.
5. After consent, the connector appears in your list as **Tako**, connected.

Two to three screenshot placeholders for host-side clicks only (Settings → Connectors landing, Add-custom-connector dialog, connected state). Tako-side consent placeholders are *not* repeated here — they live in "What you'll see during connect."

Approximate length: ~15 lines.

### ChatGPT

Tier callout: *Requires ChatGPT Pro, Business, or Enterprise. Developer Mode must be enabled.*

Numbered steps:

1. Open ChatGPT → Settings → Connectors → Developer Mode (toggle on if not already).
2. Click **Create custom connector**.
3. Paste `https://mcp.tako.com/mcp` and click Connect.
4. You'll be taken through the Tako sign-in flow described above.
5. After consent, the connector is listed and ready.

Three screenshot placeholders for host-side UI (Developer Mode toggle, Create custom dialog, connected state).

Approximate length: ~18 lines.

### Verify it's working

A single sample prompt that exercises the simplest tool (`knowledge_search`):

> Show me Tako's chart on Intel vs Nvidia headcount.

Followed by one short sentence describing what a successful response looks like (chart link or inline render in the model's reply, depending on host).

Approximate length: ~6 lines.

### Disconnecting & re-authorizing

Two paths, both honestly described:

**Per-host disconnect.** Removing the Tako connector inside Claude.ai or ChatGPT settings stops *that host* from making MCP calls. It does **not** revoke the underlying Tako API token, and other connected hosts (or Claude Code / Cursor on Bearer) keep working unchanged.

**Rotating the API token at trytako.com.** This is the hard kill switch. Rotating creates a new token and invalidates the old one Django-side. Every previously-issued OAuth grant — across every host — stops authenticating immediately. To resume from any host, disconnect and reconnect; the new consent flow picks up your fresh token.

A short closing note: this kill-switch behavior is the v1 design. Per-grant scoped tokens that would let you revoke a single host without affecting others are tracked under TAKO-2679's known limitations.

Approximate length: ~14 lines.

## Error states documented vs. omitted

**Explicitly documented:**

- *No API token yet* (in Prerequisites): the user-facing "Your Tako account does not have an API token yet…" page they'll see if they skip step 2.
- *Token rotation kills all OAuth-connected hosts* (in Disconnecting): intentional, not a bug.

**Deliberately omitted** (transient, recoverable, shouldn't appear steady-state, surface only if support load demands it):

- Expired Stytch session.
- Tako-side transport errors.
- OAuth refresh-token expiry (the host re-runs the flow automatically).

## Verification before merge

Before merging the PR:

1. Run the connect flow once against staging (`https://mcp.staging.tako.com/mcp` — same OAuth surface as prod) from a real Claude.ai or ChatGPT account, if available.
2. Confirm each numbered step in the doc matches what actually happens in the host UI today.
3. Confirm each screenshot placeholder describes a real, capturable moment in the flow.
4. Run the sample prompt; confirm a successful response.

If a Pro account on either host isn't reachable: ship with the staging test plus a PR-description note flagging which host walkthroughs were not live-verified, so the screenshot-capture pass can double as the verification step for those.

## Out-of-scope follow-ups

- Capturing real screenshots and replacing the `[Screenshot: …]` placeholders.
- Submitting Tako to Claude / ChatGPT public connector directories.
- Per-grant scoped tokens (Django-side work tracked in TAKO-2679 limitations).
- Mirroring the same content to `docs.tako.com` if the docs team prefers that long-term.
