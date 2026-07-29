import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import {
  __chart_widget_test_only__,
  buildChartAppUiResourceFromOutputPubId,
} from "../../src/tools/_chart_widget.js";

// Executable coverage for the widget bundle. The main suite's string
// assertions confirm the template CONTAINS the right code; these tests
// actually RUN it under jsdom and drive the postMessage wire protocol —
// the thing claude.ai depends on and the thing a broken bundle would
// silently take down (Claude Desktop caches widget URIs beyond connector
// lifecycle, so a shipped-broken bundle is expensive to walk back).
//
// Frame topology mirrors a nesting host:
//
//   outer (window.top)
//   └── wrapper (window.parent of the widget)
//       ├── widget    ← WIDGET_HTML runs here
//       └── sibling   ← stand-in for a co-installed hostile connector
//
// Host messages are delivered as synthetic MessageEvents with an explicit
// `source` (jsdom's real postMessage doesn't populate `event.source`), so
// each test controls exactly which browsing context "sent" the message.
// Outbound traffic is captured by stubbing `wrapper.postMessage` — the
// widget only ever posts to `window.parent`.

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };

const EMBED_URL = "https://staging.trytako.com/embed/abc123/?dark_mode=auto";
const IMAGE_URL =
  "https://staging.trytako.com/api/v1/image/abc123/?dark_mode=true";
const DATA_URL = "data:image/png;base64,AAAA";

interface Mounted {
  dom: JSDOM;
  outerWin: Window & typeof globalThis;
  wrapperWin: Window;
  widgetWin: Window;
  siblingWin: Window;
  /** Messages the widget posted to window.parent, in order. */
  toParent: unknown[];
  warnings: string[];
}

const mounted: JSDOM[] = [];

