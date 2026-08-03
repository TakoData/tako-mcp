/**
 * Environment bindings shared across the Worker.
 *
 * Populated from `vars` (and secrets, eventually) in `wrangler.jsonc`.
 * Keep this interface single-purpose so individual modules (`auth.ts`,
 * `django.ts`, `index.ts`, `mcp.ts`) can import it without creating
 * circular dependencies.
 */

/**
 * Structural type of Cloudflare's Workers rate-limiting binding
 * (`ratelimits` entries in `wrangler.jsonc` — NOT `unsafe.bindings`, which
 * produces a binding that satisfies this interface but never counts).
 * Declared locally instead of relying on `@cloudflare/workers-types` so the
 * shape is pinned to exactly what we call and tests can supply fakes.
 * `limit()` counts one hit against `key`'s bucket and reports whether the
 * request is within the configured limit. Counting is per-colo and
 * approximate — acceptable for free-tier abuse protection, not billing.
 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /**
   * Origin of the Django backend the Worker proxies to — e.g.
   * `https://trytako.com`. The path (starting with `/api/v1/...`) is
   * appended by the Django HTTP helper, so this value must NOT include
   * a trailing slash.
   */
  DJANGO_BASE_URL: string;
  /**
   * Optional public-facing **web** origin — used for chart embed URLs
   * handed to the user's browser (`/embed/{pub_id}/`). Falls back
   * to `DJANGO_BASE_URL` when unset. Default value is `https://tako.com`.
   * Must NOT include a trailing slash.
   */
  PUBLIC_BASE_URL?: string;
  /**
   * Optional public-facing **API** origin — used for chart PNG image
   * URLs handed to the user's browser (`/api/v1/image/...`).
   * Falls back to `DJANGO_BASE_URL` when unset. Kept distinct from
   * `PUBLIC_BASE_URL` because API and web origins can diverge in prod
   * (`api.tako.com` vs `tako.com`). Must NOT include a trailing slash.
   */
  PUBLIC_API_URL?: string;
  /**
   * Optional origin of the CDN that serves Tako's web front-end assets —
   * e.g. `https://d12w4pyrrczi5e.cloudfront.net`. Must NOT include a
   * trailing slash.
   *
   * EXPERIMENT SWITCH, and unset everywhere by default. Setting it turns on the
   * NATIVE CARD path — Claude rendering Tako's own `Card.js` instead of a PNG
   * of it — which is materially more than a declared CSP entry. Specifically:
   *
   *   1. Two public HTTP routes come into existence, `/embed-html/{pub_id}` and
   *      `/cdn-asset/{path}` (`embed_proxy.ts`). Unset, both decline and the
   *      router 404s them, so neither exists.
   *   2. `_meta.native_card_url` is added to chart tool results, which is what
   *      arms the widget's upgrade.
   *   3. The widget declares OUR origin — not this one — in
   *      `_meta.ui.csp.connectDomains` and `resourceDomains`, because the
   *      assets are served through `/cdn-asset/` rather than from the CDN.
   *
   * Why the assets are proxied rather than loaded from here: this CDN reflects
   * `access-control-allow-origin` for `tako.com` alone, and a `type="module"`
   * script is always fetched in CORS mode, so every asset load inside a widget
   * sandbox failed even where CSP permitted the origin. Serving them from our
   * own origin removes the upstream dependency — which is also why declaring
   * the CDN in `resourceDomains` would now be dead weight.
   *
   * The value must name the distribution the EMBED PAGE OF THAT ENVIRONMENT
   * references; staging and production use different ones, and a mismatch is
   * silent (zero URLs get rewritten, the card mounts, no chart draws). The
   * proxy logs loudly when it rewrites nothing, for exactly that reason.
   *
   * A malformed value (trailing slash, unparseable, non-http scheme) disables
   * the experiment rather than throwing — see `resolveProxyOrigins` in
   * `embed_proxy.ts`, and note those handlers run ahead of the whole OAuth
   * surface.
   *
   * Leave unset in production. Set it on staging to run the experiment.
   */
  PUBLIC_CDN_URL?: string;
  /**
   * Optional public origin clients should use to reach THIS worker — e.g.
   * `https://mcp.tako.com`. Must NOT include a trailing slash.
   *
   * Normally unnecessary: the request origin is derived from `request.url`,
   * which is correct on a real Cloudflare deploy. It exists because that
   * derivation is wrong whenever something sits in front of the worker and
   * terminates TLS or rewrites the Host — a tunnel (ngrok/cloudflared) or
   * `wrangler dev`, both of which yield `http://` and/or a host the outside
   * world cannot reach. A widget that fetches an `http://` URL from an
   * `https://` page is blocked as mixed content, and an unreachable host just
   * fails, so the derived value has to be overridable.
   *
   * Scope is deliberately narrow: this is used ONLY for widget payload URLs
   * (the native-card proxy URL and the `connectDomains` entry that permits
   * fetching it). OAuth `resource_metadata` URLs keep tracking the real
   * request origin, because those must match the `WWW-Authenticate` header the
   * same request emits.
   */
  PUBLIC_MCP_URL?: string;
  /**
   * HMAC-SHA256 signing secret for every JWT the OAuth subsystem mints
   * (auth codes, refresh tokens, access tokens, DCR client_ids, state /
   * session cookies). Optional: when unset, `/authorize`, `/token`,
   * `/register`, `/login`, and `/oauth/stytch_callback` all return 503
   * and the Worker still serves the existing static-Bearer Claude Code
   * path on `/mcp`. Set per-env via `wrangler secret put OAUTH_SIGN_KEY`.
   */
  OAUTH_SIGN_KEY?: string;
  /**
   * Base64-encoded 32-byte key (AES-256) used to encrypt the per-user
   * Tako API token before embedding it in OAuth access / refresh /
   * auth-code claims. Held separately from `OAUTH_SIGN_KEY` so the
   * signing key can be hot-rotated without exposing previously-issued
   * encrypted token claims to a leaked signing key. Optional in the
   * same sense as `OAUTH_SIGN_KEY`. Set via
   * `openssl rand -base64 32 | wrangler secret put OAUTH_ENC_KEY`.
   */
  OAUTH_ENC_KEY?: string;
  /**
   * Stytch project ID (e.g. `project-test-…` or `project-live-…`).
   * Used as the username half of the HTTP Basic credential when the
   * Worker calls Stytch's authenticate APIs server-to-server. Distinct
   * from `STYTCH_PUBLIC_TOKEN` which the browser-side login page uses.
   */
  STYTCH_PROJECT_ID?: string;
  /**
   * Stytch project secret. Pairs with `STYTCH_PROJECT_ID` for HTTP Basic
   * auth on Stytch's API. Treated as a Worker secret.
   */
  STYTCH_SECRET?: string;
  /**
   * Stytch public token. Embedded in the `/login` HTML page so the
   * browser-side Stytch SDK can drive Google / magic-link auth. Safe to
   * expose; it cannot, by itself, authenticate users — Stytch only
   * issues real sessions via redirects back to URLs registered against
   * the project ID.
   */
  STYTCH_PUBLIC_TOKEN?: string;
  /**
   * Base URL of the Stytch API for this project.
   * - Test projects: `https://test.stytch.com`
   * - Live projects: `https://api.stytch.com`
   *
   * Held as a binding (not derived from the project ID) so we can
   * point at a sandbox without juggling project IDs. Must NOT include
   * a trailing slash.
   */
  STYTCH_BASE_URL?: string;
  /**
   * OpenAI connector-directory domain-verification token. OpenAI
   * GETs `/.well-known/openai-apps-challenge` on the registered MCP
   * hostname during submission and expects this exact string back as
   * the response body. Set per-env in `wrangler.jsonc` `vars` (not a
   * secret — the value is meant to be served on a public URL).
   * When unset, the well-known route returns 404 so non-production
   * environments don't accidentally satisfy a verification challenge
   * for a connector that was never registered against them.
   */
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  /**
   * Tako API key of the dedicated free-tier account, forwarded to Django
   * as `X-API-Key` for anonymous (no `Authorization` header) `/mcp`
   * requests. A Worker secret (`wrangler secret put FREE_TIER_API_KEY
   * --env <env>`). Optional and fail-closed: when unset (or when
   * `FREE_TIER_RATE_LIMITER` is unbound), anonymous requests get the
   * same 401 as before the free tier existed. See `freetier.ts`.
   */
  FREE_TIER_API_KEY?: string;
  /**
   * Cloudflare rate-limit binding metering anonymous free-tier usage,
   * keyed per client IP. Declared under `ratelimits` in `wrangler.jsonc`
   * (10 requests / 60 s). Optional in the same fail-closed sense as
   * `FREE_TIER_API_KEY`.
   */
  FREE_TIER_RATE_LIMITER?: RateLimit;
  /**
   * Cloudflare rate-limit binding hit with one constant key for every
   * anonymous request regardless of method. PER-COLO burst shaping, not
   * a true global ceiling — the binding counts per colo with no global
   * mode, so the enforced number is `limit × colos reached`; the genuine
   * platform-wide bound is Django's per-user throttling on the free-tier
   * account (see `freetier.ts` module header). Declared under `ratelimits`
   * in `wrangler.jsonc` (120 requests / 60 s / colo). Optional in the same
   * fail-closed sense as the other two free-tier bindings — all three must
   * be present for the free tier to activate.
   */
  FREE_TIER_GLOBAL_RATE_LIMITER?: RateLimit;
  /**
   * DEV ONLY. Suffix appended to the widget's resource URI (see
   * `appUiResourceUri`). Hosts cache the widget BY URI and claude.ai's cache
   * outlives removing and re-adding the connector, so during local development
   * every widget change is otherwise invisible — you end up debugging a bundle
   * that is not running. Set it to a timestamp to force a re-read.
   *
   * MUST stay unset in staging and production: the shipped URI is effectively
   * permanent (Claude desktop caches it beyond connector lifecycle, so renaming
   * it 404s previously-installed sessions).
   */
  WIDGET_URI_SUFFIX?: string;
}

