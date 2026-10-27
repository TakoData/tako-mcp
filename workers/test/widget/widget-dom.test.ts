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

const EMBED_URL =
  "https://staging.trytako.com/embed/abc123/?dark_mode=auto&showShare=true";
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

function mountWidget(html: string, openai?: object): Mounted {
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

  if (openai !== undefined) {
    (widgetFrame.contentWindow as unknown as { openai: object }).openai = openai;
  }
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
      // The handler is gated on `event.source === frame.contentWindow` —
      // only the widget's OWN embed iframe may drive resize/reveal, not any
      // other same-origin browsing context that can reach this window.
      source: widgetFrame(m).contentWindow as unknown as MessageEventSource,
    }),
  );
}

/** Every `size-changed` height the widget has posted to the host so far. */
function sizeChangesOf(m: Mounted): Array<{ params: { height: number } }> {
  return m.toParent.filter(
    (msg) =>
      (msg as { method?: string }).method === "ui/notifications/size-changed",
  ) as Array<{ params: { height: number } }>;
}

/** Fire the embed iframe's `load` event as if the embed page loaded. */
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

/** Fire a `frame-src` CSP violation as if the host sandbox blocked the iframe. */
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
  return buildChartAppUiResourceFromOutputPubId(ENV, undefined, "chatgpt").html;
}

const WORKER_ORIGIN = "https://mcp.example.test";

interface LiveChart {
  pub_id: string;
  embed_url: string;
  image_url: string;
  native_card_url?: string;
}

interface FetchCall {
  url: string;
  init: { credentials?: string } | undefined;
}

interface LiveStubs {
  fetches: FetchCall[];
  blobs: Map<string, Blob>;
}

const SEARCH_CONTENT = {
  cards: [{ title: "Card", url: "https://tako.com/card/x" }],
  web_results: [],
  usage: null,
};

function liveChart(i: number): LiveChart {
  const pubId = `live${i}`;
  return {
    pub_id: pubId,
    embed_url: `https://staging.trytako.com/embed/${pubId}/?dark_mode=auto&showShare=true`,
    image_url: `https://staging.trytako.com/api/v1/image/${pubId}/?dark_mode=true`,
    native_card_url: `${WORKER_ORIGIN}/embed-html/${pubId}`,
  };
}

function liveCharts(count: number): LiveChart[] {
  return Array.from({ length: count }, (_, i) => liveChart(i));
}

function liveHtml(): string {
  return buildChartAppUiResourceFromOutputPubId(ENV, WORKER_ORIGIN, "generic").html;
}

function cardHtml(url: string): string {
  return `<!doctype html><html><body><div id="app">CARD ${url}</div></body></html>`;
}

function okResponse(body: string): Promise<unknown> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  });
}

function stubLive(
  m: Mounted,
  respond: (url: string) => Promise<unknown> = (url) => okResponse(cardHtml(url)),
): LiveStubs {
  const stubs: LiveStubs = { fetches: [], blobs: new Map() };
  const win = m.widgetWin as unknown as {
    fetch: unknown;
    URL: { createObjectURL: unknown };
  };
  win.fetch = (url: string, init?: { credentials?: string }) => {
    stubs.fetches.push({ url: String(url), init });
    return respond(String(url));
  };
  win.URL.createObjectURL = (blob: Blob) => {
    const url = `blob:https://host.example/${stubs.blobs.size}`;
    stubs.blobs.set(url, blob);
    return url;
  };
  return stubs;
}

function fetchedUrls(stubs: LiveStubs): string[] {
  return stubs.fetches.map((f) => f.url);
}

function nativeUrls(charts: LiveChart[]): string[] {
  return charts.map((c) => c.native_card_url ?? "");
}

function liveSlides(m: Mounted): HTMLElement[] {
  return Array.from(
    m.widgetWin.document.querySelectorAll<HTMLElement>("#tako-carousel .tako-slide"),
  );
}

function slideFrame(m: Mounted, i: number): HTMLIFrameElement | null {
  const slide = liveSlides(m)[i];
  if (slide === undefined) throw new Error(`no slide at index ${i}`);
  return slide.querySelector("iframe");
}

function mountedFrame(m: Mounted, i: number): HTMLIFrameElement {
  const frame = slideFrame(m, i);
  if (frame === null) throw new Error(`slide ${i} has no frame`);
  return frame;
}

function navButton(m: Mounted, id: "tako-prev" | "tako-next"): HTMLButtonElement {
  return m.widgetWin.document.getElementById(id) as HTMLButtonElement;
}

