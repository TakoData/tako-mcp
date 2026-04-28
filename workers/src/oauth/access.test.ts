import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { tryResolveOAuthAccessToken } from "./access.js";
import { encryptAesGcm, signJwt } from "./jwt.js";
import type { AccessTokenClaims } from "./types.js";

const SIGN_KEY = "test-sign-key-access-test";

function freshEncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function envWith(overrides: Partial<Env>): Env {
  return {
    DJANGO_BASE_URL: "https://example.test",
    OAUTH_SIGN_KEY: SIGN_KEY,
    OAUTH_ENC_KEY: freshEncKey(),
    ...overrides,
  };
}

async function mintAccessToken(
  env: Env,
  takoToken: string,
): Promise<string> {
  const enc_tako_token = await encryptAesGcm(takoToken, env.OAUTH_ENC_KEY!);
  const claims: AccessTokenClaims = {
    type: "access",
    scope: "mcp",
    user_id: "user-1",
    user_email: "alice@example.com",
    enc_tako_token,
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  return signJwt(claims, env.OAUTH_SIGN_KEY!);
}

describe("tryResolveOAuthAccessToken", () => {
  it("decrypts the Tako token from a valid OAuth access JWT", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "real-tako-token-xyz");
    const downstream = await tryResolveOAuthAccessToken(token, env);
    expect(downstream).toBe("real-tako-token-xyz");
  });

  it("returns null for non-JWT bearers (raw Tako tokens)", async () => {
    const env = envWith({});
    expect(
      await tryResolveOAuthAccessToken("plain-tako-api-token", env),
    ).toBeNull();
  });

  it("returns null when OAUTH_SIGN_KEY is unset (OAuth disabled)", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    // Strip OAUTH_SIGN_KEY rather than set it to undefined — the Env
    // interface uses `exactOptionalPropertyTypes`, so explicit `undefined`
    // doesn't satisfy `field?: string`.
    const { OAUTH_SIGN_KEY: _omit, ...disabledEnv } = env;
    void _omit;
    expect(
      await tryResolveOAuthAccessToken(token, disabledEnv as Env),
    ).toBeNull();
  });

  it("returns null when OAUTH_ENC_KEY is unset", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    const { OAUTH_ENC_KEY: _omit, ...disabledEnv } = env;
    void _omit;
    expect(
      await tryResolveOAuthAccessToken(token, disabledEnv as Env),
    ).toBeNull();
  });

  it("returns null when token signature uses a different signing key", async () => {
    const envA = envWith({});
    const envB: Env = { ...envA, OAUTH_SIGN_KEY: "completely-different-key" };
    const token = await mintAccessToken(envA, "x");
    expect(await tryResolveOAuthAccessToken(token, envB)).toBeNull();
  });

  it("returns null when type discriminator is wrong (e.g., refresh token)", async () => {
    const env = envWith({});
    const enc_tako_token = await encryptAesGcm("x", env.OAUTH_ENC_KEY!);
    const refreshShaped = await signJwt(
      {
        type: "refresh", // not "access"
        scope: "mcp",
        user_id: "u",
        user_email: "e",
        enc_tako_token,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      env.OAUTH_SIGN_KEY!,
    );
    expect(await tryResolveOAuthAccessToken(refreshShaped, env)).toBeNull();
  });

  it("returns null when ENC_KEY was rotated under a still-valid signing key", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    const rotatedEnv: Env = { ...env, OAUTH_ENC_KEY: freshEncKey() };
    expect(await tryResolveOAuthAccessToken(token, rotatedEnv)).toBeNull();
  });
});
