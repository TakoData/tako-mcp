import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// What the widget must actually put in an `iframe.src`: the same embed url with
// analytics suppressed. `withoutTracking` in `_chart_widget.ts` appends it to
// every in-widget iframe load — OpenAI's iframe policy singles out tracking
// inside an app's embedded frame, and Tako's embed route already honours this
// flag (it gates out Google Tag Manager and skips the impression counter).
// `EMBED_URL` itself stays plain: the click-through anchor is a link a HUMAN
// opens in their own browser, which is an ordinary visit that should count —
// so the href assertions below deliberately still use `EMBED_URL`.
const EMBED_IFRAME_SRC = `${EMBED_URL}&disable_tracking=true`;
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

function widgetEmpty(m: Mounted): HTMLElement {
  return m.widgetWin.document.getElementById("tako-empty") as HTMLElement;
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

  it("labels the empty state for hosts that keep the box anyway", () => {
    // ChatGPT (and any host with a minimum widget-card height) ignores the
    // shrink above and keeps a card-sized container. The collapse asked for
    // zero and got a grey void — so paint an intentional line INTO whatever
    // space the host insisted on keeping. Fixed positioning is what makes
    // that safe: on a host that DID collapse us the viewport is 0 px tall and
    // nothing shows, and an out-of-flow element cannot grow `scrollHeight`
    // for hosts that size from content.
    const m = mountWidget(staticWidgetHtml());
    deliver(m, toolResult({ cards: [], web_results: [] }), m.wrapperWin);
    const empty = widgetEmpty(m);
    expect(empty.classList.contains("hidden")).toBe(false);
    expect(empty.textContent).toMatch(/no chart/i);
  });

  it("colours the empty label for the host's theme, not the bundle's grey", () => {
    // The body grey the placeholder uses lands near 2:1 on a light host, which
    // is a label only its author can read. Both themes get their own value; the
    // theme arrives on the handshake, which is why this asserts through it
    // rather than poking the variable.
    const light = mountWidget(staticWidgetHtml());
    deliver(
      light,
      {
        jsonrpc: "2.0",
        id: "tako-ui-init",
        result: { hostContext: { theme: "light" } },
      },
      light.wrapperWin,
    );
    deliver(light, toolResult({ cards: [] }), light.wrapperWin);
    expect(widgetEmpty(light).style.color).toBe("rgb(107, 114, 128)");

    const dark = mountWidget(staticWidgetHtml());
    deliver(
      dark,
      {
        jsonrpc: "2.0",
        id: "tako-ui-init",
        result: { hostContext: { theme: "dark" } },
      },
      dark.wrapperWin,
    );
    deliver(dark, toolResult({ cards: [] }), dark.wrapperWin);
    expect(widgetEmpty(dark).style.color).toBe("rgb(180, 184, 189)");
  });

  it("never notifies a height above zero once collapsed", () => {
    // The invariant that keeps the empty state from RESURRECTING a box a host
    // already threw away: painting content is free, asking for room is not.
    const m = mountWidget(staticWidgetHtml());
    deliver(m, toolResult({ cards: [] }), m.wrapperWin);
    const heights = (
      m.toParent.filter(
        (msg) =>
          (msg as { method?: string }).method ===
          "ui/notifications/size-changed",
      ) as Array<{ params: { height: number } }>
    ).map((msg) => msg.params.height);
    // 1 px is the mount-time floor sent before any data arrives.
    expect(Math.max(...heights.slice(1))).toBe(0);
  });

  it("leaves the empty state hidden when a chart renders", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
  });

  it("collapses when NO tool-result ever arrives", () => {
    // The failed-tool-call case. An `isError` result carries no
    // `structuredContent`, but the host has already mounted the widget for
    // that call — so nothing paints and the frame is left as an
    // indeterminate ~1 px sliver forever, which a host reasonably reports as
    // a display failure. A successful zero-card result already collapsed
    // (test above); a failed call now gets the same treatment.
    vi.useFakeTimers();
    try {
      const m = mountWidget(staticWidgetHtml());
      // Nothing delivered at all.
      expect(m.widgetWin.document.documentElement.style.height).not.toBe("0px");
      vi.advanceTimersByTime(10_000);
      expect(m.widgetWin.document.documentElement.style.height).toBe("0px");
      const sizeChanges = m.toParent.filter(
        (msg) =>
          (msg as { method?: string }).method ===
          "ui/notifications/size-changed",
      ) as Array<{ params: { height: number } }>;
      expect(sizeChanges.at(-1)?.params.height).toBe(0);
      // A failed call gets the same labelled empty state as a zero-card one —
      // the host reserved a box either way, and "No chart" is true of both.
      expect(widgetEmpty(m).classList.contains("hidden")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not collapse a chart that already rendered", () => {
    // The watchdog must be a no-op once anything painted, or a slow host
    // would have its working chart yanked at the 10 s mark.
    vi.useFakeTimers();
    try {
      const m = mountWidget(staticWidgetHtml());
      deliver(
        m,
        toolResult(
          { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
          { image_data_url: DATA_URL },
        ),
        m.wrapperWin,
      );
      fireImageLoad(m);
      vi.advanceTimersByTime(20_000);
      expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
      expect(m.widgetWin.document.documentElement.style.height).not.toBe("0px");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("interactive iframe capability probe (executed)", () => {
  // `interactive_probe: true` is REQUIRED for any of this to run. The server
  // ships it false (`INTERACTIVE_IFRAME_PROBE_ENABLED`) because on claude.ai
  // the probe is guaranteed to trip `frame-src` CSP and the host surfaces that
  // blocked subresource to the user as "There was a problem displaying content
  // from tako." — next to a chart that rendered perfectly. These tests
  // therefore describe the behavior that resumes when claude.ai honors
  // `frameDomains` and the flag is flipped back on, NOT today's default.
  const CHART_RESULT = toolResult(
    { embed_url: EMBED_URL, image_url: IMAGE_URL },
    {
      image_data_url: DATA_URL,
      image_natural_width: 800,
      image_natural_height: 600,
      interactive_probe: true,
    },
  );

  it("does NOT probe by default — the server flag is off", () => {
    // The fix, pinned. Same payload minus `interactive_probe`: the PNG must
    // render and the iframe must never be navigated, so no CSP violation is
    // ever raised inside the widget document.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
    // The load handler is exactly where the probe would have been armed.
    expect(widgetFrame(m).getAttribute("src")).toBeNull();
  });

  it("does not probe when the flag is present but false", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_data_url: DATA_URL, interactive_probe: false },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    expect(widgetFrame(m).getAttribute("src")).toBeNull();
  });

  it("probes the embed iframe in the background while showing the image", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, CHART_RESULT, m.wrapperWin);
    fireImageLoad(m);
    // Image is the visible baseline...
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
    // ...while the probe iframe loads the embed hidden.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
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
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
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
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
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

/**
 * The mirror of the probe above: the `window.openai` path commits to the
 * iframe up front, so it needs a way DOWN to the PNG when that iframe never
 * renders. Before the watchdog this path had no fallback at all — a blocked
 * or hanging embed left an empty frame in the chat forever, with `image_url`
 * unused in the same payload.
 *
 * ChatGPT is the client that takes this path, and the server skips the PNG
 * prefetch for it, so these results carry `image_url` and NO
 * `_meta.image_data_url` — the real shape, not the Claude one.
 */
describe("committed iframe watchdog (executed)", () => {
  /** ChatGPT-shaped payload: remote image URL, no baked data URI. */
  const CHATGPT_RESULT = toolResult({
    embed_url: EMBED_URL,
    image_url: IMAGE_URL,
  });

  function mountChatGpt(): Mounted {
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: object }).openai = {};
    return m;
  }

  /**
   * Give the widget document a real container width. jsdom performs no layout
   * for iframes, so `documentElement.clientWidth` is 0 out of the box and the
   * aspect math has nothing to multiply — which is also the production
   * fallback path, so it has to be stubbed to test the fitted path at all.
   */
  const COLUMN_WIDTH = 700;
  function setColumnWidth(m: Mounted, px: number): void {
    Object.defineProperty(m.widgetWin.document.documentElement, "clientWidth", {
      configurable: true,
      get: () => px,
    });
  }

  it("sizes the iframe to the CARD's aspect, not the requested height", () => {
    // The "square shape with empty bands" bug. A plain Tako chart renders
    // 2400x1101 (2.18:1), but the widget used to pin the frame to
    // `structuredContent.height` — a flat 720 — inside a ~700 px chat column.
    // That is a near-square box holding a 2.18:1 card, so the card painted
    // short and left a band of empty background under it.
    const m = mountChatGpt();
    setColumnWidth(m, COLUMN_WIDTH);
    const width = COLUMN_WIDTH;
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    const expected = Math.round((width * 1101) / 2400);
    expect(widgetFrame(m).getAttribute("height")).toBe(String(expected));
    // Explicitly NOT the requested height.
    expect(widgetFrame(m).getAttribute("height")).not.toBe("720");
    // The host is told the same number, or the outer container keeps the band.
    const sizeChanges = m.toParent.filter(
      (msg) =>
        (msg as { method?: string }).method === "ui/notifications/size-changed",
    ) as Array<{ params: { height: number } }>;
    expect(sizeChanges.at(-1)?.params.height).toBe(expected);
  });

  it("sizes a tall list card taller than a wide chart card", () => {
    // Aspect is per-card, so one constant cannot serve all three shapes: a
    // ranked top-sites card measures 2400x1845 (1.30:1) against a chart's
    // 2.18:1. Same container, different frame height, or one of them is wrong.
    const chart = mountChatGpt();
    setColumnWidth(chart, COLUMN_WIDTH);
    deliver(
      chart,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      chart.wrapperWin,
    );
    const list = mountChatGpt();
    setColumnWidth(list, COLUMN_WIDTH);
    deliver(
      list,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_natural_width: 2400, image_natural_height: 1845 },
      ),
      list.wrapperWin,
    );
    const chartH = Number(widgetFrame(chart).getAttribute("height"));
    const listH = Number(widgetFrame(list).getAttribute("height"));
    expect(listH).toBeGreaterThan(chartH);
  });

  it("falls back to the requested height when dimensions are absent", () => {
    // The dimensions fetch is best-effort (ranged read, 3 s bound). Losing it
    // must cost a well-proportioned frame, not the chart.
    const m = mountChatGpt();
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 640 }),
      m.wrapperWin,
    );
    expect(widgetFrame(m).getAttribute("height")).toBe("640");
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
  });

  /** Fire a `resize` on the widget window, as a host column change would. */
  function fireResize(m: Mounted): void {
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    m.widgetWin.dispatchEvent(new WidgetEvent("resize"));
  }

  it("re-fits on resize", () => {
    const m = mountChatGpt();
    setColumnWidth(m, 400);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    expect(widgetFrame(m).getAttribute("height")).toBe(
      String(Math.round((400 * 1101) / 2400)),
    );
    setColumnWidth(m, 900);
    fireResize(m);
    expect(widgetFrame(m).getAttribute("height")).toBe(
      String(Math.round((900 * 1101) / 2400)),
    );
  });

  it("re-fits on resize even when the mount happened before layout", () => {
    // The regression this pins: the listener used to be registered only
    // `if (fitted !== null)`, and `fitted` is computed ONCE, at delivery time.
    // `aspectHeight` returns null when `clientWidth` is 0 — the normal
    // pre-layout state of a freshly mounted iframe — so a widget whose
    // tool-result arrived before layout settled got no listener at all and kept
    // the `structuredContent.height` fallback for the rest of its life, even
    // once the column width became known. Which is precisely the empty-band bug
    // the aspect fix exists to remove, reached by a different route.
    const m = mountChatGpt();
    // No `setColumnWidth`: clientWidth is 0, exactly as before layout.
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    // Mounted on the fallback, as it must be — there is nothing to fit to yet.
    expect(widgetFrame(m).getAttribute("height")).toBe("720");

    // Layout settles and the host reflows.
    setColumnWidth(m, COLUMN_WIDTH);
    fireResize(m);
    expect(widgetFrame(m).getAttribute("height")).toBe(
      String(Math.round((COLUMN_WIDTH * 1101) / 2400)),
    );
  });

  it("declines a resize that still has no width, rather than throwing", () => {
    // `aspectHeight` returns null per-event, which is what makes unconditional
    // registration safe.
    const m = mountChatGpt();
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    expect(() => fireResize(m)).not.toThrow();
    expect(widgetFrame(m).getAttribute("height")).toBe("720");
  });

  it("stands down once the committed iframe loads", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    fireFrameLoad(m);
    // Still the iframe, and no PNG was painted behind it.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetImg(m).getAttribute("src")).toBeNull();
  });

  it("falls back to the remote PNG when the host CSP blocks the iframe", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    fireFrameSrcViolation(m);
    // Frame unloaded and hidden; the image took over.
    expect(widgetFrame(m).getAttribute("src")).toBe("about:blank");
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
    // ...and the click-through still points at the interactive chart.
    fireImageLoad(m);
    expect(widgetLink(m).getAttribute("href")).toBe(EMBED_URL);
    expect(widgetLink(m).classList.contains("hidden")).toBe(false);
  });

  it("does not re-probe the iframe it just abandoned", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    fireFrameSrcViolation(m);
    // The fallback image loading is exactly when the PNG path would normally
    // arm `probeInteractiveIframe`. It must not here: the iframe already
    // failed, and a probe "succeeding" on an error page would swap the
    // working PNG back out.
    fireImageLoad(m);
    expect(widgetFrame(m).getAttribute("src")).toBe("about:blank");
    expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
  });

  it("shows a click-through when the iframe fails and there is no image", () => {
    const m = mountChatGpt();
    deliver(m, toolResult({ embed_url: EMBED_URL }), m.wrapperWin);
    fireFrameSrcViolation(m);
    const placeholder = m.widgetWin.document.getElementById(
      "tako-placeholder",
    ) as HTMLElement;
    expect(placeholder.classList.contains("hidden")).toBe(false);
    const anchor = placeholder.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(EMBED_URL);
  });

  it("ignores a violation for a directive other than frame-src", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    const event = new WidgetEvent("securitypolicyviolation");
    Object.assign(event, { effectiveDirective: "img-src" });
    m.widgetWin.document.dispatchEvent(event);
    // An unrelated CSP report must not tear down a working chart.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    expect(widgetImg(m).getAttribute("src")).toBeNull();
  });

  it("stops honoring embed-height messages after a downgrade", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    fireFrameSrcViolation(m);
    fireImageLoad(m);
    const before = widgetFrame(m).getAttribute("height");
    deliverEmbedHeight(m, 999);
    // `embedOrigin` was cleared on downgrade, so the abandoned embed can no
    // longer resize the widget out from under the PNG.
    expect(widgetFrame(m).getAttribute("height")).toBe(before);
  });
});

