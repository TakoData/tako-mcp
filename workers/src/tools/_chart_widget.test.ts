import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  __chart_widget_test_only__,
  APP_UI_RESOURCE_URI,
  appUiResourceUri,
  buildChartAppUiResourceFromOutputPubId,
} from "./_chart_widget.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

describe("appUiResourceUri (dev cache-bust)", () => {
  // Hosts cache the widget BY URI and claude.ai's cache outlives a connector
  // remove/re-add, so a stale bundle is invisible unless the URI changes. This
  // is the dev-only lever for that; it must be inert unless explicitly set.
  it("is the stable URI when the suffix is unset", () => {
    expect(appUiResourceUri({ DJANGO_BASE_URL: "https://x.test" } as never)).toBe(
      APP_UI_RESOURCE_URI,
    );
  });

  it("is the stable URI when the suffix is empty", () => {
    expect(
      appUiResourceUri({
        DJANGO_BASE_URL: "https://x.test",
        WIDGET_URI_SUFFIX: "",
      } as never),
    ).toBe(APP_UI_RESOURCE_URI);
  });

  it("appends a set suffix", () => {
    expect(
      appUiResourceUri({
        DJANGO_BASE_URL: "https://x.test",
        WIDGET_URI_SUFFIX: "dev42",
      } as never),
    ).toBe(APP_UI_RESOURCE_URI + "-dev42");
  });

  it("strips characters that would break the URI", () => {
    // The value becomes a URI the host stores and reads back; a stray slash or
    // space yields one that never resolves.
    expect(
      appUiResourceUri({
        DJANGO_BASE_URL: "https://x.test",
        WIDGET_URI_SUFFIX: "a b/c?d",
      } as never),
    ).toBe(APP_UI_RESOURCE_URI + "-abcd");
  });

  it("falls back to the stable URI when the suffix is all junk", () => {
    expect(
      appUiResourceUri({
        DJANGO_BASE_URL: "https://x.test",
        WIDGET_URI_SUFFIX: "///",
      } as never),
    ).toBe(APP_UI_RESOURCE_URI);
  });
});

describe("chart widget HTML", () => {
  it("notifies height via the MCP Apps size-changed notification", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    // claude.ai tracks widget height via the open-spec JSON-RPC
    // notification over postMessage; window.openai.notifyIntrinsicHeight
    // covers ChatGPT only.
    expect(ui.html).toContain('"ui/notifications/size-changed"');
    expect(ui.html).toContain("notifyIntrinsicHeight");
  });

  it("bakes the size-changed notification into the per-pub_id variant too", () => {
    // The static bundle (asserted above) and the baked variant are
    // separate template strings — a size-changed regression in one is
    // invisible to assertions on the other.
    const html = __chart_widget_test_only__.buildBakedWidgetHtml({
      embedUrl: "https://staging.trytako.com/embed/abc123/?dark_mode=auto",
      imageDataUrl: "data:image/png;base64,AAAA",
      naturalWidth: 800,
      naturalHeight: 600,
    });
    expect(html).toContain('"ui/notifications/size-changed"');
    expect(html).toContain("notifyIntrinsicHeight");
    // Re-notify after the <img> gets real dimensions — the initial
    // notify() runs pre-load and can measure a pre-layout height.
    expect(html).toContain('addEventListener("load"');
  });

  it("positions the empty state out of flow so it cannot grow the box", () => {
    // Three properties carry the whole design and none is cosmetic:
    // `position: fixed` fills the host's reserved viewport without
    // contributing to `scrollHeight` (a host that sizes from content must not
    // see the label as a reason to make room); `height: 100vh` makes that hold
    // even on an engine that resolves fixed-in-iframe against the document
    // rather than the viewport, where `top/bottom: 0` alone would collapse the
    // label on a zero-height document; and the individual offsets rather than
    // the `inset` shorthand keep it parseable by older engines.
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    expect(ui.html).toContain("#tako-empty");
    expect(ui.html).toMatch(/#tako-empty\s*\{[^}]*position:\s*fixed/);
    expect(ui.html).toMatch(/#tako-empty\s*\{[^}]*height:\s*100vh/);
    expect(ui.html).not.toMatch(/#tako-empty\s*\{[^}]*inset:/);
  });

  it("declares resourceDomains so the remote image fallback loads on claude.ai", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    // image_url is served from the public API base; the embed page from
    // the web base. Both must be CSP-allowed for the <img> fallback.
    expect(ui.resourceDomains).toBeDefined();
    expect(ui.resourceDomains!.length).toBeGreaterThan(0);
    for (const d of ui.resourceDomains!) {
      expect(d).toMatch(/^https:\/\//);
    }
  });
});
