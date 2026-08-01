/**
 * CORS-readable proxy for Tako's chart embed page, so the MCP Apps widget can
 * render Tako's REAL card instead of a screenshot of it.
 *
 * Why a proxy at all. The widget runs in a sandboxed iframe and wants the embed
 * page's markup. It cannot fetch `tako.com/embed/{pub_id}` directly: that route
 * sends no `Access-Control-Allow-Origin` (measured 2026-07-31 — only
 * `vary: Cookie, Accept-Language, origin`), so a cross-origin read is blocked
 * before CSP even matters. We own this worker, so it can do the read
 * server-to-server (no CORS applies) and hand the result back with a header the
 * widget can use. The widget then declares only THIS origin in
 * `connectDomains`, never tako.com.
 *
 * Why the widget can use the markup at all — the three facts that make this
 * work, all measured against production rather than assumed:
 *
 *   1. The embed page carries its own data. An ~87 KB inline JSON island holds
 *      the full card config (`config_type`, `params`, `dataset`, `components`),
 *      and a second ~1.5 KB island holds the theme (series colors, Geist fonts,
 *      tooltip, padding). Zero `fetch`/XHR/axios in the page. So there is no
 *      API to call and no credential to hold.
 *   2. `Card.js` loads cross-origin from the asset CDN with CORS present, and
 *      its lazily imported chunks resolve against the CDN, not against our
 *      document — so nothing needs bundling or rewriting.
 *   3. claude.ai honors declared `resourceDomains` for `script-src`. Confirmed
 *      2026-08-01 with a control in the same document: an undeclared origin
 *      (fonts.googleapis.com) was blocked with a reported CSP violation while
 *      the declared CDN origin was permitted.
 *
 * Two things are stripped on the way through, and both matter:
 *
 *   - The page-context island carries a `csrfToken`. It is scoped to the embed
 *     page's own session and useless here, but forwarding a CSRF token into a
 *     third-party sandbox is not a thing to do casually. Removed.
 *   - The Google Analytics bootstrap. It would load `googletagmanager.com`,
 *     which is NOT in the widget's declared `resourceDomains`, so it can only
 *     produce a CSP violation — and a blocked subresource inside the widget is
 *     what claude.ai reports to the user as "There was a problem displaying
 *     content from tako." Removing it removes a guaranteed false alarm.
 *
 * Gated on `PUBLIC_CDN_URL`: with the experiment off (production default) this
 * route 404s exactly like any unknown path, so the surface is unchanged.
 */
import { type Env, resolvePublicBase, resolvePublicCdnBase } from "./env.js";

/** Route prefix. The pub_id is the single trailing path segment. */
export const EMBED_PROXY_PREFIX = "/embed-html/";

/**
 * Upstream fetch bound. The widget shows the PNG until this resolves, so a slow
 * upstream costs an upgrade, never the chart. Deliberately below the ~8 s the
 * widget's own paths use, since this is a page fetch and not a render.
 */
const UPSTREAM_TIMEOUT_MS = 6_000;

/**
 * Refuse an upstream body larger than this. Real embed pages measure ~100 KB;
 * 2 MB is generous headroom that still bounds a pathological response before it
 * is turned into a string.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Tako pub_ids are URL-safe base64-ish tokens (letters, digits, `-`, `_`) —
 * e.g. `VKd7qE8K9Ba16kMFENNQ`, `vilUFuRZgsjKYP0qbB-A`. Validating the shape is
 * what keeps this route from being an open redirector / SSRF primitive: the
 * value is interpolated into an upstream URL, so `..%2f` or a full `http://`
 * string must never survive. Anchored, bounded, no dots and no slashes.
 */
const PUB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Extract and validate the pub_id from `/embed-html/{pub_id}`. */
export function parsePubId(pathname: string): string | undefined {
  if (!pathname.startsWith(EMBED_PROXY_PREFIX)) return undefined;
  const raw = pathname.slice(EMBED_PROXY_PREFIX.length);
  // A trailing slash is tolerated; anything else with a slash is rejected.
  const candidate = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return PUB_ID_RE.test(candidate) ? candidate : undefined;
}

