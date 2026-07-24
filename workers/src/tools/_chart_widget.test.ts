import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { buildChartAppUiResourceFromOutputPubId } from "./_chart_widget.js";

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
});
