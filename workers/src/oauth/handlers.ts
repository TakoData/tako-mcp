/**
 * HTTP handlers for the OAuth 2.1 + DCR + PKCE surface, plus the
 * Stytch-mediated login dance that backs it. Every handler is a pure
 * `(request, env) => Response` function so they're easy to wire into
 * `index.ts` and easy to unit-test in isolation.
 *
 * Flow overview:
 *
 *   Claude.ai / ChatGPT
 *      │
 *      ▼
 *   GET /authorize ──no session?──▶ set state cookie, 302 to /login
 *      │
 *      ▼
 *   GET /login ──renders Stytch UI──▶ user picks Google / magic-link
 *      │
 *      ▼
 *   Stytch (Google / email) ──redirect──▶ GET /oauth/stytch_callback
 *      │
 *      ▼
 *   /oauth/stytch_callback:
 *     1. exchange ?token for Stytch session JWT + user info
 *     2. call Tako /api/v1/api_token/ with the JWT as a Cookie header
 *     3. encrypt the Tako token, mint our own session JWT
 *     4. set `tako_oauth_session` cookie, 302 back to /authorize
 *      │
 *      ▼
 *   GET /authorize ──with session──▶ render consent page (Allow / Deny)
 *      │
 *      ▼
 *   POST /authorize ──Allow──▶ mint auth code, 302 back to client
 *      │
 *      ▼
 *   POST /token ──swap auth code for access + refresh JWTs──▶ client done
 *
 * State the Worker holds:
 *   • `tako_oauth_state` cookie  — short JWT, OAuth params across Stytch
 *   • `tako_oauth_session` cookie — short JWT, user identity + enc Tako token
 *   • Auth codes / access tokens / refresh tokens — all signed JWTs, no DB
 */

import type { Env } from "../env.js";
import {
  encryptAesGcm,
  sha256B64Url,
  signJwt,
  verifyJwt,
} from "./jwt.js";
import {
  authenticateStytchToken,
  primaryEmail,
  StytchError,
  type StytchTokenKind,
} from "./stytch.js";
import { fetchTakoApiToken, IdentityError } from "./identity.js";
import {
  buildClearCookie,
  buildSetCookie,
  readCookie,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_S,
  STATE_COOKIE,
  STATE_COOKIE_MAX_AGE_S,
} from "./cookies.js";
import type {
  AccessTokenClaims,
  AuthCodeClaims,
  ClientIdClaims,
  RefreshTokenClaims,
  SessionCookieClaims,
  StateCookieClaims,
} from "./types.js";

/* --------------------------- TTLs --------------------------- */

const ACCESS_TOKEN_TTL_S = 15 * 60;
const REFRESH_TOKEN_TTL_S = 14 * 24 * 60 * 60;
const AUTH_CODE_TTL_S = 60;

/* --------------------------- Config helpers --------------------------- */

interface OAuthConfig {
  signKey: string;
  encKey: string;
  stytch: {
    projectId: string;
    secret: string;
    publicToken: string;
    baseUrl: string;
  };
}

/**
 * Pull the OAuth config bundle out of `Env`, returning `null` if any
 * required field is missing. Every handler that touches OAuth state
 * gates on this so the Worker still serves the static-Bearer Claude
 * Code path when OAuth is intentionally disabled in an env.
 */
function readConfig(env: Env): OAuthConfig | null {
  const signKey = env.OAUTH_SIGN_KEY;
  const encKey = env.OAUTH_ENC_KEY;
  const projectId = env.STYTCH_PROJECT_ID;
  const secret = env.STYTCH_SECRET;
  const publicToken = env.STYTCH_PUBLIC_TOKEN;
  const baseUrl = env.STYTCH_BASE_URL;
  if (
    typeof signKey !== "string" ||
    signKey.length === 0 ||
    typeof encKey !== "string" ||
    encKey.length === 0 ||
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof publicToken !== "string" ||
    publicToken.length === 0 ||
    typeof baseUrl !== "string" ||
    baseUrl.length === 0
  ) {
    return null;
  }
  return {
    signKey,
    encKey,
    stytch: { projectId, secret, publicToken, baseUrl },
  };
}

