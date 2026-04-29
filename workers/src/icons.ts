/**
 * `/icons/*` proxy — serves Tako's brand icons from the worker so the
 * URLs we advertise in `serverInfo.icons` (Claude / ChatGPT connector
 * cards) are stable across Tako frontend deploys.
 *
 * Why proxy instead of pointing connectors at Tako's CDN directly:
 *   - `tako.com/static/...` 404s; static assets are served only from
 *     CloudFront under a hashed-archive path that rotates per deploy
 *     (`d12w4pyrrczi5e.cloudfront.net/archive/<hash>/images/...`).
 *   - The unhashed `tako.com/favicon.ico` redirector is the only stable
 *     entrypoint Tako maintains, but it's ICO-only and assumes the
 *     consumer follows 301 redirects when fetching icons (not all MCP
 *     hosts do).
 *   - Hardcoding the hashed CloudFront URL into `serverInfo.icons`
 *     would lock the connector to whichever Tako deploy was current
 *     when this worker was built. Eventually CloudFront GCs old
 *     archives; the connector then renders a globe again.
 *
 * Proxying through `/icons/*` lets us own the public URL while
 * isolating the rot risk to a single constant in this file. When Tako's
 * frontend redeploys with a different favicon (or the archive layout
 * changes), update `ICON_ARCHIVE_BASE` and redeploy the worker —
 * connector cards self-heal on their next icon refresh.
 */

// Fully-qualified CloudFront archive path for the current Tako frontend
// deploy. Verified against `tako.com/favicon.ico` (which 301s here) on
// 2026-04-29. If `/icons/*` starts 502'ing in production, this is the
// first thing to check — `curl -I https://tako.com/favicon.ico` returns
// the current canonical archive base in the `location:` header.
const ICON_ARCHIVE_BASE =
  "https://d12w4pyrrczi5e.cloudfront.net/archive/5135af67e713650ba06591ae914abf245774ef98/images";

// Whitelist of public path → upstream filename. Whitelist (not pattern
// match) so a request for `/icons/../../etc/passwd` or any path Tako
// hasn't shipped under `images/` returns 404 immediately, without a
// round-trip to CloudFront.
const ICON_MAP: Record<string, string> = {
  "/icons/favicon.svg": "favicon.svg",
  "/icons/favicon-light.svg": "favicon-light.svg",
  "/icons/apple-touch-icon.png": "apple-touch-icon.png",
};

// One day. Connector hosts re-poll icons on their own schedule, so this
// just bounds how stale a cached copy can be after we redeploy with a
// new `ICON_ARCHIVE_BASE`. Trades freshness against upstream load —
// 86 400 keeps the worker from hammering CloudFront on every request.
const ICON_CACHE_MAX_AGE_SECONDS = 86_400;

export async function handleIconRequest(pathname: string): Promise<Response> {
  const upstreamName = ICON_MAP[pathname];
  if (upstreamName === undefined) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // `cf: { cacheEverything, cacheTtl }` pins the response in the Workers
  // edge cache for the TTL window so subsequent worker invocations skip
  // the CloudFront round-trip. Distinct from the `cache-control` header
  // we set below, which governs downstream/connector-host caching.
  let upstream: Response;
  try {
    upstream = await fetch(`${ICON_ARCHIVE_BASE}/${upstreamName}`, {
      cf: {
        cacheEverything: true,
        cacheTtl: ICON_CACHE_MAX_AGE_SECONDS,
      },
    });
  } catch {
    return new Response("upstream fetch failed", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!upstream.ok) {
    return new Response("upstream error", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // Forward only the bits we actually want. CloudFront sends a pile of
  // amz-* / cache-control headers we don't want bleeding through into
  // our response surface.
  const headers = new Headers();
  const upstreamContentType = upstream.headers.get("content-type");
  if (upstreamContentType !== null) {
    headers.set("content-type", upstreamContentType);
  }
  headers.set(
    "cache-control",
    `public, max-age=${ICON_CACHE_MAX_AGE_SECONDS}, s-maxage=${ICON_CACHE_MAX_AGE_SECONDS}`,
  );
  return new Response(upstream.body, { status: 200, headers });
}