/**
 * Native-card upgrade: replacing the PNG with Tako's real interactive card by
 * fetching the embed page through our CORS proxy and letting its own scripts
 * run in the widget document.
 *
 * The property that matters more than the upgrade working is that FAILING
 * leaves today's behavior exactly as it was. The PNG is painted first and the
 * document is only opened once the markup is in hand, so every failure mode —
 * 502, timeout, non-HTML, network error — has to be a no-op on screen.
 */
describe("native card upgrade (executed)", () => {
  const NATIVE_URL = "https://mcp.example.test/embed-html/abc123";
  const NATIVE_HTML =
    "<!doctype html><html><body><div id='app'>REAL CARD</div></body></html>";

  /** Deliver a chart with the native URL armed. */
  function deliverNative(m: Mounted, url = NATIVE_URL): void {
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL, native_card_url: url },
      ),
      m.wrapperWin,
    );
  }

  /** Stub the widget window's fetch. */
  function stubFetch(
    m: Mounted,
    impl: (url: string) => Promise<unknown>,
  ): { calls: string[] } {
    const calls: string[] = [];
    (m.widgetWin as unknown as { fetch: unknown }).fetch = (url: string) => {
      calls.push(String(url));
      return impl(String(url));
    };
    return { calls };
  }

  function htmlResponse(body: string, ok = true): Promise<unknown> {
    return Promise.resolve({
      ok,
      status: ok ? 200 : 502,
      text: () => Promise.resolve(body),
    });
  }

  it("does not attempt an upgrade when the server did not arm it", () => {
    // Production default: no native_card_url, so no fetch at all.
    const m = mountWidget(staticWidgetHtml());
    const f = stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    expect(f.calls).toEqual([]);
  });

  it("paints the PNG first, then fetches the native card", () => {
    const m = mountWidget(staticWidgetHtml());
    const f = stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliverNative(m);
    // The PNG is the committed baseline BEFORE any fetch happens.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(f.calls).toEqual([]);
    fireImageLoad(m);
    expect(f.calls).toEqual([NATIVE_URL]);
  });

  it("keeps the PNG when the proxy errors", async () => {
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => htmlResponse("upstream error", false));
    deliverNative(m);
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));
    // Unchanged: same image, same click-through, document never opened.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(widgetLink(m).getAttribute("href")).toBe(EMBED_URL);
    expect(m.widgetWin.document.body.innerHTML).not.toContain("REAL CARD");
  });

  it("keeps the PNG when the fetch rejects", async () => {
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => Promise.reject(new Error("network down")));
    deliverNative(m);
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(m.widgetWin.document.body.innerHTML).not.toContain("REAL CARD");
  });

  it("keeps the PNG when the body is not an HTML document", async () => {
    // A proxy that starts returning JSON must not have it written into the
    // document as markup.
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => htmlResponse('{"error":"UNIQUE-SENTINEL-BODY"}'));
    deliverNative(m);
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    // A distinctive sentinel, not the word "error" — the widget's own markup
    // legitimately contains that.
    expect(m.widgetWin.document.body.innerHTML).not.toContain(
      "UNIQUE-SENTINEL-BODY",
    );
  });

  /**
   * Intercept the upgrade's 7 s bail timer so it can be fired on demand.
   *
   * The widget calls `setTimeout` from its OWN window, so the global fake-timer
   * machinery does not see it; patch the window's method instead. Only the
   * 7000 ms timer is captured — everything else (the probe, the log ladder)
   * keeps its real behavior.
   */
  function captureBailTimer(m: Mounted): { fire: () => void; count: () => number } {
    const captured: Array<() => void> = [];
    const win = m.widgetWin as unknown as {
      setTimeout: (fn: () => void, ms?: number) => unknown;
    };
    const real = win.setTimeout.bind(m.widgetWin);
    win.setTimeout = (fn: () => void, ms?: number) => {
      if (ms === 7000) {
        captured.push(fn);
        return 0;
      }
      return real(fn, ms);
    };
    return {
      fire: () => captured.forEach((fn) => fn()),
      count: () => captured.length,
    };
  }

  it("keeps the PNG when the native fetch times out", async () => {
    // The fourth failure mode. The other three (502, network, non-HTML) each
    // had a test; this one did not, and it is the one with real ordering risk.
    const m = mountWidget(staticWidgetHtml());
    // A fetch that never settles.
    stubFetch(m, () => new Promise(() => {}));
    const bail = captureBailTimer(m);
    deliverNative(m);
    fireImageLoad(m);
    expect(bail.count()).toBe(1);

    bail.fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(m.widgetWin.document.body.innerHTML).not.toContain("REAL CARD");
  });

  it("ignores a native response that arrives AFTER the timeout", async () => {
    // The timer sets `settled = true` but does not abort the fetch, so a late
    // response still runs `.then`. The only thing standing between it and a
    // `document.open()` over a working chart is the `if (settled) return` — so
    // pin that guard, not the happy path.
    const m = mountWidget(staticWidgetHtml());
    let resolveFetch: ((v: unknown) => void) | undefined;
    stubFetch(
      m,
      () =>
        new Promise((res) => {
          resolveFetch = res as (v: unknown) => void;
        }),
    );
    const bail = captureBailTimer(m);
    deliverNative(m);
    fireImageLoad(m);

    // Timeout first...
    bail.fire();
    await new Promise((r) => setTimeout(r, 10));
    // ...then the response turns up anyway, with a perfectly good document.
    resolveFetch!({
      ok: true,
      status: 200,
      text: () => Promise.resolve(NATIVE_HTML),
    });
    await new Promise((r) => setTimeout(r, 10));

    // It must not be written over the chart the user is already looking at.
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    expect(m.widgetWin.document.body.innerHTML).not.toContain("REAL CARD");
  });

  it("never fetches a relative url when the server armed no native card", () => {
    // `nativeCardUrl` is `""` whenever `_meta.native_card_url` is absent — no
    // longer the deployed default, but still an env without `PUBLIC_CDN_URL`, a
    // failed resolve, or a cached result from before the field existed — and
    // `""` IS a string, so it slipped past
    // `withHostTheme`'s `typeof` bail, took the append branch, and came back
    // `"?dark_mode=true"`. That cleared `upgradeToNativeCard`'s own
    // `nativeUrl === ""` guard, which sees the TRANSFORMED value, and reached
    // `fetch("?dark_mode=true")` resolved against the widget document — a
    // request in nobody's `connect-src`, i.e. the same blocked-subresource
    // class the retired iframe probe was costing us.
    //
    // Needs a host theme to reproduce: `withHostTheme` is a no-op when
    // `hostTheme()` returns null.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: object }).openai = { theme: "dark" };
    const f = stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliver(
      m,
      toolResult(
        // No `embed_url`, so `useIframe` is false and the PNG path runs even
        // with `window.openai` present.
        { image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    expect(f.calls).toEqual([]);
  });

  it("fetches at most once even if both image events fire", async () => {
    const m = mountWidget(staticWidgetHtml());
    const f = stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliverNative(m);
    fireImageLoad(m);
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    widgetImg(m).dispatchEvent(new WidgetEvent("error"));
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls.length).toBe(1);
  });

  it("attempts the upgrade even when the PNG itself failed", async () => {
    // Nothing to protect in that case, and the native card is the better
    // outcome than a click-through link.
    const m = mountWidget(staticWidgetHtml());
    const f = stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliverNative(m);
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    widgetImg(m).dispatchEvent(new WidgetEvent("error"));
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls).toEqual([NATIVE_URL]);
  });

  it("injects a height reporter into the markup it writes", async () => {
    // `document.open()` discards the widget's own listeners, so without an
    // injected reporter the host would size the card from a stale value.
    let written = "";
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => htmlResponse(NATIVE_HTML));
    const doc = m.widgetWin.document as unknown as {
      open: () => void;
      write: (s: string) => void;
      close: () => void;
    };
    doc.open = () => {};
    doc.write = (s: string) => {
      written += s;
    };
    doc.close = () => {};
    deliverNative(m);
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));
    expect(written).toContain("REAL CARD");
    expect(written).toContain("ui/notifications/size-changed");
    expect(written).toContain("notifyIntrinsicHeight");
    // The reporter goes inside the body, not appended after </html>.
    expect(written.indexOf("size-changed")).toBeLessThan(
      written.indexOf("</body>"),
    );
  });

  it("holds the native card to the host's inline height ceiling", async () => {
    // `MAX_INLINE_WIDGET_HEIGHT_PX` is a host CONSTRAINT, not a preference:
    // Claude renders inline up to ~500 px and gives the card no scrollbar, so
    // anything past that is cropped and the card loses its bottom edge — the
    // axis labels and the source line. The PNG path honours it in both
    // directions (`max-height` + `object-fit: contain`, and a `Math.min` on
    // what it notifies); the native card had no clamp at all, and after
    // `document.open()` the CSS that enforced the ceiling is gone with the old
    // document. It also carries strictly MORE than the PNG (range selectors,
    // chart/table toggle, source line), so it is the likelier to exceed it.
    //
    // jsdom performs no layout, so `offsetHeight` is 0 and the reporter falls
    // through to `__FALLBACK_HEIGHT__` — here the requested 600, over the cap.
    // Exactly the case that matters.
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliverNative(m);
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));

    // The document was replaced by the real card...
    expect(m.widgetWin.document.body.innerHTML).toContain("REAL CARD");
    // ...and the reporter that came with it capped what it asked the host for,
    // rather than requesting 600 and losing 100 px off the bottom.
    const sizeChanges = m.toParent.filter(
      (msg) =>
        (msg as { method?: string }).method === "ui/notifications/size-changed",
    ) as Array<{ params: { height: number } }>;
    expect(sizeChanges.at(-1)?.params.height).toBe(500);

    // And it scaled the document to fit rather than letting it be cropped —
    // the document equivalent of `object-fit: contain`.
    const root = m.widgetWin.document.documentElement;
    expect(root.style.transform).toBe(`scale(${500 / 600})`);
    expect(root.style.transformOrigin).toBe("top left");
  });

  it("leaves a card under the ceiling unscaled", async () => {
    // The clamp must not touch the common case, or every short card gets a
    // pointless transform and a blurrier render.
    const m = mountWidget(staticWidgetHtml());
    stubFetch(m, () => htmlResponse(NATIVE_HTML));
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 300 },
        { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 10));

    const sizeChanges = m.toParent.filter(
      (msg) =>
        (msg as { method?: string }).method === "ui/notifications/size-changed",
    ) as Array<{ params: { height: number } }>;
    expect(sizeChanges.at(-1)?.params.height).toBe(300);
    expect(m.widgetWin.document.documentElement.style.transform).toBe("");
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

