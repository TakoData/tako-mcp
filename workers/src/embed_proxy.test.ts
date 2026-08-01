/**
 * The embed-page proxy: the route that lets the widget read Tako's own card
 * markup, which the browser cannot fetch directly because `/embed/` serves no
 * `Access-Control-Allow-Origin`.
 *
 * Three properties carry real weight here, in this order:
 *
 *   1. INVISIBLE IN PRODUCTION. Gated on `PUBLIC_CDN_URL`; unset means the
 *      handler declines and the router 404s, so no new surface exists.
 *   2. NOT AN SSRF PRIMITIVE. The pub_id is interpolated into an upstream URL,
 *      so its shape is the security boundary.
 *   3. NOTHING SENSITIVE CROSSES INTO THE SANDBOX. The upstream page carries a
 *      `csrfToken`; it must not reach a third-party iframe.
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
    expect(res?.headers.get("content-type")).toContain("text/html");
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
});

describe("rewriteCdnUrls", () => {
  const CDN = "https://cdn.example.net";
  const TARGET = "https://mcp.tako.com/cdn-asset";

  it("repoints every occurrence and counts them", () => {
    const html = `<script src="${CDN}/a/Card.js"></script><link href="${CDN}/f.css">`;
    const out = rewriteCdnUrls(html, CDN, TARGET);
    expect(out.rewrites).toBe(2);
    expect(out.html).not.toContain(CDN);
    expect(out.html).toContain(`${TARGET}/a/Card.js`);
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
    const out = rewriteCdnUrls('src="https://other.net/x.js"', CDN, TARGET);
    expect(out.rewrites).toBe(0);
  });
});

describe("handleCdnAssetProxy", () => {
  const ASSET = "/cdn-asset/archive/abc/vite_dist/assets/Card.js";

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

  it("rejects a path trying to climb out of the origin", async () => {
    for (const bad of [
      "/cdn-asset/../secrets",
      "/cdn-asset//evil.net/x.js",
      "/cdn-asset/a/../../b",
      "/cdn-asset/",
    ]) {
      const res = await handleCdnAssetProxy(req(bad), ON);
      // Either a hard 400 or a decline; never an upstream fetch.
      expect([400, undefined]).toContain(res?.status);
    }
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
    const res = await handleCdnAssetProxy(req("/cdn-asset/fonts/geist.woff2"), ON);
    expect(res?.headers.get("cache-control")).toContain("immutable");
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
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
