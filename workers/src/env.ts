/**
 * Environment bindings shared across the Worker.
 *
 * Populated from `vars` (and secrets, eventually) in `wrangler.jsonc`.
 * Keep this interface single-purpose so individual modules (`auth.ts`,
 * `django.ts`, `index.ts`, `mcp.ts`) can import it without creating
 * circular dependencies.
 */
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
function validatePublicOrigin(raw: string | undefined, label: string): string {
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
