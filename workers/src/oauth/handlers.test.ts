import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import {
  handleAuthorize,
  handleAuthServerMetadata,
  handleLogin,
  handleLoginPassword,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
} from "./handlers.js";
import { decryptAesGcm, encryptAesGcm, signJwt, verifyJwt } from "./jwt.js";
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

/** The consent form's Allow button posts this. `handleAuthorize` requires an
 *  explicit decision — a POST with no `action` is a 400, never an implicit
 *  allow — so every consent POST in these tests carries it. */
const CONSENT_ALLOW = "action=allow";

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

/** An always-admitting limiter binding. */
function fakeLimiter(): { limit: (o: { key: string }) => Promise<{ success: boolean }> } {
  return { limit: async () => ({ success: true }) };
}

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
  // `/api/v1/internal/mcp/api_key/` to a generic token. Tests that need to
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

  it("public registrations report a finite client_id_expires_at", async () => {
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
    const body = (await res.json()) as {
      client_id: string;
      client_id_issued_at: number;
      client_id_expires_at: number;
    };
    // RFC 7591 §3.2.1: omitting the field means "never expires", which
    // would be a lie for the 1-year public path.
    expect(body.client_id_expires_at).toBe(
      body.client_id_issued_at + 365 * 24 * 60 * 60,
    );
    const claims = await verifyJwt<ClientIdClaims>(body.client_id, SIGN_KEY);
    expect(claims?.exp).toBe(body.client_id_expires_at);
    expect(claims?.partner).toBeUndefined();
  });

  it("ignores a stray Authorization header on the public path", async () => {
    // Hosts routinely retry /register with a stale access token still
    // attached. That must not be read as a failed partner registration.
    const env = envWith({ OAUTH_PARTNER_REGISTRATION_TOKEN: "partner-secret" });
    const res = await handleRegister(
      new Request("https://mcp.example.com/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer some-stale-access-token",
        },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/cb"],
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id_expires_at: number };
    expect(body.client_id_expires_at).toBeGreaterThan(0);
  });
});

/* --------------------------- /register (partner path) --------------------------- */

