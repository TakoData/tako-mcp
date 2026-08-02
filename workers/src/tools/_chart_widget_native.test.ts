/**
 * The native-card path, on the server side.
 *
 * Two things are being pinned, and the first matters more than the second:
 *
 * 1. UNSET IS INERT. `PUBLIC_CDN_URL` is absent in production, and with it
 *    absent nothing about the chart tools changes — not the declared CSP, not
 *    `_meta`, not `tako_visualize`. A flag that can alter production behaviour
 *    is not a flag.
 * 2. SET IS ARMED. With it configured (staging), the widget's own origin
 *    appears in `resourceDomains` / `connectDomains` and `native_card_url`
 *    rides along in `_meta`.
 *
 * The widget-side half — that the upgrade is sequenced after the PNG and that
 * every failure mode leaves the chart alone — lives in
 * `test/widget/widget-dom.test.ts`, where the bundle actually executes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Env, resolveWidgetOrigin } from "../env.js";
import {
  __chart_widget_test_only__,
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  fetchPngDimensions,
  nativeCardUrl,
} from "./_chart_widget.js";

const { parsePngDimensions } = __chart_widget_test_only__;

const CDN = "https://d12w4pyrrczi5e.cloudfront.net";
const BASE: Env = { DJANGO_BASE_URL: "https://tako.com" };
const ARMED: Env = { ...BASE, PUBLIC_CDN_URL: CDN };

describe("declared resourceDomains", () => {
  it("omits the CDN when the experiment is off", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(BASE);
    expect(ui.resourceDomains).toEqual(["https://tako.com"]);
    expect(ui.resourceDomains?.some((d) => d.includes("cloudfront"))).toBe(
      false,
    );
  });

  it("declares OUR origin when armed, not the CDN", () => {
    // Assets are served through this worker's `/cdn-asset/` passthrough, not
    // from the CDN: the CDN answers CORS for tako.com only, and a `type=module`
    // script is always a CORS fetch. Declaring the CDN here would grant
    // script-src to an origin nothing loads from.
    const ui = buildChartAppUiResourceFromOutputPubId(
      ARMED,
      "https://mcp.tako.com",
    );
    expect(ui.resourceDomains).toContain("https://tako.com");
    expect(ui.resourceDomains).toContain("https://mcp.tako.com");
    expect(ui.resourceDomains).not.toContain(CDN);
  });

  it("does not declare our origin when the origin is unknown", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(ARMED, undefined);
    expect(ui.resourceDomains).toEqual(["https://tako.com"]);
  });

  it("leaves frameDomains alone either way", () => {
    // The CDN serves scripts and fonts, never an iframe. Widening frameDomains
    // would be a different (and pointless) change — claude.ai hardcodes
    // frame-src regardless.
    expect(buildChartAppUiResourceFromOutputPubId(ARMED).frameDomains).toEqual([
      "https://tako.com",
    ]);
  });
});

describe("buildChartExtraMeta with the experiment off", () => {
  it("returns undefined when there is no image and no probe", async () => {
    await expect(
      buildChartExtraMeta(undefined, { bakeImage: true, env: BASE }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when env is omitted entirely", async () => {
    // The `env`-less call shape stays supported: no env, no probe, no throw.
    await expect(
      buildChartExtraMeta(undefined, { bakeImage: true }),
    ).resolves.toBeUndefined();
  });
});

describe("buildChartExtraMeta with the experiment armed", () => {
  it("still ships the native card url when the image fetch yields nothing", async () => {
    // `tako_visualize` can be called with no image_url at all. The native card
    // does not depend on the PNG, so it must not be collateral damage — and
    // equally must not invent image fields that aren't there.
    const meta = await buildChartExtraMeta(undefined, {
      bakeImage: true,
      env: ARMED,
      origin: "https://mcp.tako.com",
      pubId: "abc123",
    });
    expect(meta?.native_card_url).toBe(
      "https://mcp.tako.com/embed-html/abc123",
    );
    expect(meta).not.toHaveProperty("image_data_url");
    expect(meta).not.toHaveProperty("image_natural_width");
  });
});

describe("resolveWidgetOrigin", () => {
  it("prefers the explicit binding over the request origin", () => {
    expect(
      resolveWidgetOrigin(
        { ...ARMED, PUBLIC_MCP_URL: "https://mcp.tako.com" },
        "http://internal-host",
      ),
    ).toBe("https://mcp.tako.com");
  });

  it("forces https on a derived non-local origin", () => {
    // `request.url` reads http:// behind any upstream TLS terminator (wrangler
    // dev, ngrok, cloudflared). Emitting that into connectDomains and asking an
    // https document to fetch it is a mixed-content block, not a warning.
    expect(resolveWidgetOrigin(ARMED, "http://mcp.staging.tako.com")).toBe(
      "https://mcp.staging.tako.com",
    );
  });

  it("leaves an already-https origin alone", () => {
    expect(resolveWidgetOrigin(ARMED, "https://mcp.tako.com")).toBe(
      "https://mcp.tako.com",
    );
  });

  it("keeps http for localhost, where it is the only thing that works", () => {
    expect(resolveWidgetOrigin(ARMED, "http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(resolveWidgetOrigin(ARMED, "http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("returns undefined when there is nothing usable", () => {
    expect(resolveWidgetOrigin(ARMED, undefined)).toBeUndefined();
    expect(resolveWidgetOrigin(ARMED, "")).toBeUndefined();
    expect(resolveWidgetOrigin(ARMED, "not a url")).toBeUndefined();
  });
});

describe("nativeCardUrl", () => {
  it("is undefined when the experiment is off", () => {
    expect(nativeCardUrl(BASE, "https://mcp.tako.com", "abc123")).toBeUndefined();
  });

  it("is undefined without a pub_id", () => {
    expect(nativeCardUrl(ARMED, "https://mcp.tako.com", undefined)).toBeUndefined();
    expect(nativeCardUrl(ARMED, "https://mcp.tako.com", "")).toBeUndefined();
  });

  it("is undefined when the origin cannot be resolved", () => {
    // The widget's own origin is opaque, so it cannot resolve a relative path
    // back to us — no origin means no native card, never a relative URL.
    expect(nativeCardUrl(ARMED, undefined, "abc123")).toBeUndefined();
  });

  it("builds an https proxy URL under the embed-html prefix", () => {
    expect(nativeCardUrl(ARMED, "http://mcp.staging.tako.com", "abc123")).toBe(
      "https://mcp.staging.tako.com/embed-html/abc123",
    );
  });

  it("percent-encodes the pub_id", () => {
    // Defence in depth: the route validates the shape too, but this value is
    // built into a URL, so it is encoded at construction rather than trusted.
    expect(nativeCardUrl(ARMED, "https://m.test", "a/b")).toBe(
      "https://m.test/embed-html/a%2Fb",
    );
  });
});

describe("declared connectDomains", () => {
  it("is absent when the experiment is off", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(BASE, "https://mcp.tako.com");
    expect(ui.connectDomains ?? []).toEqual([]);
  });

  it("matches the origin the native URL is built on", () => {
    // If the declared origin and the fetched origin disagree, the fetch is
    // CSP-blocked and it looks like a broken proxy.
    const ui = buildChartAppUiResourceFromOutputPubId(
      ARMED,
      "http://mcp.staging.tako.com",
    );
    expect(ui.connectDomains).toEqual(["https://mcp.staging.tako.com"]);
    expect(
      nativeCardUrl(ARMED, "http://mcp.staging.tako.com", "x")?.startsWith(
        ui.connectDomains![0]!,
      ),
    ).toBe(true);
  });

  it("is empty when the origin is unknown", () => {
    expect(
      buildChartAppUiResourceFromOutputPubId(ARMED, undefined).connectDomains ?? [],
    ).toEqual([]);
  });
});

/**
 * The PNG header read that PRODUCES the aspect ratio.
 *
 * The aspect fix is the user-visible half of this branch, and every test that
 * exercises it hands `image_natural_width/height` in by hand — so the code that
 * derives those two integers had no coverage at all, despite
 * `parsePngDimensions` being exported through `__chart_widget_test_only__`
 * specifically for it.
 *
 * That is the wrong thing to leave unpinned: a transposed byte offset here
 * yields a plausible-but-wrong aspect, which reproduces exactly the empty-band
 * bug this branch removes — silently, and server-side, where nobody sees it.
 */