/**
 * Theme: the chart urls carry `dark_mode=auto`, which the embed page resolves
 * from `prefers-color-scheme` INSIDE the widget iframe — i.e. from the OS. That
 * is correct while the host follows the OS and wrong the moment the user themes
 * the host itself, which is how a dark ChatGPT on a light machine ends up with a
 * light card on a dark surface.
 */
describe("host theme (executed)", () => {
  function themedFrameSrc(theme: string | undefined): string | null {
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai =
      theme === undefined ? {} : { theme };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    return widgetFrame(m).getAttribute("src");
  }

  it("asks for a dark card when the host says dark", () => {
    expect(themedFrameSrc("dark")).toContain("dark_mode=true");
  });

  it("asks for a light card when the host says light", () => {
    expect(themedFrameSrc("light")).toContain("dark_mode=false");
  });

  it("handles namespaced theme values", () => {
    // Hosts have shipped values like "dark-high-contrast"; substring, not equality.
    expect(themedFrameSrc("dark-high-contrast")).toContain("dark_mode=true");
  });

  it("leaves auto alone when the host says nothing", () => {
    // `auto` is still the best available guess; overriding it with a coin flip
    // would be worse than following the OS.
    expect(themedFrameSrc(undefined)).toContain("dark_mode=auto");
  });

  it("ignores an unrecognised theme value", () => {
    expect(themedFrameSrc("solarized")).toContain("dark_mode=auto");
  });
});