function deliverLive(m: Mounted, charts: LiveChart[], content: unknown = SEARCH_CONTENT): void {
  deliver(m, toolResult(content, { charts }), m.wrapperWin);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function postSlideHeight(
  m: Mounted,
  source: Window,
  height: number,
  type = "tako-live-card-height",
): void {
  const WidgetMessageEvent = (
    m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
  ).MessageEvent;
  m.widgetWin.dispatchEvent(
    new WidgetMessageEvent("message", {
      data: { type, height },
      origin: "null",
      source: source as unknown as MessageEventSource,
    }),
  );
}

function expectFailureCopy(m: Mounted, i: number, chart: LiveChart): void {
  const slide = liveSlides(m)[i] as HTMLElement;
  expect(slide.textContent).toContain("Couldn't load this chart.");
  const link = Array.from(slide.querySelectorAll("a")).find(
    (a) => a.textContent === "Open in Tako",
  );
  expect(link?.getAttribute("href")).toBe(chart.embed_url);
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(slide.querySelector("iframe")).toBeNull();
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

  it("accepts a tool-result delivered from window.top (nested-wrapper hosts)", () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const charts = liveCharts(1);
    deliver(m, toolResult(SEARCH_CONTENT, { charts }), m.outerWin);
    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
  });

  it("drops a forged tool-result from a sibling frame — and warns about it", () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    deliver(m, toolResult(SEARCH_CONTENT, { charts: liveCharts(1) }), m.siblingWin);
    // No render: a sibling connector must not be able to inject a chart
    // or a click-through URL.
    expect(stubs.fetches).toEqual([]);
    expect(liveSlides(m)).toHaveLength(0);
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
    (m.widgetWin as unknown as { openai: object }).openai = {};
    deliver(
      m,
      toolResult(
        // eslint-disable-next-line no-script-url
        { embed_url: "javascript:alert(1)", image_url: IMAGE_URL },
      ),
      m.wrapperWin,
    );
    // Image still renders (the image url is independently validated) but
    // the hostile scheme never lands in href.
    expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
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
    const m = mountWidget(liveHtml());
    stubLive(m);
    deliverLive(m, liveCharts(1));
    expect(liveSlides(m)).toHaveLength(1);
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
      // Collapsed but NOT labelled. "Nothing arrived in 10 s" covers a failed
      // call and a merely slow delivery alike — so "No chart for this result" would be an
      // affirmative claim that is wrong exactly when the chart was late. The
      // label is reserved for the case the widget actually knows about:
      // structured content arrived and carried no chart.
      expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a live-card result that lands after the no-data watchdog collapsed", async () => {
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      const stubs = stubLive(m);
      deliver(m, { jsonrpc: "2.0", id: "tako-ui-init", result: {} }, m.wrapperWin);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(m.widgetWin.document.documentElement.style.height).toBe("0px");

      const charts = liveCharts(2);
      deliverLive(m, charts);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
      expect(liveSlides(m)).toHaveLength(2);
      expect(m.widgetWin.document.documentElement.style.height).not.toBe("0px");
      expect(m.widgetWin.document.body.style.height).not.toBe("0px");
      expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a chart that lands after the no-data watchdog collapsed, with window.openai", () => {
    vi.useFakeTimers();
    try {
      const m = mountWidget(staticWidgetHtml(), {});
      vi.advanceTimersByTime(11_000);
      expect(m.widgetWin.document.documentElement.style.height).toBe("0px");

      deliver(
        m,
        toolResult({ cards: [], embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
        m.wrapperWin,
      );

      expect(widgetFrame(m).getAttribute("src")).toBeNull();
      expect(m.widgetWin.document.documentElement.style.height).toBe("0px");
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels the collapse when the tool-result itself says the call failed", () => {
    // The MCP-Apps twin of the ChatGPT failed-call case: the host delivers
    // the error result as a `ui/notifications/tool-result` whose params carry
    // `isError: true` and `_meta["tako/error"]` but no `structuredContent`.
    // That is a positive signal — unlike the silent 10 s watchdog — so the
    // widget can collapse immediately AND label the box for hosts that keep
    // it visible anyway.
    const m = mountWidget(staticWidgetHtml());
    deliver(
      m,
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          isError: true,
          content: [{ type: "text", text: "Django returned 502 for POST /api/v3/search/" }],
          _meta: { "tako/error": { kind: "http", status: 502 } },
        },
      },
      m.wrapperWin,
    );
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(false);
    expect(widgetEmpty(m).textContent).toMatch(/failed/i);
    expect(m.widgetWin.document.documentElement.style.height).toBe("0px");
    const sizeChanges = m.toParent.filter(
      (msg) =>
        (msg as { method?: string }).method === "ui/notifications/size-changed",
    ) as Array<{ params: { height: number } }>;
    expect(sizeChanges.at(-1)?.params.height).toBe(0);
  });

  it("does not collapse a chart that already rendered", async () => {
    // The watchdog must be a no-op once anything painted, or a slow host
    // would have its working chart yanked at the 10 s mark.
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      stubLive(m);
      deliverLive(m, liveCharts(1));
      await vi.advanceTimersByTimeAsync(0);
      postSlideHeight(m, mountedFrame(m, 0).contentWindow as Window, 300);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);
      expect(m.widgetWin.document.documentElement.style.height).not.toBe("0px");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The `window.openai` path commits to the iframe up front, so it needs a way
 * DOWN to the PNG when that iframe never renders. Before the watchdog this
 * path had no fallback at all — a blocked or hanging embed left an empty frame
 * in the chat forever, with `image_url` unused in the same payload.
 *
 * ChatGPT is the client that takes this path, so these results carry
 * `image_url` and at most the PNG's natural dimensions in `_meta`.
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

  it("commits to the iframe immediately when window.openai is present", () => {
    const m = mountChatGpt();
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL },
        { image_natural_width: 800, image_natural_height: 600 },
      ),
      m.wrapperWin,
    );
    // ChatGPT path: no PNG detour — straight to the iframe, which stays
    // hidden until the embed page loads (reveal-on-load).
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    fireFrameLoad(m);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetImg(m).getAttribute("src")).toBeNull();
  });

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
    // The host is told the same number — at reveal (the frame's `load`),
    // or the outer container keeps the band.
    fireFrameLoad(m);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(expected);
  });

  it("keeps the committed iframe veiled until the embed loads, then reveals", () => {
    // The "weird loading phase" on ChatGPT: the widget used to unhide the
    // iframe and notify the full chart height at delivery, expanding the
    // host's card seconds before tako.com/embed had painted anything — a
    // full-height blank box. Reveal-on-load makes the expansion and the
    // pixels arrive together. Failure paths are unchanged: a CSP violation
    // or the watchdog timeout still downgrade to the PNG.
    //
    // Veiled, NOT display:none-hidden: the frame keeps its layout box (at
    // height 0) so the embed page boots with the REAL column width. Under
    // display:none the embed would lay out at a 0-width viewport, and a
    // `tako-embed-height` measured in that degenerate layout would be
    // notified and permanently pinned by ChatGPT's max-height quirk.
    const m = mountChatGpt();
    setColumnWidth(m, COLUMN_WIDTH);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    // Committed (src pinned, height staged, layout box live) but veiled —
    // and the host has not been told to expand: the last size-changed is
    // still the 1 px mount floor.
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(1);
    fireFrameLoad(m);
    expect(widgetFrame(m).classList.contains("veiled")).toBe(false);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(
      Math.round((COLUMN_WIDTH * 1101) / 2400),
    );
  });

  it("re-fits at reveal when layout settled between commit and load", () => {
    // The resize listener stands down while the frame is hidden, so the
    // reveal must re-derive the height itself — otherwise a widget whose
    // tool-result arrived before layout (clientWidth 0 → the 720 fallback)
    // would reveal at 720 even though the column is known by then.
    const m = mountChatGpt();
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    expect(widgetFrame(m).getAttribute("height")).toBe("720");
    setColumnWidth(m, COLUMN_WIDTH);
    fireFrameLoad(m);
    expect(widgetFrame(m).getAttribute("height")).toBe(
      String(Math.round((COLUMN_WIDTH * 1101) / 2400)),
    );
  });

  it("an embed-height report while awaiting load reveals AND settles the watchdog", () => {
    // `tako-embed-height` can only come from the running embed page, so it
    // is an even stronger "it rendered" signal than `load`. Without the
    // unveil, the handler's notify would expand the host card around an
    // invisible frame — the exact blank box reveal-on-load removes.
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
    deliverEmbedHeight(m, 500);
    expect(widgetFrame(m).classList.contains("veiled")).toBe(false);
    expect(widgetFrame(m).getAttribute("height")).toBe("500");
    // The handshake must also SETTLE the committed-iframe watchdog: the
    // embed has proven it rendered, so a late `load` (slow font, stalled
    // subresource) must not let the 8 s timeout downgrade a chart the user
    // is already looking at. A frame-src violation after the handshake is
    // the synchronous probe for that — with the watchdog settled its
    // listener is gone, so nothing downgrades.
    fireFrameSrcViolation(m);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(false);
    expect(widgetFrame(m).getAttribute("src")).toBe(EMBED_IFRAME_SRC);
  });

  it("ignores an embed-height report whose sender is not our embed frame", () => {
    // Origin alone would admit any browsing context on the pinned Tako
    // origin that can reach this window through the frame tree — and the
    // branch now controls visibility, not just size. The sender must be the
    // widget's OWN embed iframe.
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    const WidgetMessageEvent = (
      m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
    ).MessageEvent;
    m.widgetWin.dispatchEvent(
      new WidgetMessageEvent("message", {
        data: { type: "tako-embed-height", height: 500 },
        origin: "https://staging.trytako.com", // right origin...
        source: m.widgetWin as unknown as MessageEventSource, // ...wrong window
      }),
    );
    expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
    expect(widgetFrame(m).getAttribute("height")).not.toBe("500");
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
    // Reveal first: the resize listener stands down while the frame is
    // hidden awaiting its `load`.
    fireFrameLoad(m);
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
    fireFrameLoad(m);

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

  it("ignores the srcless iframe's stray about:blank load", () => {
    // #tako-embed is parser-inserted with no `src`, so the browser queues a
    // `load` for its initial about:blank document — delivered right after
    // the watchdog attaches its listener on the synchronous toolOutput
    // path. Unguarded, that one event settled the watchdog (killing the
    // CSP/timeout → PNG downgrade for the widget's life) and revealed the
    // veiled frame at full height around nothing. The guard keys on the one
    // fact that separates the stray from the real embed: about:blank is
    // same-origin-readable, the cross-origin embed is not. jsdom navigates
    // the frame's document synchronously on src assignment, so the stray
    // state is modelled by pinning contentDocument back to an about:blank
    // reading.
    const m = mountChatGpt();
    setColumnWidth(m, COLUMN_WIDTH);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    Object.defineProperty(widgetFrame(m), "contentDocument", {
      configurable: true,
      get: () => ({ location: { href: "about:blank" } }) as unknown as Document,
    });
    fireFrameLoad(m); // the stray
    // No reveal — the frame stays veiled, and the host was not told to grow.
    expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(1);
    // No settle either — the watchdog must still be armed, so a CSP block
    // arriving after the stray still downgrades to the PNG.
    fireFrameSrcViolation(m);
    expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
    expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
  });

  it("still reveals on the genuine load after ignoring the stray", () => {
    const m = mountChatGpt();
    setColumnWidth(m, COLUMN_WIDTH);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    Object.defineProperty(widgetFrame(m), "contentDocument", {
      configurable: true,
      get: () => ({ location: { href: "about:blank" } }) as unknown as Document,
    });
    fireFrameLoad(m); // stray — ignored
    expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
    // The embed responds: cross-origin, so contentDocument reads null.
    Object.defineProperty(widgetFrame(m), "contentDocument", {
      configurable: true,
      get: () => null,
    });
    fireFrameLoad(m); // the genuine load
    expect(widgetFrame(m).classList.contains("veiled")).toBe(false);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(
      Math.round((COLUMN_WIDTH * 1101) / 2400),
    );
  });

  it("downgrades a veiled frame to the PNG when nothing loads in the settle window", () => {
    // The veiled→timeout→PNG path end to end: every other downgrade test
    // reaches downgrade() via a CSP violation, so the timeout branch — and
    // the `remove("veiled")` before `add("hidden")`, and the PNG revealing
    // itself out of a veiled frame — never ran under test.
    vi.useFakeTimers();
    try {
      const m = mountChatGpt();
      setColumnWidth(m, COLUMN_WIDTH);
      deliver(m, CHATGPT_RESULT, m.wrapperWin);
      expect(widgetFrame(m).classList.contains("veiled")).toBe(true);
      vi.advanceTimersByTime(8000); // IFRAME_SETTLE_MS
      // Downgraded: unveiled AND hidden (an element carrying both classes
      // would resurrect at height 0 if `hidden` were ever lifted), frame
      // unloaded, PNG painted in its place.
      expect(widgetFrame(m).classList.contains("veiled")).toBe(false);
      expect(widgetFrame(m).classList.contains("hidden")).toBe(true);
      expect(widgetFrame(m).getAttribute("src")).toBe("about:blank");
      expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
      // The PNG reveals itself on its own load, exactly like the CSP path.
      fireImageLoad(m);
      expect(widgetLink(m).classList.contains("hidden")).toBe(false);
      expect(widgetLink(m).getAttribute("href")).toBe(EMBED_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands down the resize re-fit while the frame is veiled", () => {
    // The reveal re-fits for the veiled window (test above), so the live
    // listener must not fight it: a column change before `load` is picked
    // up at reveal time, not mid-veil.
    const m = mountChatGpt();
    setColumnWidth(m, COLUMN_WIDTH);
    deliver(
      m,
      toolResult(
        { embed_url: EMBED_URL, image_url: IMAGE_URL, height: 720 },
        { image_natural_width: 2400, image_natural_height: 1101 },
      ),
      m.wrapperWin,
    );
    const staged = widgetFrame(m).getAttribute("height");
    setColumnWidth(m, 900);
    fireResize(m);
    expect(widgetFrame(m).getAttribute("height")).toBe(staged);
    // Reveal picks up the new width.
    fireFrameLoad(m);
    expect(widgetFrame(m).getAttribute("height")).toBe(
      String(Math.round((900 * 1101) / 2400)),
    );
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

  it("does not reload the iframe it just abandoned", () => {
    const m = mountChatGpt();
    deliver(m, CHATGPT_RESULT, m.wrapperWin);
    fireFrameSrcViolation(m);
    // The fallback image loading must not send the frame back to the embed:
    // the iframe already failed, and a reload "succeeding" on an error page
    // would swap the working PNG back out.
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

  function mountLive(): { m: Mounted; stubs: LiveStubs } {
    const m = mountWidget(liveHtml());
    return { m, stubs: stubLive(m) };
  }

  it("holds a tool-result that arrives after `initialized` but before the response", () => {
    const { m, stubs } = mountLive();
    forceInitializedSent(m);
    deliverLive(m, liveCharts(1));
    // Nothing mounted yet — the theme is still unknown.
    expect(stubs.fetches).toEqual([]);
    expect(liveSlides(m)).toHaveLength(0);
  });

  it("renders with the theme once the late response lands", () => {
    const { m, stubs } = mountLive();
    forceInitializedSent(m);
    deliverLive(m, liveCharts(1));
    // Response arrives at ~350 ms, after the tool-result.
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: { hostContext: { theme: "light" } } },
      m.wrapperWin,
    );
    // The card is themed from the HOST, which is the whole point — before the
    // hold this url carried `dark_mode=auto` and resolved off the OS.
    expect(fetchedUrls(stubs)[0]).toContain("dark_mode=false");
  });

  it("releases the hold when the grace window expires", () => {
    // A host that answers `initialized` but never `ui/initialize` must not
    // strand the chart forever.
    const { m, stubs } = mountLive();
    const charts = liveCharts(1);
    forceInitializedSent(m);
    deliverLive(m, charts);
    expect(stubs.fetches).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
  });

  it("renders only once when the response and the grace both fire", () => {
    const { m, stubs } = mountLive();
    forceInitializedSent(m);
    deliverLive(m, liveCharts(1));
    deliver(
      m,
      { jsonrpc: "2.0", id: "tako-ui-init", result: { hostContext: { theme: "dark" } } },
      m.wrapperWin,
    );
    vi.advanceTimersByTime(500);
    // `rendered` latches, so a replay could not double-render anyway — but the
    // held payload is cleared before rendering so it cannot be replayed at all.
    expect(stubs.fetches).toHaveLength(1);
    expect(liveSlides(m)).toHaveLength(1);
  });

  it("does NOT hold a tool-result that precedes `initialized`", () => {
    // Such a host is not following the handshake, so there is no response to
    // wait for — holding would only delay the chart. This is also the shape
    // every other test in this file uses, which is why they still pass.
    const { m, stubs } = mountLive();
    const charts = liveCharts(1);
    deliverLive(m, charts);
    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
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
 * Asserted on the live card url because that is the Claude path — no
 * `window.openai`, so `render()` mounts live cards.
 */
describe("mcp apps host theme (executed)", () => {
  const LIVE_CARD_URL = "https://mcp.example.test/embed-html/abc123?dark_mode=auto";

  /**
   * Mount, feed the widget a sequence of host messages, deliver a live chart,
   * and return the url the live card fetched.
   */
  function liveCardUrlAfter(hostMessages: unknown[]): string | undefined {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    for (const msg of hostMessages) deliver(m, msg, m.wrapperWin);
    deliverLive(m, [{ ...liveChart(0), native_card_url: LIVE_CARD_URL }]);
    return stubs.fetches[0]?.url;
  }

  function deliverChart(m: Mounted): void {
    stubLive(m);
    deliverLive(m, liveCharts(1));
  }

  /**
   * Mount, feed the widget a sequence of host messages, deliver a live chart,
   * and return the document the widget wrote into the live card's blob.
   */
  async function liveCardDocumentAfter(hostMessages: unknown[], openai?: object): Promise<string> {
    const m = mountWidget(liveHtml(), openai);
    const stubs = stubLive(m, () =>
      okResponse("<!doctype html><html><body><div>card</div></body></html>"),
    );
    for (const msg of hostMessages) deliver(m, msg, m.wrapperWin);
    deliverLive(m, liveCharts(1));
    await settle();
    return (await stubs.blobs.get(mountedFrame(m, 0).getAttribute("src") ?? "")?.text()) ?? "";
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

  function liveCardUrlWithHostContext(hostContext: unknown): string | undefined {
    return liveCardUrlAfter(
      hostContext === undefined ? [] : [initResponse(hostContext)],
    );
  }

  it("asks for a light card when the host declares a light theme", () => {
    expect(liveCardUrlWithHostContext({ theme: "light" })).toContain(
      "dark_mode=false",
    );
  });

  it("asks for a dark card when the host declares a dark theme", () => {
    expect(liveCardUrlWithHostContext({ theme: "dark" })).toContain(
      "dark_mode=true",
    );
  });

  it("stays on auto when the host declares no theme", () => {
    // Still the best available guess — following the OS beats a coin flip.
    expect(liveCardUrlWithHostContext({})).toContain("dark_mode=auto");
  });

  it("stays on auto when the host never answers the handshake", () => {
    expect(liveCardUrlWithHostContext(undefined)).toContain("dark_mode=auto");
  });

  it("ignores an unrecognised hostContext theme", () => {
    expect(liveCardUrlWithHostContext({ theme: "solarized" })).toContain(
      "dark_mode=auto",
    );
  });

  it("honours a theme that only arrives via host-context-changed", () => {
    // Hosts MAY omit `theme` at initialize and send it later; a toggle before
    // the first tool call must still be reflected.
    expect(
      liveCardUrlAfter([initResponse({}), contextChanged({ theme: "light" })]),
    ).toContain("dark_mode=false");
  });

  it("merges a partial host-context-changed instead of replacing context", () => {
    // Spec: "Views merge received fields with their current context state
    // rather than replacing it entirely." A displayMode-only update must not
    // wipe the theme learned at initialize.
    expect(
      liveCardUrlAfter([
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
    deliverChart(m);
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
    deliverChart(m);
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
    deliverChart(m);
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
    deliverChart(m);
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
    deliverChart(m);
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("dark");
    // Still transparent — the fix must not reintroduce an opaque surface.
    const bg = m.widgetWin.document.documentElement.style.background;
    expect(bg === "" || bg.includes("transparent")).toBe(true);
  });

  it("follows a light host too", () => {
    const m = mountWidget(staticWidgetHtml());
    deliver(m, initResponse({ theme: "light" }), m.wrapperWin);
    deliverChart(m);
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("light");
  });

  it("leaves the UA default alone when the host declares no theme", () => {
    // Guessing dark here would put BLACK corners on a light host — the same
    // bug mirrored.
    const m = mountWidget(staticWidgetHtml());
    deliverChart(m);
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("");
  });

  it("injects the scheme into the live card document too", async () => {
    // The live card is a separate document, so the widget's own <html> style
    // does not reach it — the scheme has to ride in the markup.
    const written = await liveCardDocumentAfter([initResponse({ theme: "dark" })]);
    // Theme only, no surface colour sent -> the approximate tier, which paints
    // the theme's canvas literal. It used to emit `color-scheme` alone and
    // leave the canvas transparent; measured in Chrome, `color-scheme` does not
    // reliably paint a base, so the corners stayed white on the very hosts this
    // tier exists for.
    expect(written).toContain("color-scheme:dark");
    expect(written).toContain("background:#121212");
    // Injected before </body> so it wins over the page's own rules.
    expect(written.indexOf("color-scheme:dark")).toBeLessThan(
      written.indexOf("</body>"),
    );
  });

  it("paints the live card document in the host's surface colour", async () => {
    // The live card is a separate document, so the colour has to ride in the
    // markup — and this is the tier that makes the corners exact rather than
    // approximate.
    const written = await liveCardDocumentAfter([
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "rgb(25, 24, 23)" } },
      }),
    ]);
    expect(written).toContain("background:rgb(25, 24, 23)");
    expect(written).toContain("color-scheme:dark");
  });

  it("leaves the live card canvas unpainted on a host that exposes window.openai", async () => {
    const written = await liveCardDocumentAfter([], { theme: "dark" });
    expect(written).toContain("card");
    expect(written).toContain("color-scheme:dark");
    expect(written).not.toContain("background:");
  });

  it("does not inject a hostile surface colour into the live card document", async () => {
    const written = await liveCardDocumentAfter([
      initResponse({
        theme: "dark",
        styles: {
          variables: {
            "--color-background-primary": "#fff}</style><script>x=1</script><style>",
          },
        },
      }),
    ]);
    // The payload never lands. The document still gets a backdrop, but it is
    // the theme's canvas literal — the rejected value is nowhere in the markup,
    // and the escape sequence it carried never reaches the parser.
    expect(written).not.toContain("x=1");
    expect(written).toContain("background:#121212");
    expect(written).toContain("color-scheme:dark");
  });

  it("puts a backdrop behind ChatGPT's chart — its corners were white", () => {
    // The reported bug: a dark-mode ChatGPT screenshot (Aug 12 2026) with the
    // card's four 8px corners rendering pure #FFFFFF. This tier used to skip
    // ChatGPT entirely, on the theory that its frame composites transparently
    // and painting would only add a box where none existed. Measured in Chrome
    // against a page that paints white behind the widget frame:
    //
    //   - Frame nesting is NOT the cause. Same-origin, cross-origin, sandboxed,
    //     and two-deep nesting all composite through identically; the white
    //     belongs to the host's own layer underneath.
    //   - `color-scheme` on the widget root did NOT cover it, in any of those
    //     configurations. It paints Chrome's base in some frame setups and not
    //     others, so it cannot carry this fix.
    //   - `background: Canvas` did not cover it either — a root background that
    //     IS the canvas colour leaves nothing to paint.
    //   - A concrete colour on the CHART ELEMENT covered it every time. The
    //     iframe's own box background paints beneath the frame's content, so it
    //     shows exactly where the card is transparent.
    //
    // Hence the backdrop goes on the chart element, not the canvas: it covers
    // the only pixels that were wrong and leaves the rest of the widget
    // transparent, which is what the ChatGPT exclusion was protecting.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    // rgb(18, 18, 18) is #121212 — Chrome's dark Canvas, as a literal.
    expect(widgetFrame(m).style.background).toBe("rgb(18, 18, 18)");
    const root = m.widgetWin.document.documentElement;
    expect(root.style.colorScheme).toBe("dark");
    // The canvas itself stays transparent: a host that reserves more space than
    // the chart fills must keep showing its own surface there.
    expect(root.style.background).toBe("");
    // The card itself is still themed by the dark_mode rewrite on the iframe url.
    expect(widgetFrame(m).getAttribute("src")).toContain("dark_mode=true");
  });

  it("follows ChatGPT into light mode instead of assuming dark", () => {
    // The mirrored bug: a hardcoded dark backdrop would put BLACK corners on a
    // light ChatGPT.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "light",
    };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    expect(widgetFrame(m).style.background).toBe("rgb(255, 255, 255)");
    expect(m.widgetWin.document.documentElement.style.colorScheme).toBe("light");
  });

  it("backs ChatGPT's fallback PNG too, not just the iframe", () => {
    // The PNG is the same rounded rectangle over the same transparent canvas,
    // so it has the same corners. It is the surface ChatGPT falls back to when
    // the iframe is blocked.
    const m = mountWidget(staticWidgetHtml());
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    fireFrameSrcViolation(m);
    expect(widgetImg(m).getAttribute("src")).toBe(IMAGE_URL);
    const img = m.widgetWin.document.getElementById("tako-embed-img") as HTMLElement;
    expect(img.style.background).toBe("rgb(18, 18, 18)");
  });

  it("prefers a host surface token set on our own root over the theme literal", () => {
    // `hostContext.styles.variables` is how the MCP Apps spec transports these,
    // but a host is equally free to just set the custom properties on the widget
    // document — and ChatGPT, which never sends hostContext at all, is the host
    // that would have to. Reading them makes an exact backdrop available on a
    // host that ships tokens without a spec handshake.
    const m = mountWidget(staticWidgetHtml());
    m.widgetWin.document.documentElement.style.setProperty(
      "--color-background-primary",
      "#191817",
    );
    (m.widgetWin as unknown as { openai: Record<string, unknown> }).openai = {
      theme: "dark",
    };
    deliver(
      m,
      toolResult({ embed_url: EMBED_URL, image_url: IMAGE_URL, height: 600 }),
      m.wrapperWin,
    );
    expect(widgetFrame(m).style.background).toBe("rgb(25, 24, 23)");
  });

  it("paints no backdrop at all when nothing names a colour", async () => {
    // No theme, no tokens, no surface. Painting here would be a guess, and the
    // wrong guess is a black corner on a light host.
    const m = mountWidget(liveHtml());
    deliverChart(m);
    await settle();
    expect(mountedFrame(m, 0).style.background).toBe("");
  });

  it("never paints ChatGPT's canvas, even when a surface colour IS supplied", () => {
    // Inverted for ChatGPT ONLY, and measured rather than reasoned. Tier 1 was
    // held to be "exact, so safe on every host"; ChatGPT disproved it by
    // DECLARING `#212121` over `hostContext` while rendering the page behind the
    // widget black. Painting that laid a full-bleed rectangle under a card with
    // 8px rounded corners — an outline around the whole card, not merely wrong
    // corners.
    //
    // A declared surface is a claim about the host's theme, not a measurement of
    // the pixels behind this frame. Where the claim is good the paint is
    // invisible; where it is wrong it is a ring. Only ChatGPT has been measured
    // wrong, so only ChatGPT stops trusting it — every other host keeps tier 1,
    // pinned by the test above, because claude.ai renders correctly with it in
    // production.
    //
    // The colour is not discarded: it still paints the chart ELEMENT, clipped to
    // the card's radius so it cannot overhang the corners.
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
    expect(m.widgetWin.document.documentElement.style.background).toBe("");
    expect(widgetFrame(m).style.background).toBe("rgb(25, 24, 23)");
    expect(widgetFrame(m).style.borderRadius).toBe("8px");
  });

  it("leaves a NON-ChatGPT host unclipped, so claude.ai is untouched", async () => {
    // The scoping guarantee, stated as a test. claude.ai renders correctly in
    // production with the square backdrop and the canvas paint, so the fix for
    // ChatGPT must not reach it: no radius on the element, and tier 1 still
    // paints the canvas (asserted above).
    const m = mountWidget(liveHtml());
    deliver(
      m,
      initResponse({
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#191817" } },
      }),
      m.wrapperWin,
    );
    deliverChart(m);
    await settle();
    expect(mountedFrame(m, 0).style.background).toBe("rgb(25, 24, 23)");
    expect(mountedFrame(m, 0).style.borderRadius).toBe("");
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
    deliverChart(m);
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
    deliverChart(m);
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
    deliverChart(m);
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
      deliverChart(m);
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
      deliverChart(m);
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

describe("live cards (no window.openai)", () => {
  it("mounts one chart as a blob: frame with no nav and no image", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const charts = liveCharts(1);
    deliverLive(m, charts);
    await settle();

    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
    expect(stubs.fetches[0]?.init?.credentials).toBe("omit");
    const frames = m.widgetWin.document.querySelectorAll("#tako-carousel iframe");
    expect(frames).toHaveLength(1);
    expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(mountedFrame(m, 0).getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    expect(navButton(m, "tako-prev").classList.contains("hidden")).toBe(true);
    expect(navButton(m, "tako-next").classList.contains("hidden")).toBe(true);
    expect(fetchedUrls(stubs)).not.toContain(charts[0]?.image_url);
    expect(m.widgetWin.document.querySelectorAll("img[src]")).toHaveLength(0);
    expect(widgetFrame(m).getAttribute("src")).toBeNull();
  });

  it("writes the card, the host scheme, and a tako-live-card-height reporter into the blob", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    deliver(
      m,
      {
        jsonrpc: "2.0",
        id: "tako-ui-init",
        result: { hostContext: { theme: "dark" } },
      },
      m.wrapperWin,
    );
    const charts = liveCharts(1);
    deliverLive(m, charts);
    await settle();

    const src = mountedFrame(m, 0).getAttribute("src") ?? "";
    const blob = stubs.blobs.get(src);
    expect(blob?.type).toBe("text/html");
    const body = (await blob?.text()) ?? "";
    expect(body).toContain(`CARD ${stubs.fetches[0]?.url}`);
    expect(body).toContain('id="tako-host-scheme"');
    expect(body).toContain("color-scheme:dark");
    expect(body).toContain("tako-live-card-height");
    expect(body).not.toContain("tako-embed-height");
    expect(body).not.toContain("ui/notifications/size-changed");
    expect(body.indexOf("tako-live-card-height")).toBeLessThan(body.indexOf("</body>"));
  });

  it("caps the height the blob's reporter posts at the inline ceiling", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    deliverLive(m, liveCharts(1));
    await settle();
    const blob = stubs.blobs.get(mountedFrame(m, 0).getAttribute("src") ?? "");
    const body = (await blob?.text()) ?? "";

    const posted: unknown[] = [];
    const card = new JSDOM(body, {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
          configurable: true,
          get: () => 800,
        });
      },
    });
    mounted.push(card);
    card.window.addEventListener("message", (event) => posted.push(event.data));
    await new Promise((r) => setTimeout(r, 10));

    const heights = posted
      .filter((d) => (d as { type?: string }).type === "tako-live-card-height")
      .map((d) => (d as { height: number }).height);
    expect(heights.length).toBeGreaterThan(0);
    heights.forEach((h) => expect(h).toBeLessThanOrEqual(500));
  });

  it("mounts the first two of five charts, in search order, and the third on next", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const charts = liveCharts(5);
    deliverLive(m, charts);

    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts.slice(0, 2)));
    const slides = liveSlides(m);
    expect(slides).toHaveLength(5);
    await settle();
    expect(slideFrame(m, 2)).toBeNull();

    const track = m.widgetWin.document.querySelector("#tako-carousel .tako-track") as HTMLElement;
    const scrollBy = vi.fn();
    (track as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    navButton(m, "tako-next").click();
    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts.slice(0, 3)));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    await settle();

    for (let i = 0; i < 3; i++) {
      const frame = mountedFrame(m, i);
      expect(frame.getAttribute("title")).toBe(`Tako chart ${i + 1} of 5`);
      const body = (await stubs.blobs.get(frame.getAttribute("src") ?? "")?.text()) ?? "";
      expect(body).toContain(`CARD ${charts[i]?.native_card_url}`);
    }
    expect(slideFrame(m, 3)).toBeNull();
    expect(slideFrame(m, 4)).toBeNull();
  });

  it.each([
    ["HTTP 429", () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("slow down") })],
    ["a non-HTML body", () => okResponse('{"error":"UNIQUE-SENTINEL-BODY"}')],
  ])("shows the failure copy on the slide whose fetch returns %s", async (_label, failure) => {
    const m = mountWidget(liveHtml());
    const charts = liveCharts(3);
    const failing = charts[1]?.native_card_url;
    const stubs = stubLive(m, (url) => (url === failing ? failure() : okResponse(cardHtml(url))));
    deliverLive(m, charts);
    await settle();

    expectFailureCopy(m, 1, charts[1] as LiveChart);
    expect(m.widgetWin.document.body.innerHTML).not.toContain("UNIQUE-SENTINEL-BODY");
    expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);

    const track = m.widgetWin.document.querySelector("#tako-carousel .tako-track") as HTMLElement;
    const scrollBy = vi.fn();
    (track as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    navButton(m, "tako-next").click();
    navButton(m, "tako-prev").click();
    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
    await settle();
    expect(mountedFrame(m, 2).getAttribute("src")?.startsWith("blob:")).toBe(true);
    const lefts = scrollBy.mock.calls.map((call) => (call[0] as { left: number }).left);
    expect(lefts[0]).toBeGreaterThan(0);
    expect(lefts[1]).toBeLessThan(0);
  });

  it("shows the failure copy on a slide whose fetch outlives the 7000 ms timeout", async () => {
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      const charts = liveCharts(3);
      const stalled = charts[1]?.native_card_url;
      const stubs = stubLive(m, (url) =>
        url === stalled ? new Promise(() => {}) : okResponse(cardHtml(url)),
      );
      deliverLive(m, charts);
      await vi.advanceTimersByTimeAsync(6900);
      expect(liveSlides(m)[1]?.textContent).not.toContain("Couldn't load this chart.");
      await vi.advanceTimersByTimeAsync(200);

      expectFailureCopy(m, 1, charts[1] as LiveChart);
      expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);
      navButton(m, "tako-next").click();
      navButton(m, "tako-next").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
      expect(mountedFrame(m, 2).getAttribute("src")?.startsWith("blob:")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the failure copy on the slide whose fetch rejects", async () => {
    const m = mountWidget(liveHtml());
    const charts = liveCharts(2);
    const failing = charts[1]?.native_card_url;
    stubLive(m, (url) =>
      url === failing ? Promise.reject(new Error("network down")) : okResponse(cardHtml(url)),
    );
    deliverLive(m, charts);
    await settle();

    expectFailureCopy(m, 1, charts[1] as LiveChart);
    expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);
  });

  it("ignores a live card response that arrives AFTER the timeout", async () => {
    // The timer settles the slide but does not abort the fetch, so a late
    // response still runs `.then`. Only the `if (settled) return` guard stands
    // between it and a frame mounted over the failure copy — so pin that
    // guard, not the happy path.
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      const charts = liveCharts(1);
      let resolveFetch: ((v: unknown) => void) | undefined;
      const stubs = stubLive(
        m,
        () =>
          new Promise((res) => {
            resolveFetch = res as (v: unknown) => void;
          }),
      );
      deliverLive(m, charts);
      await vi.advanceTimersByTimeAsync(7100);
      expectFailureCopy(m, 0, charts[0] as LiveChart);

      resolveFetch!({
        ok: true,
        status: 200,
        text: () => Promise.resolve(cardHtml("LATE")),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(slideFrame(m, 0)).toBeNull();
      expect(stubs.blobs.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fetches a native card on a foreign origin, and shows the failure copy", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const charts = liveCharts(2);
    charts[0] = { ...(charts[0] as LiveChart), native_card_url: "https://evil.example/embed-html/live0" };
    deliverLive(m, charts);
    await settle();

    expect(fetchedUrls(stubs)).toEqual([charts[1]?.native_card_url]);
    expectFailureCopy(m, 0, charts[0]);
    expect(mountedFrame(m, 1).getAttribute("src")?.startsWith("blob:")).toBe(true);
  });

  it("shows the failure copy on a slide whose chart has no native card url", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const { native_card_url: _dropped, ...withoutNative } = liveChart(0);
    deliverLive(m, [withoutNative]);
    await settle();

    expect(stubs.fetches).toEqual([]);
    expectFailureCopy(m, 0, withoutNative);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBeGreaterThan(1);
  });

  it("resizes only the slide whose frame reported, within the 500 px ceiling, and never shrinks", async () => {
    const m = mountWidget(liveHtml());
    stubLive(m);
    deliverLive(m, liveCharts(3));
    await settle();
    const first = mountedFrame(m, 0);
    const second = mountedFrame(m, 1);
    expect(first.classList.contains("veiled")).toBe(true);

    postSlideHeight(m, first.contentWindow as Window, 380);
    expect(first.getAttribute("height")).toBe("380");
    expect(first.classList.contains("veiled")).toBe(false);
    expect(second.classList.contains("veiled")).toBe(true);
    const afterFirst = sizeChangesOf(m).at(-1)?.params.height ?? 0;
    expect(afterFirst).toBe(380);

    postSlideHeight(m, second.contentWindow as Window, 250);
    expect(second.getAttribute("height")).toBe("250");
    expect(first.getAttribute("height")).toBe("380");

    const before = sizeChangesOf(m).length;
    postSlideHeight(m, m.siblingWin, 450);
    expect(first.getAttribute("height")).toBe("380");
    expect(second.getAttribute("height")).toBe("250");
    expect(sizeChangesOf(m)).toHaveLength(before);

    postSlideHeight(m, first.contentWindow as Window, 900);
    postSlideHeight(m, first.contentWindow as Window, 200);
    const notified = sizeChangesOf(m).map((s) => s.params.height);
    expect(Math.max(...notified)).toBe(500);
    notified.forEach((h, i) => {
      if (i > 0) expect(h).toBeGreaterThanOrEqual(notified[i - 1] as number);
    });
  });

  it("ignores a tako-embed-height from a live frame, which only the card itself sends", async () => {
    const m = mountWidget(liveHtml());
    stubLive(m);
    deliverLive(m, liveCharts(2));
    await settle();
    const first = mountedFrame(m, 0);
    const before = sizeChangesOf(m).length;

    postSlideHeight(m, first.contentWindow as Window, 420, "tako-embed-height");
    expect(first.classList.contains("veiled")).toBe(true);
    expect(first.getAttribute("height")).toBeNull();
    expect(sizeChangesOf(m)).toHaveLength(before);

    postSlideHeight(m, first.contentWindow as Window, 300);
    postSlideHeight(m, first.contentWindow as Window, 420, "tako-embed-height");
    expect(first.getAttribute("height")).toBe("300");
  });

  function stubTrackOverflow(m: Mounted): void {
    const track = m.widgetWin.document.querySelector("#tako-carousel .tako-track") as HTMLElement;
    Object.defineProperty(track, "scrollWidth", { configurable: true, get: () => 2000 });
    Object.defineProperty(track, "clientWidth", { configurable: true, get: () => 700 });
  }

  it("fails a mounted frame that never reports a height once the settle window passes", async () => {
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      const revoked: string[] = [];
      const stubs = stubLive(m);
      (m.widgetWin as unknown as { URL: { revokeObjectURL: unknown } }).URL.revokeObjectURL = (
        url: string,
      ) => revoked.push(url);
      const charts = liveCharts(3);
      deliverLive(m, charts);
      stubTrackOverflow(m);
      await vi.advanceTimersByTimeAsync(0);
      const firstSrc = mountedFrame(m, 0).getAttribute("src");
      expect(navButton(m, "tako-next").classList.contains("hidden")).toBe(true);

      await vi.advanceTimersByTimeAsync(7900);
      expect(slideFrame(m, 0)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(200);

      expectFailureCopy(m, 0, charts[0] as LiveChart);
      expectFailureCopy(m, 1, charts[1] as LiveChart);
      expect(revoked).toContain(firstSrc);
      expect(navButton(m, "tako-next").classList.contains("hidden")).toBe(false);
      navButton(m, "tako-next").click();
      expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a frame that reports a height before the settle window passes", async () => {
    vi.useFakeTimers();
    try {
      const m = mountWidget(liveHtml());
      stubLive(m);
      const charts = liveCharts(2);
      deliverLive(m, charts);
      await vi.advanceTimersByTimeAsync(0);
      const first = mountedFrame(m, 0);
      postSlideHeight(m, first.contentWindow as Window, 340);

      await vi.advanceTimersByTimeAsync(9000);
      expect(mountedFrame(m, 0)).toBe(first);
      expect(first.getAttribute("height")).toBe("340");
      expect(liveSlides(m)[0]?.textContent).not.toContain("Couldn't load this chart.");
      expectFailureCopy(m, 1, charts[1] as LiveChart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the unreported live frames on a frame-src violation", async () => {
    const m = mountWidget(liveHtml());
    stubLive(m);
    const charts = liveCharts(2);
    deliverLive(m, charts);
    await settle();
    const first = mountedFrame(m, 0);
    postSlideHeight(m, first.contentWindow as Window, 340);

    fireFrameSrcViolation(m);

    expect(mountedFrame(m, 0)).toBe(first);
    expectFailureCopy(m, 1, charts[1] as LiveChart);
  });

  it("renders a finished agent result's charts as live cards", async () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const charts = liveCharts(2);
    deliverLive(m, charts, {
      status: "completed",
      run_id: "run_live",
      answer: "Two cards.",
      cards: [{ title: "A" }, { title: "B" }],
      citations: [],
      usage: null,
    });
    await settle();

    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
    expect(liveSlides(m)).toHaveLength(2);
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
  });

  it("collapses a running agent result without fetching", () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    deliverLive(m, liveCharts(2), {
      status: "running",
      run_id: "run_live",
      cards: [],
      citations: [],
      usage: null,
    });

    expect(stubs.fetches).toEqual([]);
    expect(liveSlides(m)).toHaveLength(0);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(0);
  });

  it("collapses with the label when the chart list has no valid slide", () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    const offOrigin = {
      ...liveChart(0),
      embed_url: "https://evil.example/embed/live0/?dark_mode=auto",
    };
    deliverLive(m, [offOrigin]);

    expect(stubs.fetches).toEqual([]);
    expect(liveSlides(m)).toHaveLength(0);
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(false);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(0);
  });

  it("collapses a search result with cards but no chart list blank, so the host shows its own content", () => {
    const m = mountWidget(liveHtml());
    const stubs = stubLive(m);
    deliver(m, toolResult(SEARCH_CONTENT), m.wrapperWin);

    expect(stubs.fetches).toEqual([]);
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(0);
  });

  it("collapses an agent result with cards but no chart list blank", () => {
    const m = mountWidget(liveHtml());
    deliver(
      m,
      toolResult({
        status: "completed",
        run_id: "run_noui",
        answer: "One card.",
        cards: [{ title: "A" }],
        citations: [],
        usage: null,
      }),
      m.wrapperWin,
    );

    expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
    expect(sizeChangesOf(m).at(-1)?.params.height).toBe(0);
  });

  it("still labels a zero-card search result that carries no chart list", () => {
    const m = mountWidget(liveHtml());
    deliver(m, toolResult({ cards: [], web_results: [], usage: null }), m.wrapperWin);

    expect(widgetEmpty(m).classList.contains("hidden")).toBe(false);
    expect(widgetEmpty(m).textContent).toMatch(/no chart/i);
  });

  describe("height reporter in the live card document", () => {
    async function liveCardBody(): Promise<string> {
      const m = mountWidget(liveHtml());
      const stubs = stubLive(m, () => okResponse(cardHtml("REAL CARD")));
      deliverLive(m, liveCharts(1));
      await settle();
      return (await stubs.blobs.get(mountedFrame(m, 0).getAttribute("src") ?? "")?.text()) ?? "";
    }

    interface LiveCardDocument {
      win: Window & typeof globalThis;
      heights: () => number[];
    }

    function runLiveCard(
      body: string,
      prepare: (win: Window & typeof globalThis) => void = () => {},
    ): LiveCardDocument {
      const posted: unknown[] = [];
      const card = new JSDOM(body, {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          const win = window as unknown as Window & typeof globalThis;
          (win as unknown as { postMessage: (msg: unknown) => void }).postMessage = (msg) => {
            posted.push(msg);
          };
          prepare(win);
        },
      });
      mounted.push(card);
      return {
        win: card.window as unknown as Window & typeof globalThis,
        heights: () =>
          posted
            .filter((d) => (d as { type?: string }).type === "tako-live-card-height")
            .map((d) => (d as { height: number }).height),
      };
    }

    function stubOffsetHeight(win: Window & typeof globalThis, height: number): void {
      Object.defineProperty(
        (win as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype,
        "offsetHeight",
        { configurable: true, get: () => height },
      );
    }

    it("reports nothing while the card measures 0, so the slide stays veiled", async () => {
      const card = runLiveCard(await liveCardBody());
      await new Promise((r) => setTimeout(r, 10));

      expect(card.win.document.body.innerHTML).toContain("REAL CARD");
      expect(card.heights()).toEqual([]);
    });

    it("holds the live card to the host's inline height ceiling", async () => {
      // `MAX_INLINE_WIDGET_HEIGHT_PX` is a host CONSTRAINT, not a preference:
      // Claude renders inline up to ~500 px and gives the card no scrollbar, so
      // anything past that is cropped and the card loses its bottom edge — the
      // axis labels and the source line. The live card carries strictly MORE than
      // the PNG (range selectors, chart/table toggle, source line), so it is the
      // likelier to exceed it.
      const card = runLiveCard(await liveCardBody(), (win) => stubOffsetHeight(win, 600));
      await new Promise((r) => setTimeout(r, 10));

      expect(card.win.document.body.innerHTML).toContain("REAL CARD");
      // The reporter capped what it asked the widget for, rather than
      // requesting 600 and losing 100 px off the bottom.
      expect(card.heights().at(-1)).toBe(500);
      // And it scaled the document to fit rather than letting it be cropped —
      // the document equivalent of `object-fit: contain`.
      const root = card.win.document.documentElement;
      expect(root.style.transform).toBe(`scale(${500 / 600})`);
      expect(root.style.transformOrigin).toBe("top left");
    });

    it("leaves a card under the ceiling unscaled", async () => {
      // The clamp must not touch the common case, or every short card gets a
      // pointless transform and a blurrier render.
      const card = runLiveCard(await liveCardBody(), (win) => stubOffsetHeight(win, 300));
      await new Promise((r) => setTimeout(r, 10));

      expect(card.heights().at(-1)).toBe(300);
      expect(card.win.document.documentElement.style.transform).toBe("");
    });

    /**
     * The live card is INTERACTIVE, and the reporter used to treat its height as
     * a one-time measurement.
     *
     * Reported on claude.ai 2026-08-07 as the card being "weirdly cut off" after
     * pressing `Show more`. Measured on the real Nvidia card at a 762 px frame:
     * 527 px on open, 619 px after a tab switch, 641 px after `Show more`. Neither
     * interaction fires `resize` or `load`, the ladder is finished by 3 s, and the
     * page's own CSS is `:root{overflow-y:hidden}` — so growth past the last
     * reported height is not scrolled and not scaled, it is gone.
     *
     * jsdom performs no layout, so the readings are stubbed. The important part is
     * that they are stubbed HONESTLY: `scrollHeight` is a function of the width the
     * reporter has applied to the root, because the reflow that widening causes is
     * the whole reason the loop guard is written the way it is. A stub that ignored
     * the applied style would pass whether or not the guard worked.
     */
    function stubLayout(
      win: Window & typeof globalThis,
      read: { offsetHeight: () => number },
    ): { fireObserver: () => void; observed: string[]; scrollReads: () => number } {
      const w = win as unknown as {
        HTMLElement: { prototype: object };
        ResizeObserver?: unknown;
      };
      let scrollReads = 0;
      Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get: read.offsetHeight,
      });
      // Body's content height AT THE CURRENT ROOT WIDTH. The reporter's fit sets
      // `documentElement.style.width = (100/s)%`, which in a real browser reflows
      // the body shorter — so the value the guard records after the fit differs
      // from the natural one, and a second pass reading the same value is how the
      // sequence terminates. Modelled as an inverse relationship, which is the
      // direction that matters, not the exact number.
      Object.defineProperty(w.HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(): number {
          scrollReads += 1;
          const natural = read.offsetHeight();
          const raw = win.document.documentElement.style.width;
          const pct = raw.endsWith("%") ? Number.parseFloat(raw) : 100;
          if (!Number.isFinite(pct) || pct <= 0) return natural;
          return Math.round(natural * (100 / pct));
        },
      });
      const callbacks: Array<() => void> = [];
      const observed: string[] = [];
      w.ResizeObserver = class {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe(target: { tagName?: string }): void {
          observed.push(String(target?.tagName ?? "?").toLowerCase());
        }
        disconnect(): void {}
      };
      return {
        fireObserver: () => {
          for (const cb of callbacks) cb();
        },
        observed,
        scrollReads: () => scrollReads,
      };
    }

    it("re-reports its height when the card relayouts, not just on a timer", async () => {
      const body = await liveCardBody();
      let natural = 400;
      let layout: ReturnType<typeof stubLayout> | undefined;
      const card = runLiveCard(body, (win) => {
        layout = stubLayout(win, { offsetHeight: () => natural });
      });
      await new Promise((r) => setTimeout(r, 10));
      if (layout === undefined) throw new Error("layout was not stubbed");
      const heights = card.heights;
      const root = card.win.document.documentElement;

      // It watches the BODY. Observing `documentElement` would mean every fit it
      // applies observes itself.
      expect(layout.observed).toEqual(["body"]);
      expect(heights().at(-1)).toBe(400);
      expect(root.style.transform).toBe("");
      const settled = heights().length;

      // A callback with nothing changed must not re-report and must not touch a
      // style — that is what stops the correction from feeding itself every frame.
      //
      // Asserted through the READ COUNT, which is the only signal here that is both
      // synchronous and exact. An early return reads body's scrollHeight once, in
      // the guard; a pass that does work reads it a second time to record `last`.
      // Counting reports alone cannot distinguish "returned early" from "ran and
      // re-reported the same number", and counting style mutations cannot either,
      // since a full pass clears and re-applies to the same values.
      let reads = layout.scrollReads();
      layout.fireObserver();
      expect(heights().length).toBe(settled);
      expect(layout.scrollReads()).toBe(reads + 1);

      // `Show more`: the document grows past the host's inline ceiling. Now it has
      // to both re-report and scale, or the user loses the rows they just asked
      // for. Two reads, because this pass does the work.
      natural = 640;
      reads = layout.scrollReads();
      layout.fireObserver();
      expect(heights().length).toBe(settled + 1);
      expect(heights().at(-1)).toBe(500);
      expect(root.style.transform).toBe(`scale(${500 / 640})`);
      expect(layout.scrollReads()).toBe(reads + 2);

      // THE TERMINATION PROPERTY, which is the half a width-independent stub could
      // not reach. Applying that fit widened the root to 128%, so body's
      // scrollHeight has genuinely changed since the guard last looked — a real
      // browser fires the observer again right here. The guard has to recognise the
      // post-fit value as its own work and stop, or every correction re-corrects
      // forever.
      expect(root.style.width).toBe("128%");
      for (const _ of [0, 1]) {
        reads = layout.scrollReads();
        layout.fireObserver();
        // One read, no report, styles untouched: correction, confirming callback,
        // quiet.
        expect(layout.scrollReads()).toBe(reads + 1);
        expect(heights().length).toBe(settled + 1);
        expect(root.style.transform).toBe(`scale(${500 / 640})`);
        expect(root.style.width).toBe("128%");
      }
    });

    it("swallows a ResizeObserver constructor that throws", async () => {
      // Not `delete window.ResizeObserver`: jsdom never defines it, so deleting it
      // asserted nothing the pre-PR code did not already satisfy, and it could not
      // tell the `typeof` guard apart from the surrounding `try/catch` — either
      // alone would pass. A constructor that THROWS is what reaches the catch,
      // because the global exists and the `typeof` check cannot help.
      //
      // What the catch is worth, stated precisely rather than generously: the
      // observer is wired LAST, after the first report, the listeners and the
      // ladder, so an escaping throw would not cost any of them. What it would cost
      // is an uncaught error inside a card document that hosts report to the user
      // as a broken app. So that — not the ladder — is what this asserts.
      const body = await liveCardBody();
      const uncaught: string[] = [];
      let constructed = 0;
      const card = runLiveCard(body, (win) => {
        stubOffsetHeight(win, 400);
        win.addEventListener("error", (e) => {
          uncaught.push(String((e as ErrorEvent).message ?? e.type));
        });
        (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
          constructor() {
            constructed += 1;
            throw new Error("ResizeObserver unavailable in this host");
          }
        };
      });
      await new Promise((r) => setTimeout(r, 10));

      // It really did try, so the catch is on the live path...
      expect(constructed).toBe(1);
      // ...nothing escaped...
      expect(uncaught).toEqual([]);
      // ...and everything wired before it is intact.
      expect(card.win.document.body.innerHTML).toContain("REAL CARD");
      expect(card.heights().length).toBeGreaterThan(0);
    });

    it("keeps the ladder on a host with no ResizeObserver at all", async () => {
      // The other half of the guard: `typeof ResizeObserver !== 'undefined'`. jsdom
      // gives this for free by never defining it, which is exactly why the test
      // above has to supply a throwing one to be worth anything.
      const card = runLiveCard(await liveCardBody(), (win) => stubOffsetHeight(win, 400));
      expect(
        (card.win as unknown as { ResizeObserver?: unknown }).ResizeObserver,
      ).toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
      expect(card.win.document.body.innerHTML).toContain("REAL CARD");
      expect(card.heights().length).toBeGreaterThan(0);
    });
  });
});