describe("parsePngDimensions", () => {
  /**
   * A real PNG head: 8-byte signature, then the IHDR chunk (4-byte length,
   * `IHDR`, then width and height as big-endian uint32 at byte 16 and 20).
   */
  function pngHead(width: number, height: number, totalBytes = 64): ArrayBuffer {
    const buf = new ArrayBuffer(totalBytes);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    view.setUint32(8, 13); // IHDR data length
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    view.setUint32(16, width);
    view.setUint32(20, height);
    return buf;
  }

  it("reads the three real card aspects off the header", () => {
    // The measured production shapes: the render canvas is a fixed 2400 px wide
    // and the height is per card type. These are the numbers the whole aspect
    // fix depends on being right.
    expect(parsePngDimensions(pngHead(2400, 1101))).toEqual({
      width: 2400,
      height: 1101,
    });
    expect(parsePngDimensions(pngHead(2400, 1257))).toEqual({
      width: 2400,
      height: 1257,
    });
    expect(parsePngDimensions(pngHead(2400, 1845))).toEqual({
      width: 2400,
      height: 1845,
    });
  });

  it("reads a header that is exactly the minimum length", () => {
    // The `< 24` bail is an off-by-one waiting to happen in both directions:
    // 24 bytes is exactly enough to hold the height, 23 is one short.
    expect(parsePngDimensions(pngHead(2400, 1101, 24))).toEqual({
      width: 2400,
      height: 1101,
    });
    expect(
      parsePngDimensions(pngHead(2400, 1101, 24).slice(0, 23)),
    ).toBeUndefined();
  });

  it("rejects anything that is not a PNG", () => {
    // Without the signature check, a JPEG or an HTML error page would read
    // garbage integers out of arbitrary bytes and hand back a confident,
    // completely wrong aspect ratio.
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    expect(parsePngDimensions(jpeg.buffer)).toBeUndefined();

    const html = new TextEncoder().encode(
      "<!doctype html><html><body>502 Bad Gateway</body></html>",
    );
    expect(parsePngDimensions(html.buffer as ArrayBuffer)).toBeUndefined();

    const gif = new Uint8Array(64);
    gif.set([0x47, 0x49, 0x46, 0x38], 0);
    expect(parsePngDimensions(gif.buffer)).toBeUndefined();
  });

  it("rejects a truncated buffer", () => {
    expect(parsePngDimensions(new ArrayBuffer(0))).toBeUndefined();
    expect(parsePngDimensions(new ArrayBuffer(12))).toBeUndefined();
  });

  it("rejects a zero dimension rather than dividing by it", () => {
    // `aspectHeight` multiplies by `height / width`, so a zero width is a
    // division by zero and a zero height is a zero-height frame.
    expect(parsePngDimensions(pngHead(0, 1101))).toBeUndefined();
    expect(parsePngDimensions(pngHead(2400, 0))).toBeUndefined();
    expect(parsePngDimensions(pngHead(0, 0))).toBeUndefined();
  });
});

