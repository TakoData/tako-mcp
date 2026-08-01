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

import type { Env } from "../env.js";
import {
  buildChartAppUiResourceFromOutputPubId,
  buildChartExtraMeta,
  nativeCardProbeMeta,
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

  it("adds the CDN when armed, without dropping the existing origins", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(ARMED);
    expect(ui.resourceDomains).toContain("https://tako.com");
    expect(ui.resourceDomains).toContain(CDN);
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
