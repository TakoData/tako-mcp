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

One-time per environment, set the mint-time secret:

```bash
openssl rand -base64 32 | npx wrangler secret put OAUTH_PARTNER_REGISTRATION_TOKEN --env production
```

Then mint, passing **every** redirect URI the partner will ever use:

```bash
curl -sX POST https://mcp.tako.com/register \
  -H 'content-type: application/json' \
  -H "x-tako-partner-token: $OAUTH_PARTNER_REGISTRATION_TOKEN" \
  -d '{
        "client_name": "Microsoft Foundry",
        "redirect_uris": [
          "https://<partner-callback-1>",
          "https://<partner-callback-2>"
        ]
      }'
```

The response's `client_id` is what you send the partner. Confirm
`"client_id_expires_at": 0` — that is the "never expires" signal from
RFC 7591 §3.2.1, and it is how you know the partner path actually engaged
rather than silently falling back to public DCR.

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

## Operational cautions

- **`OAUTH_SIGN_KEY` rotation is the only revocation mechanism**, and it
  invalidates every public registration too. Treat it as a break-glass action
  and tell partners before doing it.
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
