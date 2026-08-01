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
import { handleEmbedProxy, parsePubId, sanitizeEmbedHtml } from "./embed_proxy.js";

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
