import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
} from "./handlers.js";
import { decryptAesGcm, encryptAesGcm, signJwt } from "./jwt.js";
import {
  buildSetCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "./cookies.js";
import type {
  ClientIdClaims,
  RefreshTokenClaims,
  SessionCookieClaims,
} from "./types.js";

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

/**
 * Mint a `tako_oauth_session` cookie value. Carries an encrypted Stytch
 * session JWT (placeholder ASCII string is fine — handler only decrypts
 * + forwards it as a Cookie header to a mocked Tako fetch). Tests that
 * exercise POST /authorize must also stub `globalThis.fetch` so the
 * Tako-token re-fetch returns whatever value the test wants embedded in
 * the issued auth code; see `mockTakoTokenFetch`.
 */
async function mintSessionCookie(
  env: Env,
  stytchJwtPlaceholder = "stub.stytch.session",
): Promise<string> {
  const enc_stytch_session_jwt = await encryptAesGcm(
    stytchJwtPlaceholder,
    env.OAUTH_ENC_KEY!,
  );
  const claims: SessionCookieClaims = {
    type: "session",
    user_id: "user-1",
    user_email: "alice@example.com",
    enc_stytch_session_jwt,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  return signJwt(claims, env.OAUTH_SIGN_KEY!);
}

/**
 * Stub `globalThis.fetch` so a server-side call to Tako's
 * `/api/v1/internal/mcp/api_key/` endpoint returns the supplied key value.
 * Used by tests that exercise POST /authorize, since that handler now
 * mints a Tako API key from the user's Stytch session at consent
 * time (TAKO-3254).
 */
function mockTakoTokenFetch(token: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/v1/internal/mcp/api_key/")) {
        return new Response(JSON.stringify({ key: token }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      // Anything else is unexpected from these tests; fail loudly so
      // we notice if the handler grows another upstream call.
      return new Response(`unmocked fetch: ${url}`, { status: 599 });
    }),
  );
}

/**
 * Stub `globalThis.fetch` so Tako's `/api/v1/internal/mcp/api_key/` returns the
 * given non-201 status. Used to test the error branches in POST /authorize.
 */
function mockTakoTokenFetchStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/v1/internal/mcp/api_key/")) {
        return new Response("error", { status });
      }
      return new Response(`unmocked fetch: ${url}`, { status: 599 });
    }),
  );
}

