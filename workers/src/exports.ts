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
 *
 * Base64url primitives are imported from `oauth/jwt.ts` so the two
 * modules can't drift on encoding rules. The AES key derivation here
 * intentionally is NOT shared with `oauth/jwt.ts`'s `encryptAesGcm` /
 * `decryptAesGcm`: those return `null` on failure (OAuth's "treat as
 * missing claim" semantics), whereas this module needs to throw so
 * the route handler can log a distinguishable reason for tampered vs.
 * expired tokens.
 */
import type { Env } from "./env.js";
import { b64url, b64urlDecode } from "./oauth/jwt.js";

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

const KEY_HINT_SUFFIX =
  "Ask the operator to run `wrangler secret put EXPORT_TOKEN_KEY` " +
  "with a 32-byte AES-256 key (e.g. `openssl rand -base64 32`).";

/**
 * Pre-flight: throw a single operator-friendly error if
 * `EXPORT_TOKEN_KEY` is unset, undecodable, or the wrong byte length.
 * Called from the tool handler so the operator gets the same
 * actionable hint regardless of which configuration mode failed.
 *
 * Internal callers (mint/verify) hit `loadKey` directly and see a
 * generic message — that's fine because the handler pre-validates,
 * and a generic error from a deeper layer indicates a bug we want
 * surfaced loudly rather than papered over.
 */
export function assertExportTokenKeyConfigured(env: Env): void {
  const raw = env.EXPORT_TOKEN_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(
      `export_report is not configured on this deployment (missing EXPORT_TOKEN_KEY). ${KEY_HINT_SUFFIX}`,
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64urlDecode(raw);
  } catch {
    throw new Error(
      `export_report is misconfigured (EXPORT_TOKEN_KEY is not valid base64). ${KEY_HINT_SUFFIX}`,
    );
  }
  if (keyBytes.byteLength !== KEY_BYTES) {
    throw new Error(
      `export_report is misconfigured (EXPORT_TOKEN_KEY decodes to ${keyBytes.byteLength} bytes, expected ${KEY_BYTES}). ${KEY_HINT_SUFFIX}`,
    );
  }
}

async function loadKey(env: Env): Promise<CryptoKey> {
  const raw = env.EXPORT_TOKEN_KEY;
  if (raw === undefined || raw === "") {
    throw new Error("EXPORT_TOKEN_KEY is not configured");
  }
  const keyBytes = b64urlDecode(raw);
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
    token: `${TOKEN_VERSION}.${b64url(blob)}`,
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
  let blob: Uint8Array;
  try {
    blob = b64urlDecode(body);
  } catch {
    throw new Error("Invalid token encoding");
  }
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
  // Strict `<` so a token verified at exactly `exp` is still valid —
  // honors the full advertised TTL. The minted `expiresAt` is the
  // latest second the token works, not one before.
  if (payload.exp < nowSeconds) {
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
 *
 * Errors return a small HTML page, not raw text: the user clicking
 * the link sees a browser tab, not a chat window, so a friendly page
 * with a "go back to your chat" hint is more useful than the upstream
 * error string. Upstream details still go to `console.warn` for
 * operator-side triage.
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
    // Plaintext on this branch only — an empty token means the URL
    // was hand-edited or truncated, not pasted from a tool result.
    // No real user should reach this page.
    return textResponse(400, "missing token");
  }

  let payload: ExportTokenPayload;
  try {
    payload = await verifyExportToken(token, env);
  } catch (err) {
    // User-facing message stays generic — distinguishing expired /
    // tampered / malformed / misconfigured would help an attacker
    // fingerprint the validator. The operator log carries the real
    // reason so a rotated/removed EXPORT_TOKEN_KEY (loadKey throws a
    // config error) doesn't go silent in production.
    console.warn(
      "[exports] verifyExportToken failed:",
      err instanceof Error ? err.message : err,
    );
    return htmlErrorResponse(
      401,
      "Download link expired",
      "This download link is no longer valid — it may have expired or already been used.",
    );
  }

  const base = env.DJANGO_BASE_URL;
  if (base === undefined || base === "" || base.endsWith("/")) {
    console.error(
      "[exports] DJANGO_BASE_URL is missing or has a trailing slash",
    );
    return htmlErrorResponse(
      500,
      "Service unavailable",
      "The download service isn't configured correctly. Please contact Tako support if this keeps happening.",
    );
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
    console.error(
      `[exports] upstream fetch threw for rid=${payload.rid} fmt=${payload.fmt}: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return htmlErrorResponse(
      502,
      "Couldn't reach the export service",
      "We couldn't reach the Tako export service. Please go back to your chat and try again in a moment.",
    );
  }

  if (!upstream.ok) {
    // Upstream body goes to logs, not to the user. The end-user is
    // looking at a browser tab with no chat context, so a friendly
    // "go back to your chat" page is more useful than a raw 4xx/5xx
    // string.
    const text = await safeReadText(upstream);
    console.warn(
      `[exports] upstream returned ${upstream.status} for rid=${payload.rid} fmt=${payload.fmt}: ${text || "(empty)"}`,
    );
    if (upstream.status === 404) {
      // Most common user-facing case: the user clicked before the
      // report finished generating. Tell them what to do next.
      return htmlErrorResponse(
        404,
        "Report not ready yet",
        "This report isn't done generating. Go back to your chat and ask the assistant to try the export again in a moment.",
      );
    }
    return htmlErrorResponse(
      upstream.status,
      "Couldn't generate the export",
      "Something went wrong while preparing this download. Go back to your chat and try again.",
    );
  }

  // Mirror the upstream content-type when present so the browser
  // picks the right preview/download path. Filename uses the format
  // extension; the report id is included for "which report did I
  // download" disambiguation when the user has many. Sanitization is
  // defensive: report IDs are UUID-shaped today (already in the safe
  // set), but a future schema change shouldn't be allowed to inject
  // quotes/CRLF/newlines into the Content-Disposition header.
  const safeRid = sanitizeFilenameComponent(payload.rid);
  const filename = `tako-report-${safeRid}.${FORMAT_EXTENSION[payload.fmt]}`;
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength !== null) headers.set("content-length", contentLength);
  // RFC 5987 / 6266 quoting. After sanitizeFilenameComponent the
  // filename only contains characters in `[A-Za-z0-9_-]` plus the
  // fixed `tako-report-` prefix and the extension dot, so plain
  // quoting is sufficient.
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

function htmlErrorResponse(
  status: number,
  title: string,
  message: string,
): Response {
  // Inline-styled, no external assets — the page must render even
  // when the user's browser can't reach our origin for a stylesheet.
  // Kept small (well under 1 KB) so the Worker doesn't burn budget
  // on a static page.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Tako</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 480px; margin: 4em auto; padding: 0 1.5em; color: #1f2937; }
  h1 { font-size: 1.4em; margin: 0 0 0.5em; }
  p { margin: 0.75em 0; }
  .muted { color: #6b7280; font-size: 0.9em; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">You can close this tab and go back to your chat with the assistant.</p>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Restrict a string to characters that are safe inside a
 * `Content-Disposition: attachment; filename="..."` header. AES-GCM
 * already authenticates the token payload, so a tampered `rid` won't
 * reach this point — but a future bug or schema change could
 * introduce a non-UUID `rid`. Stripping anything outside
 * `[A-Za-z0-9_-]` is the cheapest insurance against quote/CRLF
 * injection without needing to add an RFC-5987 `filename*` encoder.
 */
function sanitizeFilenameComponent(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "_" : cleaned;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length <= 500 ? text : `${text.slice(0, 500)}...[truncated]`;
  } catch {
    return "";
  }
}