function mountWidget(html: string): Mounted {
  const virtualConsole = new VirtualConsole();
  const warnings: string[] = [];
  virtualConsole.on("warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  // Swallow the rest — the widget logs routinely via console.log.
  virtualConsole.on("log", () => {});
  virtualConsole.on("error", () => {});
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(
    '<!doctype html><html><body><iframe id="wrapper"></iframe></body></html>',
    {
      url: "https://host.example/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  mounted.push(dom);
  const outerWin = dom.window as unknown as Window & typeof globalThis;
  const wrapperFrame = outerWin.document.getElementById(
    "wrapper",
  ) as HTMLIFrameElement;
  const wrapperWin = wrapperFrame.contentWindow!;
  const wrapperDoc = wrapperFrame.contentDocument!;
  const widgetFrame = wrapperDoc.createElement("iframe");
  const siblingFrame = wrapperDoc.createElement("iframe");
  wrapperDoc.body.appendChild(widgetFrame);
  wrapperDoc.body.appendChild(siblingFrame);

  const toParent: unknown[] = [];
  // Capture outbound host traffic. Assignment, not spyOn: the widget
  // grabs `window.parent` lazily on each call, so patching the wrapper
  // window's own method is sufficient and survives document.write.
  (wrapperWin as unknown as { postMessage: (msg: unknown) => void }).postMessage =
    (msg: unknown) => {
      toParent.push(msg);
    };

  const widgetDoc = widgetFrame.contentDocument!;
  widgetDoc.open();
  widgetDoc.write(html);
  widgetDoc.close();

  return {
    dom,
    outerWin,
    wrapperWin,
    widgetWin: widgetFrame.contentWindow!,
    siblingWin: siblingFrame.contentWindow!,
    toParent,
    warnings,
  };
}

/** Deliver a message to the widget as if `source` had postMessage'd it. */
function deliver(m: Mounted, data: unknown, source: Window): void {
  const WidgetMessageEvent = (
    m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
  ).MessageEvent;
  m.widgetWin.dispatchEvent(
    new WidgetMessageEvent("message", {
      data,
      source: source as unknown as MessageEventSource,
    }),
  );
}

function toolResult(structuredContent: unknown, _meta?: unknown): unknown {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent, _meta },
  };
}

function methodsSent(m: Mounted): string[] {
  return m.toParent
    .map((msg) => (msg as { method?: string }).method)
    .filter((x): x is string => typeof x === "string");
}

function widgetImg(m: Mounted): HTMLImageElement {
  return m.widgetWin.document.getElementById(
    "tako-embed-img",
  ) as HTMLImageElement;
}

function widgetLink(m: Mounted): HTMLAnchorElement {
  return m.widgetWin.document.getElementById(
    "tako-embed-link",
  ) as HTMLAnchorElement;
}

function widgetFrame(m: Mounted): HTMLIFrameElement {
  return m.widgetWin.document.getElementById(
    "tako-embed",
  ) as HTMLIFrameElement;
}

/**
 * Deliver a `tako-embed-height` resize message as if the embed iframe
 * posted it. The widget's handler gates on `event.origin` matching the
 * armed embed origin, so set it to the embed URL's origin.
 */
function deliverEmbedHeight(m: Mounted, height: number): void {
  const WidgetMessageEvent = (
    m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
  ).MessageEvent;
  m.widgetWin.dispatchEvent(
    new WidgetMessageEvent("message", {
      data: { type: "tako-embed-height", height },
      origin: "https://staging.trytako.com",
      source: m.widgetWin as unknown as MessageEventSource,
    }),
  );
}

/** Fire the probe iframe's `load` event as if the embed page loaded. */
function fireFrameLoad(m: Mounted): void {
  const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
    .Event;
  widgetFrame(m).dispatchEvent(new WidgetEvent("load"));
}

/**
 * Fire the chart image's `load` event — jsdom doesn't decode `data:`
 * URIs, so the widget's img.load listener (which unhides the link)
 * never fires on its own.
 */
function fireImageLoad(m: Mounted): void {
  const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
    .Event;
  widgetImg(m).dispatchEvent(new WidgetEvent("load"));
}

/** Fire a `frame-src` CSP violation as if the host sandbox blocked the probe. */
function fireFrameSrcViolation(m: Mounted): void {
  const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
    .Event;
  const event = new WidgetEvent("securitypolicyviolation");
  Object.assign(event, {
    effectiveDirective: "frame-src",
    violatedDirective: "frame-src",
    blockedURI: EMBED_URL,
  });
  m.widgetWin.document.dispatchEvent(event);
}

function staticWidgetHtml(): string {
  return buildChartAppUiResourceFromOutputPubId(ENV).html;
}

afterEach(() => {
  // Close every mounted JSDOM so the widget's 250 ms `window.openai`
  // polling interval (10 s worth of ticks) doesn't outlive the test.
  for (const dom of mounted.splice(0)) {
    dom.window.close();
  }
});

describe("static widget bundle (executed)", () => {
  it("kicks off the MCP Apps handshake and completes it on a parent response", () => {
    const m = mountWidget(staticWidgetHtml());
    // Script ran: ui/initialize went to the parent, plus the initial
    // 1-px size notification.
    expect(methodsSent(m)).toContain("ui/initialize");
    expect(methodsSent(m)).toContain("ui/notifications/size-changed");
    expect(methodsSent(m)).not.toContain("ui/notifications/initialized");
    // Host responds to ui/initialize → widget must send `initialized`
    // (the spec gates all tool-result delivery on it).
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: { hostInfo: {} } },
      m.wrapperWin,
    );
    expect(methodsSent(m)).toContain("ui/notifications/initialized");
  });

  it("renders the chart image from a parent-delivered tool-result", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        {
          image_data_url: DATA_URL,
          image_natural_width: 800,
          image_natural_height: 600,
        },
      ),
      m.wrapperWin,
    );
    // Data URI preferred over the cross-origin image_url (claude.ai's
    // outer CSP blocks the latter), click-through wired to the embed.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).getAttribute("href")).toBe(EMBED_URL);
  });

  it("accepts a tool-result delivered from window.top (nested-wrapper hosts)", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, toolResult({ embed_url: EMBED_URL }, { image_data_url: DATA_URL }), m.outerWin);
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
  });

  it("drops a forged tool-result from a sibling frame — and warns about it", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        { embed_url: "https://evil.example/phish" },
        { image_data_url: DATA_URL },
      ),
      m.siblingWin,
    );
    // No render: a sibling connector must not be able to inject a chart
    // or a click-through URL.
    expect(widgetImg(m).getAttribute("src")).toBeNull();
    expect(widgetLink(m).getAttribute("href")).toBeNull();
    // ...but the drop is observable, not silent — this gate guards
    // Claude's only chart data path.
    expect(
      m.warnings.some((w) => w.includes("dropped JSON-RPC message")),
    ).toBe(true);
  });

  it("ignores a forged handshake response from a sibling frame", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: {} },
      m.siblingWin,
    );
    expect(methodsSent(m)).not.toContain("ui/notifications/initialized");
  });

  it("refuses a javascript: embed_url as the click-through", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        // eslint-disable-next-line no-script-url
        { embed_url: "javascript:alert(1)", image_url: IMAGE_URL },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    // Image still renders (the data URI is independently validated) but
    // the hostile scheme never lands in href.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).getAttribute("href")).toBeNull();
  });

  it("collapses to zero height on a no-chart payload", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, toolResult({ request_id: "req-1" }), m.wrapperWin);
    expect(
      m.widgetWin.document.documentElement.style.height,
    ).toBe("0px");
    // Hosts honoring shrink notifications collapse the box fully.
    const sizeChanges = m.toParent.filter(
      (msg) =>
        (msg as { method?: string }).method ===
        "ui/notifications/size-changed",
    ) as Array<{ params: { height: number } }>;
    expect(sizeChanges.at(-1)?.params.height).toBe(0);
  });
});