/**
 * Remove the two blocks that must not reach a third-party sandbox: the page
 * context island holding `csrfToken`, and the Google Analytics bootstrap.
 *
 * Deliberately conservative. Each pattern is anchored to a distinctive marker
 * and a non-match leaves the document untouched — an upstream redesign should
 * degrade to "proxied a page we didn't sanitize as expected", which the caller
 * can still detect (see `sanitizeEmbedHtml`'s return flags), rather than to a
 * mangled document.
 *
 * Exported for tests.
 */
export function sanitizeEmbedHtml(html: string): {
  html: string;
  removedCsrf: boolean;
  removedAnalytics: boolean;
} {
  let out = html;
  let removedCsrf = false;
  let removedAnalytics = false;

  // The page-context island: a JSON <script> containing "csrfToken".
  out = out.replace(
    /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?csrfToken[\s\S]*?<\/script>/gi,
    () => {
      removedCsrf = true;
      // Replaced, not deleted: Card.js reads this island by position/type, so
      // an empty stand-in of the same shape is safer than a missing element.
      return '<script type="application/json" data-tako-stripped="page-context">{}</script>';
    },
  );

  // The GA bootstrap: an inline script that injects googletagmanager.com.
  out = out.replace(
    /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?googletagmanager\.com[\s\S]*?<\/script>/gi,
    () => {
      removedAnalytics = true;
      return "<!-- analytics stripped by tako-mcp embed proxy -->";
    },
  );

  return { html: out, removedCsrf, removedAnalytics };
}

/** Plain-text response helper, always with CORS so a widget can read the error. */
function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Handle `GET /embed-html/{pub_id}`.
 *
 * Returns `undefined` when the experiment is off or the path does not match, so
 * the router falls through to its catch-all 404 and the route is invisible in
 * production.
 */
export async function handleEmbedProxy(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  if (resolvePublicCdnBase(env) === undefined) return undefined;
  const url = new URL(request.url);
  const pubId = parsePubId(url.pathname);
  if (pubId === undefined) return undefined;
  if (request.method !== "GET" && request.method !== "OPTIONS") {
    return textResponse("method not allowed", 405);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "86400",
      },
    });
  }

  // `dark_mode=auto` matches what the tools write into `embed_url`: the embed
  // page runs in the user's browser and resolves "auto" from
  // `prefers-color-scheme`, so the card follows the host's theme.
  const upstream = `${resolvePublicBase(env)}/embed/${pubId}/?dark_mode=auto`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstream, {
      signal: controller.signal,
      // No cookies, no auth: the embed page is public, and forwarding
      // credentials into a proxy whose output crosses into a sandbox would be
      // a way to leak a session.
      headers: { accept: "text/html" },
      redirect: "follow",
    });
  } catch (err) {
    console.warn(`[mcp] embed proxy upstream failed for ${pubId}:`, err);
    return textResponse("upstream unavailable", 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    console.warn(
      `[mcp] embed proxy upstream HTTP ${response.status} for ${pubId}`,
    );
    // Propagate not-found as not-found; everything else is a bad gateway.
    return textResponse(
      response.status === 404 ? "chart not found" : "upstream error",
      response.status === 404 ? 404 : 502,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    console.warn(
      `[mcp] embed proxy got non-HTML content-type "${contentType}" for ${pubId}`,
    );
    return textResponse("upstream returned non-HTML", 502);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    console.warn(
      `[mcp] embed proxy body too large (${buffer.byteLength}B) for ${pubId}`,
    );
    return textResponse("upstream body too large", 502);
  }

  const sanitized = sanitizeEmbedHtml(new TextDecoder().decode(buffer));
  // Logged because a silent stop in stripping is how a csrfToken would begin
  // reaching a third-party sandbox unnoticed after an upstream redesign.
  if (!sanitized.removedCsrf) {
    console.warn(
      `[mcp] embed proxy found no csrfToken island to strip for ${pubId} — upstream shape may have changed`,
    );
  }
  return new Response(sanitized.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
      // The widget re-reads this per chart; the upstream page is per-pub_id and
      // effectively immutable, so a short cache is safe and spares the origin.
      "cache-control": "public, max-age=300",
      // Never let a proxied third-party document be sniffed into something else.
      "x-content-type-options": "nosniff",
    },
  });
}
