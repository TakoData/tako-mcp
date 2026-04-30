/**
 * Tests for `export_report`.
 *
 * Locks three properties:
 *   1. The tool returns a `download_url` pointing at the Worker's own
 *      `/exports/<token>` route, plus matching `expires_at` /
 *      `expires_in_seconds`.
 *   2. The minted token round-trips through `verifyExportToken` to
 *      yield the original `(report_id, format, user_token)` triple.
 *      That's the contract the route handler depends on.
 *   3. The handler refuses to mint when `EXPORT_TOKEN_KEY` is missing,
 *      with a message that points at the operator (not the user).
 *
 * The actual Django fetch + streaming response is exercised in
 * `exports.test.ts` against `handleExportRequest`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import { verifyExportToken } from "../exports.js";
import type { ToolContext } from "./types.js";
import export_report from "./export_report.js";

// 32-byte AES-256 key, base64-encoded. Fixed across tests for
// determinism — the IV is randomized per-mint, so ciphertexts still
// differ even with a fixed key.
const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

const ENV: Env = {
  DJANGO_BASE_URL: "https://staging.trytako.com",
  MCP_PUBLIC_BASE_URL: "https://mcp.staging.tako.com",
  EXPORT_TOKEN_KEY: TEST_KEY_B64,
};

const CTX: ToolContext = { token: "sk-test-bearer", env: ENV };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected rejection with Error, got: ${String(err)}`);
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("export_report", () => {
  it("returns a download_url on the configured MCP origin with a verifiable token", async () => {
    const out = await export_report.handler(
      { report_id: "rep_abc", format: "pdf" },
      CTX,
    );

    expect(out.report_id).toBe("rep_abc");
    expect(out.format).toBe("pdf");
    expect(out.expires_in_seconds).toBe(300);
    // expires_at should be ~now+300s. Allow a few seconds slack for
    // CI / slow runs without coupling the test to wall-clock timing.
    const now = Math.floor(Date.now() / 1000);
    expect(out.expires_at).toBeGreaterThanOrEqual(now + 295);
    expect(out.expires_at).toBeLessThanOrEqual(now + 305);

    expect(out.download_url).toMatch(
      /^https:\/\/mcp\.staging\.tako\.com\/exports\/v1\.[A-Za-z0-9_-]+$/,
    );

    // Token round-trips. Critical because the route handler relies
    // on this exact contract — a silent mint/verify mismatch would
    // break every download URL with no way to tell from the tool's
    // own output.
    const token = out.download_url.slice(
      "https://mcp.staging.tako.com/exports/".length,
    );
    const payload = await verifyExportToken(token, ENV);
    expect(payload).toEqual({
      rid: "rep_abc",
      fmt: "pdf",
      key: "sk-test-bearer",
      exp: out.expires_at,
    });
  });

  it("mints distinct tokens across calls (random IV per mint)", async () => {
    // Same input → different ciphertext, because the IV is fresh per
    // mint. Guards against an accidental nonce-reuse regression.
    const a = await export_report.handler(
      { report_id: "rep_x", format: "json" },
      CTX,
    );
    const b = await export_report.handler(
      { report_id: "rep_x", format: "json" },
      CTX,
    );
    expect(a.download_url).not.toBe(b.download_url);
  });

  it.each(["markdown", "json", "pdf", "powerpoint"] as const)(
    "round-trips format %s through the token",
    async (format) => {
      const out = await export_report.handler(
        { report_id: "rep_fmt", format },
        CTX,
      );
      const token = out.download_url.slice(
        "https://mcp.staging.tako.com/exports/".length,
      );
      const payload = await verifyExportToken(token, ENV);
      expect(payload.fmt).toBe(format);
    },
  );

  it("throws a clear operator-targeted error when EXPORT_TOKEN_KEY is missing", async () => {
    const badEnv: Env = {
      DJANGO_BASE_URL: "https://staging.trytako.com",
      MCP_PUBLIC_BASE_URL: "https://mcp.staging.tako.com",
      // EXPORT_TOKEN_KEY intentionally omitted
    };
    const badCtx: ToolContext = { token: "sk-test-bearer", env: badEnv };

    const err = await catchError(
      export_report.handler({ report_id: "rep", format: "pdf" }, badCtx),
    );

    // Mention of `EXPORT_TOKEN_KEY` so the operator can grep their
    // logs to the cause; mention of `wrangler secret put` so they
    // know exactly how to fix it.
    expect(err.message).toMatch(/EXPORT_TOKEN_KEY/);
    expect(err.message).toMatch(/wrangler secret put/);
  });
});
