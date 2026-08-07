/**
 * Diagnostic: does the widget bundle render when data arrives the way
 * ChatGPT's Apps SDK ACTUALLY delivers it?
 *
 * The existing suite's "commits to the iframe immediately when
 * window.openai is present" test sets `window.openai = {}` and then
 * delivers the payload over the MCP-Apps `ui/notifications/tool-result`
 * postMessage — a route ChatGPT does not use. The three routes below are
 * the ones `pickFromOpenAi` / `pickFromGlobals` were written for.
 *
 * Payload is the REAL prod structuredContent from
 * `tools/call tako_search` on mcp.tako.com (2026-07-31), tako.com origins
 * and all.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import { buildChartAppUiResourceFromOutputPubId } from "../../src/tools/_chart_widget.js";

// Prod env, so embed_url/frameDomains are the real tako.com origin.
const ENV: Env = { DJANGO_BASE_URL: "https://tako.com" };

const PUB_ID = "VKd7qE8K9Ba16kMFENNQ";
const EMBED_URL = `https://tako.com/embed/${PUB_ID}/?dark_mode=auto`;
const IMAGE_URL = `https://tako.com/api/v1/image/${PUB_ID}/?dark_mode=true`;

// Verbatim shape of prod's structuredContent (cards/web_results elided).
const PROD_STRUCTURED_CONTENT = {
  cards: [],
  web_results: [],
  usage: {},
  request_id: "req_diag",
  pub_id: PUB_ID,
  embed_url: EMBED_URL,
  image_url: IMAGE_URL,
  dark_mode: true,
  width: 900,
  height: 720,
};

const mounted: JSDOM[] = [];

interface Mounted {
  widgetWin: Window;
  toParent: unknown[];
}

/**
 * Mount the widget with an optional pre-injected `window.openai`, set
 * BEFORE the bundle executes — mirroring a host that populates globals
 * ahead of the widget script (the synchronous-probe path).
 */
function mountWidget(html: string, openai?: object): Mounted {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("log", () => {});
  virtualConsole.on("warn", () => {});
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
  wrapperDoc.body.appendChild(widgetFrame);

  const toParent: unknown[] = [];
  (
    wrapperWin as unknown as { postMessage: (msg: unknown) => void }
  ).postMessage = (msg: unknown) => {
    toParent.push(msg);
  };

  const widgetWin = widgetFrame.contentWindow!;
  if (openai !== undefined) {
    (widgetWin as unknown as { openai: object }).openai = openai;
  }

  const widgetDoc = widgetFrame.contentDocument!;
  widgetDoc.open();
  widgetDoc.write(html);
  widgetDoc.close();

  return { widgetWin: widgetFrame.contentWindow!, toParent };
}

function frame(m: Mounted): HTMLIFrameElement {
  return m.widgetWin.document.getElementById("tako-embed") as HTMLIFrameElement;
}

function img(m: Mounted): HTMLImageElement {
  return m.widgetWin.document.getElementById(
    "tako-embed-img",
  ) as HTMLImageElement;
}

/** Dispatch ChatGPT's globals event on both window and document. */
function fireSetGlobals(m: Mounted, globals: unknown, name: string): void {
  const WidgetCustomEvent = (
    m.widgetWin as unknown as { CustomEvent: typeof CustomEvent }
  ).CustomEvent;
  m.widgetWin.dispatchEvent(
    new WidgetCustomEvent(name, { detail: { globals } }),
  );
}

function html(): string {
  return buildChartAppUiResourceFromOutputPubId(ENV).html;
}

/**
 * Did the widget commit to the interactive iframe?
 *
 * The expected src is the embed url with `disable_tracking=true` appended —
 * `withoutTracking` in `_chart_widget.ts` adds it to every iframe load the
 * widget performs. THIS path is why it exists: ChatGPT commits to a real
 * cross-origin iframe of the embed page, and OpenAI's iframe policy singles
 * out analytics and tracking inside an app's frame. An exact compare (not
 * `toContain`) so a regression that drops the flag fails here.
 */
function renderedIframe(m: Mounted): boolean {
  return (
    frame(m).getAttribute("src") === `${EMBED_URL}&disable_tracking=true`
  );
}

afterEach(() => {
  for (const dom of mounted.splice(0)) dom.window.close();
});

