import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  __chart_widget_test_only__,
  buildChartAppUiResourceFromOutputPubId,
} from "./_chart_widget.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

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