describe("fetchPngDimensions", () => {
  const URL_UNDER_TEST = "https://tako.com/api/v1/image/abc123/";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pngResponse(status: number): Response {
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    new Uint8Array(buf).set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    view.setUint32(16, 2400);
    view.setUint32(20, 1101);
    return new Response(buf, { status });
  }

  it("asks for only the first 64 bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pngResponse(206));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPngDimensions(URL_UNDER_TEST);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-63");
  });

  it("reads dimensions from a 206", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pngResponse(206)));
    await expect(fetchPngDimensions(URL_UNDER_TEST)).resolves.toEqual({
      naturalWidth: 2400,
      naturalHeight: 1101,
    });
  });

  it("reads dimensions from a 200 when the server ignored Range", async () => {
    // Degrades to correct-but-slower, never to broken: the parser only ever
    // looks at the head either way.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pngResponse(200)));
    await expect(fetchPngDimensions(URL_UNDER_TEST)).resolves.toEqual({
      naturalWidth: 2400,
      naturalHeight: 1101,
    });
  });

  it("returns undefined on an upstream error status", async () => {
    for (const status of [404, 500, 502]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("nope", { status })),
      );
      await expect(fetchPngDimensions(URL_UNDER_TEST), String(status)).resolves
        .toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it("returns undefined when the body is not a PNG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"detail":"not found"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(fetchPngDimensions(URL_UNDER_TEST)).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch throws or aborts", async () => {
    // Best-effort by design — the widget falls back to the requested height,
    // so this must never propagate and fail the whole tool call.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchPngDimensions(URL_UNDER_TEST)).resolves.toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      ),
    );
    await expect(fetchPngDimensions(URL_UNDER_TEST)).resolves.toBeUndefined();
  });
});