function oauthDisabledResponse(): Response {
  return jsonError(
    "service_unavailable",
    "OAuth is not configured on this Worker (missing OAUTH_*/STYTCH_* secrets)",
    503,
  );
}

function jsonError(
  error: string,
  description: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function htmlResponse(
  html: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...extraHeaders,
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

/* --------------------------- Discovery --------------------------- */

export function handleProtectedResourceMetadata(req: Request): Response {
  const origin = new URL(req.url).origin;
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}

export function handleAuthServerMetadata(req: Request): Response {
  const origin = new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}

/* --------------------------- Dynamic Client Registration --------------------------- */

export async function handleRegister(
  req: Request,
  env: Env,
): Promise<Response> {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_request", "body must be JSON", 400);
  }
  if (typeof body !== "object" || body === null) {
    return jsonError("invalid_request", "body must be a JSON object", 400);
  }
  const obj = body as Record<string, unknown>;
  const redirect_uris = obj["redirect_uris"];
  if (
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0 ||
    !redirect_uris.every((u): u is string => typeof u === "string")
  ) {
    return jsonError(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of strings",
      400,
    );
  }
  const client_name =
    typeof obj["client_name"] === "string"
      ? (obj["client_name"] as string).slice(0, 200)
      : "unknown";

  const claims: ClientIdClaims = {
    type: "client_id",
    client_name,
    redirect_uris,
    iat: Math.floor(Date.now() / 1000),
  };
  const client_id = await signJwt(claims, cfg.signKey);

  return Response.json(
    {
      client_id,
      client_id_issued_at: claims.iat,
      redirect_uris,
      client_name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}

/* --------------------------- Authorize --------------------------- */

interface AuthorizeQuery {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
}

function readAuthorizeQuery(url: URL): AuthorizeQuery | string {
  const p = url.searchParams;
  const client_id = p.get("client_id");
  const redirect_uri = p.get("redirect_uri");
  const response_type = p.get("response_type");
  const code_challenge = p.get("code_challenge");
  const code_challenge_method = p.get("code_challenge_method");
  if (!client_id) return "missing client_id";
  if (!redirect_uri) return "missing redirect_uri";
  if (response_type !== "code") return "response_type must be `code`";
  if (!code_challenge) return "missing code_challenge (PKCE required)";
  if (code_challenge_method !== "S256") {
    return "code_challenge_method must be `S256`";
  }
  return {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state: p.get("state"),
    scope: p.get("scope"),
  };
}

async function clientFromClientId(
  client_id: string,
  signKey: string,
): Promise<ClientIdClaims | null> {
  const claims = await verifyJwt<ClientIdClaims>(client_id, signKey);
  if (!claims || claims.type !== "client_id") return null;
  return claims;
}

export async function handleAuthorize(
  req: Request,
  env: Env,
): Promise<Response> {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();

  const url = new URL(req.url);
  const parsed = readAuthorizeQuery(url);
  if (typeof parsed === "string") {
    return new Response(parsed, { status: 400 });
  }
  const client = await clientFromClientId(parsed.client_id, cfg.signKey);
  if (!client) {
    return new Response("invalid_client", { status: 401 });
  }
  if (!client.redirect_uris.includes(parsed.redirect_uri)) {
    return new Response("redirect_uri not registered for this client_id", {
      status: 400,
    });
  }

  // Fetch the user's session, if any. We accept it on either GET
  // (rendering consent) or POST (issuing the auth code).
  const sessionRaw = readCookie(req, SESSION_COOKIE);
  const session =
    sessionRaw === null
      ? null
      : await verifyJwt<SessionCookieClaims>(sessionRaw, cfg.signKey);
  const sessionValid = session !== null && session.type === "session";

  if (req.method === "GET") {
    if (!sessionValid) {
      // Stash original OAuth params in a state cookie so /oauth/stytch_callback
      // can resume the flow after the Stytch round-trip. Then bounce to /login.
      const stateClaims: StateCookieClaims = {
        type: "state",
        client_id: parsed.client_id,
        redirect_uri: parsed.redirect_uri,
        response_type: parsed.response_type,
        code_challenge: parsed.code_challenge,
        code_challenge_method: parsed.code_challenge_method,
        state: parsed.state,
        scope: parsed.scope,
        exp: Math.floor(Date.now() / 1000) + STATE_COOKIE_MAX_AGE_S,
      };
      const stateJwt = await signJwt(stateClaims, cfg.signKey);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/login",
          "set-cookie": buildSetCookie(STATE_COOKIE, stateJwt, {
            maxAgeSeconds: STATE_COOKIE_MAX_AGE_S,
          }),
        },
      });
    }
    // Already authenticated — render the consent page.
    return htmlResponse(
      consentPage({
        clientName: client.client_name,
        userEmail: session!.user_email,
        formAction: url.pathname + url.search,
      }),
    );
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // POST = user clicked Allow. Must have a valid session — otherwise
  // someone is replaying the form across an expired cookie.
  if (!sessionValid) {
    return new Response(
      "session expired — restart the connect flow from your client",
      { status: 401 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const codeClaims: AuthCodeClaims = {
    type: "auth_code",
    client_id: parsed.client_id,
    redirect_uri: parsed.redirect_uri,
    code_challenge: parsed.code_challenge,
    scope: parsed.scope ?? "mcp",
    user_id: session!.user_id,
    user_email: session!.user_email,
    enc_tako_token: session!.enc_tako_token,
    exp: now + AUTH_CODE_TTL_S,
  };
  const code = await signJwt(codeClaims, cfg.signKey);

  const redirect = new URL(parsed.redirect_uri);
  redirect.searchParams.set("code", code);
  if (parsed.state !== null) redirect.searchParams.set("state", parsed.state);
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString() },
  });
}

function consentPage(args: {
  clientName: string;
  userEmail: string;
  formAction: string;
}): string {
  const safeName = escapeHtml(args.clientName);
  const safeEmail = escapeHtml(args.userEmail);
  const safeAction = escapeHtml(args.formAction);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — Tako</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #555; --border: #ddd; --accent: #111; --on-accent: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f5f5f5; --bg: #0b0b0b; --muted: #aaa; --border: #2a2a2a; --accent: #fff; --on-accent: #111; }
  }
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; margin: 0; padding: 3rem 1.5rem; max-width: 28rem; margin-inline: auto; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  p { color: var(--muted); line-height: 1.55; }
  .who { display: flex; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: 0.5rem; margin-top: 1.25rem; font-size: 0.9rem; }
  .who-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #2da44e; }
  form { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  button { flex: 1; padding: 0.75rem 1rem; font-size: 1rem; font-weight: 500; border-radius: 0.5rem; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  button[type=submit] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  button:hover { opacity: 0.85; }
</style>
</head>
<body>
<h1>Connect ${safeName} to Tako</h1>
<p>${safeName} is requesting access to your Tako account. Approving will let it call the Tako MCP server on your behalf.</p>
<div class="who"><span class="who-dot"></span> Signed in as <strong>${safeEmail}</strong></div>
<form method="POST" action="${safeAction}">
  <button type="button" onclick="window.history.back()">Cancel</button>
  <button type="submit">Allow</button>
</form>
</body>
</html>`;
}

/* --------------------------- Token --------------------------- */

export async function handleToken(req: Request, env: Env): Promise<Response> {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return jsonError(
      "invalid_request",
      "content-type must be application/x-www-form-urlencoded",
      400,
    );
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return jsonError("invalid_request", "could not parse form body", 400);
  }

  const grant_type = params.get("grant_type");
  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(params, cfg);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshGrant(params, cfg);
  }
  return jsonError(
    "unsupported_grant_type",
    `grant_type \`${grant_type}\` is not supported`,
    400,
  );
}

async function handleAuthorizationCodeGrant(
  params: URLSearchParams,
  cfg: OAuthConfig,
): Promise<Response> {
  const code = params.get("code");
  const redirect_uri = params.get("redirect_uri");
  const code_verifier = params.get("code_verifier");
  if (!code || !redirect_uri || !code_verifier) {
    return jsonError(
      "invalid_request",
      "code, redirect_uri, code_verifier are required",
      400,
    );
  }
  const claims = await verifyJwt<AuthCodeClaims>(code, cfg.signKey);
  if (!claims || claims.type !== "auth_code") {
    return jsonError("invalid_grant", "auth code is invalid or expired", 400);
  }
  if (claims.redirect_uri !== redirect_uri) {
    return jsonError(
      "invalid_grant",
      "redirect_uri does not match authorization request",
      400,
    );
  }
  const expectedChallenge = await sha256B64Url(code_verifier);
  if (claims.code_challenge !== expectedChallenge) {
    return jsonError("invalid_grant", "PKCE verifier does not match", 400);
  }
  return issueTokens(
    {
      scope: claims.scope,
      user_id: claims.user_id,
      user_email: claims.user_email,
      enc_tako_token: claims.enc_tako_token,
    },
    cfg,
  );
}

async function handleRefreshGrant(
  params: URLSearchParams,
  cfg: OAuthConfig,
): Promise<Response> {
  const refresh_token = params.get("refresh_token");
  if (!refresh_token) {
    return jsonError("invalid_request", "refresh_token is required", 400);
  }
  const claims = await verifyJwt<RefreshTokenClaims>(refresh_token, cfg.signKey);
  if (!claims || claims.type !== "refresh") {
    return jsonError(
      "invalid_grant",
      "refresh token is invalid or expired",
      400,
    );
  }
  return issueTokens(
    {
      scope: claims.scope,
      user_id: claims.user_id,
      user_email: claims.user_email,
      enc_tako_token: claims.enc_tako_token,
    },
    cfg,
  );
}

interface IdentityForToken {
  scope: string;
  user_id: string;
  user_email: string;
  enc_tako_token: string;
}

async function issueTokens(
  identity: IdentityForToken,
  cfg: OAuthConfig,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const accessClaims: AccessTokenClaims = {
    type: "access",
    scope: identity.scope,
    user_id: identity.user_id,
    user_email: identity.user_email,
    enc_tako_token: identity.enc_tako_token,
    exp: now + ACCESS_TOKEN_TTL_S,
  };
  const refreshClaims: RefreshTokenClaims = {
    type: "refresh",
    scope: identity.scope,
    user_id: identity.user_id,
    user_email: identity.user_email,
    enc_tako_token: identity.enc_tako_token,
    exp: now + REFRESH_TOKEN_TTL_S,
  };
  const access_token = await signJwt(accessClaims, cfg.signKey);
  const refresh_token = await signJwt(refreshClaims, cfg.signKey);
  return Response.json({
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token,
    scope: identity.scope,
  });
}

/* --------------------------- Login --------------------------- */

/**
 * Render the login page. The page is a static HTML document that
 * embeds Stytch's vanilla-js SDK over CDN, configures it with the
 * `STYTCH_PUBLIC_TOKEN`, and offers Sign-in-with-Google + email
 * magic-link entry points.
 *
 * On successful authentication Stytch will redirect the user to the
 * URL we pass as `login_redirect_url`, with a `?token=...` query and
 * a `&stytch_token_type=oauth|magic_links` discriminator. We point
 * that at our `/oauth/stytch_callback` endpoint.
 */
export function handleLogin(req: Request, env: Env): Response {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const origin = new URL(req.url).origin;
  const callbackUrl = `${origin}/oauth/stytch_callback`;
  return htmlResponse(loginPage(cfg.stytch.publicToken, callbackUrl));
}

function loginPage(stytchPublicToken: string, callbackUrl: string): string {
  // The Stytch SDK is loaded over their CDN; the `data-stytch-public-token`
  // and `callbackUrl` constants below are the only Worker-side data the
  // page needs. Keep this page minimal — its only job is to drive Stytch
  // to redirect to /oauth/stytch_callback.
  const safeToken = escapeHtml(stytchPublicToken);
  const safeCallback = escapeHtml(callbackUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Tako</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #555; --border: #ddd; --accent: #111; --on-accent: #fff; --error: #c1121f; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f5f5f5; --bg: #0b0b0b; --muted: #aaa; --border: #2a2a2a; --accent: #fff; --on-accent: #111; --error: #ff6b6b; }
  }
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; margin: 0; padding: 3rem 1.5rem; max-width: 24rem; margin-inline: auto; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p { color: var(--muted); margin: 0 0 1.5rem; line-height: 1.55; }
  button { width: 100%; padding: 0.75rem 1rem; font-size: 1rem; font-weight: 500; border-radius: 0.5rem; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  button:hover { opacity: 0.85; }
  .row { margin-bottom: 0.75rem; }
  .or { text-align: center; color: var(--muted); margin: 1rem 0; font-size: 0.9rem; }
  input[type=email] { width: 100%; padding: 0.7rem 0.9rem; font-size: 1rem; border-radius: 0.5rem; border: 1px solid var(--border); background: transparent; color: var(--fg); box-sizing: border-box; margin-bottom: 0.5rem; }
  .err { color: var(--error); font-size: 0.85rem; min-height: 1.2rem; margin-top: 0.5rem; }
</style>
</head>
<body>
<h1>Sign in to Tako</h1>
<p>Use your Tako account to authorize this connection.</p>
<div class="row">
  <button class="primary" id="google">Continue with Google</button>
</div>
<div class="or">or</div>
<form id="magic">
  <input type="email" name="email" placeholder="you@example.com" required autocomplete="email">
  <button type="submit">Email me a sign-in link</button>
</form>
<div class="err" id="err"></div>

<script src="https://js.stytch.com/stytch.js"></script>
<script>
  (function() {
    var publicToken = ${JSON.stringify(safeToken)};
    var callbackUrl = ${JSON.stringify(safeCallback)};
    var errEl = document.getElementById("err");
    function showError(msg) { errEl.textContent = msg || ""; }

    var client;
    try {
      client = Stytch(publicToken);
    } catch (e) {
      showError("Could not initialize Stytch: " + (e && e.message ? e.message : e));
      return;
    }

    document.getElementById("google").addEventListener("click", function() {
      showError("");
      try {
        client.oauth.google.start({
          login_redirect_url: callbackUrl,
          signup_redirect_url: callbackUrl
        });
      } catch (e) {
        showError("Google sign-in failed to start: " + (e && e.message ? e.message : e));
      }
    });

    document.getElementById("magic").addEventListener("submit", function(ev) {
      ev.preventDefault();
      showError("");
      var email = ev.target.email.value.trim();
      if (!email) { showError("Enter an email address."); return; }
      client.magicLinks.email.loginOrCreate(email, {
        login_magic_link_url: callbackUrl,
        signup_magic_link_url: callbackUrl
      }).then(function() {
        ev.target.innerHTML = "<p>Check your email for a sign-in link.</p>";
      }).catch(function(e) {
        showError("Could not send magic link: " + (e && e.message ? e.message : e));
      });
    });
  })();
</script>
</body>
</html>`;
}

/* --------------------------- Stytch callback --------------------------- */

export async function handleStytchCallback(
  req: Request,
  env: Env,
): Promise<Response> {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const tokenType = url.searchParams.get("stytch_token_type");
  if (!token) {
    return errorPage(400, "Stytch did not return a token in the redirect.");
  }
  let kind: StytchTokenKind;
  if (tokenType === "oauth") kind = "oauth";
  else if (tokenType === "magic_links") kind = "magic_links";
  else {
    return errorPage(
      400,
      `Unsupported stytch_token_type: ${tokenType ?? "(missing)"}`,
    );
  }

  // Step 1 — exchange Stytch's redirect-token for a session JWT + user info.
  let stytchResult;
  try {
    stytchResult = await authenticateStytchToken(cfg.stytch, token, kind);
  } catch (err) {
    if (err instanceof StytchError) {
      console.error("Stytch authenticate failed:", err.message, err.errorType);
      return errorPage(
        502,
        `Stytch authentication failed (${err.errorType ?? err.status}). ` +
          "Please try signing in again.",
      );
    }
    throw err;
  }

  // Step 2 — fetch the user's Tako API token using their freshly-minted
  // Stytch session JWT. This is server-to-server, the JWT travels in a
  // Cookie header (see identity.ts).
  let takoToken: string;
  try {
    takoToken = await fetchTakoApiToken(env, stytchResult.session_jwt);
  } catch (err) {
    if (err instanceof IdentityError) {
      if (err.kind === "no_token") {
        return errorPage(
          400,
          "Your Tako account does not have an API token yet. " +
            "Visit trytako.com → settings → API tokens to mint one, " +
            "then retry the connection.",
        );
      }
      if (err.kind === "unauthorized") {
        return errorPage(
          502,
          "Tako rejected the Stytch session. This usually means the " +
            "Stytch project on the Worker doesn't match Tako's project. " +
            "Contact support.",
        );
      }
      console.error("Tako identity lookup failed:", err.kind, err.message);
      return errorPage(
        502,
        "Could not retrieve your Tako API token. Please try again.",
      );
    }
    throw err;
  }

  // Step 3 — encrypt the Tako token (so it can travel in our session
  // cookie + future OAuth tokens) and mint our own session JWT.
  const enc_tako_token = await encryptAesGcm(takoToken, cfg.encKey);
  const userEmail = primaryEmail(stytchResult.user);
  const sessionClaims: SessionCookieClaims = {
    type: "session",
    user_id: stytchResult.user.user_id,
    user_email: userEmail,
    enc_tako_token,
    exp: Math.floor(Date.now() / 1000) + SESSION_COOKIE_MAX_AGE_S,
  };
  const sessionJwt = await signJwt(sessionClaims, cfg.signKey);

  // Step 4 — read the tako_oauth_state cookie, which carries the
  // original OAuth params Claude.ai sent to /authorize. If absent
  // we have no idea where to send the user; surface a friendly error.
  const stateRaw = readCookie(req, STATE_COOKIE);
  if (stateRaw === null) {
    return errorPage(
      400,
      "Login completed, but the original authorization request was lost " +
        "(missing state cookie). Please restart the connect flow from " +
        "your client.",
    );
  }
  const stateClaims = await verifyJwt<StateCookieClaims>(stateRaw, cfg.signKey);
  if (!stateClaims || stateClaims.type !== "state") {
    return errorPage(
      400,
      "Login completed, but the original authorization request expired " +
        "or was tampered with. Please restart the connect flow from your client.",
    );
  }

  // Step 5 — rebuild the /authorize URL from the state claims and
  // redirect there. The session cookie will be picked up automatically
  // and /authorize will render the consent page with the user's email.
  const authorizeUrl = new URL("/authorize", url.origin);
  authorizeUrl.searchParams.set("client_id", stateClaims.client_id);
  authorizeUrl.searchParams.set("redirect_uri", stateClaims.redirect_uri);
  authorizeUrl.searchParams.set("response_type", stateClaims.response_type);
  authorizeUrl.searchParams.set("code_challenge", stateClaims.code_challenge);
  authorizeUrl.searchParams.set(
    "code_challenge_method",
    stateClaims.code_challenge_method,
  );
  if (stateClaims.state !== null)
    authorizeUrl.searchParams.set("state", stateClaims.state);
  if (stateClaims.scope !== null)
    authorizeUrl.searchParams.set("scope", stateClaims.scope);

  // Multiple Set-Cookie headers — modern Workers fetch API handles this
  // by accepting a Headers instance with repeated entries (single string
  // separated by `, ` would not work for cookies whose values contain
  // commas, which JWTs don't but cookies-with-Date attributes do).
  const headers = new Headers({ location: authorizeUrl.toString() });
  headers.append(
    "set-cookie",
    buildSetCookie(SESSION_COOKIE, sessionJwt, {
      maxAgeSeconds: SESSION_COOKIE_MAX_AGE_S,
    }),
  );
  // Clear the state cookie — it served its purpose.
  headers.append("set-cookie", buildClearCookie(STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

function errorPage(status: number, message: string): Response {
  // Use simple HTML rather than JSON because the user is in a browser
  // tab during the OAuth dance. They need a readable message, not a
  // machine-parseable error.
  const safe = escapeHtml(message);
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tako — sign-in error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:3rem 1.5rem;max-width:32rem;margin-inline:auto;color-scheme:light dark}
h1{font-size:1.3rem;margin:0 0 0.5rem}p{line-height:1.55;color:#555}@media(prefers-color-scheme:dark){body{background:#0b0b0b;color:#f5f5f5}p{color:#aaa}}</style>
</head><body><h1>Couldn't complete sign-in</h1><p>${safe}</p></body></html>`,
    status,
  );
}
