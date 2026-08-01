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
import {
  type Env,
  resolvePublicBase,
  resolvePublicCdnBase,
  resolveWidgetOrigin,
} from "./env.js";

/** Route prefix. The pub_id is the single trailing path segment. */
export const EMBED_PROXY_PREFIX = "/embed-html/";

/**
 * Route prefix for the CDN asset passthrough. Everything after it is the
 * asset's path on the configured CDN origin.
 *
 * This exists because Tako's asset CDN enforces a CORS origin allow-list that
 * reflects `tako.com` and nothing else (measured 2026-08-01: `tako.com` gets
 * `access-control-allow-origin: https://tako.com`; any other origin gets no
 * header at all, and the staging distribution sends none even for tako.com).
 * `Card.js` is `type="module"`, and module scripts are always fetched in CORS
 * mode — so inside a widget sandbox every asset load failed with "blocked by
 * CORS policy" even though CSP permitted the origin.
 *
 * Rather than wait on a CloudFront response-headers policy we do not control,
 * the proxied page's CDN URLs are rewritten to this route and served from our
 * own origin with `Access-Control-Allow-Origin: *`. Card.js's lazily imported
 * chunks then resolve relative to ITS url — now ours — so they come back
 * through here too, without any rewriting of the bundle itself.
 */
export const CDN_ASSET_PREFIX = "/cdn-asset/";

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
 * Ceiling on a JavaScript body we will buffer in order to rewrite its CDN urls.
 * `Card.js` is ~1.5 MB today and rewriting means holding the body and its copy,
 * so this bounds the worst case at roughly twice this number. Anything larger
 * streams through unrewritten — the assets that need rewriting (the entry bundle
 * and its chunks) are all well under it.
 */
