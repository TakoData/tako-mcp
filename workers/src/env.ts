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
   * Optional public-facing **web** origin — used for `/embed/{pub_id}/`
   * URLs handed to the user's browser (see `open_chart_ui`). Falls back
   * to `DJANGO_BASE_URL` when unset. Matches Python `PUBLIC_BASE_URL`
   * (default `https://tako.com`, `src/tako_mcp/server.py:37`). Binding
   * is not yet wired in `wrangler.jsonc` for staging/production, so
   * stays optional for now. Must NOT include a trailing slash.
   */
  PUBLIC_BASE_URL?: string;
  /**
   * Optional public-facing **API** origin — used for `/api/v1/image/...`
   * PNG URLs handed to the user's browser (see `get_chart_image`).
   * Falls back to `DJANGO_BASE_URL` when unset. Kept distinct from
   * `PUBLIC_BASE_URL` because API and web origins can diverge in prod
   * (`api.tako.com` vs `tako.com`). Matches Python `PUBLIC_API_URL`
   * (default `TAKO_API_URL`, `src/tako_mcp/server.py:40`). Must NOT
   * include a trailing slash.
   */
  PUBLIC_API_URL?: string;
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
 * Resolve the public **web** origin for `/embed/` URLs (see
 * `open_chart_ui`). Prefers `PUBLIC_BASE_URL` when set, falls back to
 * `DJANGO_BASE_URL`. See `validatePublicOrigin` for invariants.
 */
export function resolvePublicBase(env: Env): string {
  return validatePublicOrigin(
    env.PUBLIC_BASE_URL ?? env.DJANGO_BASE_URL,
    "PUBLIC_BASE_URL",
  );
}

/**
 * Resolve the public **API** origin for `/api/v1/image/` URLs (see
 * `get_chart_image`). Prefers `PUBLIC_API_URL` when set, falls back to
 * `DJANGO_BASE_URL`. Kept distinct from `resolvePublicBase` because the
 * API and web origins can diverge in production (`api.tako.com` vs
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
