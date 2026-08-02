/**
 * The embed-page proxy: the route that lets the widget read Tako's own card
 * markup, which the browser cannot fetch directly because `/embed/` serves no
 * `Access-Control-Allow-Origin`.
 *
 * Three properties carry real weight here, in this order:
 *
 *   1. INVISIBLE IN PRODUCTION. Gated on `PUBLIC_CDN_URL`; unset means the
 *      handler declines and the router 404s, so no new surface exists. A
 *      MALFORMED value declines too — these handlers run ahead of the whole
 *      OAuth surface, so a throw here would 500 `/authorize` and `/token`.
 *   2. NOT AN SSRF PRIMITIVE. The pub_id is interpolated into an upstream URL,
 *      so its shape is the security boundary. Neither route follows a redirect,
 *      and the asset route is confined to the `archive/` tree.
 *   3. NOTHING SENSITIVE CROSSES INTO THE SANDBOX. The upstream page carries a
 *      `csrfToken`; it must not reach a third-party iframe. A strip that misses
 *      on a body still carrying the token is a 502, not a pass-through.
 *   4. NEITHER ROUTE SERVES AN EXECUTABLE DOCUMENT. This origin is the OAuth
 *      origin. `/embed-html/` answers `text/plain` + `CSP: sandbox`, and
 *      `/cdn-asset/` reflects only inert content types.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env.js";
import {
  handleCdnAssetProxy,
  handleEmbedProxy,
  parsePubId,
  rewriteCdnUrls,
  sanitizeEmbedHtml,
} from "./embed_proxy.js";

const OFF: Env = { DJANGO_BASE_URL: "https://tako.com" };
const ON: Env = {
  ...OFF,
  PUBLIC_CDN_URL: "https://d12w4pyrrczi5e.cloudfront.net",
};

const PUB_ID = "VKd7qE8K9Ba16kMFENNQ";

/** A well-formed asset path: under `archive/`, which is the only served tree. */
const ASSET_PATH = "/cdn-asset/archive/abc/vite_dist/assets/Card.js";

/** Shape of the real embed page, trimmed to the parts that matter. */
const UPSTREAM_HTML = `<!doctype html><html><head>
<script type="module" src="https://d12w4pyrrczi5e.cloudfront.net/archive/abc/vite_dist/assets/Card.js"></script>
</head><body>
<script type="application/json">{"staticPrefix": "https://cdn/", "csrfToken": "SECRET-TOKEN-VALUE", "userLoggedIn": false}</script>
<script type="application/json">{"config_type": "timeseries:eav_v3", "params": {"title": "Nvidia Revenues"}}</script>
<script>(function(){var s=document.createElement('script');s.src='https://www.googletagmanager.com/gtag/js?id=G-X';document.head.appendChild(s)})()</script>
<div id="app"></div>
</body></html>`;

function req(path: string, method = "GET"): Request {
  return new Request(`https://mcp.tako.com${path}`, { method });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePubId", () => {
  it("accepts real pub_id shapes, with or without a trailing slash", () => {
    expect(parsePubId(`/embed-html/${PUB_ID}`)).toBe(PUB_ID);
    expect(parsePubId("/embed-html/vilUFuRZgsjKYP0qbB-A/")).toBe(
      "vilUFuRZgsjKYP0qbB-A",
    );
    expect(parsePubId("/embed-html/a_b-C9")).toBe("a_b-C9");
  });

  it("rejects anything that could redirect the upstream fetch", () => {
    // Each of these, unvalidated, would aim the server-side fetch somewhere
    // other than Tako's embed route.
    for (const bad of [
      "/embed-html/../../etc/passwd",
      "/embed-html/..%2f..%2fadmin",
      "/embed-html/evil.com/x",
      "/embed-html/http://evil.com",
      "/embed-html/a?b=c",
      "/embed-html/a#b",
      "/embed-html/with.dot",
      "/embed-html/",
      "/embed-html",
      "/other/path",
    ]) {
      expect(parsePubId(bad), bad).toBeUndefined();
    }
  });

  it("rejects an over-long id", () => {
    expect(parsePubId(`/embed-html/${"a".repeat(65)}`)).toBeUndefined();
  });
});

