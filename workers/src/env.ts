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
   * Optional public-facing origin for URLs we hand back to LLM / user
   * (chart image URLs, interactive embed iframes). Falls back to
   * `DJANGO_BASE_URL` when unset. Python reference uses a separate
   * `PUBLIC_API_URL` / `PUBLIC_BASE_URL` pair (see
   * `src/tako_mcp/server.py:36-40`); binding is not yet wired in
   * `wrangler.jsonc` for staging/production, so stays optional for now.
   * Must NOT include a trailing slash.
   */
  PUBLIC_BASE_URL?: string;
}

/**
 * Resolve the origin used for user-visible URLs (chart image URLs, embed
 * iframe `src` values). Prefers `PUBLIC_BASE_URL` when set, falls back to
 * `DJANGO_BASE_URL`. Validates the chosen value against the same
 * invariants `django.ts::buildUrl` enforces for the Django origin:
 *
 * - Non-empty.
 * - Scheme is `http:` or `https:` (rejects `javascript:`, `data:` etc.).
 * - No trailing slash (so concatenation `${base}/path` produces exactly
 *   one separator).
 *
 * Fails loudly on config error — these URLs flow back to the end-user's
 * browser, so silent fallback on bad input would be a security boundary.
 */
export function resolvePublicBase(env: Env): string {
  const raw = env.PUBLIC_BASE_URL ?? env.DJANGO_BASE_URL;
  if (raw === undefined || raw === "") {
    throw new Error(
      "Neither PUBLIC_BASE_URL nor DJANGO_BASE_URL is configured (empty or undefined binding)",
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
