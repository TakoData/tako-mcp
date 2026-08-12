/**
 * Link-by-link diagnostic of the ChatGPT chart path.
 *
 * `chatgpt-path.test.ts` answers "does data get in at all" for the four
 * delivery routes ChatGPT actually uses. This file answers the next question:
 * once data IS in, which links of the render chain still work, and which ones
 * silently do nothing.
 *
 * The chain, in the order the widget walks it:
 *
 *   1. delivery      — `structuredContent` reaches `render()`          (PATH 1-4)
 *   2. commit        — a chart URL is present, so the iframe is pinned
 *   3. sizing        — the iframe's height matches the CARD's aspect ratio
 *   4. fallback      — the iframe failing to load downgrades to the PNG
 *
 * Link 3 is the one that fails today, and it fails silently: the server pays a
 * ranged PNG read on every ChatGPT call to ship the card's true pixel
 * dimensions in `_meta`, and the ChatGPT render path cannot read `_meta` at
 * all. The tests below pin each link separately so the next regression names
 * the link it broke instead of just "the chart looks wrong".
 *
 * Payload is the REAL prod `structuredContent` + `_meta` from
 * `tools/call tako_search {query: "upcoming MLB games"}` on mcp.tako.com
 * (2026-08-12), which is why the numbers are odd: a 2400x1989 schedule card
 * whose declared `height` (720) does not match its own aspect ratio.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import { buildChartAppUiResourceFromOutputPubId } from "../../src/tools/_chart_widget.js";

const ENV: Env = { DJANGO_BASE_URL: "https://tako.com" };

const PUB_ID = "h1fGElf4kA1zsOQU_PFu";
const EMBED_URL = `https://tako.com/embed/${PUB_ID}/?dark_mode=auto`;
const IMAGE_URL = `https://tako.com/api/v1/image/${PUB_ID}/?dark_mode=true`;

/** Prod `structuredContent` (cards/web_results elided — the widget ignores them). */
const STRUCTURED_CONTENT = {
  cards: [],
  web_results: [],
  usage: {},
  pub_id: PUB_ID,
  embed_url: EMBED_URL,
  image_url: IMAGE_URL,
  dark_mode: true,
  width: 900,
  height: 720,
};

/**
 * Prod `_meta` for the SAME call, minus `image_data_url` — which the server
 * deliberately omits for ChatGPT (`bakeImage: ctx.client !== "chatgpt"` in
 * `tako_search.ts`). Everything here IS sent to ChatGPT on the wire.
 */
const META = {
  image_natural_width: 2400,
  image_natural_height: 1989,
  native_card_url: `https://mcp.tako.com/embed-html/${PUB_ID}`,
  "ui/resourceUri": `ui://tako/embed/chart/${PUB_ID}`,
};

/** The card's true aspect. A correctly sized frame is width x this. */
const CARD_ASPECT = META.image_natural_height / META.image_natural_width;

const mounted: JSDOM[] = [];

interface Mounted {
  widgetWin: Window;
  heights: number[];
}

/**
 * Mount the widget with `window.openai` pre-populated — the synchronous-probe
 * route (PATH 1), which is the one ChatGPT takes when the host has data before
 * the bundle runs.
 *
 * `columnWidth` is what the host gives the widget. It matters because
 * `aspectHeight` derives the frame height from `clientWidth`, and jsdom
 * reports 0 for every element unless told otherwise — so without stubbing it,
 * the aspect path declines for a reason that has nothing to do with the bug
 * under test and every sizing assertion below would pass vacuously.
 */
