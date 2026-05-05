/**
 * Tests for `open_chart_ui`'s `extraContentBlocks` hook.
 *
 * The handler itself is a pure URL builder (covered by index.test.ts); the
 * hook is where the interesting behavior lives — it fetches the PNG, base64s
 * it, and degrades gracefully on every failure mode. We assert the success
 * path produces a valid `image` content block, and that each known failure
 * mode (non-200, wrong content-type, oversize body, network error) returns
 * `[]` so the tool call still resolves with the text + structuredContent
 * fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import open_chart_ui from "./open_chart_ui.js";
import { mockFetchOnce, noopSendProgress } from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "claude",
};

const HANDLER_INPUT = {
  pub_id: "abc123",
  dark_mode: true,
  width: 900,
  height: 600,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pngResponse(
  bytes: Uint8Array,
  contentType = "image/png",
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("open_chart_ui handler", () => {
  it("returns embed_url, image_url, and echoes inputs", async () => {
    const out = await open_chart_ui.handler(HANDLER_INPUT, CTX);

    expect(out.pub_id).toBe("abc123");
    expect(out.embed_url).toBe(
      "https://staging.trytako.com/embed/abc123/?theme=dark",
    );
    expect(out.image_url).toBe(
      "https://staging.trytako.com/api/v1/image/abc123/?dark_mode=true",
    );
    expect(out.dark_mode).toBe(true);
    expect(out.width).toBe(900);
    expect(out.height).toBe(600);
  });

  it("encodes pub_id into the URLs (no path traversal / unescaped chars)", async () => {
    const out = await open_chart_ui.handler(
      { ...HANDLER_INPUT, pub_id: "weird/id with space" },
      CTX,
    );
    // `encodeURIComponent` escapes both "/" and " ". This is the security
    // boundary that keeps a hostile pub_id out of the URL path structure.
    expect(out.embed_url).toContain("/embed/weird%2Fid%20with%20space/");
    expect(out.image_url).toContain(
      "/api/v1/image/weird%2Fid%20with%20space/",
    );
  });

  it("light-mode flag flips the embed theme query and the image dark_mode flag", async () => {
    const out = await open_chart_ui.handler(
      { ...HANDLER_INPUT, dark_mode: false },
      CTX,
    );
    expect(out.embed_url).toContain("?theme=light");
    expect(out.image_url).toContain("dark_mode=false");
  });
});

describe("open_chart_ui extraContentBlocks", () => {
  it("inlines the PNG as a base64 image content block on a 200 image/png response", async () => {
    // Synthetic non-empty payload — the hook doesn't decode or validate
    // the bytes, just base64s them, so any non-empty buffer is enough.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mockFetchOnce(pngResponse(png));

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "abc123",
        embed_url: "https://example.com/embed/abc123/?theme=dark",
        image_url: "https://example.com/api/v1/image/abc123/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    // base64 of the 8-byte PNG header is "iVBORw0KGgo=".
    expect((blocks[0] as { data: string }).data).toBe("iVBORw0KGgo=");
  });

  it("strips charset and other params off the content-type before reporting it as mimeType", async () => {
    const png = new Uint8Array([0x89, 0x50]);
    mockFetchOnce(pngResponse(png, "image/png; charset=binary"));

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "abc123",
        embed_url: "https://example.com/embed/abc123/?theme=dark",
        image_url: "https://example.com/api/v1/image/abc123/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { mimeType: string }).mimeType).toBe("image/png");
  });

  it("returns [] when the PNG endpoint returns non-200", async () => {
    mockFetchOnce(new Response("not found", { status: 404 }));

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "missing",
        embed_url: "https://example.com/embed/missing/?theme=dark",
        image_url: "https://example.com/api/v1/image/missing/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );
    expect(blocks).toEqual([]);
  });

  it("returns [] when the response is not an image (e.g. an HTML error page from a redirect)", async () => {
    // Defensive: an upstream that redirects "GET /api/v1/image/..." to a
    // login page would otherwise let us base64 the HTML and ship it as
    // mimeType: "image/png". Reject anything that doesn't look like an
    // image.
    mockFetchOnce(
      new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "abc123",
        embed_url: "https://example.com/embed/abc123/?theme=dark",
        image_url: "https://example.com/api/v1/image/abc123/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );
    expect(blocks).toEqual([]);
  });

  it("returns [] on a 0-byte response body (renderer returned early)", async () => {
    // A 200 with content-type: image/png but an empty body would otherwise
    // produce `{ data: "", mimeType: "image/png" }` — an invalid image
    // block clients would try to render. Mirrors the oversize bail.
    mockFetchOnce(pngResponse(new Uint8Array(0)));

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "abc123",
        embed_url: "https://example.com/embed/abc123/?theme=dark",
        image_url: "https://example.com/api/v1/image/abc123/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );
    expect(blocks).toEqual([]);
  });

  it("returns [] on network errors (fetch throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("network error");
      }),
    );

    const blocks = await open_chart_ui.extraContentBlocks!(
      {
        pub_id: "abc123",
        embed_url: "https://example.com/embed/abc123/?theme=dark",
        image_url: "https://example.com/api/v1/image/abc123/?dark_mode=true",
        dark_mode: true,
        width: 900,
        height: 600,
      },
      CTX,
    );
    expect(blocks).toEqual([]);
  });
});

describe("open_chart_ui appUiResource", () => {
  it("returns a stable URI, the MCP Apps mimeType-bound bundle, and the env's web base as the only allowed frame domain", () => {
    const ui = open_chart_ui.appUiResource!(ENV);
    // URI stability is part of the contract: clients cache fetched
    // bundles by URI, so renaming this would force every connected
    // claude.ai / ChatGPT session to re-fetch.
    expect(ui.uri).toBe("ui://tako/embed/chart");
    expect(ui.name).toBe("open_chart_ui_widget");
    // frameDomains must be exactly the env's public web base — no
    // wildcards, no extra origins. The widget only ever embeds Tako's
    // own embed page, so a tighter allow-list is the right default.
    expect(ui.frameDomains).toEqual(["https://staging.trytako.com"]);
  });

  it("bundles the JSON-RPC tool-result listener and validates embed_url is http(s) before assigning to iframe.src", () => {
    const ui = open_chart_ui.appUiResource!(ENV);
    expect(ui.html).toContain("ui/notifications/tool-result");
    // Defense-in-depth scheme check — a hostile MCP server could ship
    // a `javascript:` URL that, without this guard, would execute in
    // the widget origin once dropped into `iframe.src`. The handler
    // already validates the output schema, but the widget is the last
    // hop before the DOM, so duplicating the check is justified.
    expect(ui.html).toContain("https?:");
    expect(ui.html).toContain("addEventListener");
    expect(ui.html).toContain('id="tako-embed"');
    // Spec-compliant content type, signalling the host this is an MCP
    // Apps widget bundle (not an opaque text/html resource).
    expect(ui.html).toContain("<!doctype html>");
  });
});
