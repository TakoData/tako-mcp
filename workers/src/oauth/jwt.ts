/**
 * Crypto primitives for the OAuth implementation: HS256 JWT signing/verifying
 * and AES-GCM encryption of the per-user Tako API token that travels inside
 * each OAuth access token's claims.
 *
 * Two distinct keys are used by callers:
 * - `OAUTH_SIGN_KEY` — HMAC-SHA256 secret. Signs every JWT we emit
 *   (auth codes, refresh tokens, access tokens, DCR client_ids,
 *   short-lived state cookies).
 * - `OAUTH_ENC_KEY` — 32-byte raw AES-256 key, base64-encoded. Used only
 *   to encrypt the Tako API token claim. Kept separate so that a future
 *   leak of the signing key (which can be hot-rotated by issuing new
 *   tokens with the new key while honoring old ones for the TTL window)
 *   cannot retroactively decrypt prior access tokens.
 *
 * The two keys are never combined; callers pass each one only to the
 * function that needs it. Keep this module dependency-free — the moment
 * it imports `Env` it becomes harder to unit-test in isolation.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* --------------------------- base64url --------------------------- */

export function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = enc.encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* --------------------------- SHA-256 (b64url) --------------------------- */

export async function sha256B64Url(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return b64url(buf);
}

/* --------------------------- HS256 JWT --------------------------- */

export interface JwtClaims {
  exp?: number;
  [k: string]: unknown;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt<T extends JwtClaims>(
  payload: T,
  secret: string,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt<T extends JwtClaims = JwtClaims>(
  token: string,
  secret: string,
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (
    headerB64 === undefined ||
    payloadB64 === undefined ||
    sigB64 === undefined
  ) {
    return null;
  }
  const data = `${headerB64}.${payloadB64}`;
  let key: CryptoKey;
  try {
    key = await importHmacKey(secret);
  } catch {
    return null;
  }
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(data));
  } catch {
    return null;
  }
  if (!valid) return null;
  let payload: T;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as T;
  } catch {
    return null;
  }
  // 30 seconds of clock-skew tolerance on `exp`. Stytch sessions, the
  // Worker, and the requesting client may not share a time source; a
  // strict-equality check at the second boundary spuriously fails for
  // tokens minted within the last few hundred milliseconds of their
  // TTL. The 60s auth-code TTL is short enough that a 30s window
  // doesn't materially weaken replay protection.
  const CLOCK_SKEW_MS = 30 * 1000;
  if (
    payload.exp !== undefined &&
    payload.exp * 1000 + CLOCK_SKEW_MS < Date.now()
  ) {
    return null;
  }
  return payload;
}

/* --------------------------- AES-GCM --------------------------- */

const AES_IV_BYTES = 12;

/**
 * Decode a base64-encoded 32-byte AES-256 key into a `CryptoKey`. The key
 * source format is base64 (not base64url) to match `openssl rand -base64 32`
 * output, which is the most natural way to mint one. Length is enforced to
 * fail loud on a misconfigured secret.
 */
async function importAesKey(b64Key: string): Promise<CryptoKey> {
  const padded = b64Key.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64Key.length % 4)) % 4);
  const bin = atob(padded);
  if (bin.length !== 32) {
    throw new Error(
      `OAUTH_ENC_KEY must decode to 32 bytes (AES-256); got ${bin.length}`,
    );
  }
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a string with AES-GCM under `OAUTH_ENC_KEY`. The output bundles
 * the 12-byte IV with the ciphertext+tag (`iv || ct+tag`) into a single
 * base64url-encoded payload — single-string format keeps it embeddable as
 * a JWT claim value without nested JSON.
 *
 * The IV is freshly random per encryption (required for GCM security) and
 * therefore safe to publish alongside the ciphertext.
 */
export async function encryptAesGcm(
  plaintext: string,
  b64Key: string,
): Promise<string> {
  const key = await importAesKey(b64Key);
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(iv.length + ctBytes.length);
  out.set(iv, 0);
  out.set(ctBytes, iv.length);
  return b64url(out);
}

/**
 * Decrypt the output of `encryptAesGcm`. Returns `null` on any failure
 * (wrong key, tampered ciphertext, bad encoding) — callers should treat
 * a `null` return identically to "claim missing" to avoid leaking
 * information about which key/payload component failed.
 */
export async function decryptAesGcm(
  encoded: string,
  b64Key: string,
): Promise<string | null> {
  let buf: Uint8Array;
  try {
    buf = b64urlDecode(encoded);
  } catch {
    return null;
  }
  if (buf.length <= AES_IV_BYTES) return null;
  const iv = buf.slice(0, AES_IV_BYTES);
  const ct = buf.slice(AES_IV_BYTES);
  let key: CryptoKey;
  try {
    key = await importAesKey(b64Key);
  } catch {
    return null;
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}
