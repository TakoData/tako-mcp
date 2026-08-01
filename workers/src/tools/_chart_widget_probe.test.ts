/**
 * The `script-src` capability experiment, on the server side.
 *
 * Two things are being pinned, and the first matters more than the second:
 *
 * 1. UNSET IS INERT. `PUBLIC_CDN_URL` is absent in production, and with it
 *    absent nothing about the chart tools changes — not the declared CSP, not
 *    `_meta`, not `tako_visualize`. An experiment that can alter production
 *    behavior is not an experiment.
 * 2. SET IS ARMED. With it configured (staging), the CDN origin appears in
 *    `resourceDomains` and the probe fields ride along in `_meta`.
 *
 * The widget-side half — that a CSP refusal is distinguished from a 404 by the
 * `securitypolicyviolation` signal rather than the outcome — lives in
 * `test/widget/widget-dom.test.ts`, where the bundle actually executes.
 */
import { describe, expect, it } from "vitest";

import { type Env, resolveWidgetOrigin } from "../env.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  nativeCardProbeMeta,
  nativeCardUrl,
} from "./_chart_widget.js";

const CDN = "https://d12w4pyrrczi5e.cloudfront.net";
const BASE: Env = { DJANGO_BASE_URL: "https://tako.com" };
const ARMED: Env = { ...BASE, PUBLIC_CDN_URL: CDN };

describe("nativeCardProbeMeta", () => {
  it("is empty when PUBLIC_CDN_URL is unset (production default)", () => {
    expect(nativeCardProbeMeta(BASE)).toEqual({});
  });

  it("is empty for an empty-string binding", () => {
    // A wrangler var declared but blank must read as "off", not as an origin.
    expect(nativeCardProbeMeta({ ...BASE, PUBLIC_CDN_URL: "" })).toEqual({});
  });

  it("ships a probe url on the configured CDN origin when armed", () => {
    const meta = nativeCardProbeMeta(ARMED);
    expect(meta.cdn_probe_origin).toBe(CDN);
    expect(String(meta.cdn_probe_script_url).startsWith(`${CDN}/`)).toBe(true);
  });

  it("probes a path that cannot exist", () => {
    // Deliberate: the probe must not depend on a real asset URL, because
    // discovering one would mean fetching the embed page on the request path.
    // A 404 is fine — the verdict comes from whether a CSP violation fired,
    // not from whether the file was there.
    expect(String(nativeCardProbeMeta(ARMED).cdn_probe_script_url)).toContain(
      "__tako-csp-probe__",
    );
  });

  it("rejects a non-http(s) CDN origin instead of putting it in a CSP", () => {
    // The value lands in `resourceDomains`, which the host turns into
    // script-src. A `javascript:` or `data:` origin there would be a hole.
    expect(() =>
      nativeCardProbeMeta({ ...BASE, PUBLIC_CDN_URL: "javascript:alert(1)" }),
    ).toThrow();
  });
});

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
  it("still ships the probe when the image fetch yields nothing", async () => {
    // `tako_visualize` can be called with no image_url at all. The probe is
    // about the host, not the chart, so it must not be collateral damage —
    // and equally must not invent image fields that aren't there.
    const meta = await buildChartExtraMeta(undefined, {
      bakeImage: true,
      env: ARMED,
    });
    expect(meta?.cdn_probe_origin).toBe(CDN);
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