describe("live cards chosen by payload (window.openai defined)", () => {
  function defineOpenAi(m: Mounted): void {
    (m.widgetWin as unknown as { openai: object }).openai = {};
  }

  function embedFrames(m: Mounted): HTMLIFrameElement[] {
    return Array.from(m.widgetWin.document.querySelectorAll("iframe")).filter((frame) =>
      (frame.getAttribute("src") ?? "").includes("/embed/"),
    );
  }

  it("mounts live cards for a /mcp payload that carries native_card_url", async () => {
    const m = mountWidget(liveHtml());
    defineOpenAi(m);
    const stubs = stubLive(m);
    const charts = liveCharts(2);
    deliverLive(m, charts);
    await settle();

    expect(fetchedUrls(stubs)).toEqual(nativeUrls(charts));
    expect(liveSlides(m)).toHaveLength(2);
    expect(mountedFrame(m, 0).getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(mountedFrame(m, 1).getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(embedFrames(m)).toHaveLength(0);
    expect(widgetEmpty(m).classList.contains("hidden")).toBe(true);
  });

  it("keeps the ChatGPT path for a payload with embed_url and no native_card_url", () => {
    const m = mountWidget(staticWidgetHtml());
    defineOpenAi(m);
    const stubs = stubLive(m);
    const { native_card_url: _omitted, ...chartWithoutNative } = liveChart(0);
    deliver(
      m,
      toolResult(
        { embed_url: liveChart(0).embed_url, image_url: liveChart(0).image_url },
        { charts: [chartWithoutNative] },
      ),
      m.wrapperWin,
    );

    expect(stubs.fetches).toEqual([]);
    expect(widgetFrame(m).getAttribute("src")?.startsWith(liveChart(0).embed_url)).toBe(true);
  });

  it("keeps the ChatGPT agent path when meta charts carry no native_card_url", () => {
    const m = mountWidget(staticWidgetHtml());
    defineOpenAi(m);
    const stubs = stubLive(m);
    const { native_card_url: _omitted, ...chartWithoutNative } = liveChart(0);
    deliver(
      m,
      toolResult(
        {
          status: "completed",
          run_id: "run_chatgpt",
          answer: "One card.",
          cards: [{ title: "A" }],
          citations: [],
          usage: null,
        },
        { charts: [chartWithoutNative] },
      ),
      m.wrapperWin,
    );

    expect(stubs.fetches).toEqual([]);
    expect(widgetFrame(m).getAttribute("src")?.startsWith(liveChart(0).embed_url)).toBe(true);
  });
});