/**
 * The handshake-ordering race robertabbott flagged.
 *
 * `initialized` goes out on a 200 ms timer whether or not the init RESPONSE
 * landed, so a host answering in ~350 ms legitimately delivers a tool-result
 * BEFORE we know its theme. Rendering then latches an OS-themed card that
 * neither the late response nor a retry can fix.
 */
describe("first-render hold (executed)", () => {
  const NATIVE_URL = "https://mcp.example.test/embed-html/abc123?dark_mode=auto";

  /** Simulate the 200 ms timer having fired without an init response. */
  function forceInitializedSent(m: Mounted): void {
    vi.advanceTimersByTime(250);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function chart(): unknown {
    return toolResult(
      { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
      { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
    );
  }

  it("holds a tool-result that arrives after `initialized` but before the response", () => {
    const m = mountWidget(staticWidgetHtml());
    forceInitializedSent(m);
    deliver(m, chart(), m.wrapperWin);
    // Nothing painted yet — the theme is still unknown.
    expect(widgetImg(m).getAttribute("src")).toBeNull();
  });

  it("renders with the theme once the late response lands", () => {
    const m = mountWidget(staticWidgetHtml());
    const calls: string[] = [];
    (m.widgetWin as unknown as { fetch: unknown }).fetch = (url: string) => {
      calls.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<!doctype html><html><body>c</body></html>"),
      });
    };
    forceInitializedSent(m);
    deliver(m, chart(), m.wrapperWin);
    // Response arrives at ~350 ms, after the tool-result.
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: { hostContext: { theme: "light" } } },
      m.wrapperWin,
    );
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
    fireImageLoad(m);
    // The card is themed from the HOST, which is the whole point — before the
    // hold this url carried `dark_mode=auto` and resolved off the OS.
    expect(calls[0]).toContain("dark_mode=false");
  });

  it("releases the hold when the grace window expires", () => {
    // A host that answers `initialized` but never `ui/initialize` must not
    // strand the chart forever.
    const m = mountWidget(staticWidgetHtml());
    forceInitializedSent(m);
    deliver(m, chart(), m.wrapperWin);
    expect(widgetImg(m).getAttribute("src")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
  });

  it("renders only once when the response and the grace both fire", () => {
    const m = mountWidget(staticWidgetHtml());
    forceInitializedSent(m);
    deliver(m, chart(), m.wrapperWin);
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: { hostContext: { theme: "dark" } } },
      m.wrapperWin,
    );
    const first = widgetImg(m).getAttribute("src");
    vi.advanceTimersByTime(500);
    expect(widgetImg(m).getAttribute("src")).toBe(first);
    // `rendered` latches, so a replay could not double-render anyway — but the
    // held payload is cleared before rendering so it cannot be replayed at all.
    expect(
      methodsSent(m).filter((x) => x === "ui/notifications/size-changed").length,
    ).toBeGreaterThan(0);
  });

  it("does NOT hold a tool-result that precedes `initialized`", () => {
    // Such a host is not following the handshake, so there is no response to
    // wait for — holding would only delay the chart. This is also the shape
    // every other test in this file uses, which is why they still pass.
    const m = mountWidget(staticWidgetHtml());
    deliver(m, chart(), m.wrapperWin);
    expect(widgetImg(m).getAttribute("src")).toBe(DATA_URL);
  });
});

