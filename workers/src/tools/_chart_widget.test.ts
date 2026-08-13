import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  __chart_widget_test_only__,
  APP_UI_RESOURCE_URI,
  appUiResourceUri,
  buildChartAppUiResourceFromOutputPubId,
  buildChartUrls,
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
      // Production-shaped url (buildChartUrls output), so the `&` in the
      // query exercises htmlEscape on the baked anchor.
      embedUrl:
        "https://staging.trytako.com/embed/abc123/?dark_mode=auto&showShare=true",
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
    // Two properties carry the design and neither is cosmetic: `position:
    // fixed` fills the host's reserved viewport without contributing to
    // `scrollHeight` (a host that sizes from content must not see the label as
    // a reason to make room), and `height: 100vh` makes that hold even on an
    // engine that resolves fixed-in-iframe against the document rather than
    // the viewport, where `top/bottom: 0` alone would collapse the label on a
    // zero-height document.
    //
    // Long-hand offsets vs the `inset` shorthand is NOT asserted: both have
    // shipped everywhere since 2021, so pinning the spelling would only fail a
    // future cleanup.
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    expect(ui.html).toContain("#tako-empty");
    expect(ui.html).toMatch(/#tako-empty\s*\{[^}]*position:\s*fixed/);
    expect(ui.html).toMatch(/#tako-empty\s*\{[^}]*height:\s*100vh/);
  });

  it("ships a readable empty-label colour for a host that declares no theme", () => {
    // The silent-host fallback lives in CSS, not in `collapse()`: base is the
    // light value (an unstyled frame composites to an opaque white base) with a
    // `prefers-color-scheme` dark override. A single compromise grey was worse
    // in BOTH directions — 3.25:1 against 4.83:1 on white — and 13px normal
    // text needs 4.5:1, not the 3:1 large-text threshold.
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    expect(ui.html).toMatch(/#tako-empty\s*\{[^}]*color:\s*#6b7280/);
    expect(ui.html).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*#tako-empty\s*\{\s*color:\s*#b4b8bd/,
    );
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

describe("buildChartUrls (card share opt-in)", () => {
  // The share control on the embed page is OPT-IN per host (tako PR #28735):
  // nothing renders unless the embedding URL carries ?showShare=true. MCP
  // surfaces want it on every displayed card, so the one URL builder opts in.
  it("opts the embed url into the card share control", () => {
    const { embed_url } = buildChartUrls(ENV, "abc123", true);
    expect(embed_url).toBe(
      "https://staging.trytako.com/embed/abc123/?dark_mode=auto&showShare=true",
    );
  });

  it("keeps the param off the PNG url — a static image has no chrome", () => {
    const { image_url } = buildChartUrls(ENV, "abc123", false);
    expect(image_url).toBe(
      "https://staging.trytako.com/api/v1/image/abc123/?dark_mode=false",
    );
  });
});

describe("widget iframe clipboard delegation", () => {
  // The share dialog copies links via navigator.clipboard.writeText, which
  // only works in a nested browsing context when every ancestor delegates
  // clipboard-write down the chain. We control this hop; the host controls
  // the one above it.
  it("delegates clipboard-write to the embed iframe", () => {
    expect(__chart_widget_test_only__.WIDGET_HTML).toContain(
      'allow="fullscreen; clipboard-write"',
    );
  });
});

describe("embed origin pin (clipboard-write scope)", () => {
  // The widget's iframe delegates clipboard-write, and Permissions-Policy's
  // default 'src' allowlist follows the frame wherever it navigates — so the
  // served bundle must pin the frame to the env's own web origin, the same
  // value buildChartUrls writes into embed_url.
  it("substitutes the placeholder with the env's public web origin", () => {
    const ui = buildChartAppUiResourceFromOutputPubId(ENV);
    expect(ui.html).not.toContain("__EXPECTED_EMBED_ORIGIN__");
    expect(ui.html).toContain(
      'var EXPECTED_EMBED_ORIGIN = "https://staging.trytako.com"',
    );
  });
});