function mountWidget(openai: object, columnWidth = 720): Mounted {
  const virtualConsole = new VirtualConsole();
  for (const ch of ["log", "warn", "error", "jsdomError"]) {
    virtualConsole.on(ch, () => {});
  }

  const dom = new JSDOM(
    "<!doctype html><html><body></body></html>",
    {
      url: "https://web-sandbox.oaiusercontent.com/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  mounted.push(dom);

  const outerWin = dom.window as unknown as Window & typeof globalThis;
  const widgetFrame = outerWin.document.createElement("iframe");
  outerWin.document.body.appendChild(widgetFrame);
  const widgetWin = widgetFrame.contentWindow!;

  const heights: number[] = [];
  (widgetWin as unknown as { openai: object }).openai = {
    ...openai,
    notifyIntrinsicHeight: (h: number) => heights.push(h),
  };

  // Give every element a non-zero layout width, so `aspectHeight`'s
  // `clientWidth` read reflects the host column instead of jsdom's flat 0.
  Object.defineProperty(
    (widgetWin as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement
      .prototype,
    "clientWidth",
    { configurable: true, get: () => columnWidth },
  );

  const widgetDoc = widgetFrame.contentDocument!;
  widgetDoc.open();
  widgetDoc.write(buildChartAppUiResourceFromOutputPubId(ENV).html);
  widgetDoc.close();

  return { widgetWin: widgetFrame.contentWindow!, heights };
}

/**
 * Deliver an MCP-Apps message as if `source` had postMessage'd it. The widget
 * checks `event.source` against its own parent, so the source has to be the
 * real parent window rather than a synthetic object.
 */
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

function frame(m: Mounted): HTMLIFrameElement {
  return m.widgetWin.document.getElementById("tako-embed") as HTMLIFrameElement;
}

/** Height the widget actually pinned on the frame, in px. */
function committedHeight(m: Mounted): number {
  return Number.parseInt(frame(m).style.height, 10);
}

afterEach(() => {
  for (const dom of mounted.splice(0)) dom.window.close();
});

describe("ChatGPT chart chain — link by link", () => {
  it("LINK 1+2 (delivery, commit): a full payload pins the embed iframe", () => {
    const m = mountWidget({ toolOutput: STRUCTURED_CONTENT });
    expect(frame(m).getAttribute("src")).toBe(
      `${EMBED_URL}&disable_tracking=true`,
    );
    expect(frame(m).classList.contains("hidden")).toBe(false);
  });

  it("LINK 3 (sizing): the frame is sized from `_meta` dimensions, not the declared height", () => {
    // The regression this pins: all three ChatGPT call sites — the synchronous
    // probe, the 250 ms poll, and the `openai:set_globals` handler — used to
    // invoke `render()` with ONE argument, so `render(structuredContent,
    // meta)`'s second parameter was `undefined` on every ChatGPT delivery.
    // `image_natural_*` were read as 0, `aspectHeight` declined, and the frame
    // fell back to `structuredContent.height` — a REQUESTED height, not a
    // measured one, so this 2400x1989 card got a 720 px frame instead of the
    // 597 px its own aspect ratio calls for, and rendered inside a band of
    // empty space. Meanwhile the server was already paying a ranged PNG read
    // per ChatGPT call to ship those exact dimensions.
    const m = mountWidget({
      toolOutput: STRUCTURED_CONTENT,
      toolResponseMetadata: META,
    });
    expect(committedHeight(m)).toBe(Math.round(720 * CARD_ASPECT)); // 597
    expect(committedHeight(m)).not.toBe(STRUCTURED_CONTENT.height); // not 720
  });

  it("LINK 3 (sizing): the ChatGPT envelope shapes all resolve to the same height", () => {
    // `toolResponseMetadata` is documented as "preserving the full MCP result
    // envelope, including hidden `_meta`", but the envelope's internal shape is
    // ChatGPT's own and has drifted before. Each spelling below must land on
    // the same size, so an SDK release that moves `_meta` one level deeper
    // degrades to the old fallback rather than silently mis-sizing.
    const expected = Math.round(720 * CARD_ASPECT);
    const envelopes = [
      META,
      { _meta: META },
      { mcp_tool_result: { _meta: META } },
      { call_tool_result: { _meta: META } },
    ];
    for (const toolResponseMetadata of envelopes) {
      const m = mountWidget({
        toolOutput: STRUCTURED_CONTENT,
        toolResponseMetadata,
      });
      expect(committedHeight(m)).toBe(expected);
    }
  });

  it("LINK 3 (sizing): no `_meta` at all still renders, at the declared height", () => {
    // The degrade path. A host that ships no envelope must still get a chart —
    // `pickMetaFromOpenAi` returns undefined and every `_meta` read in
    // `render()` is guarded, so this lands on exactly the old behaviour rather
    // than throwing on a missing field.
    const m = mountWidget({ toolOutput: STRUCTURED_CONTENT });
    expect(frame(m).classList.contains("hidden")).toBe(false);
    expect(committedHeight(m)).toBe(STRUCTURED_CONTENT.height);
  });

  it("LINK 3 (sizing): the MCP-Apps path DOES size from the same `_meta`", () => {
    // Control. Same bundle, same `_meta`, delivered over the spec route that
    // passes BOTH arguments — so the sizing code is correct and only its input
    // is missing above. Without this the previous test could equally be read
    // as "aspect sizing is broken", which would point at the wrong fix.
    //
    // `window.openai` STAYS present, so this takes the same committed-iframe
    // branch as the test above and the delivery route is the only variable.
    // Deliver over the spec's postMessage notification, whose handler is the
    // one call site that forwards `params._meta` into `render()`.
    const m = mountWidget({});
    deliver(
      m,
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: STRUCTURED_CONTENT, _meta: META },
      },
      m.widgetWin.parent,
    );
    expect(committedHeight(m)).toBe(Math.round(720 * CARD_ASPECT));
  });

  it("LINK 3 (sizing): the embed's own height outranks the aspect estimate", () => {
    // The regression the browser harness caught and jsdom did not: aspect
    // sizing extrapolates from the chart PNG's fixed 2400 px-wide render, but
    // the live embed REFLOWS at the widget's real column width. On a responsive
    // card the two genuinely disagree — measured at a 634 px column, aspect says
    // 525 px and the page reports 732 px, and 525 px cuts the card off mid-row.
    //
    // So once `tako-embed-height` arrives it must win, and keep winning across
    // resizes. Before the `embedReportedHeight` latch the resize listener
    // re-derived the aspect height over the report every time.
    const m = mountWidget({
      toolOutput: STRUCTURED_CONTENT,
      toolResponseMetadata: META,
    });
    expect(committedHeight(m)).toBe(Math.round(720 * CARD_ASPECT)); // estimate

    // The embed page reports its true content height. Origin must match the
    // embed url — the handler ignores messages from anywhere else.
    const WidgetMessageEvent = (
      m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
    ).MessageEvent;
    m.widgetWin.dispatchEvent(
      new WidgetMessageEvent("message", {
        data: { type: "tako-embed-height", height: 732 },
        origin: "https://tako.com",
      }),
    );
    expect(committedHeight(m)).toBe(732);

    // ...and a column resize must not undo it.
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    m.widgetWin.dispatchEvent(new WidgetEvent("resize"));
    expect(committedHeight(m)).toBe(732);
  });

  it("LINK 4 (fallback): a chart-less payload has nothing to fall back TO", () => {
    // ChatGPT's stripped-reload payload. `image_data_url` is withheld from
    // ChatGPT, and `image_url` is absent from the payload itself, so the PNG
    // fallback that saves the iframe-blocked case cannot help here — the
    // widget's only recourse is to collapse. This is the failure mode with no
    // mitigation on this host, and the reason a beacon is worth adding.
    const m = mountWidget({ toolOutput: { width: 900, height: 720 } });
    expect(frame(m).classList.contains("hidden")).toBe(true);
    expect(m.heights.at(-1)).toBe(0);
  });
});
