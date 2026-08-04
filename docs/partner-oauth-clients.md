# Partner OAuth clients (managed OAuth)

Catalogs like the **Microsoft Foundry Tools Catalog** and **Azure API Center**
offer "managed OAuth": rather than making every customer register their own
OAuth app with us, the catalog embeds **one** `client_id` that means "this
catalog", and uses it for everyone it onboards.

Ordinary Dynamic Client Registration is wrong for that. A public `/register`
call returns a `client_id` that expires after `REGISTRATION_TTL_S` (1 year).
A consumer host re-registers on demand and never notices; a catalog partner
has the value pasted into their own configuration, so the expiry would break
every customer they onboarded, all at once, a year after anyone last touched
it.

Partner registrations therefore carry **no `exp`**.

## Minting a partner client

One-time per environment, set the mint-time secret. **Capture the value
first** — piping `openssl` straight into `wrangler` sets the secret but
leaves your shell without it, and the mint command below would then send an
empty header, which curl treats as header *removal*: the request arrives
with no partner header at all and you silently receive an ordinary 1-year
public client.

```bash
TOKEN=$(openssl rand -base64 32)
printf %s "$TOKEN" | npx wrangler secret put OAUTH_PARTNER_REGISTRATION_TOKEN --env production
```

`printf %s` rather than `echo` avoids storing a trailing newline. The worker
trims the value anyway (`partnerSecret` in `handlers.ts`, same defense
`freetier.ts` applies to `FREE_TIER_API_KEY`), so a stray newline is
survivable — but storing the exact bytes keeps the secret comparable to
what you pasted. The value must be at least 32 characters after trimming;
anything shorter is treated as *not configured* and the partner path stays
closed.

Then mint, passing **every** redirect URI the partner will ever use:

```bash
curl -sX POST https://mcp.tako.com/register \
  -H 'content-type: application/json' \
  -H "x-tako-partner-token: $TOKEN" \
  -d '{
        "client_name": "Microsoft Foundry",
        "redirect_uris": [
          "https://<partner-callback-1>",
          "https://<partner-callback-2>"
        ]
      }'
```

The response's `client_id` is what you send the partner.

**Check `"client_id_expires_at": 0` before sending it.** That field is a
Tako convention, not a spec field — RFC 7591 §3.2.1 defines
`client_secret_expires_at`, not this — and `0` is how you know the partner
path actually engaged rather than silently falling back to public DCR. A
non-zero value means you have a 1-year client and something went wrong:
wrong `--env`, mistyped secret, or a secret below the 32-character floor.
`wrangler tail` will have logged which, on the `[oauth] /register` lines.

## Adding a redirect URI later means a new client_id

`client_id` is a self-contained signed JWT with the redirect URIs inside it;
there is no server-side record to amend. `/authorize` requires the presented
`redirect_uri` to appear in the list baked into the `client_id`, matched by
exact string equality — no prefix or wildcard matching.

So adding a URI = minting a **new** `client_id`, which the partner must then
swap into their configuration. Ask for the complete list up front, including
any staging or per-region callbacks, and note that the old `client_id` keeps
working until `OAUTH_SIGN_KEY` is rotated — there is no way to revoke just
one.

## Scopes

Give partners `mcp offline_access`.

`mcp` is the only scope that grants anything — it is what `/mcp` enforces.
`offline_access` grants nothing extra (we always issue refresh tokens) but is
accepted because Azure AI Foundry's setup guidance tells operators to include
it, and its troubleshooting guide names a missing `offline_access` as the fix
for sessions that expire. Rejecting it as "unsupported" broke the flow at
configuration time, before anyone reached a tool call.

`offline_access` on its own is rejected at `/authorize`: it would mint a token
that `/mcp` later refuses with `insufficient_scope`, surfacing the mistake at a
place that cannot explain it.

## Operational cautions

- **`OAUTH_SIGN_KEY` rotation is the only revocation mechanism, and it is
  far more destructive than "partners re-register".** One key signs every
  JWT the OAuth subsystem mints: auth codes, access tokens, refresh tokens,
  DCR client_ids, and the state and session cookies. Rotating it therefore
  signs out every logged-in user, voids every live 14-day refresh token, and
  drops every registration — public and partner — simultaneously. Every
  client re-authenticates from scratch, with a browser sign-in for each
  human. Treat it as a break-glass action, size it accordingly during an
  incident, and tell partners before doing it.
- **Rotating `OAUTH_PARTNER_REGISTRATION_TOKEN` revokes nothing.** It is
  consulted only at mint time; already-issued partner clients are unaffected.
  Rotate it freely if it leaks — the worst an attacker can do with it is mint
  a non-expiring client bound to redirect URIs they control, which grants no
  access to anyone's data on its own but should still be cleaned up by
  rotating the sign key.
- **Access tokens live 15 minutes** (`ACCESS_TOKEN_TTL_S`); refresh tokens
  live 14 days and rotate on every use. A partner whose platform does not
  refresh correctly will see agents start failing with 401 about 15 minutes
  into a session. Confirm refresh support during onboarding rather than after
  the first incident.
- Partner clients appear on the consent screen under their `client_name`,
  so use the partner's real product name — that string is what users read
  when deciding whether to approve access.