/**
 * The MCP Apps theme source. `window.openai.theme` is ChatGPT-only, so on
 * claude.ai the theme used to resolve to null and both chart urls stayed on
 * `dark_mode=auto` — i.e. the OS. A light Claude on a dark machine therefore
 * rendered a dark card on a light surface.
 *
 * The spec DOES carry a theme: the `ui/initialize` RESPONSE includes
 * `result.hostContext.theme`, and hosts send `ui/notifications/host-context-changed`
 * when it changes. Both are read here.
 *
 * Asserted on the native-card url because that is the Claude path — no
 * `window.openai`, so `render()` takes the image branch and then upgrades.
 */
describe("mcp apps host theme (executed)", () => {
  const NATIVE_URL = "https://mcp.example.test/embed-html/abc123?dark_mode=auto";

  /**
   * Mount, feed the widget a sequence of host messages, deliver a chart with
   * the native url armed, and return the url the native upgrade fetched.
   * The upgrade runs from the image `load` handler, so that has to be fired.
   */
  function nativeUrlAfter(hostMessages: unknown[]): string | undefined {
    const m = mountWidget(staticWidgetHtml());
    const calls: string[] = [];
    (m.widgetWin as unknown as { fetch: unknown }).fetch = (url: string) => {
      calls.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<!doctype html><html><body></body></html>"),
      });
    };
    for (const msg of hostMessages) deliver(m, msg, m.wrapperWin);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    return calls[0];
  }

  function initResponse(hostContext: unknown): unknown {
    return { jsonrpc: "2.0", id: "tako-ui-init", result: { hostContext } };
  }

  function contextChanged(hostContext: unknown): unknown {
    return {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { hostContext },
    };
  }

  function nativeUrlWithHostContext(hostContext: unknown): string | undefined {
    return nativeUrlAfter(
      hostContext === undefined ? [] : [initResponse(hostContext)],
    );
  }

  it("asks for a light card when the host declares a light theme", () => {
    expect(nativeUrlWithHostContext({ theme: "light" })).toContain(
      "dark_mode=false",
    );
  });

  it("asks for a dark card when the host declares a dark theme", () => {
    expect(nativeUrlWithHostContext({ theme: "dark" })).toContain(
      "dark_mode=true",
    );
  });

  it("stays on auto when the host declares no theme", () => {
    // Still the best available guess — following the OS beats a coin flip.
    expect(nativeUrlWithHostContext({})).toContain("dark_mode=auto");
  });

  it("stays on auto when the host never answers the handshake", () => {
    expect(nativeUrlWithHostContext(undefined)).toContain("dark_mode=auto");
  });

  it("ignores an unrecognised hostContext theme", () => {
    expect(nativeUrlWithHostContext({ theme: "solarized" })).toContain(
      "dark_mode=auto",
    );
  });

  it("honours a theme that only arrives via host-context-changed", () => {
    // Hosts MAY omit `theme` at initialize and send it later; a toggle before
    // the first tool call must still be reflected.
    expect(
      nativeUrlAfter([initResponse({}), contextChanged({ theme: "light" })]),
    ).toContain("dark_mode=false");
  });

  it("merges a partial host-context-changed instead of replacing context", () => {
    // Spec: "Views merge received fields with their current context state
    // rather than replacing it entirely." A displayMode-only update must not
    // wipe the theme learned at initialize.
    expect(
      nativeUrlAfter([
        initResponse({ theme: "light" }),
        contextChanged({ displayMode: "fullscreen" }),
      ]),
    ).toContain("dark_mode=false");
  });

  it("paints the host's own surface colour when the host sends one", () => {
    // The exact fix for the exposed corners: an opaque canvas in the host's own
    // colour is invisible against the host's page AND gives the corners the
    // right backdrop. `color-scheme` can only approximate it.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    // The DOM normalizes hex to rgb() on the way in.
    expect(root.style.background).toBe("rgb(25, 24, 23)");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("refuses an empty functional colour", () => {
    // `rgb()` parses as a function but is not a colour; assigning it is a
    // silent no-op that would have suppressed the fallback tier.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "rgb()" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    expect(root.style.background).toBe("");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("refuses a host surface colour that is not a colour", () => {
    // Arrives over postMessage and is interpolated into an injected <style>,
    // so it is an injection sink. Allow-list a grammar, do not escape.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: {
          variables: {
            "--color-background-primary": "red;} body{display:none} :root{x:",
          },
        },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    expect(root.style.background).not.toContain("display:none");
    // Falls back to the approximate tier rather than trusting the value.
    expect(root.style.colorScheme).toBe("dark");
  });

  it("leaves the canvas alone entirely when the host says nothing", () => {
    // A same-origin frame composites transparently over the parent, so the
    // corners are already correct there. Painting anything would introduce the
    // opaque square the transparent surface exists to avoid.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    expect(root.style.colorScheme).toBe("");
    expect(root.style.background).toBe("");
  });

  it("declares color-scheme so the card's corners are not white", () => {
    // The card is a rounded rectangle over a transparent html/body, so its
    // corners fall through to the UA base background — WHITE unless the
    // document declares a scheme. On a dark host that showed as four white
    // triangles. `color-scheme` and not a background colour, because an opaque
    // colour would put a square block back over the host's rounded container.
    const m = mountWidget(staticWidgetHtml());
    deliver(m, initResponse({ theme: "dark" }), m.wrapperWin);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL },
      ),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("dark");
    // Still transparent — the fix must not reintroduce an opaque surface.
    const bg = m.widgetWin.document.documentElement.style.background;
    expect(bg === "" || bg.includes("transparent")).toBe(true);
  });

  it("follows a light host too", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, initResponse({ theme: "light" }), m.wrapperWin);
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("light");
  });

  it("leaves the UA default alone when the host declares no theme", () => {
    // Guessing dark here would put BLACK corners on a light host — the same
    // bug mirrored.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("");
  });

  it("injects the scheme into the native card document too", async () => {
    // The native path replaces this document wholesale, so the widget's own
    // <html> style does not survive — the scheme has to ride in the markup.
    const m = mountWidget(staticWidgetHtml());
    let written = "";
    (m.widgetWin as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve("<!doctype html><html><body><div>card</div></body></html>"),
      });
    const doc = m.widgetWin.document as unknown as {
      open(): void;
      write(s: string): void;
      close(): void;
    };
    doc.open = () => {};
    doc.write = (s: string) => {
      written += s;
    };
    doc.close = () => {};
    deliver(m, initResponse({ theme: "dark" }), m.wrapperWin);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 30));
    // Theme only, no surface colour sent -> the approximate tier, and NO
    // background is painted (transparency is left intact).
    expect(written).toContain("color-scheme:dark");
    expect(written).not.toContain("background:");
    // Injected before </body> so it wins over the page's own rules.
    expect(written.indexOf("color-scheme:dark")).toBeLessThan(
      written.indexOf("</body>"),
    );
  });

  it("paints the native card document in the host's surface colour", async () => {
    // The native path replaces this document, so the colour has to ride in the
    // markup — and this is the tier that makes the corners exact rather than
    // approximate.
    const m = mountWidget(staticWidgetHtml());
    let written = "";
    (m.widgetWin as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<!doctype html><html><body>c</body></html>"),
      });
    const doc = m.widgetWin.document as unknown as {
      open(): void;
      write(s: string): void;
      close(): void;
    };
    doc.open = () => {};
    doc.write = (t: string) => {
      written += t;
    };
    doc.close = () => {};
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "rgb(25, 24, 23)" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toContain("background:rgb(25, 24, 23)");
    expect(written).toContain("color-scheme:dark");
  });

  it("does not inject a hostile surface colour into the native document", async () => {
    const m = mountWidget(staticWidgetHtml());
    let written = "";
    (m.widgetWin as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<!doctype html><html><body>c</body></html>"),
      });
    const doc = m.widgetWin.document as unknown as {
      open(): void;
      write(s: string): void;
      close(): void;
    };
    doc.open = () => {};
    doc.write = (t: string) => {
      written += t;
    };
    doc.close = () => {};
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: {
          variables: {
            "--color-background-primary": "#fff}</style><script>x=1</script><style>",
          },
        },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 },
        { image_data_url: DATA_URL, native_card_url: NATIVE_URL },
      ),
      m.wrapperWin,
    );
    fireImageLoad(m);
    await new Promise((r) => setTimeout(r, 30));
    // The payload never lands, and no background is painted — it falls back
    // to the approximate tier instead of trusting the value.
    expect(written).not.toContain("x=1");
    expect(written).not.toContain("background:");
    expect(written).toContain("color-scheme:dark");
  });

  it("leaves ChatGPT's canvas transparent — no box where none existed", () => {
    // The gate that matters for cross-platform safety. ChatGPT exposes a theme,
    // but bare `color-scheme` paints Chrome's #121212, which reads as a visible
    // square on any host whose frame already composites transparently. Measured
    // against a #191817 surface, that square is obvious. claude.ai's frame is
    // WHITE (the bug), so the trade is worth it there and only there — and on
    // ChatGPT the chart is a NESTED cross-origin iframe we could not style
    // anyway. So: no paint, no color-scheme, nothing.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    expect(root.style.colorScheme).toBe("");
    expect(root.style.background).toBe("");
    // ChatGPT is still themed — via the dark_mode rewrite on the iframe url,
    // which is what actually colours its card.
    expect(widgetFrame(m).getAttribute("src")).toContain("dark_mode=true");
  });

  it("still paints ChatGPT's canvas when a surface colour IS supplied", () => {
    // Tier 1 is exact, so it is safe on every host — the gate is only on the
    // approximate tier.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      initResponse({
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.background).toBe(
      "rgb(25, 24, 23)",
    );
  });

  it("drops a stale surface when the host flips theme without sending one", () => {
    // noahjax's confirmed bug. A spec-legal `{theme:"light"}` with no `styles`
    // must not leave the DARK colour in `mcpHostSurface` — it stays truthy, so
    // tier 1 returns early and paints it under a light card. This PR's own bug,
    // mirrored, and confidently wrong rather than merely stale.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliver(m, contextChanged({ theme: "light" }), m.wrapperWin);
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    const root = m.widgetWin.document.documentElement;
    // Tier 1 dropped, tier 2 ran with the NEW theme.
    expect(root.style.background).toBe("");
    expect(root.style.colorScheme).toBe("light");
  });

  it("keeps the surface when a partial update repeats the same theme", () => {
    // The complement: dropping on every update would throw away a good colour.
    // Only a CHANGE of theme with no replacement surface invalidates it.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliver(m, contextChanged({ theme: "dark" }), m.wrapperWin);
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.background).toBe(
      "rgb(25, 24, 23)",
    );
  });

  it("keeps a surface that arrives WITH the theme flip", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      contextChanged({
        theme: "light",
        styles: { variables: { "--color-background-primary": "#ffffff" } },
      }),
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
      m.wrapperWin,
    );
    expect(m.widgetWin.document.documentElement.style.background).toBe(
      "rgb(255, 255, 255)",
    );
  });

  it("rejects shape-valid values that are not colours", () => {
    // The enumeration kept leaking: rgb() was closed, then rgb( ) got back
    // through, and #12345 / #1234567 / rgb(url) never were. Each passed, painted
    // nothing, and left tier 1 claiming success — so the parser decides now.
    for (const bogus of ["rgb( )", "rgb(url)", "lab(image-set)", "#12345", "#1234567"]) {
      const m = mountWidget(staticWidgetHtml());
      deliver(
        m,
        initResponse({
          theme: "dark",
          styles: { variables: { "--color-background-primary": bogus } },
        }),
        m.wrapperWin,
      );
      deliver(
        m,
        toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
        m.wrapperWin,
      );
      const root = m.widgetWin.document.documentElement;
      expect(root.style.background, `${bogus} must not paint`).toBe("");
      // And the fallback tier still runs, which the early return had suppressed.
      expect(root.style.colorScheme, `${bogus} must fall through`).toBe("dark");
    }
  });

  it("still accepts the spellings CSS does accept", () => {
    for (const good of ["#fff", "#ffff", "#191817", "#191817ff", "rgb(25, 24, 23)"]) {
      const m = mountWidget(staticWidgetHtml());
      deliver(
        m,
        initResponse({
          theme: "dark",
          styles: { variables: { "--color-background-primary": good } },
        }),
        m.wrapperWin,
      );
      deliver(
        m,
        toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL }, { image_data_url: DATA_URL }),
        m.wrapperWin,
      );
      expect(
        m.widgetWin.document.documentElement.style.background,
        `${good} must paint`,
      ).not.toBe("");
    }
  });

  it("prefers window.openai.theme when both sources are present", () => {
    // ChatGPT's own runtime is the authority on ChatGPT; a stale or spoofed
    // hostContext must not override the host API that host actually drives.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      {
        jsonrpc: "2.0",
        id: "tako-ui-init",
        result: { hostContext: { theme: "light" } },
      },
      m.wrapperWin,
    );
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    expect(widgetFrame(m).getAttribute("src")).toContain("dark_mode=true");
  });
});

describe("no-image embed fallback strips tracking too", () => {
  // The invariant in `docs/chatgpt-app-review.md` §4 is stated absolutely —
  // "every iframe load the widget performs" — but this branch used to assign
  // the raw url. Reaching it needs a valid `embed_url` beside an `image_url`
  // the image path rejects, which prod never emits today; the guard exists so
  // the invariant holds by construction rather than by that continuing to be
  // true. No `window.openai`, so the ChatGPT path is not taken and the
  // else-if chain falls through image → embed.
  it("appends disable_tracking on the validEmbed-without-image path", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: "ftp://tako.com/x.png" }),
      m.wrapperWin,
    );
    // Exact compare, not toContain: a regression that drops the flag or
    // double-appends it must fail here.
    expect(widgetFrame(m).getAttribute("src")).toBe(
      `${EMBED_URL}&disable_tracking=true`,
    );
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
  });
});