beforeEach(() => {
  // Every test starts with a fetch stub that resolves Tako's
  // `/api/v1/api_token/` to a generic token. Tests that need to
  // verify a specific token value or test an error path call
  // `mockTakoTokenFetch(...)` / `mockTakoTokenFetchStatus(...)`
  // themselves to override.
  vi.unstubAllGlobals();
  mockTakoTokenFetch("default-mocked-tako-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* --------------------------- Discovery --------------------------- */

describe("discovery", () => {
  it("/.well-known/oauth-protected-resource advertises auth server when configured", async () => {
    const res = handleProtectedResourceMetadata(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
      envWith(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe("https://mcp.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://mcp.example.com"]);
  });

  it("/.well-known/oauth-authorization-server lists endpoints + PKCE S256 when configured", async () => {
    const res = handleAuthServerMetadata(
      new Request(
        "https://mcp.example.com/.well-known/oauth-authorization-server",
      ),
      envWith(),
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

  it("returns 404 when OAuth is disabled (no metadata advertised)", async () => {
    const res1 = handleProtectedResourceMetadata(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
      ENV_NO_OAUTH,
    );
    expect(res1.status).toBe(404);
    const res2 = handleAuthServerMetadata(
      new Request(
        "https://mcp.example.com/.well-known/oauth-authorization-server",
      ),
      ENV_NO_OAUTH,
    );
    expect(res2.status).toBe(404);
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

  it("rejects a `javascript:` redirect_uri", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "evil",
          redirect_uris: ["javascript:alert(1)"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_redirect_uri",
    );
  });

  it("rejects a `data:` redirect_uri", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["data:text/html,<script>alert(1)</script>"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-loopback `http:` redirect_uri", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://evil.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("accepts `http://localhost` redirect_uri (developer use)", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "dev-host",
          redirect_uris: ["http://localhost:3000/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);
  });

  it("rejects client_name with control characters", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "evil\nlog-injection",
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects oversized request bodies with 413", async () => {
    const env = envWith();
    const huge = "x".repeat(5000);
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: huge,
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(413);
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
    const sessionJwt = await mintSessionCookie(env);
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
    const sessionJwt = await mintSessionCookie(env);
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

  it("rejects code_challenge_method=plain (only S256 is supported)", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "plain-challenge-string");
    url.searchParams.set("code_challenge_method", "plain");
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("escapes HTML-injecting client_name in the consent page", async () => {
    const env = envWith();
    // Inject a registration with a client_name that would break out of
    // attribute / text contexts if escaping is forgotten anywhere.
    const claims = {
      type: "client_id" as const,
      client_name: "evil<script>alert(1)</script>\"'",
      redirect_uris: ["https://client.example.com/cb"],
      iat: Math.floor(Date.now() / 1000),
    };
    const clientId = await signJwt(claims, env.OAUTH_SIGN_KEY!);
    const sessionJwt = await mintSessionCookie(env);
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
    const html = await res.text();
    // Raw <script> from the client_name must NOT appear unescaped.
    expect(html).not.toContain("<script>alert(1)</script>");
    // The escaped form should be present so the page still tells the
    // user which client_name was registered.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("rebuilds form-action from validated params (not raw query string)", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    // An attacker-supplied unknown query param should not survive
    // into the form-action URL.
    url.searchParams.set("attacker_param", "whatever");

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const html = await res.text();
    expect(html).not.toContain("attacker_param");
  });

  it("rejects redirect_uri not in client's registered list", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
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
    const sessionJwt = await mintSessionCookie(env);
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
    const sessionJwt = await mintSessionCookie(env);
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

  it("rejects mismatched redirect_uri at /token", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
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
          redirect_uri: "https://attacker.example.com/cb",
          code_verifier: verifier,
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

  it("rejects mismatched client_id at /token (belt-and-suspenders vs PKCE)", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const otherClientId = await mintClientId(env, "https://other.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
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
    // Client B presents the form with their own client_id even though
    // the auth code was minted for client A.
    const tokenRes = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example.com/cb",
          code_verifier: verifier,
          client_id: otherClientId,
        }).toString(),
      }),
      env,
    );
    expect(tokenRes.status).toBe(400);
    expect(((await tokenRes.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
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

  it("returns invalid_request when grant_type is missing", async () => {
    const env = envWith();
    const res = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "x" }).toString(),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("grant_type is required");
  });

  it("rejects replay of an already-redeemed authorization_code", async () => {
    // Single-use enforcement (OAuth 2.1 §4.1.2 / RFC 6749 §4.1.2): an
    // authorization_code MUST be redeemable at most once.
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
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

    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.example.com/cb",
      code_verifier: verifier,
      client_id: clientId,
    }).toString();

    const first = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm,
      }),
      env,
    );
    expect(first.status).toBe(200);

    const replay = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm,
      }),
      env,
    );
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBe("authorization code already redeemed");
  });

  it("does not enforce single-use on legacy refresh_token (no jti)", async () => {
    // Tokens minted before TAKO-2701 shipped lack a `jti` claim.
    // `verifyJwt` validates signature + exp only, so a legacy token
    // deserializes with `claims.jti === undefined`. If the redemption
    // handler keyed the cache on `undefined` directly, every legacy
    // token would collide on one cache slot and the first post-deploy
    // refresh would lock out every other still-active session. The
    // handler must skip enforcement when `jti` is absent so legacy
    // tokens stay redeemable for the remainder of their natural TTL.
    const env = envWith();
    const enc_tako_token = await encryptAesGcm(
      "stub-tako-token",
      env.OAUTH_ENC_KEY!,
    );
    const legacyClaims = {
      type: "refresh" as const,
      scope: "mcp",
      user_id: "user-1",
      user_email: "alice@example.com",
      enc_tako_token,
      exp: Math.floor(Date.now() / 1000) + 60,
      // intentionally no jti — simulates a token minted by the previous
      // deploy.
    };
    const refresh_token = await signJwt(
      legacyClaims as unknown as RefreshTokenClaims,
      env.OAUTH_SIGN_KEY!,
    );
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    }).toString();

    const first = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }),
      env,
    );
    expect(second.status).toBe(200);
  });

  it("rejects replay of an already-redeemed refresh_token", async () => {
    // Refresh tokens are also single-use (OAuth 2.1 §4.3.1 rotation):
    // re-presenting a token after it has been exchanged must fail.
    const { env, refreshToken } = await runFullFlow();
    const refreshForm = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();

    const first = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: refreshForm,
      }),
      env,
    );
    expect(first.status).toBe(200);

    const replay = await handleToken(
      new Request("https://mcp.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: refreshForm,
      }),
      env,
    );
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBe("refresh token already redeemed");
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

/* --------------------------- HTML response hardening --------------------------- */

