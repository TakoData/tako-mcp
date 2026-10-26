/**
 * Diagnostic: does the widget bundle render when data arrives the way
 * ChatGPT's Apps SDK ACTUALLY delivers it?
 *
 * The existing suite's "commits to the iframe immediately when
 * window.openai is present" test sets `window.openai = {}` and then
 * delivers the payload over the MCP-Apps `ui/notifications/tool-result`
 * postMessage — a route ChatGPT does not use. The three routes below are
 * the ones `pickPayload` was written for.
 *
 * Payload is the REAL prod structuredContent from
 * `tools/call tako_search` on mcp.tako.com (2026-07-31), tako.com origins
 * and all.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import { buildChartAppUiResourceFromOutputPubId } from "../../src/tools/_chart_widget.js";

// Prod env, so embed_url/frameDomains are the real tako.com origin.
const ENV: Env = { DJANGO_BASE_URL: "https://tako.com" };

const PUB_ID = "VKd7qE8K9Ba16kMFENNQ";
const EMBED_URL = `https://tako.com/embed/${PUB_ID}/?dark_mode=auto&showShare=true`;
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
  return buildChartAppUiResourceFromOutputPubId(ENV, undefined, "chatgpt").html;
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

/**
 * Fire the committed iframe's `load` event as if the embed page painted.
 * The widget defers its reveal (unhide + host height notification) to this
 * event so the card expands with pixels in it, not seconds before.
 */
function fireFrameLoad(m: Mounted): void {
  const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event }).Event;
  frame(m).dispatchEvent(new WidgetEvent("load"));
}

afterEach(() => {
  for (const dom of mounted.splice(0)) dom.window.close();
});