/**
 * Resolve a public-facing origin and validate it against the same
 * invariants `django.ts::buildUrl` enforces for the Django origin:
 *
 * - Non-empty.
 * - Scheme is `http:` or `https:` (rejects `javascript:`, `data:` etc.).
 * - No trailing slash (so concatenation `${base}/path` produces exactly
 *   one separator).
 *
 * Fails loudly on config error — the returned value flows back to the
 * end-user's browser, so silent fallback on bad input would be a
 * security boundary.
 */
export function validatePublicOrigin(raw: string | undefined, label: string): string {
  if (raw === undefined || raw === "") {
    throw new Error(
      `Neither ${label} nor DJANGO_BASE_URL is configured (empty or undefined binding)`,
    );
  }
  if (raw.endsWith("/")) {
    throw new Error(
      `public base URL must not end with a trailing slash (got \`${raw}\`)`,
    );
  }
  // Validate scheme by parsing as a URL. `new URL(...)` throws on
  // unparseable input, and we further require http/https so a pasted
  // `javascript:` or `data:` URL can never reach an `<iframe src="...">`.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`public base URL is not a valid URL (got \`${raw}\`)`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `public base URL must use http or https (got \`${parsed.protocol}\`)`,
    );
  }
  return raw;
}

/**
 * Resolve the public **web** origin for chart embed URLs
 * (`/embed/{pub_id}/`). Prefers `PUBLIC_BASE_URL` when set, falls back
 * to `DJANGO_BASE_URL`. See `validatePublicOrigin` for invariants.
 */