function partnerRegisterRequest(
  token: string | null,
  body: Record<string, unknown> = {
    client_name: "Microsoft Foundry",
    redirect_uris: ["https://foundry.example.com/cb"],
  },
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-tako-partner-token"] = token;
  return new Request("https://mcp.example.com/register", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("/register (partner path)", () => {
  const PARTNER_TOKEN = "partner-secret-value";

  it("mints a non-expiring client_id when the partner token matches", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      client_id_expires_at: number;
    };
    // RFC 7591 §3.2.1: 0 means the client_id never expires.
    expect(body.client_id_expires_at).toBe(0);
    const claims = await verifyJwt<ClientIdClaims>(body.client_id, SIGN_KEY);
    expect(claims).not.toBeNull();
    expect(claims?.exp).toBeUndefined();
    expect(claims?.partner).toBe(true);
    expect(claims?.redirect_uris).toEqual(["https://foundry.example.com/cb"]);
  });

  it("a partner client_id still authorizes after the public TTL would have lapsed", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN),
      env,
    );
    const { client_id } = (await res.json()) as { client_id: string };

    // Jump two years past issuance — well beyond REGISTRATION_TTL_S.
    const realNow = Date.now;
    try {
      const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
      Date.now = () => realNow() + twoYearsMs;
      const claims = await verifyJwt<ClientIdClaims>(client_id, SIGN_KEY);
      expect(claims).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects a wrong partner token with 401 rather than silently downgrading", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest("wrong-token"),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_client",
    );
  });

  it("rejects a partner token of the wrong length with 401", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(partnerRegisterRequest("short"), env);
    expect(res.status).toBe(401);
  });

  it("rejects the partner header with 401 when no partner token is configured", async () => {
    const env = envWith();
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("still enforces redirect_uri validation on the partner path", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN, {
        client_name: "Microsoft Foundry",
        redirect_uris: ["javascript:alert(1)"],
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("mints a partner client accepted end-to-end by /authorize", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN),
      env,
    );
    const { client_id } = (await res.json()) as { client_id: string };

    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", "https://foundry.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp");

    const authRes = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    // No session cookie yet, so the happy path is a redirect to /login —
    // what matters is that the client_id was NOT rejected as invalid_client.
    expect(authRes.status).toBe(302);
    expect(authRes.headers.get("location")).toContain("/login");
  });

  it("rejects a redirect_uri not registered to the partner client", async () => {
    const env = envWith({
      OAUTH_PARTNER_REGISTRATION_TOKEN: PARTNER_TOKEN,
    });
    const res = await handleRegister(
      partnerRegisterRequest(PARTNER_TOKEN),
      env,
    );
    const { client_id } = (await res.json()) as { client_id: string };

    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const authRes = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    expect(authRes.status).toBe(400);
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
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: CONSENT_ALLOW,
      }),
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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

  it("offers email + password directly, and no magic link", async () => {
    // Plugin review requires a password field on the page itself. The magic
    // link is gone deliberately, so its copy must not linger. Limiters bound,
    // because the form is only rendered when the endpoint behind it can run.
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      envWith({ LOGIN_RATE_LIMITER: fakeLimiter(), LOGIN_EMAIL_RATE_LIMITER: fakeLimiter() }),
    );
    const html = await res.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('action="/login/password"');
    expect(html).not.toContain("Email me a sign-in link");
    expect(html).not.toContain("magicLinks");
  });

  it("links out for password reset and account creation", async () => {
    const res = handleLogin(new Request("https://mcp.example.com/login"), envWith());
    const html = await res.text();
    expect(html).toContain("Forgot password?");
    expect(html).toContain("New to Tako?");
  });

  it("serves the dark-theme mark to a dark host, not the light-theme one", async () => {
    // `favicon.svg` is the LIGHT-theme asset (dark ink) and
    // `favicon-light.svg` is the dark-theme one — the naming reads backwards,
    // and `mcp.ts`'s `icons` array is the reference for which is which.
    // Hardcoding `favicon.svg` renders a near-invisible dark-on-dark mark for
    // every user whose OS is in dark mode, which a screenshot caught.
    const res = handleLogin(new Request("https://mcp.example.com/login"), envWith());
    const html = await res.text();
    expect(html).toContain("/icons/favicon-light.svg");
    // The dark asset must be selected by the media query, not merely present.
    expect(html).toMatch(
      /<source[^>]+srcset="\/icons\/favicon-light\.svg"[^>]+media="\(prefers-color-scheme: dark\)"/,
    );
    // …and the light asset stays as the `<img>` fallback, so a host that
    // states no preference still gets a visible mark.
    expect(html).toMatch(/<img[^>]+src="\/icons\/favicon\.svg"/);
  });

  it("renders only errors it issued itself, reflecting nothing", async () => {
    // `?error=` is attacker-controllable, so the page maps a CLOSED set of
    // codes to copy rather than escaping and echoing. Stronger than escaping:
    // there is no path from URL text to the document at all, so the page can
    // never become a phishing surface ("session expired, call this number").
    for (const attempt of [
      "<img src=x onerror=alert(1)>",
      "call_this_number_now",
    ]) {
      const res = handleLogin(
        new Request(
          "https://mcp.example.com/login?error=" + encodeURIComponent(attempt),
        ),
        envWith(),
      );
      const html = await res.text();
      expect(html).not.toContain(attempt);
      expect(html).not.toContain("<img src=x");
      // The error slot renders empty and CSS hides it (`.err:empty`).
      expect(html).toContain('id="err" role="alert" aria-live="polite"></div>');
    }
  });

  it("renders the mapped copy for a code it did issue", async () => {
    const res = handleLogin(
      new Request("https://mcp.example.com/login?error=no_user_password"),
      envWith(),
    );
    const html = await res.text();
    // Assert the DISTINGUISHING half of the copy, inside the error slot.
    // Asserting "Continue with Google" would pass with `LOGIN_ERROR_COPY`
    // emptied entirely, because that is the Google button's own label and the
    // page renders it on every request.
    expect(html).toMatch(
      /id="err"[^>]*>[^<]*This account signs in with Google/,
    );
  });

  it("hides the password form when the limiter binding is absent", async () => {
    // `handleLoginPassword` fails closed without the binding, so a page that
    // still renders the form is offering an input whose every submit 503s —
    // and the SDK's own fallback copy points at that form.
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      envWith(),
    );
    const html = await res.text();
    expect(html).not.toContain('action="/login/password"');
    expect(html).not.toContain('type="password"');
    // Google must survive: it is the path the fail-closed design protects.
    expect(html).toContain("Continue with Google");
  });

  it("renders the password form when the limiter IS bound", async () => {
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      envWith({ LOGIN_RATE_LIMITER: fakeLimiter(), LOGIN_EMAIL_RATE_LIMITER: fakeLimiter() }),
    );
    const html = await res.text();
    expect(html).toContain('action="/login/password"');
    expect(html).toContain('type="password"');
  });

  it("survives an unusable public base instead of 500ing the whole page", async () => {
    // `resolvePublicBase` throws on a trailing slash. It feeds only two footer
    // links, so a bad value must cost those links — not the page, and above all
    // not Google sign-in, the one path the limiter's fail-closed design keeps.
    const res = handleLogin(
      new Request("https://mcp.example.com/login"),
      envWith({ PUBLIC_BASE_URL: "https://tako.com/" }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Forgot password?");
  });

  it("points an MFA account at Tako's own second-factor page, not at Google", async () => {
    // Google resolves through the SAME `parseAuthenticateResponse`, so if
    // Stytch reports the second factor on that path too, "use Google" is a
    // loop. Tako's `/login/mfa` is the only place that can actually complete it.
    const res = handleLogin(
      new Request("https://mcp.example.com/login?error=mfa_required"),
      envWith({ PUBLIC_BASE_URL: "https://tako.com" }),
    );
    const html = await res.text();
    expect(html).toContain("https://tako.com/login/mfa");
    expect(html).not.toMatch(/id="err"[^>]*>[^<]*[^>]*Continue with Google/);
  });
});

