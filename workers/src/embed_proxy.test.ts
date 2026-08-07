/**
 * The embed-page proxy: the route that lets the widget read Tako's own card
 * markup, which the browser cannot fetch directly because `/embed/` serves no
 * `Access-Control-Allow-Origin`.
 *
 * Three properties carry real weight here, in this order:
 *
 *   1. ABSENT WITHOUT ITS BINDING. Gated on `PUBLIC_CDN_URL`; unset means the
 *      handler declines and the router 404s, so no new surface exists. Both
 *      deployed envs now SET it, so in staging and production these routes are
 *      live and the properties below are load-bearing rather than theoretical.
 *      A MALFORMED value declines too — these handlers run ahead of the whole
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
 *
 * `/embed-data/` is the third route and shares all four. It is the card's own
 * tab-data endpoint, which the page resolves against `window.location.href` —
 * the host's sandbox inside a widget, so without the passthrough and the shim
 * that repoints it, every tab the page did not inline showed "There was an error
 * loading the data."
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env.js";
import {
  dataProxyShim,
  findUpstreamWrite,
  handleCdnAssetProxy,
  handleEmbedDataProxy,
  handleEmbedProxy,
  injectDataProxyShim,
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
<input type="hidden" name="csrfmiddlewaretoken" value="SECRET-MIDDLEWARE-TOKEN">
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

  it("removes Django's OTHER csrf token, the hidden input", () => {
    // `{% csrf_token %}` renders `<input type=hidden name=csrfmiddlewaretoken>`
    // into the body. The island strip never touched it and the fail-closed guard
    // greps for the camelCase spelling, so it rode into the sandbox on every
    // render while the module's own header claimed it did not.
    const out = sanitizeEmbedHtml(UPSTREAM_HTML);
    expect(out.removedCsrfInput).toBe(true);
    expect(out.html).not.toContain("SECRET-MIDDLEWARE-TOKEN");
    expect(out.html).not.toContain("csrfmiddlewaretoken");
  });

  it("reports honestly when there was no hidden input to strip", () => {
    const out = sanitizeEmbedHtml("<!doctype html><html><body></body></html>");
    expect(out.removedCsrfInput).toBe(false);
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

    // Upstream must be the embed route for exactly this id, on the public
    // base, and it must ask the page to skip analytics: this markup crosses
    // into a third-party widget sandbox, where a Google Tag Manager beacon has
    // no business (and would only trip the sandbox CSP). The sanitizer still
    // strips GA if the flag is ever not honoured — see `sanitizeEmbedHtml`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://tako.com/embed/${PUB_ID}/?dark_mode=auto&disable_tracking=true`,
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

  it("refuses a SECOND occurrence the strip did not match, even after it succeeded", async () => {
    // The guard used to read `!stripped && html.includes(token)`, which skipped
    // the scan entirely once a strip reported success — the same shape as the
    // miss this PR is fixing. `sanitizeEmbedHtml`'s island replacer returns the
    // script untouched for anything it cannot `JSON.parse`, so a page carrying
    // the real island PLUS an unparseable script that mentions the token sets
    // `removedCsrf = true` and forwarded the second one.
    //
    // The unconditional scan cannot false-positive, because neither replacement
    // re-emits the token string: one leaves `data-tako-stripped="csrf"` over a
    // token-free dict, the other an HTML comment. Every other test in this file
    // that expects a 200 is the proof of that.
    const twice = `<!doctype html><html><body>
<script type="application/json">{"staticPrefix":"https://cdn/","csrfToken":"SECRET-TOKEN-VALUE"}</script>
<script>var leftover = {csrfToken: "SECOND-COPY"};</script>
</body></html>`;
    const sanitized = sanitizeEmbedHtml(twice);
    // The first island WAS stripped — this is not a "the strip broke" case.
    expect(sanitized.removedCsrf).toBe(true);
    expect(sanitized.html).not.toContain("SECRET-TOKEN-VALUE");
    // ...and the second copy survived the sanitizer, which is why the route has
    // to be the one that refuses.
    expect(sanitized.html).toContain("SECOND-COPY");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(twice, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(res?.status).toBe(502);
    expect(await res!.text()).not.toContain("SECOND-COPY");
  });

  it("refuses to forward a csrfmiddlewaretoken it could not strip", async () => {
    // Same fail-closed rule for Django's other spelling. The strip is a regex on
    // the tag, so a shape it cannot match — the name in a `data-` attribute, a
    // `>` inside an attribute value — must be a 502 rather than a pass-through.
    const odd = `<!doctype html><html><body>
<div data-csrfmiddlewaretoken="SECRET-MIDDLEWARE-TOKEN"></div>
</body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(odd, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    expect(res?.status).toBe(502);
    expect(await res!.text()).not.toContain("SECRET-MIDDLEWARE-TOKEN");
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

describe("the rewrite is wired into handleEmbedProxy, not just exported", () => {
  // `rewriteCdnUrls` has direct tests above, and the JS path is covered through
  // `handleCdnAssetProxy` — but nothing asserted that the HANDLER actually calls
  // it on the page body. That wiring is the whole feature: an unrewritten page
  // sends Card.js straight to the CDN, which reflects CORS for tako.com alone,
  // so a `type="module"` load fails and no chart draws. Until this test existed
  // the property was verified only post-deploy, by smoke step 6.
  it("rewrites the page's CDN urls to this origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(UPSTREAM_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    const body = await res!.text();
    // Origin-qualified: `widgetOrigin` prefers `PUBLIC_MCP_URL` over the request
    // origin, so a bare `/cdn-asset/` substring would pass while every asset
    // pointed at a different worker.
    expect(body).toContain("https://mcp.tako.com/cdn-asset/archive/abc/");
    // And the CDN origin is gone from the markup the widget receives.
    expect(body).not.toContain("d12w4pyrrczi5e.cloudfront.net");
  });
});

describe("NATIVE_CARD_RATE_LIMITER", () => {
  // A binding of its own rather than the free tier's, because one card render is
  // ~10 metered subresource fetches against a bucket of 10 sized for tool calls
  // — measured on staging as requests 1-10 served and 11-14 all 429, i.e. the
  // feature throttling its own assets.
  const limiter = (success: boolean) => ({ limit: vi.fn().mockResolvedValue({ success }) });

  it("429s both routes when the bucket is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...ON, NATIVE_CARD_RATE_LIMITER: limiter(false) } as unknown as Env;

    const page = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), env);
    expect(page?.status).toBe(429);
    const asset = await handleCdnAssetProxy(req(ASSET_PATH), env);
    expect(asset?.status).toBe(429);
    // The point of metering: the upstream work never happened.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("meters BEFORE the upstream fetch, on both routes", async () => {
    // Ordering is the property with teeth. A refactor that moves either
    // `rateLimited` call below its fetch leaves a meter that reports honestly
    // and bounds nothing — the ~1.5 MB buffer-and-rewrite it exists to prevent
    // has already run. Nothing else in this file would go red.
    const order: string[] = [];
    // One implementation for both phases, swapping only the body it returns.
    // Reassigning via `mockResolvedValue` would REPLACE this implementation and
    // stop recording `fetch` — which is how the first draft of this test
    // "passed" the asset route and then reported `['limit']` for the page route.
    let upstream = () =>
      new Response("export const x=1", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    const fetchMock = vi.fn().mockImplementation(() => {
      order.push("fetch");
      return Promise.resolve(upstream());
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...ON,
      NATIVE_CARD_RATE_LIMITER: {
        limit: vi.fn().mockImplementation(() => {
          order.push("limit");
          return Promise.resolve({ success: true });
        }),
      },
    } as unknown as Env;

    await handleCdnAssetProxy(req(ASSET_PATH), env);
    expect(order).toEqual(["limit", "fetch"]);

    order.length = 0;
    upstream = () =>
      new Response(UPSTREAM_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), env);
    expect(order).toEqual(["limit", "fetch"]);
  });

  it("fails OPEN when the limiter throws", async () => {
    // Unlike the login buckets, which fail closed. A limiter outage here must
    // degrade to an unmetered chart, never a missing one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("export const x=1", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      ),
    );
    const env = {
      ...ON,
      NATIVE_CARD_RATE_LIMITER: {
        limit: vi.fn().mockRejectedValue(new Error("limiter down")),
      },
    } as unknown as Env;
    const res = await handleCdnAssetProxy(req(ASSET_PATH), env);
    expect(res?.status).toBe(200);
  });

  it("serves unmetered when the binding is absent", async () => {
    // `ON` carries no limiter, which is the local-dev shape.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("export const x=1", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(req(ASSET_PATH), ON);
    expect(res?.status).toBe(200);
  });
});

describe("the asset route is not a cache-busting amplifier", () => {
  it("drops the query string instead of forwarding it upstream", async () => {
    // Forwarded, the query landed in CloudFront's cache key for the
    // `cacheEverything` subrequest, so `Card.js?<nonce>` missed cache on every
    // distinct nonce: a ~200-byte request bought a ~1.48 MB origin fetch, a
    // decode, a whole-body rewrite copy and 1.48 MB of `ACAO: *` egress.
    // Measured on staging at 0.11 s cached vs 0.32-0.44 s per fresh nonce.
    // Content-hashed assets under `archive/<sha>/` carry their own buster, and
    // `rewriteCdnUrls` never emits a query, so there is nothing legitimate to
    // forward.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("export const x=1", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleCdnAssetProxy(req(`${ASSET_PATH}?nonce=abc123`), ON);
    expect(res?.status).toBe(200);
    const called = String(fetchMock.mock.calls[0]?.[0]);
    expect(called).toBe(`${ON.PUBLIC_CDN_URL}/archive/abc/vite_dist/assets/Card.js`);
    expect(called).not.toContain("nonce");
    expect(called).not.toContain("?");
  });
});

describe("path confinement survives percent-encoding", () => {
  it("400s an encoded traversal that the raw guards let through", async () => {
    // `%2f` is not a segment delimiter, so WHATWG parsing leaves `%2e%2e%2f`
    // intact as ONE segment: the path still starts with `archive/`, holds no
    // literal `..`, no leading `/` and no `\`, and so passed every guard and
    // reached the upstream fetch. Verified on staging before the fix — 502 (the
    // fetch was issued) where the unencoded `..%2f` gives 400.
    //
    // It was not exploitable, because CloudFront/S3 treat the encoded dots as a
    // literal key. That is the problem: confinement rested on S3 key literalness
    // rather than on this code, and any normalizing hop added later (a
    // CloudFront Function, a URI-rewrite behavior, a move off the S3 origin)
    // would have armed it with nothing going red.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of [
      "/cdn-asset/archive/x/%2e%2e%2fuser-images/evil.html",
      "/cdn-asset/archive/x/%2E%2E%2fcontent-style/evil.html",
      "/cdn-asset/archive/x/%2e%2e%2F%2e%2e%2Fstatic/x.js",
    ]) {
      const res = await handleCdnAssetProxy(req(bad), ON);
      expect(res?.status, bad).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s a malformed escape rather than guessing at it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleCdnAssetProxy(req("/cdn-asset/archive/x/%zz.js"), ON);
    expect(res?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still serves an encoded slash, which names a real S3 key (asset route)", async () => {
    // Not traversal — an S3 key can literally contain a slash, so decoding must
    // not become a reason to reject one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("body", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      ),
    );
    const res = await handleCdnAssetProxy(
      req("/cdn-asset/archive/abc/b%2Fc.js"),
      ON,
    );
    expect(res?.status).toBe(200);
  });
});

describe("dataProxyShim", () => {
  const TARGET = "https://mcp.tako.com/embed-data/";

  it("rewrites only the card's data endpoint", () => {
    const shim = dataProxyShim(TARGET);
    // The shim matches on the RESOLVED pathname being exactly this. Anything
    // else — the `staticPrefix`-relative `geo/*.json` map features, whatever gets
    // added next — has to go where the page sent it.
    expect(shim).toContain('"/knowledge/get_data/"');
    expect(shim).toContain("u.pathname===P");
    expect(shim).toContain(JSON.stringify(TARGET));
  });

  it("falls through to the real fetch instead of throwing", () => {
    // A throw here would take out the card's OTHER fetches with it, and a chart
    // that does not draw is worse than a tab that does not load.
    const shim = dataProxyShim(TARGET);
    expect(shim).toContain("catch(e){}");
    expect(shim).toContain("to===null?f.apply(window,arguments)");
  });

  it("cannot terminate the script element that carries it", () => {
    // The origin is already vetted by `validatePublicOrigin`, so this is belt to
    // that brace — but the url reaches a browser inside a `<script>`, and the one
    // escape that matters costs nothing.
    const shim = dataProxyShim("https://evil.example</script><img src=x>/");
    expect(shim).not.toContain("</script><img");
    expect(shim).toContain("\\u003C/script");
    // Exactly one closing tag: the one we wrote.
    expect(shim.match(/<\/script>/gi)?.length).toBe(1);
  });

  it("actually redirects the page's own call, evaluated", () => {
    // The regexes above say the shim mentions the right strings. This says it
    // behaves: run it against a stub `window` shaped like the sandbox and check
    // where the card's exact call lands.
    const calls: unknown[][] = [];
    const win: Record<string, unknown> = {
      location: { href: "https://claude-sandbox.example/widget/abc" },
      fetch: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve("ok");
      },
    };
    const body = dataProxyShim(TARGET)
      .replace(/^<script>/, "")
      .replace(/<\/script>$/, "");
    // eslint-disable-next-line no-new-func
    new Function("window", "URL", body)(win, URL);

    const patched = win.fetch as (input: unknown, init?: unknown) => unknown;
    // Exactly what `Card.js` does: `new URL("/knowledge/get_data/",
    // window.location.href).toString()`, POST, JSON body.
    const asCardDoes = new URL(
      "/knowledge/get_data/",
      "https://claude-sandbox.example/widget/abc",
    ).toString();
    patched(asCardDoes, { method: "POST", body: "{}" });
    expect(calls[0]?.[0]).toBe(TARGET);
    expect((calls[0]?.[1] as { method: string }).method).toBe("POST");

    // ...and an unrelated fetch is left exactly where the page aimed it.
    patched("https://d12w4pyrrczi5e.cloudfront.net/archive/a/geo/countries.json");
    expect(calls[1]?.[0]).toBe(
      "https://d12w4pyrrczi5e.cloudfront.net/archive/a/geo/countries.json",
    );
  });
});

describe("injectDataProxyShim", () => {
  const TARGET = "https://mcp.tako.com/embed-data/";

  it("lands before Card.js by landing in the head", () => {
    const out = injectDataProxyShim(
      '<!doctype html><html><head><script type="module" src="/Card.js"></script></head><body></body></html>',
      TARGET,
    );
    expect(out.anchor).toBe("head");
    expect(out.html.indexOf("window.fetch=")).toBeLessThan(
      out.html.indexOf("</head>"),
    );
  });

  it("falls back to the body, then to appending — never to prepending", () => {
    // Prepending would put a script ahead of `<!doctype html>` and drop the page
    // into quirks mode: changing the card's LAYOUT to fix its data. Appending is
    // still correct, because `Card.js` is a deferred module and this is a classic
    // script.
    const noHead = injectDataProxyShim(
      "<!doctype html><html><body><div id=app></div></body></html>",
      TARGET,
    );
    expect(noHead.anchor).toBe("body");
    expect(noHead.html.startsWith("<!doctype html>")).toBe(true);

    const neither = injectDataProxyShim("<div id=app></div>", TARGET);
    expect(neither.anchor).toBe("append");
    expect(neither.html.startsWith("<div id=app>")).toBe(true);
  });

  it("leaves the document otherwise untouched", () => {
    const doc = '<!doctype html><html><head><title>T</title></head><body>x</body></html>';
    const out = injectDataProxyShim(doc, TARGET);
    expect(out.html).toContain("<title>T</title>");
    expect(out.html).toContain("<body>x</body>");
  });
});

describe("the shim is wired into handleEmbedProxy, not just exported", () => {
  it("injects a shim pointing at this origin's data route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(UPSTREAM_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), ON);
    const body = await res!.text();
    // Including the pub_id: that is what lets the data route's failures name the
    // card, since its request body is opaque JSON and carries no id of its own.
    expect(body).toContain(`https://mcp.tako.com/embed-data/${PUB_ID}`);
    expect(body).toContain("/knowledge/get_data/");
    // And the page it was injected into is still the page.
    expect(body).toContain("timeseries:eav_v3");
    expect(body).toContain("vite_dist/assets/Card.js");
  });

  it("serves no page at all rather than a shimless one, on a bad origin", async () => {
    // The shim shares the CDN rewrite's gate: both need a resolved widget
    // origin. There is no half-configured state to fall into, because
    // `resolveProxyOrigins` turns an unresolvable origin into "experiment off"
    // for all three routes together — the embed page is useless without its
    // assets, and now also without its data.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleEmbedProxy(req(`/embed-html/${PUB_ID}`), {
      ...ON,
      PUBLIC_MCP_URL: "not a url",
    } as unknown as Env);
    expect(res).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("findUpstreamWrite", () => {
  // The upstream endpoint is not read-only. `GetData.post` (tako repo,
  // `app/backend/knowledge/views.py`) is `csrf_exempt` and unauthenticated, and
  // for a non-empty `pub_id` it overwrites that card's `viz_config` and `data`
  // with no ownership check — `frozen_after_sharing` is `BooleanField(null=True)`
  // so the default branch is writable. Django's closed `CORS_ALLOWED_ORIGINS` is
  // what keeps a drive-by page off it, and this route's `ACAO: *` removes exactly
  // that. So this gate is the replacement barrier.
  const enc = (v: unknown): ArrayBuffer =>
    new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer;

  it("passes the shape the card actually sends", () => {
    // Measured on all eleven data requests of a full twelve-tab walk: `pub_id`
    // is `""` every time, because `window.frameElement` is null in any
    // cross-origin embed. Absent and null are the same read-only shape.
    expect(findUpstreamWrite(enc({ config_type: "x", pub_id: "" }))).toBeUndefined();
    expect(findUpstreamWrite(enc({ config_type: "x" }))).toBeUndefined();
    expect(findUpstreamWrite(enc({ config_type: "x", pub_id: null }))).toBeUndefined();
  });

  it("refuses any non-empty pub_id, including a non-string one", () => {
    // Django's `if pub_id:` is a truthiness test, so anything truthy reaches the
    // write — a number and a list included.
    expect(findUpstreamWrite(enc({ pub_id: "VKd7qE8K9Ba16kMFENNQ" }))).toBe("writes");
    expect(findUpstreamWrite(enc({ pub_id: 1 }))).toBe("writes");
    expect(findUpstreamWrite(enc({ pub_id: ["a"] }))).toBe("writes");
    expect(findUpstreamWrite(enc({ pub_id: { toString: 1 } }))).toBe("writes");
  });

  it("refuses a body that is not a JSON object", () => {
    // Free with the parse, and the route was forwarding these blind before.
    expect(findUpstreamWrite(enc([1, 2]))).toBe("not-an-object");
    expect(findUpstreamWrite(enc("a string"))).toBe("not-an-object");
    expect(findUpstreamWrite(enc(null))).toBe("not-an-object");
    expect(
      findUpstreamWrite(new TextEncoder().encode("{oops,").buffer as ArrayBuffer),
    ).toBe("not-json");
  });
});

describe("handleEmbedDataProxy", () => {
  // The pub_id in the path is a LOG CORRELATOR. It never reaches the upstream url
  // and never reaches the body.
  const DATA_PATH = `/embed-data/${PUB_ID}`;

  const dataReq = (method = "POST", body = '{"config_type":"x"}'): Request =>
    method === "POST"
      ? new Request(`https://mcp.tako.com${DATA_PATH}`, {
          method,
          headers: { "content-type": "application/json" },
          body,
        })
      : new Request(`https://mcp.tako.com${DATA_PATH}`, {
          method,
          headers: { "content-type": "application/json" },
        });

  const jsonUpstream = (body = '{"component_data":[]}') =>
    vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("declines when the experiment is off, so the router 404s", async () => {
    await expect(handleEmbedDataProxy(dataReq(), OFF)).resolves.toBeUndefined();
  });

  it("declines a path with no pub_id, or a malformed one", async () => {
    // Same shape as `/embed-html/`: declining keeps the route invisible rather
    // than answering an error from a path we do not serve.
    for (const path of [
      "/embed-data/",
      "/embed-data",
      "/embed-data/a/b",
      "/embed-data/../secrets",
      `/embed-data/${"a".repeat(65)}`,
    ]) {
      await expect(
        handleEmbedDataProxy(
          new Request(`https://mcp.tako.com${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          ON,
        ),
        path,
      ).resolves.toBeUndefined();
    }
  });

  it("forwards the body to the CONFIGURED origin and constant path", async () => {
    const fetchMock = jsonUpstream();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleEmbedDataProxy(dataReq(), ON);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.json()).toEqual({ component_data: [] });

    // Neither the origin nor the path may come from the caller — and the pub_id
    // segment in particular must NOT appear upstream, or the correlator would
    // have become an injection point.
    const called = String(fetchMock.mock.calls[0]?.[0]);
    expect(called).toBe("https://tako.com/knowledge/get_data/");
    expect(called).not.toContain(PUB_ID);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(
      '{"config_type":"x"}',
    );
  });

  it("refuses a body that would make the upstream WRITE", async () => {
    // The security property this route rests on. `findUpstreamWrite` has the full
    // reasoning; this pins that the handler actually consults it, and that the
    // refusal happens BEFORE the request is issued.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleEmbedDataProxy(
      dataReq("POST", JSON.stringify({ config_type: "x", pub_id: PUB_ID })),
      ON,
    );
    expect(res?.status).toBe(400);
    expect(await res!.text()).toContain("pub_id must be empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a JSON object, without forwarding it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["[1,2]", '"a string"', "{oops,"]) {
      const res = await handleEmbedDataProxy(dataReq("POST", bad), ON);
      expect(res?.status, bad).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards no credentials, invents none, and does not follow a redirect", async () => {
    const fetchMock = jsonUpstream();
    vi.stubGlobal("fetch", fetchMock);
    await handleEmbedDataProxy(
      new Request(`https://mcp.tako.com${DATA_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "sessionid=SECRET",
          authorization: "Bearer SECRET",
        },
        body: "{}",
      }),
      ON,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headerKeys = Object.keys(
      (init.headers ?? {}) as Record<string, string>,
    ).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("cookie");
    expect(headerKeys).not.toContain("authorization");
    expect(headerKeys).not.toContain("x-csrftoken");
    expect(init.redirect).toBe("manual");
  });

  it("answers a preflight that NAMES content-type", async () => {
    // Load-bearing, unlike on the two GET routes. `Card.js` sends
    // `Content-Type: application/json`, which is not CORS-safelisted, so the
    // browser preflights — and without `allow-headers` it never sends the POST
    // at all, no matter how correct this handler is.
    const res = await handleEmbedDataProxy(dataReq("OPTIONS"), ON);
    expect(res?.status).toBe(204);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res?.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("rejects a GET and a non-JSON content type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await handleEmbedDataProxy(dataReq("GET"), ON))?.status).toBe(405);
    const wrongType = new Request(`https://mcp.tako.com${DATA_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: "<html>",
    });
    expect((await handleEmbedDataProxy(wrongType, ON))?.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty body and an over-cap body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const empty = new Request(`https://mcp.tako.com${DATA_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect((await handleEmbedDataProxy(empty, ON))?.status).toBe(400);

    // The cap is 3 MB, sized UNDER Django's `DATA_UPLOAD_MAX_MEMORY_SIZE` of
    // 3.5 MB so that everything this route accepts is something Django will also
    // accept. A cap above that could only trade a clear 413 for an `upstream
    // HTTP 400` that says nothing about size. Real bodies reach 1.29 MB after
    // twelve tabs.
    const huge = new Request(`https://mcp.tako.com${DATA_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(3 * 1024 * 1024 + 16)}"}`,
    });
    expect((await handleEmbedDataProxy(huge, ON))?.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading an over-cap body instead of buffering it whole", async () => {
    // The ordering here is the property, not the 413. `arrayBuffer()` then
    // checking `byteLength` reads the wrong way round: Cloudflare accepts up to
    // 100 MB while an isolate has 128 MB, and exceeding that KILLS the isolate
    // rather than throwing something catchable — on the origin that also serves
    // `/authorize` and `/token`. So the check has to happen mid-stream.
    //
    // A stream body also declares no `Content-Length`, which is exactly the case
    // a header pre-check would miss.
    const CHUNK = 256 * 1024;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
        if (pulled >= 64 * 1024 * 1024) controller.close();
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleEmbedDataProxy(
      new Request(`https://mcp.tako.com${DATA_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      ON,
    );
    expect(res?.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    // One chunk of slop past the cap is the most a chunked read can avoid.
    expect(pulled).toBeLessThanOrEqual(3 * 1024 * 1024 + CHUNK);
  });

  it("maps upstream failures without leaking them as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );
    expect((await handleEmbedDataProxy(dataReq(), ON))?.status).toBe(404);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    expect((await handleEmbedDataProxy(dataReq(), ON))?.status).toBe(502);

    // A 3xx: `redirect: "manual"` makes it a non-ok response, so it lands here.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil/" } }),
      ),
    );
    expect((await handleEmbedDataProxy(dataReq(), ON))?.status).toBe(502);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect((await handleEmbedDataProxy(dataReq(), ON))?.status).toBe(502);
  });

  it("names the card in every failure log, since the body cannot", async () => {
    // Before this, a 502 here could not be tied back to a chart: the request body
    // is opaque JSON and none of the three failure lines carried a correlator,
    // while `/embed-html/` logs `... for ${pubId}` throughout.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const upstream of [
        () => Promise.resolve(new Response("boom", { status: 500 })),
        () => Promise.reject(new Error("network down")),
        () =>
          Promise.resolve(
            new Response("<html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
          ),
      ]) {
        warn.mockClear();
        vi.stubGlobal("fetch", vi.fn().mockImplementation(upstream));
        await handleEmbedDataProxy(dataReq(), ON);
        expect(warn.mock.calls.flat().map(String).join(" ")).toContain(PUB_ID);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a non-JSON upstream body", async () => {
    // This origin is the OAuth origin. Whatever MIME upstream declares would
    // otherwise become the MIME we serve here, and `Card.js` calls `.json()` on
    // the result anyway — an HTML error page is useless to it and dangerous here.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const res = await handleEmbedDataProxy(dataReq(), ON);
    expect(res?.status).toBe(502);
    expect(res?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("logs a response stream that dies mid-flight, and does not pretend it was whole", async () => {
    // The failure the streaming path used to swallow. Headers are long gone by
    // the time a body errors, so the client gets truncated JSON and `Card.js`
    // renders its own error — buffering would only change that to a 502, which
    // `Card.js` renders identically, at the cost of a second ~1.6 MB buffer.
    // What was actually missing was the log line.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"component_data":'));
          controller.error(new Error("upstream reset"));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const res = await handleEmbedDataProxy(dataReq(), ON);
      expect(res?.status).toBe(200);
      // The consumer sees a failed read, not a silently short document.
      await expect(res!.text()).rejects.toThrow();
      const logged = warn.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("response stream failed");
      expect(logged).toContain(PUB_ID);
      // And it says how far it got, which is what distinguishes "died at once"
      // from "died near the end".
      expect(logged).toMatch(/after \d+B/);
    } finally {
      warn.mockRestore();
    }
  });

  it("is metered, and metered BEFORE the upstream fetch", async () => {
    // Same ordering property the other two routes pin. This is the only one of
    // the three that costs Tako a QUERY rather than a cached render, so a meter
    // that runs after the fetch bounds nothing at all.
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      order.push("fetch");
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...ON,
      NATIVE_CARD_RATE_LIMITER: {
        limit: vi.fn().mockImplementation(() => {
          order.push("limit");
          return Promise.resolve({ success: true });
        }),
      },
    } as unknown as Env;
    await handleEmbedDataProxy(dataReq(), env);
    expect(order).toEqual(["limit", "fetch"]);

    order.length = 0;
    const full = {
      ...ON,
      NATIVE_CARD_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: false }),
      },
    } as unknown as Env;
    const res = await handleEmbedDataProxy(dataReq(), full);
    expect(res?.status).toBe(429);
    expect(order).toEqual([]);
  });

  it("fails OPEN when the limiter throws", async () => {
    vi.stubGlobal("fetch", jsonUpstream());
    const env = {
      ...ON,
      NATIVE_CARD_RATE_LIMITER: {
        limit: vi.fn().mockRejectedValue(new Error("limiter down")),
      },
    } as unknown as Env;
    expect((await handleEmbedDataProxy(dataReq(), env))?.status).toBe(200);
  });
});