describe("sanitizeEmbedHtml", () => {
  it("removes the csrfToken and reports having done so", () => {
    const out = sanitizeEmbedHtml(UPSTREAM_HTML);
    expect(out.removedCsrf).toBe(true);
    expect(out.html).not.toContain("SECRET-TOKEN-VALUE");
    expect(out.html).not.toContain("csrfToken");
  });

  it("removes the analytics bootstrap", () => {
    // Not privacy theatre: googletagmanager.com is not in the widget's declared
    // resourceDomains, so it can only produce a CSP violation — and a blocked
    // subresource is what claude.ai reports as "problem displaying content".
    const out = sanitizeEmbedHtml(UPSTREAM_HTML);
    expect(out.removedAnalytics).toBe(true);
    expect(out.html).not.toContain("googletagmanager.com");
  });

  it("keeps staticPrefix while removing only csrfToken", () => {
    // Regression: an earlier version replaced the whole island with `{}`, which
    // also removed `staticPrefix` — the CDN base Card.js resolves its lazily
    // imported view chunks against. The card mounted its title and skeleton and
    // never drew a chart, silently.
    const out = sanitizeEmbedHtml(UPSTREAM_HTML);
    expect(out.removedCsrf).toBe(true);
    expect(out.html).not.toContain("SECRET-TOKEN-VALUE");
    expect(out.html).toContain("staticPrefix");
    expect(out.html).toContain("https://cdn/");
    expect(out.html).toContain("userLoggedIn");
  });

  it("leaves a non-JSON script that merely mentions csrfToken alone", () => {
    const inline = '<script>var x="csrfToken is a word";</script>';
    const out = sanitizeEmbedHtml(inline);
    expect(out.html).toBe(inline);
    expect(out.removedCsrf).toBe(false);
  });

  it("keeps the card config and the Card.js tag intact", () => {
    // The whole point of proxying rather than reimplementing.
    const out = sanitizeEmbedHtml(UPSTREAM_HTML);
    expect(out.html).toContain("timeseries:eav_v3");
    expect(out.html).toContain("Nvidia Revenues");
    expect(out.html).toContain("vite_dist/assets/Card.js");
    expect(out.html).toContain('<div id="app">');
  });

  it("leaves the document alone when the markers are absent", () => {
    // An upstream redesign should degrade to "unsanitized as expected", which
    // the caller can detect via the flags, not to a mangled document.
    const plain = "<!doctype html><html><body><div id=app></div></body></html>";
    const out = sanitizeEmbedHtml(plain);
    expect(out.html).toBe(plain);
    expect(out.removedCsrf).toBe(false);
  });

  it("keeps the script-breakout escaping the round-trip would drop", () => {
    // Django's `json_script` escapes `<`, `>`, `&` as `\u003C` / `\u003E` /
    // `\u0026` inside the JSON string precisely so no value can close the
    // `<script>` element. `JSON.parse` decodes those to literals and
    // `JSON.stringify` re-emits them RAW — so parsing an island and
    // re-serializing it silently removes a control Django put there on purpose.
    //
    // Latent rather than live today: this island's five keys are all
    // server-derived, and caller-authored card content lives in the separate
    // `config-json` island this replace never matches. It re-arms the moment one
    // user-influenced value joins the dict, which is why the control goes back
    // rather than the key list being trusted.
    const island =
      '<script id="server-config" type="application/json">' +
      '{"csrfToken":"T","title":"a \\u003C/script\\u003E\\u003Cimg src=x onerror=alert(1)\\u003E b"}' +
      "</script>";
    const out = sanitizeEmbedHtml(island);
    expect(out.removedCsrf).toBe(true);
    // The token is gone...
    expect(out.html).not.toContain("csrfToken");
    // ...and the payload never becomes markup.
    expect(out.html).not.toContain("</script><img");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("\\u003C/script\\u003E");
    // Exactly one script element survives, so the island did not terminate early.
    expect(out.html.match(/<\/script>/gi)?.length).toBe(1);
    // And the value still MEANS the same thing to anything that parses it.
    const body = out.html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect((JSON.parse(body) as { title: string }).title).toBe(
      "a </script><img src=x onerror=alert(1)> b",
    );
  });
});

describe("handleEmbedProxy — experiment off", () => {
  it("declines entirely, so the router 404s", async () => {
    await expect(
      handleEmbedProxy(req(`/embed-html/${PUB_ID}`), OFF),
    ).resolves.toBeUndefined();
  });
});

