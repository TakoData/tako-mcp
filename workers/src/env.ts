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
