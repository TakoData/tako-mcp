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
 *   2. `Card.js` and its lazily imported chunks are static assets with no API
 *      behind them, so they only have to be REACHABLE — nothing needs bundling.
 *      They are not, however, loadable straight from the CDN: it reflects CORS
 *      for `tako.com` alone and a `type="module"` script is always a CORS
 *      fetch, so they are served through `/cdn-asset/` instead and the page's
 *      CDN urls are rewritten to match. (An earlier reading of this said CORS
 *      was present and no rewriting was needed. That check passed only because
 *      it ran from a `tako.com` page — the one origin on the allow-list.)
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
 *     Belt-and-braces as of the `disable_tracking=true` upstream param below,
 *     which asks the page not to emit the bootstrap in the first place; the
 *     strip stays because it is the half that does not depend on an upstream
 *     template continuing to honour a query flag.
 *
 * Gated on `PUBLIC_CDN_URL`, which is now set in BOTH staging and production —
 * so on the deployed envs these routes are LIVE, and this file is the public
 * surface it describes rather than dormant code. Unset (local dev and the test
 * env, unless a fixture supplies it) the route 404s exactly like any unknown
 * path. A MALFORMED value gates it off too rather than throwing — see
 * `resolveProxyOrigins`, and note these handlers run ahead of the whole OAuth
 * subsystem in `index.ts`.
 *
 * Neither route serves a document the browser will execute. `/embed-html/`
 * answers `text/plain` with `Content-Security-Policy: sandbox`, and
 * `/cdn-asset/` is confined to the `archive/` tree and reflects only inert
 * content types. This origin is the OAuth origin; see the two constants and the
 * response headers below for what that rules out.
 */
import {
  type Env,
  resolvePublicBase,
  resolvePublicCdnBase,
  resolveWidgetOrigin,
} from "./env.js";
import { freeTierRateLimitKey } from "./freetier.js";

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
 * The only CDN path prefix these routes will serve.
 *
 * Measured against a real production embed page (2026-08-02): of its 16 CDN
 * references, 15 sit under `archive/<sha>/` — `Card.js` and its `vite_dist`
 * chunks, the Geist/Inter/Space-Grotesk fonts, the card images, and
 * `staticPrefix` itself. The sixteenth is `previews/<hash>.png`, and it appears
 * in exactly two places: a `<meta name="twitter:image">` and a `<noscript>`
 * fallback `<img>`. Neither is fetched when JavaScript runs, which is the only
 * condition under which the widget renders at all.
 *
 * So confining the route costs nothing the card uses, and it buys the thing
 * that is otherwise hard to guarantee: the distribution fronts its S3 bucket at
 * the ROOT, not at an `archive/`-only origin path (verified — `archive/`,
 * `user-images/`, `content-style/` and `static/` all answer with the same S3
 * `AccessDenied` rather than a CloudFront 404). Tako hands out presigned
 * uploads into that bucket under `user-images/` and `content-style/` with a
 * caller-supplied filename and no content-type conditions. Without this prefix
 * an uploaded `.html` would be reachable at `/cdn-asset/user-images/...` and
 * served as a document on `mcp.tako.com` — the OAuth origin.
 */
const ASSET_PATH_PREFIX = "archive/";

/**
 * Content types this route will reflect from the CDN. Anything else is served
 * as `application/octet-stream`.
 *
 * Defense in depth behind {@link ASSET_PATH_PREFIX}. The prefix is what makes
 * an attacker-influenced object unreachable; this is what keeps a surprise in
 * the `archive/` tree from becoming an executable document on the OAuth origin
 * anyway. The list is exactly what a chart needs — script, style, fonts,
 * images, JSON, plain text — and notably excludes `text/html` and `image/svg+xml`,
 * both of which script.
 */
const REFLECTABLE_CONTENT_TYPE_RE =
  /^(?:application\/(?:javascript|ecmascript|json|wasm|font-woff2?)|text\/(?:javascript|ecmascript|css|plain)|font\/[a-z0-9.+-]+|image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon))\b/i;

/** What an unreflectable content type becomes. Inert, and never sniffed. */
const INERT_CONTENT_TYPE = "application/octet-stream";

/**
 * Edge-cache hint for both upstream fetches, matching what `icons.ts` already
 * does against this same distribution ("so subsequent worker invocations skip
 * the CloudFront round-trip"). Without it every widget render pays a full
 * origin round-trip per asset — and for JavaScript, a fresh buffer-and-replace
 * of a ~1.5 MB body each time.
 */