describe("handleEmbedProxy — experiment on", () => {
  it("declines a malformed pub_id rather than serving an error", async () => {
    // Falling through to the catch-all 404 keeps the route unadvertised.
    await expect(
      handleEmbedProxy(req("/embed-html/../secrets"), ON),
    ).resolves.toBeUndefined();
  });

  it("serves the sanitized page with CORS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(UPSTREAM_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    // NOT text/html. This is the OAuth origin, and script execution here could
    // drive `/register` + `/authorize` + `/token` same-origin with the victim's
    // session cookie. The widget only ever does `r.text()`, so plain text is
    // invisible to the one consumer.
    expect(res?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res?.headers.get("content-security-policy")).toBe("sandbox");
    expect(res?.headers.get("x-frame-options")).toBe("DENY");
    const body = await res!.text();
    expect(body).toContain("timeseries:eav_v3");
    expect(body).not.toContain("SECRET-TOKEN-VALUE");

    // Upstream must be the embed route for exactly this id, on the public base.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://tako.com/embed/${PUB_ID}/?dark_mode=auto`,
    );
  });

  it("does not forward credentials upstream", async () => {
    // The proxied output crosses into a third-party sandbox; a session cookie
    // picked up here would ride along with it.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(UPSTREAM_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "cookie",
    );
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "authorization",
    );
  });

  it("maps an upstream 404 to 404 and other failures to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );
    expect((await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON))?.status).toBe(
      404,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    expect((await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON))?.status).toBe(
      502,
    );
  });

  it("refuses a non-HTML upstream body", async () => {
    // A JSON error envelope or an image must never be handed to the widget as
    // a document to execute.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"error":"x"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect((await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON))?.status).toBe(
      502,
    );
  });

  it("answers 502 when the upstream fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect((await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON))?.status).toBe(
      502,
    );
  });

  it("answers a CORS preflight", async () => {
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`, "OPTIONS"), ON);
    expect(res?.status).toBe(204);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects a write method", async () => {
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`, "POST"), ON);
    expect(res?.status).toBe(405);
  });

  it("refuses to forward a csrfToken it could not strip", async () => {
    // FAILS CLOSED on invariant #3. Every non-match path in `sanitizeEmbedHtml`
    // returns the document untouched, which is right for the DOCUMENT and wrong
    // for the TOKEN: an upstream key rename or a whitespace change that breaks
    // `JSON.parse` would start forwarding a live CSRF token into a third-party
    // sandbox with nothing but a log line to say so. The route's whole failure
    // story is that a failure costs an upgrade — so no card beats a leaked
    // credential.
    const unparseable = `<!doctype html><html><body>
<script type="application/json">{"csrfToken": "SECRET-TOKEN-VALUE", oops,}</script>
</body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(unparseable, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(res?.status).toBe(502);
    expect(await res!.text()).not.toContain("SECRET-TOKEN-VALUE");
  });

  it("still serves a page that never carried a token", async () => {
    // The 502 above keys on the token still being PRESENT, not merely on the
    // strip having missed — an upstream that stops shipping the island at all is
    // a success, not a failure.
    const noToken = `<!doctype html><html><body><div id="app"></div></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(noToken, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(res?.status).toBe(200);
  });
});

describe("rewriteCdnUrls", () => {
  const CDN = "https://cdn.example.net";
  const TARGET = "https://mcp.tako.com/cdn-asset";

  it("repoints every occurrence and counts them", () => {
    const html = `<script src="${CDN}/archive/a/Card.js"></script><link href="${CDN}/archive/a/f.css">`;
    const out = rewriteCdnUrls(html, CDN, TARGET);
    expect(out.rewrites).toBe(2);
    expect(out.html).not.toContain(CDN);
    expect(out.html).toContain(`${TARGET}/archive/a/Card.js`);
  });

  it("leaves CDN urls outside archive/ pointing at the CDN", () => {
    // Scoped so we only rewrite what the asset route will actually serve. On a
    // real embed page the sole non-`archive/` reference is `previews/<hash>.png`
    // in a `<meta twitter:image>` and a `<noscript>` `<img>` — never fetched
    // with JS enabled, and an OG image belongs on the CDN anyway. Rewriting it
    // would only point it at a route that declines.
    const html = `<meta content="${CDN}/previews/x.png"><script src="${CDN}/archive/a/Card.js">`;
    const out = rewriteCdnUrls(html, CDN, TARGET);
    expect(out.rewrites).toBe(1);
    expect(out.html).toContain(`${CDN}/previews/x.png`);
    expect(out.html).toContain(`${TARGET}/archive/a/Card.js`);
  });

  it("produces no double slash", () => {
    // Regression: the target used to carry a trailing slash while the CDN
    // origin does not, yielding `/cdn-asset//archive/...` — which the asset
    // route then rejected as a path climbing out of its origin. 400 on every
    // asset, card mounts, no chart.
    const out = rewriteCdnUrls(`src="${CDN}/archive/x.js"`, CDN, TARGET);
    expect(out.html).toContain("/cdn-asset/archive/x.js");
    expect(out.html).not.toContain("//archive");
  });

  it("rewrites staticPrefix, not just tags", () => {
    // staticPrefix is the base Card.js builds runtime asset urls from, so this
    // is what makes the lazily imported chunks come back through the proxy.
    const out = rewriteCdnUrls(`{"staticPrefix": "${CDN}/archive/abc/"}`, CDN, TARGET);
    expect(out.html).toContain(`"${TARGET}/archive/abc/"`);
  });

  it("reports zero when the page references a different CDN", () => {
    // Staging and production use separate distributions and the mismatch is
    // silent, so the count is the only signal. The proxy logs on zero.
    const out = rewriteCdnUrls('src="https://other.net/archive/x.js"', CDN, TARGET);
    expect(out.rewrites).toBe(0);
  });
});