/* --------------------------- Password login --------------------------- */

describe("POST /login/password", () => {
  function limiterEnv(overrides: Partial<Env> = {}): Env {
    return envWith({
      LOGIN_RATE_LIMITER: fakeLimiter(),
      LOGIN_EMAIL_RATE_LIMITER: fakeLimiter(),
      ...overrides,
    });
  }

  function form(email: string, password: string): Request {
    return new Request("https://mcp.example.com/login/password", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ email, password }).toString(),
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a non-POST", async () => {
    const res = await handleLoginPassword(
      new Request("https://mcp.example.com/login/password"),
      limiterEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("503s when OAuth is not configured", async () => {
    const res = await handleLoginPassword(
      form("eric@trytako.com", "pw"),
      ENV_NO_OAUTH,
    );
    expect(res.status).toBe(503);
  });

  it("refuses a cross-site POST", async () => {
    const req = new Request("https://mcp.example.com/login/password", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({ email: "e@t.com", password: "pw" }).toString(),
    });
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleLoginPassword(req, limiterEnv());
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the rate limiter binding is missing", async () => {
    // An unauthenticated password endpoint with no limiter is a
    // credential-stuffing oracle. Google sign-in still works.
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleLoginPassword(form("e@t.com", "pw"), envWith());
    expect(res.status).toBe(503);
    // Assert the BODY, not just the status: `oauthDisabledResponse()` is also a
    // 503 that never calls fetch, so a regression in `readConfig` would satisfy
    // a status-only assertion while the limiter check went unexercised.
    expect(await res.text()).toContain(
      "Password sign-in is unavailable on this deployment",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when only the EMAIL limiter binding is missing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleLoginPassword(
      form("e@t.com", "pw"),
      envWith({ LOGIN_RATE_LIMITER: fakeLimiter() }),
    );
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks a rate-limited attempt without calling Stytch", async () => {
    // A browser form post, so the block comes back as the same redirect every
    // other error uses — the message renders on the page instead of a bare
    // 429 body. The property that matters is that Stytch is never reached.
    const spy = vi.spyOn(globalThis, "fetch");
    const env = limiterEnv({
      LOGIN_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const res = await handleLoginPassword(form("e@t.com", "pw"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=rate_limited");
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks when the limiter itself throws (never fails open)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const env = limiterEnv({
      LOGIN_RATE_LIMITER: {
        limit: async () => {
          throw new Error("limiter exploded");
        },
      },
    });
    const res = await handleLoginPassword(form("e@t.com", "pw"), env);
    // Assert the status too: a response carrying a `location` header with a 200
    // is not a redirect at all, so the header alone does not pin the behaviour.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=rate_limited");
    expect(spy).not.toHaveBeenCalled();
  });

  it("tells an MFA account where the second factor lives, not that the password was wrong", async () => {
    // Stytch answers 200 with an intermediate token and no session_jwt. This
    // Worker has no second-factor UI, and Tako has /login/mfa routes, so real
    // accounts hit this.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ intermediate_session_token: "ist-abc" }),
        { status: 200 },
      ),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "correct-password"),
      limiterEnv(),
    );
    expect(res.headers.get("location")).toContain("error=mfa_required");
  });

  /** Run one attempt, returning the keys each limiter axis was metered on. */
  async function meteredKeys(
    email: string,
    ip: string,
  ): Promise<{ ipKeys: string[]; emailKeys: string[] }> {
    const ipKeys: string[] = [];
    const emailKeys: string[] = [];
    const env = envWith({
      LOGIN_RATE_LIMITER: {
        limit: async (o: { key: string }) => {
          ipKeys.push(o.key);
          return { success: true };
        },
      },
      LOGIN_EMAIL_RATE_LIMITER: {
        limit: async (o: { key: string }) => {
          emailKeys.push(o.key);
          return { success: true };
        },
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "invalid_credentials" }), {
        status: 401,
      }),
    );
    const req = form(email, "pw");
    req.headers.set("cf-connecting-ip", ip);
    await handleLoginPassword(req, env);
    return { ipKeys, emailKeys };
  }

  it("meters each email under its own key, not one shared bucket", async () => {
    // A constant email key would satisfy "two keys, one has the IP, none has
    // the plaintext address" while being a single global bucket — i.e. one
    // attacker could lock every account out of password sign-in. The property
    // that matters is that distinct emails map to DISTINCT keys.
    const a = await meteredKeys("alice@trytako.com", "203.0.113.7");
    const b = await meteredKeys("bob@trytako.com", "203.0.113.7");
    expect(a.emailKeys).toHaveLength(1);
    expect(b.emailKeys).toHaveLength(1);
    expect(a.emailKeys[0]).not.toBe(b.emailKeys[0]);
    // …and the same address is stable, or the bucket never accumulates.
    const again = await meteredKeys("alice@trytako.com", "198.51.100.4");
    expect(again.emailKeys[0]).toBe(a.emailKeys[0]);
  });

  it("meters the client IP, and keys the email as a hash", async () => {
    const { ipKeys, emailKeys } = await meteredKeys(
      "eric@trytako.com",
      "203.0.113.7",
    );
    expect(ipKeys.some((k) => k.includes("203.0.113.7"))).toBe(true);
    // Key hygiene: the rate-limit key space never holds the address itself.
    expect(emailKeys.some((k) => k.includes("eric@trytako.com"))).toBe(false);
  });

  it("does not charge the victim's email bucket for a fieldless POST", async () => {
    // The cheapest attack on a per-email bucket is junk POSTs against a known
    // address: no password guess needed, and the victim is held in the
    // `rate_limited` redirect. Field validation must run BEFORE the email axis
    // is metered, so only attempts that reach a credential check can consume
    // someone else's bucket. The IP axis is still charged, so the spam is not
    // free to the sender.
    const ipKeys: string[] = [];
    const emailKeys: string[] = [];
    const env = envWith({
      LOGIN_RATE_LIMITER: {
        limit: async (o: { key: string }) => {
          ipKeys.push(o.key);
          return { success: true };
        },
      },
      LOGIN_EMAIL_RATE_LIMITER: {
        limit: async (o: { key: string }) => {
          emailKeys.push(o.key);
          return { success: true };
        },
      },
    });
    const res = await handleLoginPassword(form("victim@trytako.com", ""), env);
    expect(res.headers.get("location")).toContain("error=missing_fields");
    expect(emailKeys).toHaveLength(0);
    expect(ipKeys).toHaveLength(1);
  });

  it("redirects back to /login with a generic code on bad credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "invalid_credentials" }), {
        status: 401,
      }),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "wrong"),
      limiterEnv(),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/login?error=invalid_credentials");
  });

  it("does not distinguish an unknown email from a wrong password", async () => {
    // Enumeration: both must produce the same code.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "email_not_found" }), {
        status: 404,
      }),
    );
    const res = await handleLoginPassword(
      form("nobody@trytako.com", "pw"),
      limiterEnv(),
    );
    expect(res.headers.get("location")).toContain("error=invalid_credentials");
  });

  it("tells a Google-signup user to use Google", async () => {
    // The one case that must NOT be collapsed: with the magic link gone, a
    // passwordless account has no other hint about how to get in.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "no_user_password" }), {
        status: 401,
      }),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "pw"),
      limiterEnv(),
    );
    expect(res.headers.get("location")).toContain("error=no_user_password");
  });

  it("surfaces a reset-required password distinctly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "reset_password" }), {
        status: 401,
      }),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "pw"),
      limiterEnv(),
    );
    expect(res.headers.get("location")).toContain("error=reset_password");
  });

  it("classifies every mapped Stytch error_type, and both default branches", async () => {
    // Table-driven so no branch of `loginErrorCode` is reachable-but-unpinned.
    // The 5xx row matters most: during a Stytch outage the page must not tell
    // every user their password is wrong.
    const cases: Array<{ errorType: string | undefined; status: number; code: string }> = [
      { errorType: "invalid_credentials", status: 401, code: "invalid_credentials" },
      { errorType: "email_not_found", status: 404, code: "invalid_credentials" },
      { errorType: "user_not_found", status: 404, code: "invalid_credentials" },
      { errorType: "password_does_not_match", status: 401, code: "invalid_credentials" },
      { errorType: "no_user_password", status: 401, code: "no_user_password" },
      { errorType: "reset_password", status: 401, code: "reset_password" },
      { errorType: "password_reset_required", status: 401, code: "reset_password" },
      // `default:` — unmapped type, credential-ish status.
      { errorType: "something_new_from_stytch", status: 401, code: "invalid_credentials" },
      { errorType: "also_unmapped", status: 404, code: "invalid_credentials" },
      // `default:` — the outage side. Ours, not theirs.
      { errorType: "internal_server_error", status: 500, code: "server_error" },
      { errorType: undefined, status: 503, code: "server_error" },
    ];
    for (const c of cases) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify(c.errorType === undefined ? {} : { error_type: c.errorType }),
          { status: c.status },
        ),
      );
      const res = await handleLoginPassword(
        form("eric@trytako.com", "pw"),
        limiterEnv(),
      );
      expect(res.status, `${c.errorType}/${c.status}`).toBe(302);
      expect(res.headers.get("location"), `${c.errorType}/${c.status}`).toContain(
        `error=${c.code}`,
      );
    }
  });

  it("allows a header-less POST but never lets it mint a session", async () => {
    // `sec-fetch-site` absent (curl, an older browser) is deliberately allowed
    // through. The limiter does NOT make that safe — it bounds volume, and a
    // forced login needs one request. What actually saves it is that
    // `tako_oauth_state` is SameSite=Lax, so a cross-site POST arrives without
    // it and `completeStytchLogin` bails BEFORE appending the session cookie.
    // That ordering is load-bearing; this pins it.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session_jwt: "stub.session.jwt",
          user: { emails: [{ email: "eric@trytako.com" }] },
        }),
        { status: 200 },
      ),
    );
    const req = new Request("https://mcp.example.com/login/password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "eric@trytako.com",
        password: "correct",
      }).toString(),
    });
    expect(req.headers.get("sec-fetch-site")).toBeNull();
    const res = await handleLoginPassword(req, limiterEnv());
    // No state cookie was sent, so no session cookie may come back.
    expect(res.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("treats a non-form body as missing fields rather than throwing", async () => {
    // `req.formData().catch(() => null)` swallows the parse failure; without a
    // test, a refactor could turn a malformed body into an unhandled rejection.
    const req = new Request("https://mcp.example.com/login/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: '{"email":"e@t.com","password":"pw"}',
    });
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleLoginPassword(req, limiterEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_fields");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a GET", async () => {
    const res = await handleLoginPassword(
      new Request("https://mcp.example.com/login/password"),
      limiterEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("never puts the password or email in the redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_type: "invalid_credentials" }), {
        status: 401,
      }),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "sup3rs3cret"),
      limiterEnv(),
    );
    const loc = res.headers.get("location")!;
    expect(loc).not.toContain("sup3rs3cret");
    expect(loc).not.toContain("eric@trytako.com");
  });

  it("rejects a missing email or password before calling Stytch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleLoginPassword(form("", ""), limiterEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_fields");
    expect(spy).not.toHaveBeenCalled();
  });

  it("mints the session cookie and resumes /authorize on success", async () => {
    // The whole point: a password login must land in exactly the same place a
    // Google login does, via the same session cookie.
    const env = limiterEnv();
    const { challenge } = await pkcePair();
    const clientId = await mintClientId(env, "https://client.example/cb");
    const stateJwt = await signJwt(
      {
        type: "state",
        client_id: clientId,
        redirect_uri: "https://client.example/cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
        scope: "mcp",
        resource: null,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SIGN_KEY,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session_jwt: "aaa.bbb.ccc",
          user: {
            user_id: "user-test-1",
            emails: [{ email: "eric@trytako.com" }],
          },
        }),
        { status: 200 },
      ),
    );
    const req = form("eric@trytako.com", "correct-password");
    req.headers.set("cookie", `${STATE_COOKIE}=${stateJwt}`);

    const res = await handleLoginPassword(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/authorize");
    // Both cookies ride on one response (session set, state cleared), so read
    // the repeated header rather than the single-value getter.
    const cookies = (res.headers as unknown as {
      getSetCookie(): string[];
    }).getSetCookie();
    expect(cookies.some((c: string) => c.startsWith(SESSION_COOKIE))).toBe(true);
    expect(cookies.some((c: string) => c.startsWith(STATE_COOKIE))).toBe(true);
  });

  it("explains the lost state cookie instead of a bare redirect loop", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session_jwt: "aaa.bbb.ccc",
          user: {
            user_id: "u",
            emails: [{ email: "eric@trytako.com" }],
          },
        }),
        { status: 200 },
      ),
    );
    const res = await handleLoginPassword(
      form("eric@trytako.com", "correct-password"),
      limiterEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    // The state cookie can now expire INSIDE a retry loop that password
    // sign-in introduced, so this page is reachable after a SUCCESSFUL login.
    // It must say the sign-in worked, name the 10-minute window, and give a way
    // forward — not just report that a request was lost.
    expect(body).toContain("signed in successfully");
    expect(body).toContain("10 minutes");
    expect(body).toContain("start the connection again");
    // And it must not imply the account is at fault.
    expect(body).not.toContain("authorization request was lost");
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

  it("accepts `mcp offline_access` (Azure AI Foundry's documented scope)", async () => {
    // Foundry's docs tell operators to include `offline_access` for auto
    // token refresh, and its troubleshooting guide names a missing
    // `offline_access` as the fix for expiring sessions. Rejecting it as
    // "unsupported" would break the managed-OAuth integration on setup.
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
    url.searchParams.set("scope", "mcp offline_access");
    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "GET",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("rejects `offline_access` alone, which would 401 later at /mcp", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const { challenge } = await pkcePair();
    const url = new URL("https://mcp.example.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "offline_access");
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "GET" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("advertises offline_access in the discovery document", () => {
    const res = handleAuthServerMetadata(
      new Request(
        "https://mcp.example.com/.well-known/oauth-authorization-server",
      ),
      envWith(),
    );
    const body = res as Response;
    return body.json().then((d) => {
      expect((d as { scopes_supported: string[] }).scopes_supported).toEqual(
        expect.arrayContaining(["mcp", "offline_access"]),
      );
    });
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
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

/* --------------------------- Resource indicators (RFC 8707) --------------------------- */

describe("OAuth resource indicators (RFC 8707)", () => {
  const ORIGIN = "https://mcp.example.com";
  const RESOURCE = `${ORIGIN}/mcp`;

  /** Decode a JWT payload (no verification — tests assert claim values). */
  function jwtPayload(token: string): Record<string, unknown> {
    const part = token.split(".")[1]!;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  }

  /** Run authorize(POST) -> token, optionally sending a `resource` param. */
  async function flowWithResource(resource: string | null): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp");
    if (resource !== null) url.searchParams.set("resource", resource);

    const authorizeRes = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
      }),
      env,
    );
    const code = new URL(authorizeRes.headers.get("location")!)
      .searchParams.get("code")!;
    const tokenRes = await handleToken(
      new Request(`${ORIGIN}/token`, {
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
    };
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  it("protected-resource metadata advertises the /mcp resource", async () => {
    const res = handleProtectedResourceMetadata(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
      envWith(),
    );
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(RESOURCE);
  });

  it("binds issued access + refresh tokens to iss (origin) and aud (resource)", async () => {
    const { accessToken, refreshToken } = await flowWithResource(RESOURCE);
    const access = jwtPayload(accessToken);
    expect(access.iss).toBe(ORIGIN);
    expect(access.aud).toBe(RESOURCE);
    const refresh = jwtPayload(refreshToken);
    expect(refresh.iss).toBe(ORIGIN);
    expect(refresh.aud).toBe(RESOURCE);
    expect(refresh.resource).toBe(RESOURCE);
  });

  it("defaults aud to the /mcp resource when the client omits `resource`", async () => {
    const { accessToken } = await flowWithResource(null);
    const access = jwtPayload(accessToken);
    expect(access.iss).toBe(ORIGIN);
    expect(access.aud).toBe(RESOURCE);
  });

  it("accepts a resource with a trailing slash / query (canonicalized)", async () => {
    const { accessToken } = await flowWithResource(`${ORIGIN}/mcp/?tools=agent`);
    expect(jwtPayload(accessToken).aud).toBe(RESOURCE);
  });

  it("accepts the bare origin as a valid resource", async () => {
    const { accessToken } = await flowWithResource(ORIGIN);
    // aud is whichever accepted form the client requested — here the origin.
    expect(jwtPayload(accessToken).aud).toBe(ORIGIN);
  });

  it("rejects a foreign resource via the redirect URI (invalid_target)", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "xyz");
    url.searchParams.set("resource", "https://evil.example/mcp");
    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
      }),
      env,
    );
    // RFC 6749 §4.1.2.1 error delivery: 302 to the registered redirect_uri.
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://client.example.com/cb");
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("state")).toBe("xyz");
  });

  it("rejects a foreign `resource` at /token (invalid_target)", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const sessionJwt = await mintSessionCookie(env);
    const { verifier, challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const authorizeRes = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionJwt}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: CONSENT_ALLOW,
      }),
      env,
    );
    const code = new URL(authorizeRes.headers.get("location")!)
      .searchParams.get("code")!;
    const tokenRes = await handleToken(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example.com/cb",
          code_verifier: verifier,
          client_id: clientId,
          resource: "https://evil.example/mcp",
        }).toString(),
      }),
      env,
    );
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe("invalid_target");
  });

  it("carries `resource` into the state cookie on the login round-trip", async () => {
    const env = envWith();
    const clientId = await mintClientId(env, "https://client.example.com/cb");
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://client.example.com/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", RESOURCE);
    // GET with no session → 302 /login, Set-Cookie state carries resource.
    const res = await handleAuthorize(new Request(url.toString()), env);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie")!;
    const stateJwt = setCookie.split(`${STATE_COOKIE}=`)[1]!.split(";")[0]!;
    expect(jwtPayload(stateJwt).resource).toBe(RESOURCE);
  });
});