export function resolvePublicBase(env: Env): string {
  return validatePublicOrigin(
    env.PUBLIC_BASE_URL ?? env.DJANGO_BASE_URL,
    "PUBLIC_BASE_URL",
  );
}

/**
 * Resolve the public **API** origin for chart PNG image URLs
 * (`/api/v1/image/...`). Prefers `PUBLIC_API_URL` when set, falls back
 * to `DJANGO_BASE_URL`. Kept distinct from `resolvePublicBase` because
 * the API and web origins can diverge in production (`api.tako.com` vs
 * `tako.com`) — collapsing them would produce image URLs on the wrong
 * host once `PUBLIC_BASE_URL` is wired. See `validatePublicOrigin` for
 * invariants.
 */
export function resolvePublicApiBase(env: Env): string {
  return validatePublicOrigin(
    env.PUBLIC_API_URL ?? env.DJANGO_BASE_URL,
    "PUBLIC_API_URL",
  );
}

/**
 * The front-end asset CDN origin, or `undefined` when unconfigured.
 *
 * Unlike the web/API resolvers this does NOT fall back to `DJANGO_BASE_URL`:
 * absence is meaningful (the experiment is off), and defaulting it would
 * silently widen the widget's declared `resourceDomains` in production. Still
 * validated as http(s) + trailing-slash-clean when present, since the value
 * ends up in a CSP directive.
 */
export function resolvePublicCdnBase(env: Env): string | undefined {
  if (env.PUBLIC_CDN_URL === undefined || env.PUBLIC_CDN_URL === "") {
    return undefined;
  }
  return validatePublicOrigin(env.PUBLIC_CDN_URL, "PUBLIC_CDN_URL");
}

/**
 * The origin the WIDGET should use to reach this worker.
 *
 * Order: the explicit `PUBLIC_MCP_URL` binding, else the request origin with
 * its scheme forced to https for any non-local host.
 *
 * The https coercion is not cosmetic. `request.url` reports `http://` whenever
 * TLS is terminated upstream (`wrangler dev`, ngrok, cloudflared), and this
 * value goes into two places that both hard-fail on it: a `connectDomains` CSP
 * entry, and a URL the widget fetches from an https document — mixed content,
 * blocked before the request leaves. Localhost is exempt because http is the
 * only thing that works there.
 *
 * Returns `undefined` when neither source is usable, and every caller treats
 * that as "no native card", so a bad value degrades to today's PNG.
 */
export function resolveWidgetOrigin(
  env: Env,
  requestOrigin: string | undefined,
): string | undefined {
  if (env.PUBLIC_MCP_URL !== undefined && env.PUBLIC_MCP_URL !== "") {
    return validatePublicOrigin(env.PUBLIC_MCP_URL, "PUBLIC_MCP_URL");
  }
  if (requestOrigin === undefined || requestOrigin === "") return undefined;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return undefined;
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLocal) url.protocol = "https:";
  return url.origin;
}