describe("handleCdnAssetProxy", () => {
  const ASSET = ASSET_PATH;

  it("declines when the experiment is off", async () => {
    await expect(handleCdnAssetProxy(req(ASSET), OFF)).resolves.toBeUndefined();
  });

  it("fetches from the CONFIGURED origin, never one from the request", async () => {
    // This is what keeps the route from being an open proxy: the caller controls
    // the path, never the host.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("export const x=1", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleCdnAssetProxy(req(ASSET), ON);
    expect(res?.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${ON.PUBLIC_CDN_URL}/archive/abc/vite_dist/assets/Card.js`,
    );
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("400s a path outside the one tree the card loads from", async () => {
    // A hard 400, not "400 or a decline" — these all still carry the route
    // prefix when they reach the handler, so a decline would mean the prefix
    // check failed to match, which is a different bug wearing this test's name.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of [
      "/cdn-asset/",
      "/cdn-asset/user-images/1/uuid/evil.html",
      "/cdn-asset/content-style/1/uuid/evil.html",
      "/cdn-asset/previews/x.png",
      "/cdn-asset/static/x.js",
      "/cdn-asset/archivex/x.js",
      "/cdn-asset/Archive/x.js",
    ]) {
      const res = await handleCdnAssetProxy(req(bad), ON);
      expect(res?.status, bad).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sees a traversal path, because URL parsing eats it first", async () => {
    // This is the assertion that carries the weight, and it is about the URL
    // PARSER rather than about the handler's guards.
    //
    // The WHATWG path parser resolves `..` segments and decodes `%2e` in order
    // to recognise them, so every encoded form collapses during
    // `new URL(request.url)` — before the handler is entered. What arrives no
    // longer carries the route prefix, so the handler declines and the router
    // 404s. The `includes("..")` guard in the handler is therefore defense in
    // depth, not the mechanism.
    //
    // Pinned explicitly so a refactor that builds `assetPath` from a raw string
    // instead of a parsed `URL` — where these WOULD be live traversal — fails
    // here rather than in production.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [raw, normalized] of [
      ["/cdn-asset/../secrets", "/secrets"],
      ["/cdn-asset/a/../../b", "/b"],
      ["/cdn-asset/%2e%2e/%2e%2e/x", "/x"],
      ["/cdn-asset/.%2e/.%2e/x", "/x"],
      ["/cdn-asset/%2E%2E/secrets", "/secrets"],
      [
        "/cdn-asset/archive/%2e%2e/%2e%2e/user-images/evil.html",
        "/user-images/evil.html",
      ],
    ] as const) {
      expect(new URL(req(raw).url).pathname, raw).toBe(normalized);
      // Prefix gone → decline → the router's catch-all 404.
      await expect(handleCdnAssetProxy(req(raw), ON), raw).resolves.toBeUndefined();
    }
    // `//evil.net/x.js` keeps the prefix but is caught by the guards.
    expect((await handleCdnAssetProxy(req("/cdn-asset//evil.net/x.js"), ON))?.status)
      .toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewrites CDN urls baked inside a JS bundle", async () => {
    // Vite built Card.js with the CDN as its base, so some dynamic imports are
    // absolute CDN urls the HTML rewrite never sees. Observed live as
    // TabSection.js and useTransactionDrawer.js dying on CORS while the rest of
    // the card rendered.
    const body = `import("${ON.PUBLIC_CDN_URL}/archive/abc/vite_dist/assets/TabSection.js")`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/javascript",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(req(ASSET), ON);
    const out = await res!.text();
    expect(out).not.toContain("cloudfront.net");
    expect(out).toContain("/cdn-asset/archive/abc/vite_dist/assets/TabSection.js");
    // And must NOT claim immutability for a body we generated: doing so pinned a
    // stale bundle in the browser for a year.
    expect(res?.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("passes an untouched asset through with its upstream caching", async () => {
    // A font is byte-identical to upstream, so `immutable` stays honest.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("fontbytes", {
          status: 200,
          headers: {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(
      req("/cdn-asset/archive/abc/fonts/google/geist/geist.woff2"),
      ON,
    );
    expect(res?.headers.get("cache-control")).toContain("immutable");
    // `access-control-allow-origin`, not `timing-allow-origin`, is what lets a
    // cross-origin font load at all.
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("content-type")).toBe("font/woff2");
  });

  it("maps upstream failures without leaking them as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("no", { status: 404 })),
    );
    expect((await handleCdnAssetProxy(req(ASSET), ON))?.status).toBe(404);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await handleCdnAssetProxy(req(ASSET), ON))?.status).toBe(502);
  });
});