const UPSTREAM_CACHE_TTL_S = 3600;

/**
 * `RequestInit` plus Cloudflare's `cf` extension.
 *
 * Spelled out rather than relying on `@cloudflare/workers-types` because this
 * module is compiled by four separate tsconfig projects and only two of them
 * load those types — `scripts/tsconfig.json` and `test/widget/tsconfig.json`
 * pull it in transitively under DOM lib types, where `RequestInit` has no `cf`
 * and a bare object literal is an excess-property error. Naming the type here
 * makes the init a non-fresh value, so all four projects accept it.
 */
type CfFetchInit = RequestInit & {
  cf?: { cacheEverything?: boolean; cacheTtl?: number };
};

/**
 * Resolve every origin these two routes need, or `undefined` if any of them is
 * malformed.
 *
 * The resolvers THROW on a bad binding rather than returning `undefined`, and
 * that is deliberate — their values reach a browser, so a silent fallback would
 * be a security boundary. But these handlers run in `index.ts` ahead of the
 * entire OAuth subsystem, so an uncaught throw here does not degrade this
 * feature, it 500s `/authorize`, `/token`, `/register`, `/login`,
 * `/oauth/stytch_callback` and both discovery documents — from one trailing
 * slash in `PUBLIC_CDN_URL`. `POST /mcp` returns earlier and survives, so tool
 * traffic would look perfectly healthy while the connector could not log anyone
 * in.
 *
 * Catching here keeps the blast radius exactly where it was before these routes
 * existed, when the binding was only read while building a widget payload: a
 * misconfigured experiment binding disables the experiment, the same as an
 * unset one. The two routes are one feature — the embed page is useless without
 * its assets — so any bad origin among them turns both off together.
 */
function resolveProxyOrigins(
  env: Env,
  requestOrigin: string,
):
  | { cdnBase: string; publicBase: string; widgetOrigin: string | undefined }
  | undefined {
  try {
    const cdnBase = resolvePublicCdnBase(env);
    if (cdnBase === undefined) return undefined;
    return {
      cdnBase,
      publicBase: resolvePublicBase(env),
      widgetOrigin: resolveWidgetOrigin(env, requestOrigin),
    };
  } catch (err) {
    // Loud: this is indistinguishable from "experiment off" at the route, and
    // the operator who set the binding expects it to have done something.
    console.error(
      "[mcp] native-card proxy disabled — malformed origin binding:",
      err,
    );
    return undefined;
  }
}

/**
 * Meter a proxy request against the free-tier per-IP limiter.
 *
 * These two routes sit above the rate-limited surface: `FREE_TIER_RATE_LIMITER`
 * is otherwise consulted only inside `handleMcpRequest`. Left unmetered,
 * `/cdn-asset/` is an unauthenticated `ACAO: *` mirror of a CloudFront
 * distribution that buffers and string-replaces ~1.5 MB per JavaScript request,
 * and `/embed-html/` lets an anonymous caller drive `/embed/{id}/` renders on
 * Tako's own origin at whatever rate it likes.
 *
 * Fails OPEN, like every other use of this binding: a limiter outage must not
 * take the card down. Returns a 429 rather than a JSON-RPC result because these
 * are browser subresource fetches, not MCP traffic — nothing here has a request
 * id to answer.
 */