describe("ChatGPT Apps SDK delivery paths", () => {
  it("PATH 1: window.openai.toolOutput present before the script runs", () => {
    const m = mountWidget(html(), { toolOutput: PROD_STRUCTURED_CONTENT });
    expect(renderedIframe(m)).toBe(true);
    expect(frame(m).classList.contains("hidden")).toBe(false);
  });

  it("PATH 2: openai:set_globals fires with detail.globals.toolOutput", () => {
    const m = mountWidget(html(), {});
    expect(renderedIframe(m)).toBe(false); // nothing yet — correct
    fireSetGlobals(
      m,
      { toolOutput: PROD_STRUCTURED_CONTENT },
      "openai:set_globals",
    );
    expect(renderedIframe(m)).toBe(true);
  });

  it("PATH 3: only toolResponseMetadata.structuredContent is populated", () => {
    const openai: Record<string, unknown> = {};
    const m = mountWidget(html(), openai);
    // Host populates the global late, then fires the event with no
    // useful detail — the dev-mode behavior the bundle comments cite.
    openai.toolResponseMetadata = {
      structuredContent: PROD_STRUCTURED_CONTENT,
    };
    fireSetGlobals(m, undefined, "openai:set_globals");
    expect(renderedIframe(m)).toBe(true);
  });

  it("PATH 4: globals carry structuredContent directly (no toolOutput key)", () => {
    const m = mountWidget(html(), {});
    fireSetGlobals(
      m,
      { structuredContent: PROD_STRUCTURED_CONTENT },
      "openai:set_globals",
    );
    expect(renderedIframe(m)).toBe(true);
  });

  it("EMPTY: a chart-less toolOutput labels the card ChatGPT keeps anyway", () => {
    // The host this was reported on. ChatGPT mounts the widget from static
    // `openai/outputTemplate` registration metadata, so a zero-card search
    // still gets a widget card, and it holds that card at its minimum height
    // through the shrink to zero — an unexplained grey void beside a working
    // answer. The bundle cannot un-mount itself; it can only make the space
    // read as intentional. Delivered on PATH 1, the route ChatGPT actually
    // uses, because a guard that only works over postMessage would not have
    // covered this host at all.
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: { cards: [], web_results: [], usage: {} },
      theme: "light",
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    const empty = m.widgetWin.document.getElementById(
      "tako-empty",
    ) as HTMLElement;
    expect(empty.classList.contains("hidden")).toBe(false);
    expect(empty.textContent).toMatch(/no chart/i);
    expect(renderedIframe(m)).toBe(false);
    // ChatGPT reads `notifyIntrinsicHeight`, not the postMessage, and the last
    // thing it hears must be zero: labelling a box the host kept is not a
    // request for one. [1, 0] — the mount-time floor, then the collapse.
    expect(heights).toEqual([1, 0]);
  });

  it("EMPTY: reads the label colour from window.openai.theme, both ways", () => {
    // `window.openai.theme` is the ONLY theme source on ChatGPT — it never
    // sends `hostContext`, so the MCP Apps coverage in widget-dom.test.ts says
    // nothing about this read. Without this, a regression in it would surface
    // as an unreadable label in a chat window rather than in CI.
    const emptyOf = (m: Mounted) =>
      (m.widgetWin.document.getElementById("tako-empty") as HTMLElement).style
        .color;

    const light = mountWidget(html(), {
      toolOutput: { cards: [] },
      theme: "light",
    });
    expect(emptyOf(light)).toBe("rgb(107, 114, 128)");

    const dark = mountWidget(html(), {
      toolOutput: { cards: [] },
      theme: "dark",
    });
    expect(emptyOf(dark)).toBe("rgb(180, 184, 189)");

    // No theme declared → no inline override at all, so the stylesheet's
    // `prefers-color-scheme` pair decides. Asserting the ABSENCE is what keeps
    // a compromise grey from creeping back into the JS.
    const silent = mountWidget(html(), { toolOutput: { cards: [] } });
    expect(emptyOf(silent)).toBe("");
  });

  it("NO PNG FALLBACK: with openai present the widget never paints an image", () => {
    const m = mountWidget(html(), { toolOutput: PROD_STRUCTURED_CONTENT });
    // ChatGPT skips extraMeta, so there is no image_data_url; confirm the
    // bundle does not fall back to the remote image_url either.
    expect(img(m).getAttribute("src")).toBeNull();
  });
});
