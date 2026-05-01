/**
 * Short-lived signed download URLs for `export_report`.
 *
 * `export_report` previously returned the file content inline (text or
 * base64) in the tool result. ChatGPT's tool-safety wrapper blocks
 * those payloads (binary AND large text), so the user can't actually
 * download anything. This module flips the contract: the tool returns
 * a download URL, and clicking the URL hits a Worker route that
 * streams the file back with `Content-Disposition: attachment`.
 *
 * Why a Worker-side proxy instead of returning a Django URL directly:
 * the Django export endpoint requires Tako auth (`X-API-Key`). A bare
 * link in chat would 401 unless the user happens to be on a logged-in
 * tako.com tab. The Worker re-uses the user's MCP bearer (which IS
 * the Tako API key) to do the upstream call.
 *
 * Where does the bearer come from at click time? The bearer is
 * embedded inside the download token itself, encrypted with a Worker
 * secret. The token is signed-and-encrypted (AES-256-GCM provides
 * AEAD), short-lived (5 min default), and scoped to one specific
 * `(report_id, format)` pair. Risk: a leaked URL within the TTL lets
 * the holder download that one report in that one format. Tradeoff
 * accepted — mitigated by the tight TTL and the per-call scope.
 *
 * Token format (custom, not RFC-7519/JWT):
 *
 *   v1.<base64url(IV (12 bytes) || ciphertext (variable) || GCM-tag (16 bytes))>
 *
 * Plaintext is `JSON.stringify({ rid, fmt, key, exp })`. AES-GCM
 * provides confidentiality + integrity in one primitive — no separate
 * HMAC needed.
 */
import type { Env } from "./env.js";

/** Wire-format version. Bump if the payload shape ever changes. */
const TOKEN_VERSION = "v1";

/** AES-GCM IV length (NIST recommended for GCM). */
const IV_BYTES = 12;

/** AES-256 key length. `EXPORT_TOKEN_KEY` must decode to this many bytes. */
const KEY_BYTES = 32;

/**
 * Default TTL for a download token. Five minutes is the tradeoff
 * between "user has time to click the link" and "minimize the leaked-
 * URL exposure window." Tunable per-call by the tool but should never
 * grow much past this without a security review — the URL effectively
 * carries the user's API key (encrypted) and lands in browser history,
 * referer headers, and any URL-capturing log aggregator the client
 * passes through.
 */
export const DEFAULT_TOKEN_TTL_SECONDS = 300;

