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
    // Flip a character in the body. Token format is `v1.<body>` — we
    // mutate the last char of body, which is part of the GCM tag and
    // therefore guaranteed to fail authentication.
    const bad =
      token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
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

  it("returns 401 for an invalid token", async () => {
    const res = await handleExportRequest(
      new Request("https://mcp.staging.tako.com/exports/v1.bogus"),
      ENV_A,
    );
    expect(res.status).toBe(401);
    // Single generic message — no fingerprinting which check failed.
    expect(await res.text()).toBe("invalid or expired token");
  });

  it("returns 401 for an expired token", async () => {
    const { token } = await mintExportToken(
      "sk",
      "rep",
      "pdf",
      ENV_A,
      // 1-second TTL — by the time we call the route below, it'll be
      // expired. Wait one second to be safe.
      1,
    );
    await new Promise((r) => setTimeout(r, 1100));
    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      ENV_A,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when the token segment is empty", async () => {
    const res = await handleExportRequest(
      new Request("https://mcp.staging.tako.com/exports/"),
      ENV_A,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing token");
  });

  it("forwards upstream non-2xx status with body for triage", async () => {
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
    const body = await res.text();
    expect(body).toMatch(/upstream returned 404/);
    expect(body).toMatch(/Not found\./);
  });

  it("returns 500 when DJANGO_BASE_URL has a trailing slash", async () => {
    const { token } = await mintExportToken("sk", "rep", "pdf", ENV_A);
    const badEnv: Env = { ...ENV_A, DJANGO_BASE_URL: "https://x.com/" };
    const res = await handleExportRequest(
      new Request(`https://mcp.staging.tako.com/exports/${token}`),
      badEnv,
    );
    expect(res.status).toBe(500);
  });
});
