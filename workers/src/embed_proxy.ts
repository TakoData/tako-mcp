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
 *   1. The embed page carries the data for the section it opens on. A ~230 KB
 *      inline JSON island holds that section's card config (`config_type`,
 *      `params`, `dataset`, `components`), and a second ~1.5 KB island holds the
 *      theme (series colors, Geist fonts, tooltip, padding).
 *
 *      It does NOT carry the other sections. An earlier reading of this said
 *      "zero fetch/XHR in the page, so there is no API to call" — true of the
 *      first paint and false of every interaction after it. A multi-tab card
 *      (`Nvidia Stock Overview` ships twelve tabs) inlines `component_data` for
 *      the ACTIVE tab only and fetches the rest from `/knowledge/get_data/`,
 *      resolved against `window.location.href`. Inside the widget that base is
 *      the host's sandbox origin, not tako.com, so every tab but the first
 *      rendered `There was an error loading the data.` — reported on claude.ai
 *      2026-08-07, invisible on ChatGPT because ChatGPT commits to the nested
 *      `tako.com` iframe and never takes this path at all.
 *
 *      Hence {@link EMBED_DATA_PREFIX} and the shim {@link dataProxyShim} injects:
 *      one origin-fixed passthrough for that endpoint, and a `window.fetch`
 *      wrapper that repoints the page's own location-relative call at it. Still
 *      no credential to hold — the endpoint is public (verified against
 *      production: no cookie, no CSRF header, HTTP 200) — but public is not the
 *      same as read-only, and it is not: see {@link findUpstreamWrite} for the
 *      write branch that made a request-body gate load-bearing here.
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
 * Three things are stripped on the way through, and all three matter:
 *
 *   - The page-context island carries a `csrfToken`. It is scoped to the embed
 *     page's own session and useless here, but forwarding a CSRF token into a
 *     third-party sandbox is not a thing to do casually. Removed.
 *   - So does a `<input type="hidden" name="csrfmiddlewaretoken">` in the body,
 *     which the island strip never touched and the fail-closed guard never
 *     noticed — it greps for the camelCase `csrfToken` and this is Django's
 *     other spelling. Same value, same reasoning, so it is removed the same way
 *     and the guard now covers both spellings. Not a live vulnerability: the
 *     proxy fetch is credential-free, so the token belongs to a fresh anonymous
 *     secret whose `Set-Cookie` we drop, and Django's double-submit check needs
 *     the matching cookie. It was simply the module claiming a property it did
 *     not have.
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
 * None of the three routes serves a document the browser will execute.
 * `/embed-html/` answers `text/plain` with `Content-Security-Policy: sandbox`,
 * `/cdn-asset/` is confined to the `archive/` tree and reflects only inert
 * content types, and `/embed-data/` answers a pinned `application/json` rather
 * than echoing whatever upstream declared. This origin is the OAuth origin; see
 * the constants and the response headers below for what that rules out.
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
 * Route prefix for the card's own data endpoint. The pub_id is the single
 * trailing segment, exactly as on {@link EMBED_PROXY_PREFIX}.
 *
 * The pub_id is a LOG CORRELATOR and nothing else. It never reaches the upstream
 * URL — that is `publicBase + UPSTREAM_DATA_PATH`, both constants — and it never
 * reaches the body. It exists because the three 502s below had no way to name
 * the card they failed for: the body is opaque JSON and `/embed-html/` logs
 * `... for ${pubId}` throughout, so a 502 here was the one failure in this file
 * that could not be tied back to a chart. `handleEmbedProxy` already knows the
 * id at the moment it injects the shim, so it bakes it into the shim's target.
 *
 * A path segment rather than `?pub_id=`, for two reasons: it matches the shape
 * the rest of this file uses and reuses {@link PUB_ID_RE}, and a query would
 * have broken the shim, whose `to = T + u.search` would concatenate a second
 * `?` if the target already carried one.
 *
 * Exists because `Card.js` fetches every non-initial tab's data at click time
 * from `new URL("/knowledge/get_data/", window.location.href)`. On tako.com that
 * is same-origin and invisible. Inside the widget, `window.location.href` is the
 * host's sandbox document, so the request went to claude.ai's origin — where it
 * is neither in `connectDomains` nor answered by anything — and the card
 * rendered its `CardError` ("There was an error loading the data.") on every tab
 * but the one the page shipped inlined.
 */