async function rateLimited(request: Request, env: Env): Promise<Response | undefined> {
  const limiter = env.FREE_TIER_RATE_LIMITER;
  if (limiter === undefined) return undefined;
  const key = freeTierRateLimitKey(request.headers.get("CF-Connecting-IP"));
  try {
    const { success } = await limiter.limit({ key });
    if (success) return undefined;
  } catch (err) {
    console.error(
      `[mcp] native-card proxy rate limiter error (failing open): ${String(err)}`,
    );
    return undefined;
  }
  return textResponse("too many requests", 429);
}

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
/**
 * Re-apply the script-breakout escaping that a JSON round-trip throws away.
 *
 * Django's `json_script` emits `<`, `>` and `&` as `<`, `>` and
 * `&` inside the JSON string, specifically so no value can close the
 * `<script>` element that carries it. `JSON.parse` decodes those back to
 * literals and `JSON.stringify` re-emits them raw — so parsing an island and
 * re-serializing it silently removes a control Django put there on purpose.
 *
 * Reproduced before fixing: a `title` of `a </script><img src=x onerror=...> b`
 * survives Django's escaping intact and comes back out of the round-trip as a
 * literal `</script><img ...>`, terminating the island early and turning the
 * rest of the page into live markup.
 *
 * Latent rather than live today — the island this touches is `server_config`,
 * whose five keys (`staticPrefix`, `csrfToken`, `userLoggedIn`, `hostContext`,
 * `developerConsoleEnabled`) are all server-derived, and caller-authored card
 * content lives in a separate `config-json` island this replace never matches.
 * It re-arms the moment one user-influenced value joins that dict, which is
 * reason enough to put the control back rather than depend on the key list.
 *
 * These three escapes are valid JSON and decode to exactly the same string, so
 * the island's meaning is byte-for-byte unchanged for any consumer that parses
 * it — only the HTML tokenizer sees a difference.
 */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

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
      return `<script${attrs} data-tako-stripped="csrf">${escapeJsonForScript(JSON.stringify(rest))}</script>`;
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
  const url = new URL(request.url);
  const origins = resolveProxyOrigins(env, url.origin);
  if (origins === undefined) return undefined;
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

  const limited = await rateLimited(request, env);
  if (limited !== undefined) return limited;

  // `disable_tracking=true` asks the embed page not to emit the Google Tag
  // Manager bootstrap at all, and excludes this fetch from Tako's own
  // impression counters. Both are wanted here: the markup we return crosses
  // into a third-party widget sandbox where a tracker has no business (the
  // sanitizer below still strips GA belt-and-braces, in case an upstream
  // change stops honouring the flag), and a proxy read is a machine fetch, not
  // a person viewing a chart, so counting it was always noise.
  const upstream = `${origins.publicBase}/embed/${pubId}/?dark_mode=${darkMode}&disable_tracking=true`;
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
      // A 3xx is an upstream ERROR here, not an instruction. Following one
      // would quietly break the guarantee the `handleCdnAssetProxy` docstring
      // states and this route relies on just as much: the origin is fixed by
      // configuration. That holds for the request we issue, but not for the
      // response we serve — with `follow`, the `text/html` gate below, the
      // sanitizer, and the body itself would all be judging a document from
      // whatever host the redirect chain ended at, re-served under our origin
      // with `ACAO: *`. Tako's origin does redirect on this class of path
      // (canonical-host 301/308, and `redirect("/login")`), so this is not
      // hypothetical — only currently same-host. `manual` turns a 3xx into a
      // non-`ok` response, which falls into the error branch below.
      redirect: "manual",
      cf: { cacheEverything: true, cacheTtl: UPSTREAM_CACHE_TTL_S },
    } satisfies CfFetchInit as CfFetchInit);
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
    // Propagate not-found as not-found; everything else — a 3xx included, see
    // `redirect: "manual"` above — is a bad gateway.
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
  const { widgetOrigin, cdnBase } = origins;
  let html = sanitized.html;
  if (widgetOrigin !== undefined) {
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
  // FAIL CLOSED on the property this module's tests name as invariant #3:
  // nothing sensitive crosses into the sandbox.
  //
  // Every non-match path in `sanitizeEmbedHtml` returns the document untouched
  // — `JSON.parse` throws, the parse yields a non-object, `csrfToken` is absent.
  // That conservatism is right for the DOCUMENT (a mangled page is worse than
  // an unsanitized one), but it must not extend to the TOKEN: an upstream key
  // rename or a stray whitespace change would start forwarding a live CSRF
  // token to a third party with nothing but a log line to say so.
  //
  // A missed strip on a body that still contains the token is therefore a 502.
  // The route's whole failure story is that a failure costs an upgrade and
  // leaves today's chart untouched — so the safe default here is no native
  // card, not a forwarded credential.
  if (!sanitized.removedCsrf && html.includes("csrfToken")) {
    console.error(
      `[mcp] embed proxy could not strip the csrfToken island for ${pubId} — refusing to forward it; upstream shape has likely changed`,
    );
    return textResponse("upstream shape unrecognized", 502);
  }
  return new Response(html, {
    status: 200,
    headers: {
      // NOT `text/html`, and that is the point. This origin is the OAuth origin:
      // `tako_oauth_state` and `tako_oauth_session` are set here with `Path=/`
      // and no `Domain`, and the design's stated threat model assumes no XSS on
      // `mcp.tako.com`. A browsable, executable document served from here could
      // `fetch('/register')` (open DCR, unauthenticated), then drive
      // `/authorize` + `/token` same-origin with the victim's session cookie
      // attached and read the auth code out of a same-origin response — without
      // ever touching the HttpOnly cookie.
      //
      // Nothing needs it to be HTML. The only consumer is `upgradeToNativeCard`
      // in `_chart_widget.ts`, which does `fetch(...).then(r => r.text())` and
      // writes the string into its OWN sandboxed document; it never dispatches
      // on the content type (its sole shape check is `indexOf("<html")`).
      "content-type": "text/plain; charset=utf-8",
      // Belt to that brace: even if something did render this as a document,
      // `sandbox` with no tokens denies scripts, forms, popups and same-origin,
      // and `DENY` keeps it out of a frame.
      "content-security-policy": "sandbox",
      "x-frame-options": "DENY",
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
 * A plain global string replace of the CDN origin PLUS the `archive/` prefix,
 * which covers all four places that matter: the `Card.js` module `src`, the
 * `<link>` hrefs (fonts.css, favicons), the font URLs inside that stylesheet's
 * own fetch chain, and `staticPrefix` in the page-context island. That last one
 * matters most — it is the base Card.js builds asset URLs from at runtime, so
 * rewriting it is what makes the lazily imported view chunks come back through
 * the proxy rather than straight to a CORS wall.
 *
 * Scoped to `archive/` so we only ever rewrite what {@link ASSET_PATH_PREFIX}
 * will actually serve. The one CDN reference outside that tree on a real embed
 * page is `previews/<hash>.png` in a `<meta twitter:image>` and a `<noscript>`
 * `<img>`; leaving those pointing at the CDN is strictly better than rewriting
 * them to a route that would decline — neither is ever fetched with JavaScript
 * enabled, and an OG image belongs on the CDN regardless.
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
  const parts = html.split(`${cdnBase}/${ASSET_PATH_PREFIX}`);
  return {
    html: parts.join(`${assetBase}/${ASSET_PATH_PREFIX}`),
    rewrites: parts.length - 1,
  };
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
  const url = new URL(request.url);
  const origins = resolveProxyOrigins(env, url.origin);
  if (origins === undefined) return undefined;
  const { cdnBase } = origins;
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

  // `url.pathname` is ALREADY dot-segment normalized, and that is what makes
  // this safe rather than the checks below.
  //
  // The WHATWG path parser resolves `..` segments — and decodes `%2e` for the
  // purpose of recognising them, so `%2e%2e`, `.%2e` and `%2E%2E` all collapse
  // too — during `new URL(request.url)`, before this handler sees anything.
  // Measured in workerd: `/cdn-asset/%2e%2e/%2e%2e/x` arrives as `/x`, and
  // `/cdn-asset/archive/%2e%2e/%2e%2e/user-images/evil.html` as
  // `/user-images/evil.html`. Neither still carries the route prefix, so both
  // fail the `startsWith` above and fall through to the router's 404. Encoded
  // SLASHES do survive (`b%2Fc.js` stays encoded), which is not traversal — it
  // names an S3 key that literally contains a slash.
  //
  // The guards below are therefore defense in depth, kept because they are free
  // and because they still hold if this is ever called with a hand-built path
  // instead of a parsed Request. `embed_proxy.test.ts` pins the parser behavior
  // directly, so a refactor that stops going through `URL` fails loudly.
  const assetPath = url.pathname.slice(CDN_ASSET_PREFIX.length);
  // No traversal, no protocol-relative escape, no empty path, and nothing
  // outside the one tree the card actually loads from. The origin is fixed
  // above, so the rest only has to keep the PATH from climbing out of it —
  // see `ASSET_PATH_PREFIX` for why confinement is not merely belt-and-braces.
  if (
    assetPath === "" ||
    !assetPath.startsWith(ASSET_PATH_PREFIX) ||
    assetPath.includes("..") ||
    assetPath.startsWith("/") ||
    assetPath.includes("\\")
  ) {
    return textResponse("bad asset path", 400);
  }

  const limited = await rateLimited(request, env);
  if (limited !== undefined) return limited;

  const upstream = `${cdnBase}/${assetPath}${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstream, {
      signal: controller.signal,
      // See `handleEmbedProxy` — a 3xx is an upstream error, not an
      // instruction. Following one would make every decision below (the
      // reflected content type, the body, `response.ok`) judge a response from
      // a host the configuration never named, which is exactly the property
      // this route's docstring claims it has.
      redirect: "manual",
      cf: { cacheEverything: true, cacheTtl: UPSTREAM_CACHE_TTL_S },
    } satisfies CfFetchInit as CfFetchInit);
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
  const upstreamContentType = response.headers.get("content-type");
  // Reflect only inert types. Whatever MIME the CDN declares would otherwise
  // become the MIME we serve on `mcp.tako.com` — the OAuth origin — and the
  // distribution fronts an S3 bucket that also holds user-uploaded objects with
  // caller-negotiated content types. `ASSET_PATH_PREFIX` already puts those out
  // of reach; this keeps a surprise inside `archive/` from becoming a document
  // anyway. `text/html` and `image/svg+xml` are deliberately absent — both
  // script.
  const contentType =
    upstreamContentType !== null &&
    REFLECTABLE_CONTENT_TYPE_RE.test(upstreamContentType)
      ? upstreamContentType
      : INERT_CONTENT_TYPE;
  if (upstreamContentType !== null && contentType === INERT_CONTENT_TYPE) {
    console.warn(
      `[mcp] cdn asset ${assetPath} declared "${upstreamContentType}" — not reflectable, serving as ${INERT_CONTENT_TYPE}`,
    );
  }
  headers.set("content-type", contentType);

  // JavaScript gets the same origin rewrite the HTML got, because some chunk
  // URLs are baked into the BUNDLE rather than the page. Vite built Card.js
  // with the CDN as its base, so a handful of its dynamic imports are absolute
  // CDN URLs that no amount of HTML rewriting reaches — observed as
  // `TabSection.js` and `useTransactionDrawer.js` loading straight from
  // CloudFront and dying on its CORS allow-list while the rest of the card
  // rendered fine. Buffering to do a string replace costs holding ~1.5 MB
  // briefly on a cold cache; the assets are immutable, so warm hits skip it.
  const isJavaScript = /javascript|ecmascript/i.test(contentType);
  if (isJavaScript) {
    // Only JavaScript is buffered, and only up to a bound. Everything else
    // streams. The upstream origin is fixed by config so this is not an
    // arbitrary-URL risk, but `Card.js` is already ~1.5 MB and a rewrite means
    // holding the whole body plus its copy — worth a ceiling rather than
    // trusting the CDN to stay reasonable forever. Over the cap, return it
    // unrewritten: the assets that actually need rewriting are the entry bundle
    // and its chunks, all far below this.
    //
    // The bound is read off the ACCUMULATED BODY, not off `content-length`.
    // Workers strips `Content-Length` (with `Content-Encoding`) when it
    // auto-decompresses a gzipped response — which is exactly how CloudFront
    // serves JavaScript — so a declared-length check read `0` for `Card.js`,
    // the one asset the cap was written for, and never tripped. Two smaller
    // versions of the same hole: a non-numeric header yields `NaN`, and
    // `NaN > cap` is `false`; and where the header IS present on a compressed
    // response it describes compressed bytes while the cap governs a
    // decompressed buffer. The body is the only honest measure of all three.
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_JS_REWRITE_BYTES) {
      console.warn(
        `[mcp] cdn asset ${assetPath} is ${bytes.byteLength}B — over the rewrite cap, serving unmodified`,
      );
      headers.set("access-control-allow-origin", "*");
      headers.set("x-content-type-options", "nosniff");
      headers.set(
        "cache-control",
        response.headers.get("cache-control") ?? "public, max-age=3600",
      );
      return new Response(bytes, { status: 200, headers });
    }
    const { widgetOrigin } = origins;
    const body = new TextDecoder().decode(bytes);
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
  // Fonts are subject to CORS even in `<link>`/`@font-face` form, so THIS
  // header is what keeps Geist/Inter from falling back to a system font.
  headers.set("access-control-allow-origin", "*");
  // Not part of that: `timing-allow-origin` governs what the Resource Timing
  // API is allowed to reveal about the request, and has no bearing on whether
  // the font loads. Kept because it makes these fetches legible in a
  // performance profile, which is the only thing it does.
  headers.set("timing-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: 200, headers });
}