/** Allowed export format slugs. Kept in lockstep with the tool. */
export const EXPORT_FORMATS = [
  "markdown",
  "json",
  "pdf",
  "powerpoint",
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Format → URL slug used in the Django export endpoint path. */
export const FORMAT_SLUG: Record<ExportFormat, string> = {
  markdown: "markdown",
  json: "json",
  pdf: "pdf",
  // PowerPoint maps to `.pptx`. Confirmed convention with PDF/JSON; if
  // the backend ever uses `powerpoint` instead, flip this and the
  // download endpoint will start working.
  powerpoint: "pptx",
};

/** Format → download filename extension. */
const FORMAT_EXTENSION: Record<ExportFormat, string> = {
  markdown: "md",
  json: "json",
  pdf: "pdf",
  powerpoint: "pptx",
};

/** Decoded download-token payload. */
interface ExportTokenPayload {
  /** Report id. */
  rid: string;
  /** Export format. */
  fmt: ExportFormat;
  /** User's Tako API key (used as `X-API-Key` upstream). */
  key: string;
  /** Unix epoch seconds at which the token expires. */
  exp: number;
}

async function loadKey(env: Env): Promise<CryptoKey> {
  const raw = env.EXPORT_TOKEN_KEY;
  if (raw === undefined || raw === "") {
    throw new Error("EXPORT_TOKEN_KEY is not configured");
  }
  const keyBytes = base64Decode(raw);
  if (keyBytes.byteLength !== KEY_BYTES) {
    throw new Error(
      `EXPORT_TOKEN_KEY must decode to ${KEY_BYTES} bytes (AES-256); got ${keyBytes.byteLength}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Mint a download token for `(reportId, format)` that embeds the
 * caller's API key. The token is the only authentication the
 * `/exports/:token` route requires — anyone who holds the token can
 * download the file until `exp`.
 */
export async function mintExportToken(
  userToken: string,
  reportId: string,
  format: ExportFormat,
  env: Env,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  if (userToken === "") {
    throw new Error("userToken must not be empty");
  }
  const key = await loadKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: ExportTokenPayload = {
    rid: reportId,
    fmt: format,
    key: userToken,
    exp: expiresAt,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const blob = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ciphertext), IV_BYTES);
  return {
    token: `${TOKEN_VERSION}.${base64UrlEncode(blob)}`,
    expiresAt,
  };
}

/**
 * Reverse of {@link mintExportToken}. Throws on any tampering, expiry,
 * or shape violation — the route handler maps any throw to a generic
 * 401 so an attacker can't distinguish "expired" from "decryption
 * failed" from "wrong format."
 */
export async function verifyExportToken(
  token: string,
  env: Env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ExportTokenPayload> {
  const dot = token.indexOf(".");
  if (dot < 0) throw new Error("Invalid token format");
  const version = token.slice(0, dot);
  const body = token.slice(dot + 1);
  if (version !== TOKEN_VERSION || body === "") {
    throw new Error("Invalid token format");
  }
  const blob = base64UrlDecode(body);
  // Need at least IV + 16-byte GCM tag. Anything shorter can't be a
  // legitimate encrypted payload.
  if (blob.byteLength <= IV_BYTES + 16) {
    throw new Error("Invalid token length");
  }
  const iv = blob.slice(0, IV_BYTES);
  const ciphertext = blob.slice(IV_BYTES);
  const key = await loadKey(env);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
  } catch {
    throw new Error("Token authentication failed");
  }
  let payload: ExportTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as ExportTokenPayload;
  } catch {
    throw new Error("Token payload is not JSON");
  }
  // Defensive shape validation. AES-GCM ensures the bytes weren't
  // tampered, but a bug in mintExportToken could still produce a
  // payload missing fields — fail loudly rather than passing
  // `undefined` into a fetch URL.
  if (
    typeof payload.rid !== "string" ||
    payload.rid === "" ||
    typeof payload.key !== "string" ||
    payload.key === "" ||
    typeof payload.exp !== "number" ||
    !EXPORT_FORMATS.includes(payload.fmt as ExportFormat)
  ) {
    throw new Error("Token payload is malformed");
  }
  if (payload.exp <= nowSeconds) {
    throw new Error("Token expired");
  }
  return payload;
}

/**
 * `GET /exports/:token` route. Validates the token, calls Django's
 * export endpoint with the wrapped API key, and streams the response
 * back to the user's browser with a download disposition.
 *
 * Streamed pass-through (no `arrayBuffer()`) so we don't buffer
 * potentially large reports in Worker memory. Cloudflare Workers'
 * fetch is streaming by default — assigning `upstream.body` directly
 * to the new Response keeps it that way.
 */
export async function handleExportRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  // Path is `/exports/<token>`. Use slice so a malformed path falls
  // through to the empty-token check below.
  const prefix = "/exports/";
  if (!url.pathname.startsWith(prefix)) {
    return textResponse(404, "not found");
  }
  const token = url.pathname.slice(prefix.length);
  if (token === "") {
    return textResponse(400, "missing token");
  }

  let payload: ExportTokenPayload;
  try {
    payload = await verifyExportToken(token, env);
  } catch {
    // Single generic message — distinguishing expired / tampered /
    // malformed would help an attacker fingerprint the validator.
    return textResponse(401, "invalid or expired token");
  }

  const base = env.DJANGO_BASE_URL;
  if (base === undefined || base === "" || base.endsWith("/")) {
    return textResponse(500, "server misconfigured");
  }

  const slug = FORMAT_SLUG[payload.fmt];
  const djangoUrl = `${base}/api/v1/internal/reports/${encodeURIComponent(payload.rid)}/export/${slug}/`;

  let upstream: Response;
  try {
    upstream = await fetch(djangoUrl, {
      method: "GET",
      headers: { "X-API-Key": payload.key },
      // No timeout here — the Worker invocation itself caps at 30 s
      // CPU time, and big PDF/PPTX renders are I/O bound on Django's
      // side anyway. A user click should fail visibly via Worker's
      // own subrequest cap if upstream hangs.
    });
  } catch (err) {
    return textResponse(
      502,
      `upstream fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (!upstream.ok) {
    // Forward the upstream status so the user (and Worker logs) can
    // tell "report not done" (404) from "auth bad" (401/403) from
    // "render failed" (5xx).
    const text = await safeReadText(upstream);
    return textResponse(
      upstream.status,
      `upstream returned ${upstream.status}: ${text || "(empty)"}`,
    );
  }

  // Mirror the upstream content-type when present so the browser
  // picks the right preview/download path. Filename uses the format
  // extension; the report id is included for "which report did I
  // download" disambiguation when the user has many.
  const filename = `tako-report-${payload.rid}.${FORMAT_EXTENSION[payload.fmt]}`;
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength !== null) headers.set("content-length", contentLength);
  // RFC 5987 / 6266 quoting: filename has no special chars in our
  // format (UUID + extension), so plain quoting is sufficient.
  headers.set(
    "content-disposition",
    `attachment; filename="${filename}"`,
  );
  // Forbid caching the file via this short-lived URL. The token is
  // single-use in spirit (though not enforced server-side without
  // KV); a downstream cache replaying the response would defeat the
  // TTL.
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length <= 500 ? text : `${text.slice(0, 500)}...[truncated]`;
  } catch {
    return "";
  }
}

/** Strict base64 (no URL-safe alphabet) — used for the AES key in env. */
function base64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function base64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}