export const EMBED_DATA_PREFIX = "/embed-data/";

/**
 * The one upstream path {@link EMBED_DATA_PREFIX} forwards to, and the path the
 * injected shim matches on. A constant, never derived from the request: that is
 * what keeps this a single-endpoint passthrough rather than a POST proxy for
 * Tako's whole origin.
 */
export const UPSTREAM_DATA_PATH = "/knowledge/get_data/";

/**
 * Upstream fetch bound. The widget shows the PNG until this resolves, so a slow
 * upstream costs an upgrade, never the chart. Deliberately below the ~8 s the
 * widget's own paths use, since this is a page fetch and not a render.
 */
const UPSTREAM_TIMEOUT_MS = 6_000;

/**
 * Separate, longer bound for the data endpoint.
 *
 * The page-fetch bound above is short because the widget is showing a working
 * PNG while it waits and a timeout costs only the upgrade. This one is different
 * in both directions: the card is already on screen with a spinner in the tab
 * the user just clicked, so a timeout is a visible failure, and the work
 * upstream is a real query rather than a template render (measured against
 * production: ~0.6 s and a ~350 KB body for one tab of a twelve-tab card).
 * `Card.js` imposes no deadline of its own, so this is the only one.
 */
const DATA_UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Ceiling on the request body this route will forward.
 *
 * The body is the card's whole viz config, and the size that matters is not the
 * first request's — it GROWS. `Card.js` merges each response's `viz_config` into
 * the config it holds and posts the whole accumulated thing on the next click,
 * so the body scales with how much of the card the user has explored.
 *
 * Measured end-to-end against the production Nvidia overview card, walking all
 * twelve tabs in one session: 118 KB on the first request, 1.29 MB on the last,
 * roughly +100 KB per tab. A first cut at 1 MB therefore worked for five tabs
 * and then 413'd — the tab the user clicked showing exactly the error this route
 * exists to remove, which is why the number is measured rather than guessed.
 *
 * The ceiling that actually binds is DJANGO'S, not this one:
 * `DATA_UPLOAD_MAX_MEMORY_SIZE = 3670016` (3.5 MB) in the tako repo,
 * `app/config/settings/base.py`. Anything past that is refused upstream, arrives
 * here as a 400, and maps to a 502 — the tab error again, under a log line
 * reading `upstream HTTP 400` that says nothing about size. So a cap ABOVE it
 * cannot buy headroom, only a worse diagnosis.
 *
 * Hence 3 MB: under Django's limit, so everything this route accepts is
 * something Django will also accept, and an over-cap body gets a 413 that names
 * the real problem. That is ~28 tabs of headroom against the 1.29 MB the largest
 * card Tako ships actually reaches — and the number is deliberately not tuned
 * closer, because Django's limit lives in another repo where a change to it
 * would not show up in this PR's tests.
 *
 * Subtabs are free: one response carries all of a tab's subtabs, so clicking
 * through EPS/Revenue/EBITDA issues no further requests at all.
 */
const MAX_DATA_REQUEST_BYTES = 3 * 1024 * 1024;

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
 * Meter a proxy request against the native-card per-IP limiter.
 *
 * Left unmetered, `/cdn-asset/` is an unauthenticated `ACAO: *` mirror of a
 * CloudFront distribution that buffers and string-replaces ~1.5 MB per
 * JavaScript request, and `/embed-html/` lets an anonymous caller drive
 * `/embed/{id}/` renders on Tako's own origin at whatever rate it likes.
 *
 * Metered on its OWN binding, not the free tier's. These are browser
 * SUBRESOURCE fetches: one card render costs ~10 of them before `Card.js`'s
 * lazily imported chunks, against a free-tier bucket of 10 per 60 s sized for
 * `tools/call`. Sharing it meant the render throttled its own assets — measured
 * on staging, requests 1-10 served and 11-14 all 429 — so the chart failed to
 * draw. See `NATIVE_CARD_RATE_LIMITER` in `env.ts`.
 *
 * Fails OPEN: a limiter outage must degrade to an unmetered chart, never a
 * missing one. Returns a 429 rather than a JSON-RPC result because nothing here
 * has a request id to answer.
 *
 * ORDER MATTERS: every caller must await this BEFORE its upstream fetch, or the
 * meter becomes decorative — the work it exists to bound has already happened.
 * `embed_proxy.test.ts` pins that ordering.
 */