describe("HTML responses set defensive headers", () => {
  async function fetchHtml(): Promise<Response> {
    const env = envWith();
    return handleLogin(new Request("https://mcp.example.com/login"), env);
  }

  it("sets X-Frame-Options: DENY (clickjacking defense)", async () => {
    const res = await fetchHtml();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets CSP frame-ancestors 'none' (modern clickjacking defense)", async () => {
    const res = await fetchHtml();
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("sets Cache-Control: no-store (no proxy caching of auth pages)", async () => {
    const res = await fetchHtml();
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("no-store");
    expect(cc).toContain("no-cache");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await fetchHtml();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets Referrer-Policy: no-referrer (don't leak OAuth params on outbound clicks)", async () => {
    const res = await fetchHtml();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

/* --------------------------- /authorize scope + client_id expiry --------------------------- */

describe("/authorize hardening", () => {
  it("rejects unsupported scope values", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "admin:write");
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("accepts the supported `mcp` scope", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp");
    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("treats empty `?scope=` as the default `mcp` scope", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "");
    const authorizeRes = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(authorizeRes.status).toBe(302);
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
    const body = (await tokenRes.json()) as { scope: string };
    expect(body.scope).toBe("mcp");
  });

  it("rejects an expired client_id (registration TTL)", async () => {
    const env = envWith();
    // Mint a client_id that's already expired.
    const expiredClient: ClientIdClaims = {
      type: "client_id",
      client_name: "expired-test",
      redirect_uris: ["https://client.example.com/cb"],
      iat: Math.floor(Date.now() / 1000) - 1000,
      exp: Math.floor(Date.now() / 1000) - 100,
    };
    const expiredClientId = await signJwt(expiredClient, env.OAUTH_SIGN_KEY!);
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", expiredClientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    // 401 from the invalid_client branch — verifyJwt returned null
    // because exp is in the past.
    expect(res.status).toBe(401);
  });

  it("issues client_id JWTs with an `exp` (registrations age out)", async () => {
    const env = envWith();
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "exp-check",
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    // Decode the JWT body manually and check that exp is set.
    const parts = body.client_id.split(".");
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number; iat: number };
    expect(payload.exp).toBeDefined();
    expect(payload.exp!).toBeGreaterThan(payload.iat);
  });
});

/* --------------------------- /authorize POST re-fetches Tako token --------------------------- */

describe("/authorize POST always re-fetches the Tako token (Option 2)", () => {
  async function runAuthorizePost(
    env: Env,
  ): Promise<{ accessToken: string; verifier: string; clientId: string }> {
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
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
    expect(authorizeRes.status).toBe(302);
    const code = new URL(authorizeRes.headers.get("location")!)
      .searchParams.get("code")!;

    // Exchange the auth code for tokens so the test can decrypt the
    // resulting access token's enc_tako_token claim.
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
    const body = (await tokenRes.json()) as { access_token: string };
    return { accessToken: body.access_token, verifier, clientId };
  }

  function decodeAccessClaims(jwt: string): Record<string, unknown> {
    const parts = jwt.split(".");
    return JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
  }

  it("embeds the freshly-fetched Tako token in the issued auth code, not a cached value", async () => {
    const env = envWith();
    // Mock fetch to return a known token. The session cookie itself
    // carries only the encrypted Stytch JWT — no Tako token cached.
    mockTakoTokenFetch("FRESH_TAKO_TOKEN_FROM_DJANGO");
    const { accessToken } = await runAuthorizePost(env);
    const claims = decodeAccessClaims(accessToken);
    const decrypted = await decryptAesGcm(
      claims["enc_tako_token"] as string,
      env.OAUTH_ENC_KEY!,
    );
    expect(decrypted).toBe("FRESH_TAKO_TOKEN_FROM_DJANGO");
  });

  it("reflects rotation: a second consent flow uses the rotated Tako token", async () => {
    const env = envWith();

    mockTakoTokenFetch("OLD_TAKO_TOKEN");
    const first = await runAuthorizePost(env);
    const firstDecrypted = await decryptAesGcm(
      decodeAccessClaims(first.accessToken)["enc_tako_token"] as string,
      env.OAUTH_ENC_KEY!,
    );
    expect(firstDecrypted).toBe("OLD_TAKO_TOKEN");

    // Simulate rotation at trytako.com: subsequent fetches return the new token.
    mockTakoTokenFetch("NEW_TAKO_TOKEN_AFTER_ROTATION");
    const second = await runAuthorizePost(env);
    const secondDecrypted = await decryptAesGcm(
      decodeAccessClaims(second.accessToken)["enc_tako_token"] as string,
      env.OAUTH_ENC_KEY!,
    );
    expect(secondDecrypted).toBe("NEW_TAKO_TOKEN_AFTER_ROTATION");
  });

  it("returns a 401 sign-in-required page when Stytch session is rejected by Tako", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    // Tako returns 401 → unauthorized → user must re-login.
    mockTakoTokenFetchStatus(401);

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Session cookie cleared so the next /authorize forces a fresh /login.
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("returns a 400 'too many API keys' page when user is at the key cap", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    // 400 from Tako means user is at the API-key cap.
    mockTakoTokenFetchStatus(400);

    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("trytako.com");
  });
});

/* --------------------------- helper unused-export grounding --------------------------- */

describe("test helpers stay imported", () => {
  it("buildSetCookie is referenced (keeps the cookies module live in tree-shake)", () => {
    expect(typeof buildSetCookie).toBe("function");
  });
});
