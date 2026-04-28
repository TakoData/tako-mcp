import { describe, expect, it } from "vitest";

import {
  b64url,
  b64urlDecode,
  decryptAesGcm,
  encryptAesGcm,
  sha256B64Url,
  signJwt,
  verifyJwt,
} from "./jwt.js";

const SIGN_KEY = "test-sign-key-for-jwt-tests-do-not-ship";

// 32-byte key, base64-encoded — what `OAUTH_ENC_KEY` should look like.
function freshEncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

describe("b64url", () => {
  it("round-trips arbitrary bytes", () => {
    const input = new Uint8Array([0, 1, 254, 255, 100, 50]);
    const encoded = b64url(input);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const decoded = b64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(input));
  });

  it("round-trips ASCII strings", () => {
    const encoded = b64url("hello world");
    const decoded = new TextDecoder().decode(b64urlDecode(encoded));
    expect(decoded).toBe("hello world");
  });
});

describe("sha256B64Url", () => {
  it("matches a known PKCE vector", async () => {
    // RFC 7636 §4.2 vector: code_verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // → S256 challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const actual = await sha256B64Url(verifier);
    expect(actual).toBe(expected);
  });
});

describe("HS256 signJwt / verifyJwt", () => {
  it("round-trips claims", async () => {
    const token = await signJwt({ sub: "alice", scope: "mcp" }, SIGN_KEY);
    expect(token.split(".").length).toBe(3);
    const claims = await verifyJwt<{ sub: string; scope: string }>(
      token,
      SIGN_KEY,
    );
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("alice");
    expect(claims!.scope).toBe("mcp");
  });

  it("returns null for tampered payload", async () => {
    const token = await signJwt({ sub: "alice" }, SIGN_KEY);
    const [h, p, s] = token.split(".");
    // Flip a payload character — signature should now mismatch.
    const tampered = `${h}.${p}A.${s}`;
    expect(await verifyJwt(tampered, SIGN_KEY)).toBeNull();
  });

  it("returns null for wrong signing key", async () => {
    const token = await signJwt({ sub: "alice" }, SIGN_KEY);
    expect(await verifyJwt(token, "different-key")).toBeNull();
  });

  it("returns null for malformed token", async () => {
    expect(await verifyJwt("not-a-jwt", SIGN_KEY)).toBeNull();
    expect(await verifyJwt("only.two", SIGN_KEY)).toBeNull();
    expect(await verifyJwt("", SIGN_KEY)).toBeNull();
  });

  it("returns null for expired claims", async () => {
    const token = await signJwt(
      { sub: "alice", exp: Math.floor(Date.now() / 1000) - 60 },
      SIGN_KEY,
    );
    expect(await verifyJwt(token, SIGN_KEY)).toBeNull();
  });
});

describe("AES-GCM encrypt / decrypt", () => {
  it("round-trips a Tako-token-shaped string", async () => {
    const key = freshEncKey();
    const plaintext = "fake-tako-token-abc123def456ghi789";
    const ciphertext = await encryptAesGcm(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    const recovered = await decryptAesGcm(ciphertext, key);
    expect(recovered).toBe(plaintext);
  });

  it("returns null for wrong key", async () => {
    const key1 = freshEncKey();
    const key2 = freshEncKey();
    const ciphertext = await encryptAesGcm("secret", key1);
    expect(await decryptAesGcm(ciphertext, key2)).toBeNull();
  });

  it("returns null for tampered ciphertext", async () => {
    const key = freshEncKey();
    const ciphertext = await encryptAesGcm("secret", key);
    // Flip a character in the middle of the encoded value rather than the
    // last char. base64url's last char can carry unused bits (depending on
    // the encoded length), so a single-char flip there sometimes decodes
    // to identical bytes — the tamper would be invisible to AES-GCM.
    // Mid-string the bits land squarely inside the ciphertext + tag.
    const mid = Math.floor(ciphertext.length / 2);
    const flip = ciphertext[mid] === "A" ? "B" : "A";
    const tampered =
      ciphertext.slice(0, mid) + flip + ciphertext.slice(mid + 1);
    expect(await decryptAesGcm(tampered, key)).toBeNull();
  });

  it("uses a fresh IV per encryption (different ciphertexts for same plaintext)", async () => {
    const key = freshEncKey();
    const plaintext = "stable-input";
    const ct1 = await encryptAesGcm(plaintext, key);
    const ct2 = await encryptAesGcm(plaintext, key);
    expect(ct1).not.toBe(ct2);
  });

  it("rejects keys that aren't 32 bytes", async () => {
    const shortKey = btoa("only-16-bytes-ok"); // 16 bytes
    await expect(encryptAesGcm("secret", shortKey)).rejects.toThrow(
      /must decode to 32 bytes/,
    );
  });
});
