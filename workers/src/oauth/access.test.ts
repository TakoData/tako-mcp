import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { tryResolveOAuthAccessToken } from "./access.js";
import { encryptAesGcm, signJwt } from "./jwt.js";
import type { AccessTokenClaims } from "./types.js";

const SIGN_KEY = "test-sign-key-access-test";
const ISSUER = "https://mcp.tako.com";
const RESOURCE = "https://mcp.tako.com/mcp";

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

/** Mint an access token; `claims` overrides let a test vary iss/aud/scope/type. */
async function mintAccessToken(
  env: Env,
  takoToken: string,
  overrides: Partial<AccessTokenClaims> = {},
): Promise<string> {
  const enc_tako_token = await encryptAesGcm(takoToken, env.OAUTH_ENC_KEY!);
  const claims: AccessTokenClaims = {
    type: "access",
    scope: "mcp",
    user_id: "user-1",
    user_email: "alice@example.com",
    enc_tako_token,
    iss: ISSUER,
    aud: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
  return signJwt(claims, env.OAUTH_SIGN_KEY!);
}

describe("tryResolveOAuthAccessToken", () => {
  it("resolves the Tako token from a valid, correctly-audienced access JWT", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "real-tako-token-xyz");
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r).toEqual({ kind: "ok", takoToken: "real-tako-token-xyz" });
  });

  it("accepts a legacy token with no iss/aud during the cutover", async () => {
    const env = envWith({});
    // Mint an access token WITHOUT iss/aud (the pre-audience-binding shape).
    const enc_tako_token = await encryptAesGcm("legacy-tok", env.OAUTH_ENC_KEY!);
    const token = await signJwt(
      {
        type: "access",
        scope: "mcp",
        user_id: "u",
        user_email: "e",
        enc_tako_token,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      env.OAUTH_SIGN_KEY!,
    );
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r).toEqual({ kind: "ok", takoToken: "legacy-tok" });
  });

  it("is not_oauth for non-JWT bearers (raw Tako tokens)", async () => {
    const env = envWith({});
    const r = await tryResolveOAuthAccessToken("plain-tako-api-token", env, ISSUER);
    expect(r).toEqual({ kind: "not_oauth" });
  });

  it("is not_oauth when OAUTH_SIGN_KEY is unset (OAuth disabled)", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    const { OAUTH_SIGN_KEY: _omit, ...disabledEnv } = env;
    void _omit;
    const r = await tryResolveOAuthAccessToken(token, disabledEnv as Env, ISSUER);
    expect(r).toEqual({ kind: "not_oauth" });
  });

  it("is not_oauth when OAUTH_ENC_KEY is unset", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    const { OAUTH_ENC_KEY: _omit, ...disabledEnv } = env;
    void _omit;
    const r = await tryResolveOAuthAccessToken(token, disabledEnv as Env, ISSUER);
    expect(r).toEqual({ kind: "not_oauth" });
  });

  it("is not_oauth when the signature uses a different signing key", async () => {
    const envA = envWith({});
    const envB: Env = { ...envA, OAUTH_SIGN_KEY: "completely-different-key" };
    const token = await mintAccessToken(envA, "x");
    const r = await tryResolveOAuthAccessToken(token, envB, ISSUER);
    expect(r).toEqual({ kind: "not_oauth" });
  });

  it("rejects a wrong-type token (e.g. a refresh token) presented at /mcp", async () => {
    const env = envWith({});
    const enc_tako_token = await encryptAesGcm("x", env.OAUTH_ENC_KEY!);
    const refreshShaped = await signJwt(
      {
        type: "refresh",
        scope: "mcp",
        user_id: "u",
        user_email: "e",
        enc_tako_token,
        iss: ISSUER,
        aud: RESOURCE,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      env.OAUTH_SIGN_KEY!,
    );
    const r = await tryResolveOAuthAccessToken(refreshShaped, env, ISSUER);
    expect(r.kind).toBe("reject");
  });

  it("rejects a token whose audience names a different resource", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x", { aud: "https://evil.example" });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.error).toBe("invalid_token");
  });

  it("rejects a token whose issuer is a different origin", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x", { iss: "https://evil.example" });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
  });

  it("rejects a token missing the required 'mcp' scope", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x", { scope: "openid" });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.error).toBe("insufficient_scope");
  });

  it("accepts a multi-valued scope containing 'mcp' (mcp offline_access)", async () => {
    // Azure AI Foundry's documented scope. Every other token in this file is
    // single-valued `mcp`, so narrowing the check to an equality test
    // (`claims.scope !== REQUIRED_SCOPE`) would keep the suite green while
    // rejecting every token Foundry obtains.
    const env = envWith({});
    const token = await mintAccessToken(env, "x", {
      scope: "mcp offline_access",
    });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("ok");
  });

  it("accepts 'mcp' in any position within a multi-valued scope", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x", {
      scope: "offline_access mcp",
    });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("ok");
  });

  it("rejects a scope that merely contains 'mcp' as a substring", async () => {
    // `mcpx` must not satisfy the requirement — the check splits on
    // whitespace rather than using a substring match.
    const env = envWith({});
    const token = await mintAccessToken(env, "x", { scope: "mcpx" });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.error).toBe("insufficient_scope");
  });

  it("rejects (fails closed) when ENC_KEY was rotated under a still-valid signing key", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x");
    const rotatedEnv: Env = { ...env, OAUTH_ENC_KEY: freshEncKey() };
    const r = await tryResolveOAuthAccessToken(token, rotatedEnv, ISSUER);
    expect(r.kind).toBe("reject");
  });

  it("accepts a token audienced to the bare origin (both forms are this server)", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "ok-tok", { aud: ISSUER });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r).toEqual({ kind: "ok", takoToken: "ok-tok" });
  });

  it("rejects an expired access token with a 401-worthy reject (not fall-through)", async () => {
    const env = envWith({});
    const token = await mintAccessToken(env, "x", {
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.error).toBe("invalid_token");
  });

  it("rejects a non-string aud (array) rather than skipping the check", async () => {
    const env = envWith({});
    // RFC 7519 permits aud as an array; a future minter must not bypass the
    // check by emitting one, so a present non-string aud is rejected.
    const enc_tako_token = await encryptAesGcm("x", env.OAUTH_ENC_KEY!);
    const token = await signJwt(
      {
        type: "access",
        scope: "mcp",
        user_id: "u",
        user_email: "e",
        enc_tako_token,
        iss: ISSUER,
        aud: [RESOURCE, "https://evil.example"],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      env.OAUTH_SIGN_KEY!,
    );
    const r = await tryResolveOAuthAccessToken(token, env, ISSUER);
    expect(r.kind).toBe("reject");
  });
});