/** Shared setup for the consent-decision and account-switch tests: a
 *  registered client plus a valid PKCE challenge on a fresh env. */
async function consentFixture(): Promise<{
  env: Env;
  url: URL;
  redirectUri: string;
}> {
  const env = envWith();
  const redirectUri = "https://client.example.com/cb";
  const clientId = await mintClientId(env, redirectUri);
  const { challenge } = await pkcePair();
  const url = new URL("https://mcp.example.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "client-state");
  return { env, url, redirectUri };
}

const FORM_CT = { "content-type": "application/x-www-form-urlencoded" };

describe("consent decision (RFC 6749 §4.1.2.1)", () => {
  it("delivers a denial to the client as access_denied, preserving state", async () => {
    const { env, url, redirectUri } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}`, ...FORM_CT },
        body: "action=deny",
      }),
      env,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
    // A denial must never hand back a usable code.
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("still denies without a live session, rather than 401-ing into a dead end", async () => {
    // The whole point of Cancel is that the CLIENT learns the outcome. An
    // expired cookie must not convert that into a bare error page, or the
    // host sits waiting for a callback that never arrives.
    const { env, url, redirectUri } = await consentFixture();
    const res = await handleAuthorize(
      new Request(url.toString(), { method: "POST", headers: FORM_CT, body: "action=deny" }),
      env,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects a consent POST with no action instead of implying allow", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}`, ...FORM_CT },
        body: "",
      }),
      env,
    );
    expect(res.status).toBe(400);
    // No redirect, so no code could have been issued.
    expect(res.headers.get("location")).toBeNull();
  });

  it("renders both decisions as real submits, with Allow first in DOM order", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('name="action" value="allow"');
    expect(html).toContain('name="action" value="deny"');
    // Cancel must not be a history.back() no-op any more.
    expect(html).not.toContain("history.back");
    // Enter activates the FIRST submit in tree order — that must be Allow,
    // never deny. The visual left/right order is CSS's job (row-reverse).
    expect(html.indexOf('value="allow"')).toBeLessThan(
      html.indexOf('value="deny"'),
    );
  });
});