const MAX_JS_REWRITE_BYTES = 4 * 1024 * 1024;

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
  //
  // Surgical, and it has to be. An earlier version replaced this island with
  // `{}` — which also threw away `staticPrefix`, the CDN base Card.js resolves
  // its lazily imported view chunks against. The card then mounted its title
  // and skeleton and never drew a chart, with no error to explain why. Keep
  // every key; delete exactly one.
  out = out.replace(
    /<script\b([^>]*)>((?:(?!<\/script>)[\s\S])*?csrfToken[\s\S]*?)<\/script>/gi,
    (whole, attrs: string, body: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        // Not the JSON island we expected (an inline script that merely
        // mentions the word, say). Leave it alone rather than corrupt it, and
        // do NOT claim to have stripped anything.
        return whole;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return whole;
      }
      const rest = { ...(parsed as Record<string, unknown>) };
      if (!("csrfToken" in rest)) return whole;
      delete rest.csrfToken;
      removedCsrf = true;
      return `<script${attrs} data-tako-stripped="csrf">${JSON.stringify(rest)}</script>`;
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

  // `dark_mode` is forwarded when the widget asked for one, else `auto`.
  //
  // `auto` resolves from `prefers-color-scheme` in the viewer's browser, which
  // tracks the OS — right when the host follows the OS, wrong when the user has
  // themed the host itself (a dark ChatGPT on a light Mac would get a light
  // card on a dark surface). Hosts that expose a theme let the widget ask
  // explicitly; see `withHostTheme` in `_chart_widget.ts`. Only the two literal
  // values are honoured, so this cannot smuggle anything into the upstream
  // query.
  const requested = url.searchParams.get("dark_mode");
  const darkMode =
    requested === "true" || requested === "false" ? requested : "auto";
  const upstream = `${resolvePublicBase(env)}/embed/${pubId}/?dark_mode=${darkMode}`;
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
  // Repoint every CDN URL at our own passthrough. Without this the page loads
  // in the widget and then every asset dies on the CDN's CORS allow-list — the
  // exact half-render this route exists to avoid.
  const widgetOrigin = resolveWidgetOrigin(env, new URL(request.url).origin);
  const cdnBase = resolvePublicCdnBase(env);
  let html = sanitized.html;
  if (widgetOrigin !== undefined && cdnBase !== undefined) {
    // No trailing slash on the target: the CDN origin has none either, so the
    // page's paths already start with `/`. Appending the prefix WITH its slash
    // produced `/cdn-asset//archive/...`, which the asset route then rejected as
    // a path trying to climb out of its origin — a 400 on every asset.
    const rewritten = rewriteCdnUrls(
      html,
      cdnBase,
      `${widgetOrigin}${CDN_ASSET_PREFIX.replace(/\/$/, "")}`,
    );
    html = rewritten.html;
    if (rewritten.rewrites === 0) {
      // The page referenced a DIFFERENT CDN origin than `PUBLIC_CDN_URL` names
      // — staging and production use separate distributions, and a mismatch is
      // silent: the card mounts and never draws. Loud, because the symptom is
      // not.
      console.warn(
        `[mcp] embed proxy rewrote 0 CDN urls for ${pubId} — PUBLIC_CDN_URL (${cdnBase}) likely does not match the origin this page references`,
      );
    }
  }
  // Logged because a silent stop in stripping is how a csrfToken would begin
  // reaching a third-party sandbox unnoticed after an upstream redesign.
  if (!sanitized.removedCsrf) {
    console.warn(
      `[mcp] embed proxy found no csrfToken island to strip for ${pubId} — upstream shape may have changed`,
    );
  }
  return new Response(html, {
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

/**
 * Point every CDN URL in the page at our own asset passthrough.
 *
 * A plain global string replace of the CDN origin, which covers all four places
 * the origin appears: the `Card.js` module `src`, the `<link>` hrefs (fonts.css,
 * favicons), the font URLs inside that stylesheet's own fetch chain, and
 * `staticPrefix` in the page-context island. That last one matters most — it is
 * the base Card.js builds asset URLs from at runtime, so rewriting it is what
 * makes the lazily imported view chunks come back through the proxy rather than
 * straight to a CORS wall.
 *
 * Exported for tests.
 */
export function rewriteCdnUrls(
  html: string,
  cdnBase: string,
  assetBase: string,
): { html: string; rewrites: number } {
  // `split`/`join` rather than a regex: the CDN origin is a literal with dots
  // in it, and building a pattern from it would need escaping for no gain. The
  // segment count also gives the rewrite tally for free.
  const parts = html.split(cdnBase);
  return { html: parts.join(assetBase), rewrites: parts.length - 1 };
}

/**
 * Handle `GET /cdn-asset/{path}` — fetch the asset from the configured CDN
 * origin and return it with CORS.
 *
 * The upstream ORIGIN is fixed by configuration (`PUBLIC_CDN_URL`), never taken
 * from the request. That is the whole reason this is not an open proxy: a
 * caller controls the path but can never redirect it to another host.
 *
 * Assets are content-hashed and served `immutable` with a one-year max-age
 * upstream, so that is passed straight through — a cold cache costs ~400 KB for
 * `Card.js` plus fonts, and every warm hit is free.
 */
export async function handleCdnAssetProxy(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const cdnBase = resolvePublicCdnBase(env);
  if (cdnBase === undefined) return undefined;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CDN_ASSET_PREFIX)) return undefined;
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
  if (request.method !== "GET") return textResponse("method not allowed", 405);

  const assetPath = url.pathname.slice(CDN_ASSET_PREFIX.length);
  // No traversal, no protocol-relative escape, no empty path. The origin is
  // fixed above, so this only has to keep the PATH from climbing out of it.
  if (
    assetPath === "" ||
    assetPath.includes("..") ||
    assetPath.startsWith("/") ||
    assetPath.includes("\\")
  ) {
    return textResponse("bad asset path", 400);
  }

  const upstream = `${cdnBase}/${assetPath}${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstream, {
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    console.warn(`[mcp] cdn asset proxy failed for ${assetPath}:`, err);
    return textResponse("upstream unavailable", 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    return textResponse(
      "asset not available",
      response.status === 404 ? 404 : 502,
    );
  }

  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);

  // JavaScript gets the same origin rewrite the HTML got, because some chunk
  // URLs are baked into the BUNDLE rather than the page. Vite built Card.js
  // with the CDN as its base, so a handful of its dynamic imports are absolute
  // CDN URLs that no amount of HTML rewriting reaches — observed as
  // `TabSection.js` and `useTransactionDrawer.js` loading straight from
  // CloudFront and dying on its CORS allow-list while the rest of the card
  // rendered fine. Buffering to do a string replace costs holding ~1.5 MB
  // briefly on a cold cache; the assets are immutable, so warm hits skip it.
  const isJavaScript =
    contentType !== null && /javascript|ecmascript/i.test(contentType);
  if (isJavaScript) {
    // Only JavaScript is buffered, and only up to a bound. Everything else
    // streams. The upstream origin is fixed by config so this is not an
    // arbitrary-URL risk, but `Card.js` is already ~1.5 MB and a rewrite means
    // holding the whole body plus its copy — worth a ceiling rather than
    // trusting the CDN to stay reasonable forever. Over the cap, stream it
    // through unrewritten: the assets that actually need rewriting are the
    // entry bundle and its chunks, all far below this.
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_JS_REWRITE_BYTES) {
      console.warn(
        `[mcp] cdn asset ${assetPath} is ${declaredLength}B — over the rewrite cap, streaming unmodified`,
      );
      headers.set("access-control-allow-origin", "*");
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { status: 200, headers });
    }
    const widgetOrigin = resolveWidgetOrigin(env, url.origin);
    const body = await response.text();
    if (widgetOrigin !== undefined && body.includes(cdnBase)) {
      const rewritten = rewriteCdnUrls(
        body,
        cdnBase,
        `${widgetOrigin}${CDN_ASSET_PREFIX.replace(/\/$/, "")}`,
      );
      headers.set("access-control-allow-origin", "*");
      headers.set("x-content-type-options", "nosniff");
      // NOT the upstream `immutable, max-age=31536000`. Upstream can promise
      // that because its URL is content-hashed; ours cannot, because we have
      // rewritten the body to embed THIS worker's origin. Passing `immutable`
      // through pinned a stale bundle in the browser for a year — it is how a
      // fixed rewrite appeared not to work at all, since the cached copy still
      // carried raw CDN urls. A day is plenty (the path is still hashed, so a
      // new build is a new url) and it keeps the body's origin-dependence
      // honest.
      headers.set("cache-control", "public, max-age=86400");
      return new Response(rewritten.html, { status: 200, headers });
    }
    headers.set("access-control-allow-origin", "*");
    headers.set("x-content-type-options", "nosniff");
    headers.set(
      "cache-control",
      response.headers.get("cache-control") ?? "public, max-age=3600",
    );
    return new Response(body, { status: 200, headers });
  }
  const cacheControl = response.headers.get("cache-control");
  headers.set(
    "cache-control",
    cacheControl ?? "public, max-age=3600",
  );
  headers.set("access-control-allow-origin", "*");
  // Fonts are subject to CORS even in `<link>`/`@font-face` form, and the
  // stylesheet that requests them is now same-origin with the page, so this
  // header is what keeps Geist/Inter from falling back to a system font.
  headers.set("timing-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: 200, headers });
}