async function rateLimited(request: Request, env: Env): Promise<Response | undefined> {
  const limiter = env.NATIVE_CARD_RATE_LIMITER;
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

/**
 * Extract and validate the pub_id from `/embed-html/{pub_id}`, or from
 * `/embed-data/{pub_id}` when given that prefix.
 *
 * Shared deliberately. On `/embed-html/` the value is interpolated into an
 * upstream URL, so the validation is a security boundary; on `/embed-data/` it
 * only ever reaches a log line. Validating both the same way costs nothing and
 * means a log correlator can never become the weaker of the two.
 */
export function parsePubId(
  pathname: string,
  prefix: string = EMBED_PROXY_PREFIX,
): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length);
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
  removedCsrfInput: boolean;
  removedAnalytics: boolean;
} {
  let out = html;
  let removedCsrf = false;
  let removedCsrfInput = false;
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

  // Django's OTHER csrf token: `{% csrf_token %}` renders a hidden input into
  // the body, and the island strip above never saw it. It is the same secret
  // under a different name, so it gets the same treatment. Matched on the `name`
  // attribute rather than on `type=hidden` because the name is the part Django
  // fixes; the whole tag goes either way.
  out = out.replace(
    /<input\b[^>]*\bname\s*=\s*["']?csrfmiddlewaretoken["']?[^>]*>/gi,
    () => {
      removedCsrfInput = true;
      return "<!-- csrf input stripped by tako-mcp embed proxy -->";
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

  return { html: out, removedCsrf, removedCsrfInput, removedAnalytics };
}

/**
 * Inline script that repoints the card's own data fetch at our passthrough.
 *
 * `Card.js` builds that URL as `new URL("/knowledge/get_data/",
 * window.location.href)`. Nothing in the document can change what
 * `window.location.href` is inside the host's sandbox, and `<base>` does not
 * help — the page passes `location.href` explicitly rather than relying on
 * `document.baseURI`. So the interception has to be on `fetch` itself.
 *
 * Deliberately narrow:
 *
 *   - It matches on the resolved PATHNAME being exactly
 *     {@link UPSTREAM_DATA_PATH}. Every other fetch the card makes — the
 *     `staticPrefix`-relative `geo/*.json` map features, anything added later —
 *     passes through untouched.
 *   - It only rewrites string and `URL` inputs, which is what the call site
 *     uses. A `Request` object is forwarded as-is rather than reconstructed,
 *     because copying one faithfully (method, headers, and a body that is a
 *     single-use stream) is exactly the kind of thing that half-works.
 *   - Every step is inside `try`/`catch` with a fall-through to the original
 *     `fetch`. A throw here would break the card's OTHER fetches too, and a
 *     broken chart is worse than a broken tab.
 *
 * Runs before `Card.js` regardless of where it is injected: `Card.js` is
 * `type="module"`, so it is deferred until parsing finishes, while this is a
 * classic inline script.
 *
 * Exported for tests.
 */
export function dataProxyShim(dataProxyUrl: string): string {
  // The url reaches a browser inside a `<script>`. It is built from an origin
  // that `validatePublicOrigin` has already vetted plus a constant path, so
  // there is nothing to smuggle — but escaping `<` costs nothing and means the
  // string can never terminate the element that carries it.
  const target = JSON.stringify(dataProxyUrl).replace(/</g, "\\u003C");
  const upstreamPath = JSON.stringify(UPSTREAM_DATA_PATH);
  return [
    "<script>(function(){",
    `var T=${target};var P=${upstreamPath};`,
    "var f=window.fetch;",
    "if(typeof f!=='function')return;",
    "window.fetch=function(input,init){",
    "var to=null;",
    "try{",
    "if(typeof input==='string'||(typeof URL!=='undefined'&&input instanceof URL)){",
    "var u=new URL(String(input),window.location.href);",
    "if(u.pathname===P)to=T+u.search;",
    "}",
    "}catch(e){}",
    "return to===null?f.apply(window,arguments):f.call(window,to,init);",
    "};",
    "})();<\/script>",
  ].join("");
}

/**
 * Put {@link dataProxyShim} into the proxied document.
 *
 * Anchored to `</head>` first, then to the opening `<body>` tag, and only then
 * appended. Appending is the fallback rather than prepending on purpose:
 * prepending would land the script ahead of `<!doctype html>` and drop the page
 * into quirks mode, which would change the card's layout to fix its data.
 *
 * Exported for tests.
 */
export function injectDataProxyShim(
  html: string,
  dataProxyUrl: string,
): { html: string; anchor: "head" | "body" | "append" } {
  const shim = dataProxyShim(dataProxyUrl);
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose !== null) {
    return {
      html: html.slice(0, headClose.index) + shim + html.slice(headClose.index),
      anchor: "head",
    };
  }
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen !== null) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return { html: html.slice(0, at) + shim + html.slice(at), anchor: "body" };
  }
  return { html: html + shim, anchor: "append" };
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
    // Same gate as the CDN rewrite, and for the same reason: both need an origin
    // to point at. Without one the card still renders its initial tab, which is
    // the pre-existing behaviour, so this is additive rather than load-bearing
    // for the first paint.
    // The pub_id rides along so the data route's failures can name the card —
    // see `EMBED_DATA_PREFIX`. `encodeURIComponent` for the same reason the
    // native-card URL uses it, even though `PUB_ID_RE` has already bounded the
    // shape on the way in here.
    const shimmed = injectDataProxyShim(
      html,
      `${widgetOrigin}${EMBED_DATA_PREFIX}${encodeURIComponent(pubId)}`,
    );
    html = shimmed.html;
    if (shimmed.anchor === "append") {
      // Still correct — a classic script anywhere beats the deferred module —
      // but it means the document had neither a `</head>` nor a `<body>`, which
      // is not the page we think we are proxying.
      console.warn(
        `[mcp] embed proxy found no head/body anchor for ${pubId} — appended the data shim`,
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
  // A body that still contains the token is therefore a 502. The route's whole
  // failure story is that a failure costs an upgrade and leaves today's chart
  // untouched — so the safe default here is no native card, not a forwarded
  // credential.
  //
  // Both of Django's spellings are covered. The guard used to name only
  // `csrfToken`, so the `csrfmiddlewaretoken` hidden input in the body sailed
  // through every render.
  //
  // The scan is UNCONDITIONAL: `!stripped && html.includes(token)` skipped it
  // entirely once a strip had succeeded, which is the same shape as the miss this
  // change is fixing. A page carrying the JSON island PLUS a second inline script
  // that merely mentions `csrfToken` sets `removedCsrf = true` — the island
  // replacer returns `whole` untouched for anything it cannot `JSON.parse` — and
  // the second one rode through. Dropping the conjunct is strictly stronger and
  // cannot false-positive, because neither replacement re-emits the token string:
  // one leaves `data-tako-stripped="csrf"` and a token-free dict, the other an
  // HTML comment. The strip flags stay, but only to say which case this is.
  for (const { token, stripped } of [
    { token: "csrfToken", stripped: sanitized.removedCsrf },
    { token: "csrfmiddlewaretoken", stripped: sanitized.removedCsrfInput },
  ]) {
    if (html.includes(token)) {
      console.error(
        `[mcp] embed proxy is still carrying ${token} for ${pubId} after ` +
          `${stripped ? "a strip that reported success — a second occurrence the replacer did not match" : "no strip — the upstream shape has likely changed"}` +
          `; refusing to forward it`,
      );
      return textResponse("upstream shape unrecognized", 502);
    }
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
 * Read a request body, refusing anything past {@link MAX_DATA_REQUEST_BYTES}
 * WITHOUT having buffered it first.
 *
 * `request.arrayBuffer()` then checking `byteLength` reads the wrong way round,
 * and on this route that is not a style point. Cloudflare accepts request bodies
 * up to 100 MB while an isolate has 128 MB, so `arrayBuffer()` on a hostile body
 * can exceed the memory limit — and exceeding it kills the isolate rather than
 * throwing something a `catch` can turn into a 413. These handlers run ahead of
 * the entire OAuth subsystem in `index.ts`, so that is `/authorize` and `/token`
 * paying for an unauthenticated POST to an experiment route.
 *
 * Reading incrementally and cancelling at the cap bounds the read. Bounding the
 * PEAK takes the second half: the accumulated chunks are released as they are
 * copied into the result, so the two allocations do not coexist. Without that,
 * `new ArrayBuffer(total)` while `chunks` is still reachable puts peak at ~2x the
 * cap, and since nothing bounds request concurrency in an isolate, enough
 * simultaneous max-size POSTs from one IP — well inside 200/60 s — would reach
 * the 128 MB limit anyway. Halving the peak and lowering the cap to 3 MB together
 * take the count that gets there from single digits to well past what the meter
 * allows.
 *
 * `Content-Length` is deliberately not consulted: it is absent on a chunked
 * body, and the whole point is to bound the case where the caller is not telling
 * the truth.
 */
async function readBoundedBody(
  request: Request,
): Promise<ArrayBuffer | "too-large" | "unreadable"> {
  // Null for a POST with no body at all. Zero bytes, which the caller rejects as
  // an empty body — a more accurate answer than "unreadable".
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_DATA_REQUEST_BYTES) {
        console.warn(
          `[mcp] embed data proxy body exceeded ${MAX_DATA_REQUEST_BYTES}B — refusing without buffering the rest`,
        );
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } catch (err) {
    console.warn("[mcp] embed data proxy could not read the request body:", err);
    return "unreadable";
  }
  // An `ArrayBuffer` rather than the `Uint8Array` view over it, so the value is
  // a `BodyInit` under every one of the four tsconfig projects that compile this
  // module — two of them load DOM lib types, where a generic
  // `Uint8Array<ArrayBufferLike>` no longer satisfies `BufferSource`.
  const out = new ArrayBuffer(total);
  const view = new Uint8Array(out);
  let offset = 0;
  // `shift()` rather than `for..of`: each chunk becomes unreachable as soon as it
  // is copied, so the accumulated chunks and the result never both exist in full.
  // See the docstring — this is the half that actually bounds the peak.
  for (let chunk = chunks.shift(); chunk !== undefined; chunk = chunks.shift()) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Refuse a body that would make the upstream endpoint WRITE.
 *
 * `/knowledge/get_data/` is not the read-only endpoint its name suggests.
 * `GetData.post` (tako repo, `app/backend/knowledge/views.py`) is `csrf_exempt`
 * and unauthenticated, and for any non-empty `pub_id` in the body it does:
 *
 *     chart_config = ChartConfig.objects.get(pub_id=pub_id)
 *     if chart_config.frozen_after_sharing is None or not ...:
 *         chart_config.viz_config = serialized_viz_config
 *         chart_config.data = data
 *         chart_config.save()
 *
 * No ownership check, and `frozen_after_sharing` is `BooleanField(null=True)`, so
 * the default is `None` and that branch is writable. The rest of the body is
 * `parse_search_doc(payload)`, so a caller who supplies a pub_id chooses both the
 * row overwritten and what lands in it.
 *
 * What has kept that off the internet is CORS, not authorization: Django's
 * `CORS_ALLOWED_ORIGINS` is a closed allowlist, so a drive-by page's preflight
 * for a JSON POST fails and the browser never sends the request. This route
 * answers `Access-Control-Allow-Origin: *`, which removes exactly that barrier —
 * and forwards only `content-type`/`accept`, so Tako would see one Cloudflare
 * egress IP for all of it. It cannot be narrowed instead: the widget document's
 * origin inside the host sandbox is opaque, so there is no value to allowlist.
 *
 * So the gate is here. The shim never sends a real pub_id — `Card.js` uses
 * `window.frameElement?.id ?? ""`, and `frameElement` is null in any
 * cross-origin embed, which is also what ChatGPT sends on the path where tabs
 * work. Measured on all eleven data requests of a full twelve-tab walk: `""`
 * every time. Refusing a non-empty value therefore costs the feature nothing and
 * leaves `if pub_id:` unreached, which makes this route read-only upstream.
 *
 * The body is parsed to check it and then DISCARDED — the original bytes are what
 * gets forwarded, so nothing about what Django receives depends on a JSON
 * round-trip here. Parsing also gets the JSON-validity check for free, which the
 * route was otherwise forwarding blind.
 *
 * Exported for tests.
 */
export function findUpstreamWrite(
  body: ArrayBuffer,
): "not-json" | "not-an-object" | "writes" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "not-json";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "not-an-object";
  }
  const pubId = (parsed as Record<string, unknown>)["pub_id"];
  // Absent, null and `""` are all the read-only shape. Anything else — including
  // a non-string, which Django would evaluate as truthy just the same — is a
  // write.
  if (pubId === undefined || pubId === null || pubId === "") return undefined;
  return "writes";
}

/**
 * A pass-through that observes the streamed response without holding it.
 *
 * Two jobs, both about the failure the streaming path used to swallow:
 *
 *   - On a clean end it calls `settle`, which clears the upstream timeout. That
 *     is what makes {@link DATA_UPSTREAM_TIMEOUT_MS} bound the whole exchange
 *     rather than time-to-headers: the timer stays armed while the body flows,
 *     so a stalled upstream aborts instead of hanging the tab forever.
 *   - On an error it LOGS, with the pub_id and the byte count. The status line is
 *     already sent by then, so the card will render its own error either way —
 *     but before this, that was the only failure on this route that reached a
 *     user with nothing written down anywhere.
 *
 * Constant memory: one chunk in flight, never an accumulated copy.
 */
function countingPassThrough(
  source: ReadableStream<Uint8Array>,
  pubId: string,
  settle: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  // An explicit reader loop rather than a `TransformStream`, because the hook
  // that matters here is the SOURCE erroring and `Transformer.cancel` is not in
  // the lib types all four tsconfig projects see. Reading by hand puts the upstream
  // failure in an ordinary `catch`, which is both portable and the only place the
  // byte count is in scope.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        if (value !== undefined) {
          seen += value.byteLength;
          controller.enqueue(value);
        }
      } catch (err) {
        // An upstream reset, or our own abort firing mid-body. The status line
        // went out long ago, so the client now holds a truncated JSON document
        // and `Card.js` will render its own error — this line is the only record
        // of why, and its absence was the actual gap.
        settle();
        console.warn(
          `[mcp] embed data proxy response stream failed after ${seen}B for ${pubId}: ${String(err)}`,
        );
        controller.error(err);
      }
    },
    cancel(reason) {
      // The client went away (a closed tab, a navigated widget). Not a failure,
      // so it is not logged — but the timer has to go, and the upstream body
      // should stop being pulled.
      settle();
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Handle `POST /embed-data/{pub_id}` — forward the card's tab-data request to
 * Tako and hand the JSON back with CORS.
 *
 * The upstream URL is `${PUBLIC_BASE_URL}${UPSTREAM_DATA_PATH}` and nothing
 * about it comes from the request: not the origin, not the path (the pub_id
 * segment is a log correlator and reaches neither), not the query.
 *
 * The caller controls the body — but NOT all of it. An earlier version of this
 * comment said the body was "the same thing anyone pointed at the public embed
 * page already controls", which was wrong in the way that matters: for a
 * non-empty `pub_id` the upstream endpoint WRITES that card's stored config, with
 * no ownership check, and what has kept that off the internet is Django's CORS
 * allowlist — precisely the barrier this route's `ACAO: *` removes. So a
 * non-empty `pub_id` is refused here and the route is read-only upstream. See
 * {@link findUpstreamWrite}.
 *
 * What this route does NOT do, by construction:
 *
 *   - It forwards no headers but `content-type` and `accept`. No cookie, no
 *     `Authorization`, no `X-CSRFToken` — the endpoint needs none of them
 *     (verified against production: a bare anonymous POST returns 200), and
 *     inventing credentials here would turn a public passthrough into a
 *     confused deputy.
 *   - It does not follow a redirect, for the same reason the other two routes
 *     do not: a 3xx would make the content-type check and the body we serve
 *     under `ACAO: *` describe a host the configuration never named.
 *   - It reflects the body only when upstream declares JSON. `Card.js` calls
 *     `.json()` on the result, so an HTML error page is useless to it anyway,
 *     and this origin is the OAuth origin — see the header block below.
 *
 * Metered on the native-card limiter like its siblings, and for a sharper
 * reason: this is the only one of the three that costs Tako a query rather than
 * a cached render. Unlike them it is one request per user CLICK, not ~10 per
 * card render, so it sits far below the bucket that sizing was chosen for.
 */
export async function handleEmbedDataProxy(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const origins = resolveProxyOrigins(env, url.origin);
  if (origins === undefined) return undefined;
  // Correlator only — see `EMBED_DATA_PREFIX`. Declining a malformed one keeps
  // the route invisible, the same as the other two.
  const pubId = parsePubId(url.pathname, EMBED_DATA_PREFIX);
  if (pubId === undefined) return undefined;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        // Load-bearing, unlike on the two GET routes. `Card.js` sends
        // `Content-Type: application/json`, which is not a CORS-safelisted
        // value, so the browser preflights and will not send the POST unless
        // the header is named here. Without this line the route answers
        // correctly and is never reached.
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") return textResponse("method not allowed", 405);

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return textResponse("expected application/json", 415);
  }

  // Metered ahead of BOTH the body read and the upstream fetch, so a caller
  // cannot spend our memory or Tako's query budget on an unmetered request.
  // `embed_proxy.test.ts` pins the ordering.
  const limited = await rateLimited(request, env);
  if (limited !== undefined) return limited;

  const read = await readBoundedBody(request);
  if (read === "unreadable") {
    return textResponse("unreadable request body", 400);
  }
  if (read === "too-large") {
    return textResponse("request body too large", 413);
  }
  if (read.byteLength === 0) return textResponse("empty request body", 400);
  const body = read;

  // The upstream endpoint WRITES for a non-empty `pub_id` in the body, with no
  // ownership check. See `findUpstreamWrite` for the full shape and for why CORS
  // rather than authorization is what has kept that off the internet.
  const write = findUpstreamWrite(body);
  if (write !== undefined) {
    console.warn(
      `[mcp] embed data proxy refused a ${write} body for ${pubId} — this route forwards read-only requests only`,
    );
    return textResponse(
      write === "writes"
        ? // Named precisely, because the one way this can bite a real user is an
          // upstream frontend change that starts sending a pub_id for embeds.
          "pub_id must be empty: this route forwards read-only requests only"
        : "expected a JSON object",
      400,
    );
  }

  const upstream = `${origins.publicBase}${UPSTREAM_DATA_PATH}`;
  const controller = new AbortController();
  // NOT cleared when the headers arrive. `Card.js` sets no deadline of its own,
  // so this is the only bound on the whole exchange — and clearing it in a
  // `finally` around the fetch made it cover time-to-headers only, leaving a
  // stalled response body as an unbounded spinner in the tab the user just
  // clicked. `settle()` below clears it when the body actually finishes.
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    DATA_UPSTREAM_TIMEOUT_MS,
  );
  const settle = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      redirect: "manual",
    });
  } catch (err) {
    settle();
    console.warn(`[mcp] embed data proxy upstream failed for ${pubId}:`, err);
    return textResponse("upstream unavailable", 502);
  }

  if (!response.ok) {
    settle();
    console.warn(
      `[mcp] embed data proxy upstream HTTP ${response.status} for ${pubId}` +
        (response.status === 400
          ? ` — a 400 here is usually the request body exceeding Django's DATA_UPLOAD_MAX_MEMORY_SIZE (3.5 MB)`
          : ""),
    );
    return textResponse(
      response.status === 404 ? "data not found" : "upstream error",
      response.status === 404 ? 404 : 502,
    );
  }
  const upstreamType = response.headers.get("content-type") ?? "";
  if (!upstreamType.toLowerCase().includes("application/json")) {
    settle();
    console.warn(
      `[mcp] embed data proxy got non-JSON content-type "${upstreamType}" for ${pubId}`,
    );
    return textResponse("upstream returned non-JSON", 502);
  }

  // Streamed, not buffered, and deliberately so even though buffering would let
  // this return a clean 502 on a mid-flight failure instead of a truncated 200.
  //
  // Buffering does not actually save the user from anything: `Card.js` calls
  // `.json()` on the result, so a 502 and a truncated body produce the SAME
  // "There was an error loading the data." card. What it would cost is real —
  // responses measure up to 1.57 MB (larger than the requests, since the
  // accumulated config comes back with the new tab's data), so a second buffer
  // would undo what the request cap above is for, on the isolate that also serves
  // `/authorize`.
  //
  // What was genuinely missing was not the status code but the LOG: a stream that
  // died mid-flight was the one failure here that reached the user with nothing
  // written down. `countingPassThrough` fixes that half and leaves the memory
  // profile flat.
  // A 200 with no body at all: nothing will ever call `settle`, so do it here or
  // the abort timer stays armed for the full bound on a request that is finished.
  if (response.body === null) settle();
  return new Response(
    response.body === null
      ? null
      : countingPassThrough(response.body, pubId, settle),
    {
      status: 200,
      headers: {
        // Pinned, not reflected. This origin is the OAuth origin; the
        // content-type check above already refused anything else, and stating the
        // value we serve rather than echoing upstream's means a charset or
        // parameter surprise cannot become the MIME on `mcp.tako.com`.
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        // Live data behind a POST: nothing to cache, and the shared caches in
        // between have no business trying.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
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
  //
  // Applied to the raw path AND to a percent-decoded copy, because the raw form
  // alone did not deliver what the note above claims. `%2f` is not a segment
  // delimiter, so WHATWG parsing leaves `%2e%2e%2f` intact as ONE segment: the
  // path `archive/x/%2e%2e%2fuser-images/evil.html` starts with `archive/`,
  // holds no literal `..`, no leading `/` and no `\`, and so passed every guard
  // and reached the upstream fetch (verified on staging — 502, i.e. issued,
  // where the unencoded `..%2f` gives 400).
  //
  // It was not exploitable: CloudFront/S3 treat the encoded dots as a literal
  // key. But that means confinement rested on S3 key literalness rather than on
  // this code, and `ASSET_PATH_PREFIX` names what is on the other side of it —
  // a presigned-upload `.html` under `user-images/` served as a document on the
  // OAuth origin. Any normalizing hop added later (a CloudFront Function, a
  // URI-rewrite behavior, a move off the S3 origin) would arm it silently.
  //
  // Decoding rather than rejecting `%` outright, because an encoded slash is
  // legitimate here — it names an S3 key that literally contains one, and no
  // real asset path carries a percent-escape today (measured, 9 of 9 clean). A
  // malformed escape cannot be reasoned about, so it is refused.
  let decodedAssetPath: string;
  try {
    decodedAssetPath = decodeURIComponent(assetPath);
  } catch {
    return textResponse("bad asset path", 400);
  }
  const confined = (p: string): boolean =>
    p !== "" &&
    p.startsWith(ASSET_PATH_PREFIX) &&
    !p.includes("..") &&
    !p.startsWith("/") &&
    !p.includes("\\");
  if (!confined(assetPath) || !confined(decodedAssetPath)) {
    return textResponse("bad asset path", 400);
  }

  const limited = await rateLimited(request, env);
  if (limited !== undefined) return limited;

  // Query string deliberately DROPPED rather than forwarded.
  //
  // Forwarding it made this an amplifier. The query reaches CloudFront and lands
  // in the cache key for the `cacheEverything` subrequest below, so
  // `Card.js?<nonce>` misses cache on every distinct nonce: a ~200-byte request
  // buys a ~1.48 MB origin fetch, an `arrayBuffer()`, a `TextDecoder` decode, a
  // whole-body rewrite copy, and 1.48 MB of `ACAO: *` egress. Measured on
  // staging: 0.11 s cached vs 0.32-0.44 s per fresh nonce, so the query did
  // reach upstream and did defeat the cache. These handlers run ahead of the
  // whole OAuth subsystem (`index.ts`), so that pressure lands on `/authorize`,
  // `/token` and `/register` too, and the per-IP meter above fails open and
  // counts per colo.
  //
  // Safe to drop: `rewriteCdnUrls` never emits a query, and these are
  // content-hashed assets under `archive/<sha>/` — the hash IS the cache-buster,
  // so a query could only ever be someone else's. Measured on a real production
  // page, 0 of 9 rewritten urls carried one.
  const upstream = `${cdnBase}/${assetPath}`;
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