describe("account switching via prompt=login", () => {
  it("forces re-auth and clears the session even when one is valid", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    url.searchParams.set("prompt", "login");
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    // BOTH cookies must survive onto the response: an object literal would
    // have dropped one of the two Set-Cookie headers.
    // `getSetCookie` exists on the Workers runtime but is absent from
    // workers-types, so the shape is asserted locally rather than with `any`.
    const cookies = (
      res.headers as unknown as { getSetCookie(): string[] }
    ).getSetCookie();
    expect(cookies.some((c: string) => c.startsWith(`${STATE_COOKIE}=`))).toBe(
      true,
    );
    const cleared = cookies.find(
      (c: string) =>
        c.startsWith(`${SESSION_COOKIE}=`) && c.includes("Max-Age=0"),
    );
    expect(cleared).toBeDefined();
  });

  it("does not render the consent page when prompt=login", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    url.searchParams.set("prompt", "login");
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(await res.text()).toBe("");
  });

  it("still renders consent with a valid session and no prompt (regression)", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signed in as");
  });

  it("offers a switch-account link carrying prompt=login, and keeps it off the POST", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const html = await res.text();
    const href = html.match(/href="([^"]*prompt=login[^"]*)"/)?.[1];
    expect(href).toBeDefined();
    // The link must retain the validated OAuth params, or the resumed flow
    // loses the client it was authorizing.
    expect(href).toContain("client_id=");
    expect(href).toContain("code_challenge=");
    // `prompt` is GET-only: the form action must not carry it, or Allow would
    // bounce the user back to /login instead of issuing a code.
    const formAction = html.match(/<form method="POST" action="([^"]*)"/)?.[1];
    expect(formAction).toBeDefined();
    expect(formAction).not.toContain("prompt");
  });
});