describe("ChatGPT Apps SDK delivery paths", () => {
  it("PATH 1: window.openai.toolOutput present before the script runs", () => {
    const m = mountWidget(html(), { toolOutput: PROD_STRUCTURED_CONTENT });
    expect(renderedIframe(m)).toBe(true);
    // Committed but veiled (height 0, layout box live) until the embed page
    // loads — reveal-on-load.
    expect(frame(m).classList.contains("veiled")).toBe(true);
    fireFrameLoad(m);
    expect(frame(m).classList.contains("veiled")).toBe(false);
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

  it("PIN: refuses to commit the iframe to a non-Tako origin", () => {
    // The iframe carries allow="clipboard-write" and the Permissions-Policy
    // default allowlist ('src') follows the frame wherever it navigates. So
    // the widget must not hand the frame — and with it, clipboard access —
    // to whatever https origin a corrupted tool result names. Scheme checks
    // alone pass this URL; the EXPECTED_EMBED_ORIGIN pin is what refuses it.
    const m = mountWidget(html(), {
      toolOutput: {
        ...PROD_STRUCTURED_CONTENT,
        embed_url: `https://evil.example/embed/${PUB_ID}/?dark_mode=auto`,
      },
    });
    expect(renderedIframe(m)).toBe(false);
    const src = frame(m).getAttribute("src");
    expect(src ?? "").not.toContain("evil.example");
    // The card still renders — it falls back to the PNG path.
    expect(img(m).getAttribute("src")).toBe(IMAGE_URL);
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

  it("EMPTY: asks ChatGPT to close the widget for a chart-less result", () => {
    const requestClose = vi.fn();
    const m = mountWidget(html(), {
      toolOutput: { cards: [], web_results: [], usage: {} },
      requestClose,
    });
    expect(requestClose).toHaveBeenCalledTimes(1);
    const empty = m.widgetWin.document.getElementById("tako-empty") as HTMLElement;
    expect(empty.classList.contains("hidden")).toBe(false);
  });

  it.each([
    ["throws", () => { throw new Error("closed"); }],
    ["rejects", () => Promise.reject(new Error("closed"))],
  ])("EMPTY: keeps the label and finishes booting when requestClose %s", (_label, requestClose) => {
    const m = mountWidget(html(), {
      toolOutput: { cards: [] },
      requestClose,
    });
    const empty = m.widgetWin.document.getElementById("tako-empty") as HTMLElement;
    expect(empty.classList.contains("hidden")).toBe(false);
    expect(empty.textContent).toMatch(/no chart/i);
    expect(m.toParent).toContainEqual(expect.objectContaining({ method: "ui/initialize" }));
  });

  it("EMPTY: collapses a stripped reload payload blank, without closing", () => {
    const requestClose = vi.fn();
    const m = mountWidget(html(), {
      toolOutput: { width: 900, height: 720 },
      requestClose,
    });
    const empty = m.widgetWin.document.getElementById("tako-empty") as HTMLElement;
    expect(empty.classList.contains("hidden")).toBe(true);
    expect(renderedIframe(m)).toBe(false);
    expect(requestClose).not.toHaveBeenCalled();
  });

  it("EMPTY: doesn't close a widget that renders a chart", () => {
    const requestClose = vi.fn();
    const m = mountWidget(html(), {
      toolOutput: PROD_STRUCTURED_CONTENT,
      requestClose,
    });
    expect(renderedIframe(m)).toBe(true);
    expect(requestClose).not.toHaveBeenCalled();
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

  it("ERROR: a failed call labels the box instead of leaving it blank", () => {
    // The reported bug: an expanded Tako tool call showing a tall, pure-blank
    // area. An `isError` result carries no `structuredContent`, ChatGPT mounts
    // the widget from static registration metadata anyway, holds it at its
    // default height, and ignores shrink notifications — so the no-data
    // watchdog's unlabelled collapse reads as a broken card. But a failed
    // call is not unknowable: every server-built failure carries
    // `_meta["tako/error"]`, and `toolResponseMetadata` preserves the result
    // envelope for the widget.
    //
    // The label lands at the WATCHDOG's exit, not synchronously: the sniffed
    // ChatGPT channels are not provably fresh, so an error sighting is only
    // recorded (`errorSeen`) while the poll runs its full window — a payload
    // landing on a later tick must still win (test below). The watchdog then
    // turns the sighting into the labelled collapse.
    vi.useFakeTimers();
    try {
      const heights: number[] = [];
      const m = mountWidget(html(), {
        toolOutput: null,
        toolResponseMetadata: {
          _meta: {
            "tako/error": { kind: "timeout", path: "/api/v3/search/", method: "POST" },
          },
        },
        theme: "light",
        notifyIntrinsicHeight: (h: number) => heights.push(h),
      });
      const empty = m.widgetWin.document.getElementById(
        "tako-empty",
      ) as HTMLElement;
      // Sighted but not yet acted on — the payload window is still open.
      expect(empty.classList.contains("hidden")).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(empty.classList.contains("hidden")).toBe(false);
      expect(empty.textContent).toMatch(/failed/i);
      expect(renderedIframe(m)).toBe(false);
      // Same contract as the zero-card empty state: the mount-time floor,
      // then the collapse. Labelling a box the host kept is not a request
      // for one.
      expect(heights).toEqual([1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ERROR: a failed call asks ChatGPT to close the widget", () => {
    vi.useFakeTimers();
    try {
      const requestClose = vi.fn();
      mountWidget(html(), {
        toolOutput: null,
        toolResponseMetadata: { _meta: { "tako/error": { kind: "timeout" } } },
        requestClose,
      });
      expect(requestClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(requestClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WATCHDOG: doesn't close when no data and no error arrived", () => {
    vi.useFakeTimers();
    try {
      const requestClose = vi.fn();
      mountWidget(html(), { requestClose });
      vi.advanceTimersByTime(10_000);
      expect(requestClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ERROR: a payload landing after an error sighting still renders", () => {
    // The redesign's reason to exist. An early `tako/error` read at boot
    // must not be terminal: whether ChatGPT populates `toolResponseMetadata`
    // under `isError` — and with what staleness — is not provable from the
    // jsdom harness, and payload and `_meta` are known to land on different
    // ticks. So a chart arriving mid-window wins over the sighting, and the
    // watchdog then no-ops.
    vi.useFakeTimers();
    try {
      const openai: Record<string, unknown> = {
        toolResponseMetadata: {
          _meta: { "tako/error": { kind: "timeout" } },
        },
      };
      const m = mountWidget(html(), openai);
      const empty = m.widgetWin.document.getElementById(
        "tako-empty",
      ) as HTMLElement;
      expect(empty.classList.contains("hidden")).toBe(true);
      // The payload lands two ticks later.
      openai.toolOutput = PROD_STRUCTURED_CONTENT;
      vi.advanceTimersByTime(500);
      expect(renderedIframe(m)).toBe(true);
      // And the watchdog must not label over a rendered chart.
      vi.advanceTimersByTime(10_000);
      expect(empty.classList.contains("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ERROR: the envelope's own isError flag is enough (SDK-wrapped errors)", () => {
    // Handler bugs and wire-guard throws re-throw to the MCP SDK, which wraps
    // them in a generic error result WITHOUT `_meta["tako/error"]`. The
    // envelope's `isError: true` is the one signal those still carry, on
    // whichever spelling ChatGPT's envelope uses.
    vi.useFakeTimers();
    try {
      const m = mountWidget(html(), {
        toolOutput: null,
        toolResponseMetadata: {
          mcp_tool_result: {
            isError: true,
            content: [{ type: "text", text: "Tako search endpoint returned an unexpected shape." }],
          },
        },
      });
      const empty = m.widgetWin.document.getElementById(
        "tako-empty",
      ) as HTMLElement;
      vi.advanceTimersByTime(10_000);
      expect(empty.classList.contains("hidden")).toBe(false);
      expect(empty.textContent).toMatch(/failed/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ERROR: a late-arriving error on the event path labels too", () => {
    // Same failure, delivered the way PATH 3 delivers success: the host
    // populates `toolResponseMetadata` after mount and fires the globals
    // event with no useful detail. The event only records the sighting;
    // the watchdog labels at exit.
    vi.useFakeTimers();
    try {
      const openai: Record<string, unknown> = {};
      const m = mountWidget(html(), openai);
      const empty = m.widgetWin.document.getElementById(
        "tako-empty",
      ) as HTMLElement;
      expect(empty.classList.contains("hidden")).toBe(true);
      openai.toolResponseMetadata = {
        _meta: { "tako/error": { kind: "http", status: 502 } },
      };
      fireSetGlobals(m, undefined, "openai:set_globals");
      // Sighted, not yet labelled — a payload could still arrive.
      expect(empty.classList.contains("hidden")).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(empty.classList.contains("hidden")).toBe(false);
      expect(empty.textContent).toMatch(/failed/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ERROR: a renderable payload wins over a stale error signal", () => {
    // Payload first, error check second, on every delivery path. A chart that
    // can paint must never be pre-empted into a failure label by leftover
    // metadata from another channel.
    const m = mountWidget(html(), {
      toolOutput: PROD_STRUCTURED_CONTENT,
      toolResponseMetadata: {
        _meta: { "tako/error": { kind: "timeout" } },
      },
    });
    expect(renderedIframe(m)).toBe(true);
    const empty = m.widgetWin.document.getElementById(
      "tako-empty",
    ) as HTMLElement;
    expect(empty.classList.contains("hidden")).toBe(true);
  });
});

// The reported bug: a chart that renders fine, then comes back as an empty box
// after the conversation is reloaded. ChatGPT rehydrates with a STRIPPED
// `toolOutput` — observed as `{"width":900,"height":720}`, the two
// `topCardChartFields` defaults with no `embed_url` and no `image_url` — which
// render()'s no-chart guard correctly reads as "no card" and collapses.
//
// The server is not the fault: a repeat call returns all ten declared keys
// (verified against prod), and `topCardChartFields` emits its six widget fields
// all-or-nothing, so nothing server-side emits that pair alone. The widget has
// to survive the loss, which is what `setWidgetState` is for.
describe("ChatGPT reload rehydration", () => {
  /** Exactly what ChatGPT handed the widget after a reload. */
  const STRIPPED_TOOL_OUTPUT = { width: 900, height: 720 };

  it("mirrors the rendered card into widget state", () => {
    const writes: unknown[] = [];
    const m = mountWidget(html(), {
      toolOutput: PROD_STRUCTURED_CONTENT,
      setWidgetState: (s: unknown) => writes.push(s),
    });
    expect(renderedIframe(m)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      pub_id: PUB_ID,
      embed_url: EMBED_URL,
      image_url: IMAGE_URL,
    });
  });

  it("repaints from widget state when the reloaded toolOutput is stripped", () => {
    const m = mountWidget(html(), {
      toolOutput: STRIPPED_TOOL_OUTPUT,
      widgetState: PROD_STRUCTURED_CONTENT,
    });
    // Without the fallback this collapses to the labelled empty state.
    expect(renderedIframe(m)).toBe(true);
    fireFrameLoad(m);
    expect(frame(m).classList.contains("hidden")).toBe(false);
  });

  it("a live toolOutput still wins over a stale mirror", () => {
    // Ordering matters: widget state is a mirror of the LAST render, so a
    // fresh result must never be overridden by it.
    const m = mountWidget(html(), {
      toolOutput: PROD_STRUCTURED_CONTENT,
      widgetState: {
        ...PROD_STRUCTURED_CONTENT,
        embed_url: "https://tako.com/embed/STALE/",
      },
    });
    expect(renderedIframe(m)).toBe(true);
  });

  it("a chart-less widget state does not satisfy the payload search", () => {
    // A stripped mirror must not short-circuit the poll still waiting on the
    // real payload, so it has to fail the same URL guard render() applies.
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: STRIPPED_TOOL_OUTPUT,
      widgetState: STRIPPED_TOOL_OUTPUT,
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    expect(renderedIframe(m)).toBe(false);
    expect(heights).toEqual([1, 0]);
  });

  it("does not rewrite state for the same card, across two deliveries", () => {
    // `setWidgetState` re-renders on some hosts and render() is reachable from
    // a 250 ms poll, so an unguarded write is a loop.
    //
    // The payload has to be one that render() ACCEPTS but cannot paint, and
    // that is the whole difficulty. A healthy payload latches `rendered` on the
    // first delivery, so every later delivery returns at render()'s `if
    // (rendered)` guard and `lastPersistedKey` is never consulted — an earlier
    // version of this test drove two healthy deliveries and passed with the
    // write-once guard deleted, which is no test at all.
    //
    // Non-http(s) URLs thread the gap: they are strings, so the no-chart guard
    // lets them through and `persistWidgetState` runs; but they fail the
    // `^https?://` scheme check on every render branch, so render() falls to
    // its `return false` with `rendered` still unset and the next delivery
    // re-enters. That is the real re-persist loop this guard exists to stop.
    const writes: unknown[] = [];
    const unpaintable = {
      ...PROD_STRUCTURED_CONTENT,
      embed_url: "ftp://tako.com/embed/X/",
      image_url: "ftp://tako.com/api/v1/image/X/",
    };
    const m = mountWidget(html(), {
      setWidgetState: (s: unknown) => writes.push(s),
    });
    fireSetGlobals(m, { toolOutput: unpaintable }, "openai:set_globals");
    fireSetGlobals(m, { toolOutput: unpaintable }, "openai:set_globals");
    // Never painted — which is what keeps render() re-entrant here.
    expect(renderedIframe(m)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("a whole zero-card result outranks a chart in a lesser channel", () => {
    // The other route to the harm `looksComplete` guards against, and the one
    // the mirror test above cannot see because it only populates `toolOutput`.
    //
    // Preferring any chart-bearing candidate over list order means a stale
    // chart sitting in `widget.structuredContent` beats a fresh, whole,
    // chart-less `toolOutput` — so the selection returns the stale card and
    // the veto never runs. The user gets a chart for a question that returned
    // nothing, which is exactly what the veto exists to prevent, arrived at
    // from the other direction. Completeness has to be checked first.
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: { cards: [], web_results: [], usage: {} },
      widget: { structuredContent: PROD_STRUCTURED_CONTENT },
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    expect(renderedIframe(m)).toBe(false);
    expect(heights).toEqual([1, 0]);
  });

  it("restores the mirror when the stripped payload arrives on the EVENT path", () => {
    // The rehydration fix has to cover the route the host actually takes, and
    // we cannot know which one that is. This path used to be
    // `render(pickFromGlobals(globals) || pickFromOpenAi())`: a stripped
    // `toolOutput` in the event's globals is truthy, so it satisfied the left
    // side, short-circuited the right, and collapsed with `rendered = true`
    // before the mirror was ever read — the fix silently no-opping in the case
    // it targets. The old code justified that with "set_globals fires only on
    // live calls, never on rehydration", which is an assumption about ChatGPT's
    // timing, and the 250 ms poll exists because that timing is not knowable.
    const openai: Record<string, unknown> = {};
    const m = mountWidget(html(), openai);
    // Nothing on mount, so the synchronous probe cannot be what renders.
    expect(renderedIframe(m)).toBe(false);
    openai.widgetState = PROD_STRUCTURED_CONTENT;
    fireSetGlobals(m, { toolOutput: STRIPPED_TOOL_OUTPUT }, "openai:set_globals");
    expect(renderedIframe(m)).toBe(true);
    fireFrameLoad(m);
    expect(frame(m).classList.contains("hidden")).toBe(false);
  });

  it("a live chart on the event path still beats the mirror", () => {
    // The converse of the test above, and the regression that unifying the two
    // candidate lists could plausibly introduce: globals must keep their
    // precedence when what they carry is real. Both are populated after mount
    // so the synchronous probe stays out of it and the event path is what the
    // assertion is about.
    const openai: Record<string, unknown> = {};
    const m = mountWidget(html(), openai);
    openai.widgetState = {
      ...PROD_STRUCTURED_CONTENT,
      embed_url: "https://tako.com/embed/STALE/",
    };
    fireSetGlobals(
      m,
      { toolOutput: PROD_STRUCTURED_CONTENT },
      "openai:set_globals",
    );
    expect(renderedIframe(m)).toBe(true);
  });

  it("a zero-card result is NOT overpainted by a stale mirror", () => {
    // The regression the `looksComplete` guard exists for. A search that
    // genuinely found nothing is a COMPLETE result that happens to have no
    // chart, and it must still collapse. Restoring here would show a chart
    // for a question that returned nothing, which is worse than an empty box.
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: { cards: [], web_results: [], usage: {} },
      widgetState: PROD_STRUCTURED_CONTENT,
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    expect(renderedIframe(m)).toBe(false);
    expect(heights).toEqual([1, 0]);
  });

  it("survives a host with no setWidgetState at all", () => {
    // Every host that is not ChatGPT. The persist is best-effort and must
    // never take down a render already in progress.
    const m = mountWidget(html(), { toolOutput: PROD_STRUCTURED_CONTENT });
    expect(renderedIframe(m)).toBe(true);
  });
});

const CAROUSEL_PUB_IDS = [PUB_ID, "Lm3nQ8rT2vWx9yZa1bCd", "Ef4gH5iJ6kL7mN8oP9qR"];

interface CarouselChart {
  pub_id: string;
  embed_url: string;
  image_url: string;
  image_natural_width?: number;
  image_natural_height?: number;
}

function carouselChart(pubId: string, withDims = true): CarouselChart {
  const chart: CarouselChart = {
    pub_id: pubId,
    embed_url: `https://tako.com/embed/${pubId}/?dark_mode=auto&showShare=true`,
    image_url: `https://tako.com/api/v1/image/${pubId}/?dark_mode=true`,
  };
  if (withDims) {
    chart.image_natural_width = 2400;
    chart.image_natural_height = 1100;
  }
  return chart;
}

function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`no item at index ${i}`);
  return item;
}

function threeCharts(withDims = true): CarouselChart[] {
  return CAROUSEL_PUB_IDS.map((id) => carouselChart(id, withDims));
}

function carouselFrames(m: Mounted): HTMLIFrameElement[] {
  return Array.from(
    m.widgetWin.document.querySelectorAll<HTMLIFrameElement>(
      "#tako-carousel iframe",
    ),
  );
}

describe("ChatGPT carousel", () => {
  function mountCarousel(
    charts: CarouselChart[],
    extra: Record<string, unknown> = {},
  ): Mounted {
    return mountWidget(html(), {
      toolOutput: PROD_STRUCTURED_CONTENT,
      toolResponseMetadata: { charts },
      ...extra,
    });
  }

  function carouselSlides(m: Mounted): HTMLElement[] {
    return Array.from(
      m.widgetWin.document.querySelectorAll<HTMLElement>(
        "#tako-carousel .tako-slide",
      ),
    );
  }

  function postEmbedHeight(
    m: Mounted,
    source: Window,
    height: number,
    origin = "https://tako.com",
  ): void {
    const WidgetMessageEvent = (
      m.widgetWin as unknown as { MessageEvent: typeof MessageEvent }
    ).MessageEvent;
    m.widgetWin.dispatchEvent(
      new WidgetMessageEvent("message", {
        data: { type: "tako-embed-height", height },
        origin,
        source: source as unknown as MessageEventSource,
      }),
    );
  }

  function fireFrameSrcViolation(m: Mounted): void {
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event })
      .Event;
    const event = new WidgetEvent("securitypolicyviolation");
    Object.assign(event, {
      effectiveDirective: "frame-src",
      violatedDirective: "frame-src",
    });
    m.widgetWin.document.dispatchEvent(event);
  }

  function expectPngFallback(m: Mounted, charts: CarouselChart[]): void {
    const slides = carouselSlides(m);
    expect(slides).toHaveLength(charts.length);
    slides.forEach((slide, i) => {
      const image = slide.querySelector("a > img") as HTMLImageElement;
      expect(image.getAttribute("src")).toBe(nth(charts, i).image_url);
      const link = image.parentElement as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(nth(charts, i).embed_url);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });
    expect(carouselFrames(m)).toHaveLength(0);
  }

  it("renders one iframe per chart, in order", () => {
    const m = mountCarousel(threeCharts());
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(3);
    frames.forEach((f, i) => {
      expect(f.getAttribute("src")).toContain(nth(CAROUSEL_PUB_IDS, i));
      expect(f.getAttribute("src")).toContain("disable_tracking=true");
      expect(f.getAttribute("title")).toBe(`Tako chart ${i + 1} of 3`);
      expect(f.classList.contains("veiled")).toBe(true);
    });
    expect(frame(m).getAttribute("src")).toBeNull();
    const doc = m.widgetWin.document;
    expect(doc.getElementById("tako-carousel")!.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("tako-prev")!.getAttribute("aria-label")).toBe("Previous chart");
    expect(doc.getElementById("tako-next")!.getAttribute("aria-label")).toBe("Next chart");
  });

  it("keeps the single-frame path for one chart", () => {
    const m = mountWidget(html(), { toolOutput: PROD_STRUCTURED_CONTENT });
    expect(frame(m).getAttribute("src")).toContain(PUB_ID);
    expect(carouselFrames(m)).toHaveLength(0);
  });

  it("keeps the single-frame path for a one-entry chart list", () => {
    const m = mountCarousel([carouselChart(PUB_ID)]);
    expect(frame(m).getAttribute("src")).toContain(PUB_ID);
    expect(carouselFrames(m)).toHaveLength(0);
  });

  it("drops a chart whose embed is off the pinned origin", () => {
    const charts = threeCharts();
    charts[1] = {
      ...nth(charts, 1),
      embed_url: `https://evil.example/embed/${nth(CAROUSEL_PUB_IDS, 1)}/?dark_mode=auto`,
    };
    const m = mountCarousel(charts);
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(2);
    expect(nth(frames, 0).getAttribute("src")).toContain(nth(CAROUSEL_PUB_IDS, 0));
    expect(nth(frames, 1).getAttribute("src")).toContain(nth(CAROUSEL_PUB_IDS, 2));
    expect(nth(frames, 1).getAttribute("title")).toBe("Tako chart 2 of 2");
  });

  it("grows to the tallest slide and never shrinks", () => {
    const heights: number[] = [];
    const m = mountCarousel(threeCharts(), {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    const frames = carouselFrames(m);
    postEmbedHeight(m, nth(frames, 0).contentWindow!, 500);
    postEmbedHeight(m, nth(frames, 1).contentWindow!, 650);
    postEmbedHeight(m, nth(frames, 2).contentWindow!, 400);
    expect(heights[heights.length - 1]).toBe(650);
    expect(heights).toEqual([1, 500, 650]);
    frames.forEach((f) => expect(f.classList.contains("veiled")).toBe(false));
    expect(nth(frames, 2).getAttribute("height")).toBe("400");
  });

  it("ignores an embed height report from a window that is not a slide", () => {
    const heights: number[] = [];
    const m = mountCarousel(threeCharts(), {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    postEmbedHeight(m, frame(m).contentWindow!, 500);
    expect(heights).toEqual([1]);
    carouselFrames(m).forEach((f) =>
      expect(f.classList.contains("veiled")).toBe(true),
    );
  });

  it("ignores a slide's height report from another origin", () => {
    const heights: number[] = [];
    const m = mountCarousel(threeCharts(), {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    const first = nth(carouselFrames(m), 0);
    postEmbedHeight(m, first.contentWindow!, 500, "https://evil.example");
    expect(heights).toEqual([1]);
    expect(first.classList.contains("veiled")).toBe(true);
  });

  it("paints the host backdrop behind every slide on a dark ChatGPT", () => {
    const m = mountCarousel(threeCharts(), { theme: "dark" });
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(3);
    frames.forEach((f) => {
      expect(f.style.background).toBe("rgb(18, 18, 18)");
      expect(f.style.borderRadius).not.toBe("");
    });
  });

  it("paints the host backdrop behind a slide's PNG fallback", () => {
    const m = mountCarousel(threeCharts(), { theme: "dark" });
    fireFrameSrcViolation(m);
    carouselSlides(m).forEach((slide) => {
      const image = slide.querySelector("a > img") as HTMLImageElement;
      expect(image.style.background).toBe("rgb(18, 18, 18)");
    });
  });

  function pinContentDocument(f: HTMLIFrameElement, doc: unknown): void {
    Object.defineProperty(f, "contentDocument", {
      configurable: true,
      get: () => doc as Document,
    });
  }

  function fireLoad(m: Mounted, el: Element): void {
    const WidgetEvent = (m.widgetWin as unknown as { Event: typeof Event }).Event;
    el.dispatchEvent(new WidgetEvent("load"));
  }

  it("ignores a slide's stray about:blank load and reveals on the genuine one", () => {
    const heights: number[] = [];
    const m = mountCarousel(threeCharts(), {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    const first = nth(carouselFrames(m), 0);
    Object.defineProperty(nth(carouselSlides(m), 0), "clientWidth", {
      configurable: true,
      get: () => 600,
    });
    pinContentDocument(first, { location: { href: "about:blank" } });
    fireLoad(m, first);
    expect(first.classList.contains("veiled")).toBe(true);
    expect(heights).toEqual([1]);
    pinContentDocument(first, null);
    fireLoad(m, first);
    expect(first.classList.contains("veiled")).toBe(false);
    expect(heights).toEqual([1, Math.round((600 * 1100) / 2400)]);
  });

  it("falls back to each slide's PNG when the embed times out", () => {
    vi.useFakeTimers();
    try {
      const charts = threeCharts();
      const m = mountCarousel(charts);
      vi.advanceTimersByTime(8000);
      expectPngFallback(m, charts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slide that reported its height when the others time out", () => {
    vi.useFakeTimers();
    try {
      const m = mountCarousel(threeCharts());
      const first = nth(carouselFrames(m), 0);
      postEmbedHeight(m, first.contentWindow!, 500);
      vi.advanceTimersByTime(8000);
      const frames = carouselFrames(m);
      expect(frames).toEqual([first]);
      expect(nth(carouselSlides(m), 1).querySelector("a > img")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back on a frame-src CSP violation", () => {
    const heights: number[] = [];
    const charts = threeCharts();
    const m = mountCarousel(charts, {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    fireFrameSrcViolation(m);
    expectPngFallback(m, charts);
    expect(Math.max(...heights)).toBeGreaterThan(1);
  });

  it("keeps a slide without dimensions veiled until its embed reports a height", () => {
    const heights: number[] = [];
    const charts = [
      carouselChart(nth(CAROUSEL_PUB_IDS, 0)),
      carouselChart(nth(CAROUSEL_PUB_IDS, 1), false),
      {
        ...carouselChart(nth(CAROUSEL_PUB_IDS, 2)),
        image_natural_width: 1200,
        image_natural_height: 900,
      },
    ];
    const m = mountCarousel(charts, {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    carouselSlides(m).forEach((slide) =>
      Object.defineProperty(slide, "clientWidth", {
        configurable: true,
        get: () => 600,
      }),
    );
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(3);
    frames.forEach((f) => {
      pinContentDocument(f, null);
      fireLoad(m, f);
    });
    expect(frames.map((f) => f.classList.contains("veiled"))).toEqual([false, true, false]);
    expect(Math.max(...heights)).toBe(Math.round((600 * 900) / 1200));
    postEmbedHeight(m, nth(frames, 1).contentWindow!, 400);
    expect(nth(frames, 1).classList.contains("veiled")).toBe(false);
    expect(nth(frames, 1).getAttribute("height")).toBe("400");
    expect(heights).not.toContain(720);
  });

  it("doesn't grow to the payload height when a slide without dimensions falls back", () => {
    vi.useFakeTimers();
    try {
      const heights: number[] = [];
      const charts = threeCharts(false);
      const m = mountCarousel(charts, {
        notifyIntrinsicHeight: (h: number) => heights.push(h),
      });
      vi.advanceTimersByTime(8000);
      expectPngFallback(m, charts);
      expect(heights).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a slide's later height report without shrinking the widget", () => {
    const heights: number[] = [];
    const m = mountCarousel(threeCharts(), {
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    const first = nth(carouselFrames(m), 0);
    postEmbedHeight(m, first.contentWindow!, 500);
    postEmbedHeight(m, first.contentWindow!, 300);
    expect(first.getAttribute("height")).toBe("300");
    expect(heights).toEqual([1, 500]);
  });

  it("next scrolls the row by one slide", () => {
    const m = mountCarousel(threeCharts());
    const doc = m.widgetWin.document;
    const track = doc.querySelector("#tako-carousel .tako-track") as HTMLElement;
    const scrollBy = vi.fn();
    (track as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    (doc.getElementById("tako-next") as HTMLButtonElement).click();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    const [scrollOptions] = nth(scrollBy.mock.calls, 0) as [{ left: number }];
    expect(scrollOptions.left).toBeGreaterThan(0);
  });

  it("mirrors the chart list into widget state", () => {
    const writes: Array<{ charts?: CarouselChart[] }> = [];
    mountCarousel(threeCharts(), {
      setWidgetState: (s: { charts?: CarouselChart[] }) => writes.push(s),
    });
    expect(writes).toHaveLength(1);
    const mirrored = nth(writes, 0).charts ?? [];
    expect(mirrored).toHaveLength(3);
    expect(nth(mirrored, 1)).toEqual(carouselChart(nth(CAROUSEL_PUB_IDS, 1)));
  });

  it("repaints the carousel from widget state on reload", () => {
    const m = mountWidget(html(), {
      toolOutput: { width: 900, height: 720 },
      toolResponseMetadata: {},
      widgetState: { ...PROD_STRUCTURED_CONTENT, charts: threeCharts() },
    });
    expect(carouselFrames(m)).toHaveLength(3);
  });

  function deliverChartsLate(m: Mounted, openai: Record<string, unknown>): void {
    const toolResponseMetadata = { charts: threeCharts() };
    openai.toolResponseMetadata = toolResponseMetadata;
    fireSetGlobals(m, { toolResponseMetadata }, "openai:set_globals");
  }

  it("upgrades a single frame to the carousel when _meta.charts lands late", () => {
    vi.useFakeTimers();
    try {
      const writes: Array<{ charts?: CarouselChart[] }> = [];
      const openai: Record<string, unknown> = {
        toolOutput: PROD_STRUCTURED_CONTENT,
        setWidgetState: (s: { charts?: CarouselChart[] }) => writes.push(s),
      };
      const m = mountWidget(html(), openai);
      expect(renderedIframe(m)).toBe(true);
      expect(carouselFrames(m)).toHaveLength(0);
      deliverChartsLate(m, openai);
      expect(carouselFrames(m)).toHaveLength(3);
      expect(frame(m).classList.contains("hidden")).toBe(true);
      expect(renderedIframe(m)).toBe(false);
      expect(nth(writes, writes.length - 1).charts).toHaveLength(3);
      vi.advanceTimersByTime(8000);
      expect(img(m).getAttribute("src")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("upgrades when the poll reads _meta.charts after the single frame committed", () => {
    vi.useFakeTimers();
    try {
      const openai: Record<string, unknown> = { toolOutput: PROD_STRUCTURED_CONTENT };
      const m = mountWidget(html(), openai);
      expect(renderedIframe(m)).toBe(true);
      openai.toolResponseMetadata = { charts: threeCharts() };
      vi.advanceTimersByTime(250);
      expect(carouselFrames(m)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["dimensions but no chart list", { image_natural_width: 2400, image_natural_height: 1100 }],
    ["a one-entry chart list", { charts: [carouselChart(PUB_ID)] }],
  ])("stays a single frame when the first render had meta with %s", (_label, firstMeta) => {
    const openai: Record<string, unknown> = {
      toolOutput: PROD_STRUCTURED_CONTENT,
      toolResponseMetadata: firstMeta,
    };
    const m = mountWidget(html(), openai);
    expect(renderedIframe(m)).toBe(true);
    deliverChartsLate(m, openai);
    expect(carouselFrames(m)).toHaveLength(0);
    expect(renderedIframe(m)).toBe(true);
    expect(frame(m).classList.contains("hidden")).toBe(false);
  });

  it("keeps a revealed single frame on screen until a slide reveals", () => {
    const openai: Record<string, unknown> = { toolOutput: PROD_STRUCTURED_CONTENT };
    const m = mountWidget(html(), openai);
    fireFrameLoad(m);
    expect(renderedIframe(m)).toBe(true);
    deliverChartsLate(m, openai);
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(3);
    expect(renderedIframe(m)).toBe(true);
    expect(frame(m).classList.contains("hidden")).toBe(false);
    postEmbedHeight(m, nth(frames, 0).contentWindow!, 500);
    expect(renderedIframe(m)).toBe(false);
    expect(frame(m).classList.contains("hidden")).toBe(true);
  });

  it("resizes a kept single frame from its own height report during the upgrade", () => {
    const heights: number[] = [];
    const openai: Record<string, unknown> = {
      toolOutput: PROD_STRUCTURED_CONTENT,
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    };
    const m = mountWidget(html(), openai);
    fireFrameLoad(m);
    deliverChartsLate(m, openai);
    postEmbedHeight(m, frame(m).contentWindow!, 900);
    expect(frame(m).getAttribute("height")).toBe("900");
    expect(nth(heights, heights.length - 1)).toBe(900);
    postEmbedHeight(m, nth(carouselFrames(m), 0).contentWindow!, 800);
    expect(frame(m).classList.contains("hidden")).toBe(true);
    expect(nth(heights, heights.length - 1)).toBe(900);
  });

  it("never shrinks the widget when it upgrades to the carousel", () => {
    const heights: number[] = [];
    const openai: Record<string, unknown> = {
      toolOutput: PROD_STRUCTURED_CONTENT,
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    };
    const m = mountWidget(html(), openai);
    fireFrameLoad(m);
    const singleFrameHeight = nth(heights, heights.length - 1);
    expect(singleFrameHeight).toBe(720);
    deliverChartsLate(m, openai);
    const frames = carouselFrames(m);
    postEmbedHeight(m, nth(frames, 0).contentWindow!, 500);
    expect(nth(heights, heights.length - 1)).toBeGreaterThanOrEqual(singleFrameHeight);
    postEmbedHeight(m, nth(frames, 1).contentWindow!, 800);
    expect(nth(heights, heights.length - 1)).toBe(800);
  });
});

describe("ChatGPT agent results", () => {
  const AGENT_OUTPUT = {
    status: "completed",
    run_id: "answer_run_r1",
    answer: "a",
    cards: [{ title: "One", exportable: false }],
    citations: [],
    usage: null,
  };

  function emptyLabel(m: Mounted): HTMLElement {
    return m.widgetWin.document.getElementById("tako-empty") as HTMLElement;
  }

  it("renders a one-card result in the single frame from _meta.charts", () => {
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      toolResponseMetadata: {
        image_natural_width: 2400,
        image_natural_height: 1100,
        charts: [carouselChart(PUB_ID)],
      },
    });
    expect(renderedIframe(m)).toBe(true);
  });

  it("requests search's fallback height when the chart has no PNG dimensions", () => {
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      toolResponseMetadata: { charts: [carouselChart(PUB_ID, false)] },
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    fireFrameLoad(m);
    expect(nth(heights, heights.length - 1)).toBe(720);
  });

  it("renders a multi-card result as the carousel, in order", () => {
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      toolResponseMetadata: { charts: threeCharts() },
    });
    const frames = carouselFrames(m);
    expect(frames).toHaveLength(3);
    frames.forEach((f, i) => {
      expect(f.getAttribute("src")).toContain(nth(CAROUSEL_PUB_IDS, i));
    });
  });

  it("closes a running result without the label", () => {
    const requestClose = vi.fn();
    const heights: number[] = [];
    const m = mountWidget(html(), {
      toolOutput: { status: "running", run_id: "answer_run_r1", message: "m", cards: [], citations: [], usage: null },
      requestClose,
      notifyIntrinsicHeight: (h: number) => heights.push(h),
    });
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(emptyLabel(m).classList.contains("hidden")).toBe(true);
    expect(heights).toEqual([1, 0]);
  });

  it("labels and closes a finished result with no cards", () => {
    const requestClose = vi.fn();
    const m = mountWidget(html(), {
      toolOutput: { ...AGENT_OUTPUT, cards: [] },
      toolResponseMetadata: { charts: [] },
      requestClose,
    });
    expect(emptyLabel(m).classList.contains("hidden")).toBe(false);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("labels and closes a result whose chart list is empty although it has cards", () => {
    const requestClose = vi.fn();
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      toolResponseMetadata: { charts: [] },
      requestClose,
    });
    expect(emptyLabel(m).classList.contains("hidden")).toBe(false);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("waits for late _meta instead of labelling a result with cards", () => {
    vi.useFakeTimers();
    try {
      const requestClose = vi.fn();
      const openai: Record<string, unknown> = { toolOutput: AGENT_OUTPUT, requestClose };
      const m = mountWidget(html(), openai);
      expect(emptyLabel(m).classList.contains("hidden")).toBe(true);
      expect(requestClose).not.toHaveBeenCalled();
      openai.toolResponseMetadata = { charts: [carouselChart(PUB_ID)] };
      vi.advanceTimersByTime(250);
      expect(renderedIframe(m)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses blank and asks ChatGPT to close when _meta never arrives", () => {
    vi.useFakeTimers();
    try {
      const requestClose = vi.fn();
      const m = mountWidget(html(), { toolOutput: AGENT_OUTPUT, requestClose });
      vi.advanceTimersByTime(10_001);
      expect(emptyLabel(m).classList.contains("hidden")).toBe(true);
      expect(renderedIframe(m)).toBe(false);
      expect(requestClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the cards of a failed run that has them", () => {
    const m = mountWidget(html(), {
      toolOutput: { ...AGENT_OUTPUT, status: "failed" },
      toolResponseMetadata: { charts: [carouselChart(PUB_ID)] },
    });
    expect(renderedIframe(m)).toBe(true);
  });

  it("mirrors the promoted chart into widget state", () => {
    const writes: Array<{ embed_url?: string }> = [];
    mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      toolResponseMetadata: { charts: [carouselChart(PUB_ID)] },
      setWidgetState: (s: { embed_url?: string }) => writes.push(s),
    });
    expect(writes).toHaveLength(1);
    expect(nth(writes, 0).embed_url).toBe(EMBED_URL);
  });

  it("repaints from widget state when a reload restores the result without _meta", () => {
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      widgetState: { pub_id: PUB_ID, embed_url: EMBED_URL, image_url: IMAGE_URL, charts: [carouselChart(PUB_ID)] },
    });
    expect(renderedIframe(m)).toBe(true);
  });

  it("repaints the carousel from widget state when a reload restores the result without _meta", () => {
    const m = mountWidget(html(), {
      toolOutput: AGENT_OUTPUT,
      widgetState: { pub_id: PUB_ID, embed_url: EMBED_URL, image_url: IMAGE_URL, charts: threeCharts() },
    });
    expect(carouselFrames(m)).toHaveLength(3);
  });

  it("labels a search result whose cards have no chart at once, without waiting for _meta", () => {
    const m = mountWidget(html(), { toolOutput: { cards: [{ title: "No id" }], web_results: [], usage: {} } });
    expect(emptyLabel(m).classList.contains("hidden")).toBe(false);
  });
});
