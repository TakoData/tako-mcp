/**
 * Tests for `exports.ts` — token mint/verify and the
 * `/exports/:token` route handler.
 *
 * Covers:
 *   - Token round-trip (mint → verify → original payload)
 *   - Tampering: any byte flipped in IV or ciphertext fails AEAD
 *   - Expiry: `verifyExportToken` rejects past `exp`
 *   - Wrong key: tokens minted with one key cannot be verified with
 *     another (defense-in-depth in case ENVs ever cross-leak in CI)
 *   - Route handler: validates token, calls Django with the wrapped
 *     API key, streams the response back with `Content-Disposition:
 *     attachment` and the right filename per format
 *   - Route handler: 401 on bad/expired token, status pass-through on
 *     upstream non-2xx
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env.js";
import {
  handleExportRequest,
  mintExportToken,
  verifyExportToken,
} from "./exports.js";

const KEY_A_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const KEY_B_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

const ENV_A: Env = {
  DJANGO_BASE_URL: "https://staging.trytako.com",
  MCP_PUBLIC_BASE_URL: "https://mcp.staging.tako.com",
  EXPORT_TOKEN_KEY: KEY_A_B64,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token mint/verify", () => {
  it("round-trips the payload", async () => {
    const { token, expiresAt } = await mintExportToken(
      "sk-user",
      "rep_abc",
      "pdf",
      ENV_A,
    );
    const payload = await verifyExportToken(token, ENV_A);
    expect(payload.rid).toBe("rep_abc");
    expect(payload.fmt).toBe("pdf");
    expect(payload.key).toBe("sk-user");
    expect(payload.exp).toBe(expiresAt);
  });

  it("rejects a token signed with a different key", async () => {
    // Tokens are AEAD — verifying with the wrong key fails GCM tag
    // check before any payload is exposed. This is the property
    // that lets us share a single token across staging/prod without
    // worrying about cross-env replay.
    const ENV_B: Env = { ...ENV_A, EXPORT_TOKEN_KEY: KEY_B_B64 };
    const { token } = await mintExportToken("sk-user", "rep", "pdf", ENV_A);
    await expect(verifyExportToken(token, ENV_B)).rejects.toThrow(
      /authentication failed/,
    );
  });

  it("rejects a tampered token byte-for-byte", async () => {
    const { token } = await mintExportToken("sk-user", "rep", "pdf", ENV_A);
    // Flip a character in the middle of the body. Token format is
    // `v1.<body>`. The last character of `body` can fall in base64url
    // padding bits that decode identically when flipped (3 bytes →
    // 4 chars; the trailing chars carry only some of the bits), which
    // would falsely report "no tampering detected." Mutating a char a
    // few positions in guarantees the decoded ciphertext changes,
    // which AES-GCM tag verification then rejects.
    const dot = token.indexOf(".");
    const target = dot + 5;
    const original = token[target]!;
    const flipped = original === "a" ? "b" : "a";
    const bad = token.slice(0, target) + flipped + token.slice(target + 1);
    await expect(verifyExportToken(bad, ENV_A)).rejects.toThrow();
  });

  it("rejects expired tokens", async () => {
    const { token, expiresAt } = await mintExportToken(
      "sk-user",
      "rep",
      "pdf",
      ENV_A,
      // 1-second TTL. Pass `now` to verifyExportToken below to
      // simulate clock advance without sleeping (keeps tests fast).
      1,
    );
    await expect(
      verifyExportToken(token, ENV_A, expiresAt + 1),
    ).rejects.toThrow(/expired/);
  });

  it("accepts a token verified at exactly its expiry second", async () => {
    // The minted `expiresAt` is the latest second the token is valid.
    // A strict `<` comparison in verify means `now == exp` still
    // passes; a `<=` would have shaved one second off the advertised
    // TTL. Locks the boundary so a future refactor can't silently
    // re-introduce the off-by-one.
    const { token, expiresAt } = await mintExportToken(
      "sk-user",
      "rep",
      "pdf",
      ENV_A,
    );
    const payload = await verifyExportToken(token, ENV_A, expiresAt);
    expect(payload.exp).toBe(expiresAt);
  });

  it("rejects malformed token strings", async () => {
    await expect(verifyExportToken("not-a-token", ENV_A)).rejects.toThrow();
    await expect(verifyExportToken("v2.something", ENV_A)).rejects.toThrow(
      /Invalid token format/,
    );
    await expect(verifyExportToken("v1.", ENV_A)).rejects.toThrow();
  });

  it("refuses to mint without EXPORT_TOKEN_KEY", async () => {
    const noKeyEnv: Env = { DJANGO_BASE_URL: "https://x" };
    await expect(
      mintExportToken("sk", "rep", "pdf", noKeyEnv),
    ).rejects.toThrow(/EXPORT_TOKEN_KEY/);
  });

  it("refuses to mint when the key is the wrong byte length", async () => {
    const shortKeyEnv: Env = {
      DJANGO_BASE_URL: "https://x",
      EXPORT_TOKEN_KEY: Buffer.from("short").toString("base64"),
    };
    await expect(
      mintExportToken("sk", "rep", "pdf", shortKeyEnv),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("handleExportRequest", () => {
  it("validates the token, fetches Django with X-API-Key, and streams back with Content-Disposition", async () => {
    const { token } = await mintExportToken(
      "sk-user-bearer",
      "rep_abc",
      "pdf",
      ENV_A,
    );
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(pdfBytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tako-report-rep_abc.pdf"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdfBytes);

    // Upstream call must use X-API-Key from the embedded user
    // bearer, hit the right path, and not strip query/path encoding.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const upstreamUrl = call[0] as string;
    expect(upstreamUrl).toBe(
      "https://staging.trytako.com/api/v1/internal/reports/rep_abc/export/pdf/",
    );
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(
      "sk-user-bearer",
    );
  });

  it("uses pptx as the slug + extension for powerpoint", async () => {
    const { token } = await mintExportToken(
      "sk",
      "rep_pp",
      "powerpoint",
      ENV_A,
    );
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://staging.trytako.com/api/v1/internal/reports/rep_pp/export/pptx/",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tako-report-rep_pp.pptx"',
    );
  });

  it("returns a friendly HTML page (401) for an invalid token", async () => {
    const res = await handleExportRequest(
      new Request("https://mcp.staging.tako.com/exports/v1.bogus"),
      ENV_A,
    );
    expect(res.status).toBe(401);
    // The user clicking the link sees a browser tab, not chat — give
    // them a styled HTML page rather than a raw error string.
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Download link expired/);
    // Single generic message — distinguishing expired/tampered/
    // malformed would help an attacker fingerprint the validator.
    expect(body).not.toMatch(/tampered|malformed/i);
  });

  it("returns 401 for an expired token", async () => {
    // Expiry is compared at whole-second granularity with a strict
    // `<`, so a 1s-TTL token only reads as expired once the clock is
    // two whole seconds past the mint second. Drive that with fake
    // timers instead of a real sleep — a real sleep of ~1.1s lands on
    // the wrong side of the second boundary most of the time (the
    // token still validates, the handler then hits real Django and
    // returns 404 instead of 401), which made this test flaky in CI.
    vi.useFakeTimers();
    try {
      const { token } = await mintExportToken("sk", "rep", "pdf", ENV_A, 1);
      vi.setSystemTime(Date.now() + 2000);
      const res = await handleExportRequest(
        new Request(`https://mcp.staging.tako.com/exports/${token}`),
        ENV_A,
      );
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 when the token segment is empty", async () => {
    const res = await handleExportRequest(
      new Request("https://mcp.staging.tako.com/exports/"),
      ENV_A,
    );
    expect(res.status).toBe(400);
    // Stays as plaintext — empty token means hand-edited URL, not a
    // real user clicking a tool result.
    expect(await res.text()).toBe("missing token");
  });

  it("returns a friendly HTML page (404) when upstream reports the report isn't ready", async () => {
    const { token } = await mintExportToken("sk", "rep", "pdf", ENV_A);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response("Not found.", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Report not ready/);
    // Upstream raw error must not leak into the user-facing page —
    // the user's browser tab has no chat context, so a raw "Not
    // found." string is unhelpful. The body still goes to logs.
    expect(body).not.toMatch(/Not found\./);
  });

  it("returns a friendly HTML page for upstream 5xx", async () => {
    const { token } = await mintExportToken("sk", "rep", "pdf", ENV_A);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response("internal error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    // Substring-match on the apostrophe-free portion — the page
    // HTML-escapes `'` to `&#39;`, so a regex against the raw
    // word would miss.
    expect(body).toMatch(/generate the export/);
    expect(body).not.toMatch(/internal error/);
  });

  it("returns 500 when DJANGO_BASE_URL has a trailing slash", async () => {
    const { token } = await mintExportToken("sk", "rep", "pdf", ENV_A);
    const badEnv: Env = { ...ENV_A, DJANGO_BASE_URL: "https://x.com/" };
    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      badEnv,
    );
    expect(res.status).toBe(500);
    // Misconfig page is HTML too — the user shouldn't see this in
    // practice, but if they do they get a "contact support" hint
    // rather than a bare error string.
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("sanitizes the report id in the Content-Disposition filename", async () => {
    // Report IDs are UUID-shaped today, so the sanitizer is dead
    // weight on the happy path. The defense matters on the bad-day
    // path: if a future schema change ever produces a report ID with
    // a `"`, `\`, or newline, the sanitizer prevents
    // header-injection / response-splitting via Content-Disposition.
    // mintExportToken doesn't validate `rid` shape — it accepts any
    // string — so we can mint with shell-unsafe characters and
    // assert the sanitizer cleans the resulting header.
    const { token } = await mintExportToken(
      "sk",
      'rep"abc\nuser=admin',
      "pdf",
      ENV_A,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      ),
    );

    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );

    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition");
    // Each non-`[A-Za-z0-9_-]` char becomes `_`. Quote/newline/equals
    // are gone — header stays well-quoted, single-line.
    expect(cd).toBe(
      'attachment; filename="tako-report-rep_abc_user_admin.pdf"',
    );
    // Pull out the filename component and verify nothing dangerous
    // survived the sanitizer. The surrounding `filename="..."` quotes
    // are expected; what matters is the inside.
    const filenameMatch = cd?.match(/^attachment; filename="([^"]*)"$/);
    expect(filenameMatch).not.toBeNull();
    expect(filenameMatch![1]).not.toMatch(/["\\\n\r]/);
  });
});