describe("interactive iframe capability probe (executed)", () => {
  const CHART_RESULT = toolResult(
    { embed_url: EMBED_URL, image_url: IMAGE_URL },
    {
      image_data_url: DATA_URL,
      image_natural_width: 800,
      image_natural_height: 600,
    },
  );

  it("probes the embed iframe in the background while showing the image", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    fireImageLoad(m);
    // Image is the visible baseline...
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
    // ...while the probe iframe loads the embed hidden.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_URL);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
  });

  it("upgrades to the interactive iframe when the probe loads", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    // The probe only arms once the PNG baseline has loaded, so the swap
    // measures the image's real rendered height rather than the requested
    // fallback.
    fireImageLoad(m);
    fireFrameLoad(m);
    // Iframe swapped in over the PNG.
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetLink(m).classList.contains("hidden")).toBe(true);
  });

  it("does not arm the probe until the PNG baseline has loaded", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    // No probe in flight yet: the frame has no src and a stray `load`
    // (there is no listener bound) can't swap a not-yet-measured iframe
    // over the PNG.
    expect(widgetFrame(m).getAttribute("src")).toBeNull();
    fireFrameLoad(m);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetLink(m).classList.contains("hidden")).toBe(true);
    // Image loads → probe arms and starts loading the embed, hidden.
    fireImageLoad(m);
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_URL);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
  });

  it("does not re-reveal the PNG when a duplicate image load fires after upgrade", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    fireImageLoad(m);
    fireFrameLoad(m); // upgrade to the interactive iframe
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetLink(m).classList.contains("hidden")).toBe(true);
    // A stray second image load must not un-hide the PNG on top of the
    // live iframe.
    fireImageLoad(m);
    expect(widgetLink(m).classList.contains("hidden")).toBe(true);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
  });

  it("ignores embed-height messages while the probe is hidden, honors them after upgrade", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    fireImageLoad(m); // probe armed, embed loading hidden behind the PNG
    const frame = widgetFrame(m);
    frame.removeAttribute("height");
    // During the probe window `embedOrigin` is unarmed, so a resize
    // message from the (hidden) embed must not size the widget under the
    // visible PNG.
    deliverEmbedHeight(m, 1234);
    expect(frame.getAttribute("height")).toBeNull();
    // After the swap, `embedOrigin` is armed and the same message resizes.
    fireFrameLoad(m);
    deliverEmbedHeight(m, 1234);
    expect(frame.getAttribute("height")).toBe("1234");
  });

  it("stays on the image when the host CSP blocks the probe", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    fireImageLoad(m);
    fireFrameSrcViolation(m);
    // Probe cancelled: frame unloaded and still hidden, image untouched.
    expect(widgetFrame(m).getAttribute("src")).toBe("about:blank");
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
    // A late load (e.g. the about:blank unload settling) must not swap.
    fireFrameLoad(m);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
  });

  it("commits to the iframe immediately when window.openai is present", () => {
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: object }).openai = {};
    deliver(m, CHART_RESULT, m.wrapperWin);
    // ChatGPT path: no PNG detour, no probe — straight to the iframe.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_URL);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetImg(m).getAttribute("src")).toBeNull();
  });

  it("does not probe when there is no embed_url", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult({ image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetFrame(m).getAttribute("src")).toBeNull();
  });
});

describe("baked widget variant (executed)", () => {
  it("notifies size-changed to the parent on execution", () => {
    const html = __chart_widget_test_only__.buildBakedWidgetHtml({
      embedUrl: EMBED_URL,
      imageDataUrl: DATA_URL,
      naturalWidth: 800,
      naturalHeight: 600,
    });
    const m = mountWidget(html);
    expect(methodsSent(m)).toContain("ui/notifications/size-changed");
    // The image and click-through are baked server-side.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(
      m.widgetWin.document
        .getElementById("tako-embed-link")!
        .getAttribute("href"),
    ).toBe(EMBED_URL);
  });
});
