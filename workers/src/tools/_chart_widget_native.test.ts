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
import { describe, expect, it } from "vitest";

import { type Env, resolveWidgetOrigin } from "../env.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  nativeCardUrl,
} from "./_chart_widget.js";

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
