import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
} from "./handlers.js";
import { encryptAesGcm, signJwt } from "./jwt.js";
import {
  buildSetCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "./cookies.js";
import type { ClientIdClaims, SessionCookieClaims } from "./types.js";

const SIGN_KEY = "test-sign-key-handlers";

function freshEncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    DJANGO_BASE_URL: "https://example.test",
    OAUTH_SIGN_KEY: SIGN_KEY,
    OAUTH_ENC_KEY: freshEncKey(),
    STYTCH_PROJECT_ID: "project-test-stub",
    STYTCH_SECRET: "secret-stub",
    STYTCH_PUBLIC_TOKEN: "public-token-test-stub",
    STYTCH_BASE_URL: "https://test.stytch.com",
    ...overrides,
  };
}

const ENV_NO_OAUTH: Env = {
  DJANGO_BASE_URL: "https://example.test",
};

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(verifierBytes);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(verifier),
  );
  return { verifier, challenge: b64url(challengeBytes) };
}

async function mintClientId(env: Env, redirectUri: string): Promise<string> {
  const claims: ClientIdClaims = {
    type: "client_id",
    client_name: "test-client",
    redirect_uris: [redirectUri],
    iat: Math.floor(Date.now() / 1000),
  };
  return signJwt(claims, env.OAUTH_SIGN_KEY!);
}

async function mintSessionCookie(env: Env, takoToken: string): Promise<string> {
  const enc_tako_token = await encryptAesGcm(takoToken, env.OAUTH_ENC_KEY!);
  const claims: SessionCookieClaims = {
    type: "session",
    user_id: "user-1",
    user_email: "alice@example.com",
    enc_tako_token,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  return signJwt(claims, env.OAUTH_SIGN_KEY!);
}

/* --------------------------- Discovery --------------------------- */

describe("discovery", () => {
  it("/.well-known/oauth-protected-resource advertises auth server", async () => {
    const res = handleProtectedResourceMetadata(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe("https://mcp.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://mcp.example.com"]);
  });

  it("/.well-known/oauth-authorization-server lists endpoints + PKCE S256", async () => {
    const res = handleAuthServerMetadata(
      new Request(
        "https://mcp.example.com/.well-known/oauth-authorization-server",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(body.authorization_endpoint).toBe("https://mcp.example.com/authorize");
    expect(body.token_endpoint).toBe("https://mcp.example.com/token");
    expect(body.registration_endpoint).toBe("https://mcp.example.com/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});

/* --------------------------- DCR --------------------------- */

describe("/register (DCR)", () => {
  it("returns 503 when OAuth is disabled", async () => {
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      ENV_NO_OAUTH,
    );
    expect(res.status).toBe(503);
  });

  it("returns 201 with a signed client_id JWT on valid registration", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "test-host",
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id.split(".").length).toBe(3);
  });

  it("rejects an empty redirect_uris array", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

/* --------------------------- /authorize --------------------------- */

describe("/authorize", () => {
  it("GET without session redirects to /login and sets state cookie", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "xyz");

    const res = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain(`${STATE_COOKIE}=`);
    expect(setCookie!).toContain("HttpOnly");
  });

  it("GET with valid session renders HTML consent page", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env, "tako-token-x");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("test-client");
    expect(html).toContain("Allow");
    expect(html).toContain("Cancel");
  });

  it("POST without session is rejected with 401", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "POST" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("POST with valid session redirects to client with auth code", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env, "tako-token-x");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "client-state");

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const redirected = new URL(location!);
    expect(redirected.origin + redirected.pathname).toBe(
      "https://client.example.com/cb",
    );
    expect(redirected.searchParams.get("state")).toBe("client-state");
    expect(redirected.searchParams.get("code")?.split(".").length).toBe(3);
  });

  it("rejects redirect_uri not in client's registered list", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env, "tako-token-x");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

/* --------------------------- /token --------------------------- */

describe("/token", () => {
  async function runFullFlow(): Promise<{
    env: Env;
    accessToken: string;
    refreshToken: string;
    scope: string;
  }> {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env, "tako-token-real");
    const { verifier, challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp");

    const authorizeRes = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const code = new URL(authorizeRes.headers.get("location")!)
      .searchParams.get("code")!;

    const tokenRes = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example.com/cb",
          code_verifier: verifier,
          client_id: clientId,
        }).toString(),
      }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe("Bearer");
    return {
      env,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      scope: body.scope,
    };
  }

  it("authorization_code grant issues access + refresh tokens", async () => {
    const result = await runFullFlow();
    expect(result.accessToken.split(".").length).toBe(3);
    expect(result.refreshToken.split(".").length).toBe(3);
    expect(result.scope).toBe("mcp");
  });

  it("rejects authorization_code grant with mismatched PKCE verifier", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env, "tako-token-real");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const code = new URL(authorizeRes.headers.get("location")!)
      .searchParams.get("code")!;

    const tokenRes = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example.com/cb",
          code_verifier: "wrong-verifier",
          client_id: clientId,
        }).toString(),
      }),
      env,
    );
    expect(tokenRes.status).toBe(400);
    expect(((await tokenRes.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("refresh_token grant issues new tokens", async () => {
    const { env, refreshToken } = await runFullFlow();
    const refreshRes = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      }),
      env,
    );
    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as { access_token: string };
    expect(body.access_token.split(".").length).toBe(3);
  });

  it("rejects unsupported grant_type", async () => {
    const env = envWith();
    const res = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password" }).toString(),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });
});

/* --------------------------- /login --------------------------- */

describe("/login", () => {
  it("returns 503 when OAuth is disabled", () => {
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      ENV_NO_OAUTH,
    );
    expect(res.status).toBe(503);
  });

  it("renders an HTML login page with Stytch SDK and public token", () => {
    const env = envWith();
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    return res.text().then((html) => {
      expect(html).toContain("https://js.stytch.com/stytch.js");
      expect(html).toContain("public-token-test-stub");
      expect(html).toContain("/oauth/stytch_callback");
      expect(html).toContain("Continue with Google");
    });
  });
});

/* --------------------------- helper unused-export grounding --------------------------- */

describe("test helpers stay imported", () => {
  it("buildSetCookie is referenced (keeps the cookies module live in tree-shake)", () => {
    expect(typeof buildSetCookie).toBe("function");
  });
});