describe("dark_mode forwarding", () => {
  function stubHtml() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(UPSTREAM_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("defaults to auto when the widget asks for nothing", async () => {
    const f = stubHtml();
    await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(String(f.mock.calls[0]?.[0])).toContain("dark_mode=auto");
  });

  it("forwards an explicit host theme", async () => {
    // `auto` follows the OS; a host that themes itself independently would get
    // a light card on a dark surface without this.
    for (const v of ["true", "false"]) {
      const f = stubHtml();
      await handleEmbedProxy(req(`/embed-html/${PUB_ID}?dark_mode=${v}`), ON);
      expect(String(f.mock.calls[0]?.[0])).toContain(`dark_mode=${v}`);
      vi.unstubAllGlobals();
    }
  });

  it("ignores anything that is not one of the two literals", async () => {
    // The value is interpolated into the upstream query, so it is allow-listed
    // rather than sanitised.
    for (const bad of ["auto&x=1", "1", "yes", "'; DROP", "true&evil=1"]) {
      const f = stubHtml();
      await handleEmbedProxy(
        req(`/embed-html/${PUB_ID}?dark_mode=${encodeURIComponent(bad)}`),
        ON,
      );
      expect(String(f.mock.calls[0]?.[0])).toContain("dark_mode=auto");
      expect(String(f.mock.calls[0]?.[0])).not.toContain("evil");
      vi.unstubAllGlobals();
    }
  });
});

describe("asset rewrite bounds", () => {
  it("serves an over-cap JS body unrewritten, measured off the BODY", async () => {
    // The origin is config-fixed so this is not an arbitrary-url risk, but a
    // rewrite holds the body and its copy — the cap keeps the worst case bounded
    // rather than trusting the CDN to stay reasonable.
    //
    // The cap is read off the accumulated body, and this test supplies NO
    // `content-length` on purpose. The previous version declared one, which is
    // why it passed while the real path bypassed the cap entirely: Workers
    // strips `Content-Length` when it auto-decompresses a gzipped response —
    // which is how CloudFront serves JavaScript — so the declared-length read
    // was `0` for `Card.js`, the one asset the cap exists for.
    const body = `import("${ON.PUBLIC_CDN_URL}/archive/a/x.js")${"/*".repeat(3 * 1024 * 1024)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(
      req("/cdn-asset/archive/abc/huge.js"),
      ON,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    // Unrewritten: correctness of the rewrite is traded for a bounded worst
    // case, and the assets that matter are far below the cap.
    expect(await res!.text()).toContain("cloudfront.net");
  });

  it("still rewrites an under-cap JS body that declares no content-length", async () => {
    // The header-absent path is the REAL one (`new Response(string)` sets no
    // length in workerd either), so it has to be the tested one.
    const body = `import("${ON.PUBLIC_CDN_URL}/archive/abc/vite_dist/assets/TabSection.js")`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(req(ASSET_PATH), ON);
    expect(res?.status).toBe(200);
    expect(await res!.text()).not.toContain("cloudfront.net");
  });
});

describe("a malformed PUBLIC_CDN_URL disables the experiment, not the server", () => {
  // These handlers run in `index.ts` ABOVE `/authorize`, `/token`, `/register`,
  // `/login`, `/oauth/stytch_callback` and both discovery documents. The origin
  // resolvers throw on a bad binding — deliberately, since their values reach a
  // browser — so without a catch here one trailing slash in `PUBLIC_CDN_URL`
  // turns the connector's whole auth flow into 500s while `POST /mcp` returns
  // earlier and keeps working. Tool traffic looks healthy; nobody can log in.
  const BAD: Env[] = [
    { ...OFF, PUBLIC_CDN_URL: "https://d12w4pyrrczi5e.cloudfront.net/" },
    { ...OFF, PUBLIC_CDN_URL: "not-a-url" },
    { ...OFF, PUBLIC_CDN_URL: "javascript:alert(1)" },
    { ...OFF, PUBLIC_CDN_URL: "ftp://cdn.example.net" },
  ];

  it("declines both routes instead of throwing", async () => {
    for (const env of BAD) {
      await expect(
        handleEmbedProxy(req(`/embed-html/${PUB_ID}`), env),
        env.PUBLIC_CDN_URL,
      ).resolves.toBeUndefined();
      await expect(
        handleCdnAssetProxy(req(ASSET_PATH), env),
        env.PUBLIC_CDN_URL,
      ).resolves.toBeUndefined();
    }
  });

  it("declines when PUBLIC_BASE_URL is the malformed one", async () => {
    // The embed route interpolates this origin too, and it throws on the same
    // invariants. One bad binding turns the feature off, never the server.
    const env: Env = { ...ON, PUBLIC_BASE_URL: "https://tako.com/" };
    await expect(
      handleEmbedProxy(req(`/embed-html/${PUB_ID}`), env),
    ).resolves.toBeUndefined();
  });
});

describe("neither route follows a redirect", () => {
  // The docstring's guarantee — "the upstream ORIGIN is fixed by configuration,
  // never taken from the request" — holds for the request we ISSUE but not for
  // the response we SERVE if a 3xx is followed. Tako's origin does redirect on
  // this class of path (canonical-host 301/308, `redirect("/login")`), so every
  // downstream decision would be judging a document from whatever host the chain
  // ended at, re-served under our origin with `ACAO: *`.
  it("asks fetch for manual redirect handling on both routes", async () => {
    // A fresh Response per call: a body stream can only be read once, and the
    // asset route passes it straight through.
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(UPSTREAM_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");

    fetchMock.mockClear();
    await handleCdnAssetProxy(req(ASSET_PATH), ON);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
  });

  it("treats a 3xx as an upstream error on both routes", async () => {
    for (const status of [301, 302, 307, 308]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(null, {
            status,
            headers: { location: "https://evil.example/x" },
          }),
        ),
      );
      expect(
        (await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON))?.status,
        `embed ${status}`,
      ).toBe(502);
      expect(
        (await handleCdnAssetProxy(req(ASSET_PATH), ON))?.status,
        `asset ${status}`,
      ).toBe(502);
      vi.unstubAllGlobals();
    }
  });
});

describe("the asset route reflects only inert content types", () => {
  // Whatever MIME the CDN declares would otherwise become the MIME we serve on
  // `mcp.tako.com`, the OAuth origin — and the distribution fronts an S3 bucket
  // that also holds presigned user uploads with caller-negotiated types.
  // `ASSET_PATH_PREFIX` puts those out of reach; this is the second lock.
  async function serve(contentType: string): Promise<string | null> {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("bytes", { status: 200, headers: { "content-type": contentType } }),
      ),
    );
    const res = await handleCdnAssetProxy(
      req("/cdn-asset/archive/abc/asset.bin"),
      ON,
    );
    const got = res?.headers.get("content-type") ?? null;
    vi.unstubAllGlobals();
    return got;
  }

  it("passes the types a chart actually needs", async () => {
    for (const ct of [
      "application/javascript",
      "text/javascript; charset=utf-8",
      "text/css",
      "font/woff2",
      "application/json",
      "image/png",
      "image/webp",
    ]) {
      expect(await serve(ct), ct).toBe(ct);
    }
  });

  it("forces anything that could script to application/octet-stream", async () => {
    for (const ct of [
      "text/html",
      "text/html; charset=utf-8",
      // SVG scripts, so it is deliberately NOT on the allow-list even though it
      // is an image type.
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "application/x-shockwave-flash",
    ]) {
      expect(await serve(ct), ct).toBe("application/octet-stream");
    }
  });
});