describe("consent page keeps the two decisions visually distinct", () => {
  // The regression this exists to catch: making Cancel a real submit (needed
  // to carry `action=deny`) silently swept it into the pre-existing
  // `button[type=submit]` accent rule, so BOTH buttons rendered as identical
  // filled accent buttons. The DOM-ordering test passed throughout — ordering
  // and appearance are different properties, and only one was asserted.
  //
  // String assertions rather than getComputedStyle: this suite runs in the
  // workers pool, which has no DOM. They are still specific enough to fail on
  // the exact regression.
  it("accents only Allow, never every submit", async () => {
    const { env, url } = await consentFixture();
    const sessionJwt = await mintSessionCookie(env);
    const res = await handleAuthorize(
      new Request(url.toString(), {
        headers: { cookie: `${SESSION_COOKIE}=${sessionJwt}` },
      }),
      env,
    );
    const html = await res.text();
    // The accent rule must be keyed on the decision, not on the element type.
    expect(html).toContain('button[value="allow"] { background: var(--accent)');
    // A `type=submit` accent rule would hit Cancel as well — that IS the bug.
    expect(html).not.toMatch(/button\[type=submit\][^}]*var\(--accent\)/);
    // Both remain real submits: the deny path depends on it, so a "fix" that
    // reverted Cancel to type="button" would break denial and must fail here.
    expect(html).toContain('<button type="submit" name="action" value="allow"');
    expect(html).toContain('<button type="submit" name="action" value="deny"');
  });
});
