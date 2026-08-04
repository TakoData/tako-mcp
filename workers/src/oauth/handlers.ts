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
 *   GET /login ──renders sign-in UI──▶ user picks Google, or posts a password
 *      │                                          │
 *      │                            POST /login/password ──▶ Stytch passwords
 *      │                                          │            authenticate
 *      ▼                                          │
 *   Stytch (Google) ──redirect──▶ GET /oauth/stytch_callback
 *      │                                          │
 *      └──────────────▶ completeStytchLogin ◀──────┘
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

import { type Env, resolvePublicBase } from "../env.js";
import {
  decryptAesGcm,
  encryptAesGcm,
  sha256B64Url,
  signJwt,
  verifyJwt,
} from "./jwt.js";
import {
  authenticateStytchPassword,
  authenticateStytchToken,
  primaryEmail,
  StytchError,
  type StytchTokenKind,
} from "./stytch.js";
import type { StytchAuthenticateResult } from "./types.js";
import {
  IdentityError,
  mintTakoApiKey,
} from "./identity.js";
import {
  buildClearCookie,
  buildSetCookie,
  readCookie,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_S,
  STATE_COOKIE,
  STATE_COOKIE_MAX_AGE_S,
} from "./cookies.js";
import {
  canonicalizeResource,
  isServerResource,
  serverIssuer,
  serverResource,
} from "./resource.js";
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
/** DCR registrations expire after a year. Without expiry the only way
 *  to invalidate an abandoned client is to rotate `OAUTH_SIGN_KEY`,
 *  which nukes every registration at once. A 1-year TTL means a
 *  long-running connector re-registers periodically (Claude.ai/ChatGPT
 *  do this automatically on first use after expiry) while leaked /
 *  abandoned client_ids age out. */
const REGISTRATION_TTL_S = 365 * 24 * 60 * 60;
/** Scopes we advertise in the discovery doc. Any scope value not on
 *  this list is rejected at /authorize so we don't echo unexpected
 *  values into issued tokens. Keep in sync with the
 *  `scopes_supported` field in `handleAuthServerMetadata`. */
const SUPPORTED_SCOPES = new Set(["mcp"]);

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
  // RFC 6749 §5.2 — `temporarily_unavailable` is the spec-conformant
  // value when the authorization server is configured but cannot
  // service requests. Used here for "OAuth subsystem disabled in this
  // env" too, since that's the closest match in the standard set.
  return jsonError(
    "temporarily_unavailable",
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
      // Clickjacking defense: every HTML page we serve carries
      // user-identifying or grant-authorizing UI. Framing them in a
      // hostile parent enables click-jacked consent. `frame-ancestors
      // 'none'` (CSP) plus the legacy `X-Frame-Options: DENY` covers
      // both modern and old browsers.
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      // Prevent intermediate caches from storing pages that embed
      // `user_email` (consent) or any auth-flow artifact. Belt-and-
      // suspenders Pragma covers ancient HTTP/1.0 caches.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      pragma: "no-cache",
      // MIME-sniffing defense — ensures browsers never reinterpret
      // these HTML responses as another type.
      "x-content-type-options": "nosniff",
      // Don't leak the full URL (which carries OAuth params + cookies)
      // when users click out from /login or /authorize.
      "referrer-policy": "no-referrer",
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

/**
 * RFC 6749 §4.1.2.1 — deliver an authorization error to the client via its
 * (already-validated) redirect URI as a 302, preserving `state`. Used for
 * `invalid_target` so the connector sees a structured OAuth error rather than
 * a bare page it can't parse.
 */
function redirectAuthError(
  redirectUri: string,
  state: string | null,
  error: string,
  errorDescription: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", errorDescription);
  if (state !== null) u.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { location: u.toString() },
  });
}

/* --------------------------- Discovery --------------------------- */

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Gated on OAuth configuration: when the secrets are unset the Worker
 * should not advertise an OAuth surface, since following discovery would
 * just take the client to a 503 from /register. Returning 404 lets
 * clients fall back cleanly to static-Bearer mode.
 */
export function handleProtectedResourceMetadata(
  req: Request,
  env: Env,
): Response {
  if (readConfig(env) === null) {
    return new Response("not found", { status: 404 });
  }
  return Response.json({
    // The MCP endpoint URL is the canonical resource identifier (RFC 8707).
    // Issued tokens are audienced to this value and `/mcp` validates it.
    resource: serverResource(req),
    authorization_servers: [serverIssuer(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SUPPORTED_SCOPES],
  });
}

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * Same env-gating rationale as the protected-resource metadata above.
 */
export function handleAuthServerMetadata(
  req: Request,
  env: Env,
): Response {
  if (readConfig(env) === null) {
    return new Response("not found", { status: 404 });
  }
  const origin = new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients (PKCE, no secret) — the only auth method we
    // actually accept at /token. ChatGPT uses PKCE per their published
    // guidance, Claude.ai uses PKCE, the MCP spec uses PKCE.
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
  });
}

/**
 * RFC 7009 OAuth 2.0 Token Revocation — stub endpoint.
 *
 * Our access + refresh tokens are stateless JWTs, so there is no
 * server-side state to invalidate; revocation is genuinely a no-op
 * unless we add a deny list. RFC 7009 §2.2 explicitly allows: "Note:
 * invalid tokens do not cause an error response since the client
 * cannot handle such an error in a reasonable way." So returning 200
 * regardless of the token's validity is spec-compliant.
 *
 * Why advertise it at all: ChatGPT's App Review classifier rejects
 * metadata it labels as "unsupported OAuth config type"; a richer,
 * more conventional discovery doc (with `revocation_endpoint`) helps
 * us look like the OAuth servers their classifier already accepts.
 */
export function handleRevoke(req: Request, env: Env): Response {
  if (readConfig(env) === null) {
    return new Response("not found", { status: 404 });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  return new Response(null, { status: 200 });
}

/* --------------------------- Dynamic Client Registration --------------------------- */

/**
 * `/register` is intentionally unauthenticated, per RFC 7591 conventions
 * for public-client DCR. Cloudflare WAF / rate-limit rules in front of
 * the Worker are expected to bound abuse — every registration is a small
 * HMAC sign + JSON response, but a sustained flood would still burn CPU.
 * Document the assumption in infra; don't add app-level rate limiting
 * here unless we observe abuse.
 */

/** Cap registration body size to keep the resulting `client_id` JWT
 *  (which echoes the redirect_uris and client_name) from blowing past
 *  reasonable HTTP header limits. 4 KB is comfortably above any sane
 *  consumer-host registration. */
const REGISTER_MAX_BODY_BYTES = 4 * 1024;
/** Limit on a single redirect_uri so a malicious registration can't
 *  bake an enormous URL into every signed `client_id`. */
const REDIRECT_URI_MAX_LEN = 2048;
/** Reject control characters in `client_name` to prevent log-line
 *  injection / display corruption when we echo the name back on the
 *  consent page. The `\x00-\x1f\x7f` range covers ASCII control codes. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

function isValidRedirectUri(s: string): boolean {
  if (s.length === 0 || s.length > REDIRECT_URI_MAX_LEN) return false;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  // Only http/https. Reject `javascript:`, `data:`, `file:`, `vbscript:`
  // etc. — even though redirect_uris are looked up against the registered
  // list before being used, this is a defense-in-depth check at the
  // entry point so a malicious `/register` can't seed the system with
  // exotic-scheme URIs that some downstream code path might honor.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  // `http:` only for `localhost` (and `127.0.0.1`) — production OAuth
  // clients must use https. Any non-loopback `http:` redirect_uri is a
  // strong signal of either misconfiguration or attack.
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return false;
  }
  return true;
}

export async function handleRegister(
  req: Request,
  env: Env,
): Promise<Response> {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  // Read at most REGISTER_MAX_BODY_BYTES of body. Anything larger gets
  // rejected before we try to parse it — a 100 MB JSON blob would
  // otherwise pin a Worker until the body finishes streaming.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return jsonError("invalid_request", "could not read request body", 400);
  }
  if (bodyText.length > REGISTER_MAX_BODY_BYTES) {
    return jsonError(
      "invalid_request",
      `body too large (max ${REGISTER_MAX_BODY_BYTES} bytes)`,
      413,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
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
  if (!redirect_uris.every(isValidRedirectUri)) {
    return jsonError(
      "invalid_redirect_uri",
      "every redirect_uri must be a valid https URL (http only allowed for localhost)",
      400,
    );
  }
  const rawName =
    typeof obj["client_name"] === "string"
      ? (obj["client_name"] as string)
      : "unknown";
  if (CONTROL_CHARS_RE.test(rawName)) {
    return jsonError(
      "invalid_request",
      "client_name must not contain control characters",
      400,
    );
  }
  const client_name = rawName.slice(0, 200);

  const now = Math.floor(Date.now() / 1000);
  const claims: ClientIdClaims = {
    type: "client_id",
    client_name,
    redirect_uris,
    iat: now,
    exp: now + REGISTRATION_TTL_S,
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
  /** RFC 8707 resource, RAW (uncanonicalized) or null. Validated in
   *  `handleAuthorize` after client validation. */
  resourceRaw: string | null;
  /** OIDC Core §3.1.2.1 `prompt`. Only `login` is acted on: it forces a
   *  fresh sign-in even when a session cookie is present, which is what
   *  the consent page's "different account" link uses. Any other value
   *  (including `none`) is carried but ignored — see the note in
   *  `handleAuthorize`. */
  prompt: string | null;
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
  // Validate `scope`: only values in SUPPORTED_SCOPES are accepted.
  // Empty / null defaults to "mcp" downstream. This fails-closed instead
  // of silently echoing unknown scope strings into issued tokens — which
  // matters once any downstream system starts gating behavior on scope.
  // Normalize `?scope=` (present but empty) to null so the downstream
  // `?? "mcp"` default applies consistently — `??` doesn't trigger on "".
  const scope = p.get("scope") || null;
  if (scope !== null) {
    const requested = scope.split(/\s+/).filter((s) => s.length > 0);
    if (!requested.every((s) => SUPPORTED_SCOPES.has(s))) {
      return `scope contains unsupported values; supported: ${[...SUPPORTED_SCOPES].join(", ")}`;
    }
  }
  // RFC 8707 resource indicator is carried RAW here; it is canonicalized and
  // validated in `handleAuthorize` AFTER client + redirect_uri validation, so
  // an `invalid_target` can be delivered to the client via the redirect URI
  // (RFC 6749 §4.1.2.1) rather than a bare 400 page.
  return {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state: p.get("state"),
    scope,
    resourceRaw: p.get("resource"),
    // Normalize `?prompt=` (present but empty) to null, matching `scope`.
    prompt: p.get("prompt") || null,
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

  // RFC 8707 resource: canonicalize and validate now that the redirect_uri is
  // known-registered. This server accepts either the bare origin or the `/mcp`
  // endpoint (see `isServerResource`). Any other value is `invalid_target`,
  // delivered to the client via the redirect URI per RFC 6749 §4.1.2.1 rather
  // than a bare page. Omitted is allowed (token audienced to `/mcp` by default).
  let resource: string | null = null;
  if (parsed.resourceRaw !== null) {
    const canonical = canonicalizeResource(parsed.resourceRaw);
    if (canonical === null || !isServerResource(canonical, url.origin)) {
      return redirectAuthError(
        parsed.redirect_uri,
        parsed.state,
        "invalid_target",
        `unknown resource; this server is ${url.origin}/mcp`,
      );
    }
    resource = canonical;
  }

  // Fetch the user's session, if any. We accept it on either GET
  // (rendering consent) or POST (issuing the auth code).
  const sessionRaw = readCookie(req, SESSION_COOKIE);
  const session =
    sessionRaw === null
      ? null
      : await verifyJwt<SessionCookieClaims>(sessionRaw, cfg.signKey);
  const sessionValid = session !== null && session.type === "session";

  // `prompt=login` (OIDC Core §3.1.2.1) forces a fresh sign-in even when a
  // session cookie is present. The consent page's "different account" link
  // sets it, and any client that sends it gets the standard behavior for
  // free. `prompt=none` is deliberately NOT honored: doing it properly means
  // returning `login_required` via the redirect URI rather than rendering
  // anything, and no host sends it today — treating it as "ignore" keeps the
  // unauthenticated path the same as before rather than half-implementing it.
  const forceLogin = parsed.prompt === "login";

  if (req.method === "GET") {
    if (!sessionValid || forceLogin) {
      // Stash original OAuth params in a state cookie so /oauth/stytch_callback
      // can resume the flow after the Stytch round-trip. Then bounce to /login.
      //
      // KNOWN GAP (TAKO-2679 follow-up): the cookie's only binding to the
      // user-agent is the cookie itself (HttpOnly + Secure + SameSite=Lax,
      // which prevents network attackers from reading or planting it under
      // HTTPS). RFC 9700 (OAuth 2.0 Security BCP) recommends a nonce
      // round-tripped via Stytch's `state` parameter for belt-and-suspenders
      // session-fixation defense. Defer to the OAuth-hardening follow-up
      // ticket; the cookie alone is adequate for the threat model where
      // an attacker has neither XSS on mcp.tako.com nor an active MITM.
      const stateClaims: StateCookieClaims = {
        type: "state",
        client_id: parsed.client_id,
        redirect_uri: parsed.redirect_uri,
        response_type: parsed.response_type,
        code_challenge: parsed.code_challenge,
        code_challenge_method: parsed.code_challenge_method,
        state: parsed.state,
        scope: parsed.scope,
        resource,
        exp: Math.floor(Date.now() / 1000) + STATE_COOKIE_MAX_AGE_S,
      };
      const stateJwt = await signJwt(stateClaims, cfg.signKey);
      // A `Headers` instance, not an object literal: `forceLogin` needs TWO
      // `Set-Cookie` headers, and an object literal can only carry one (the
      // second silently overwrites the first).
      const headers = new Headers({ location: "/login" });
      headers.append(
        "set-cookie",
        buildSetCookie(STATE_COOKIE, stateJwt, {
          maxAgeSeconds: STATE_COOKIE_MAX_AGE_S,
        }),
      );
      if (forceLogin) {
        // Drop our own session so `/login` is a real re-authentication rather
        // than a bounce straight back into consent as the same user. This is
        // host-scoped by construction (`buildSetCookie` sets no `Domain`), so
        // it signs the user out of this Worker only — not trytako.com and not
        // Google. On the email path they can enter a different address; the
        // Stytch Google button may still re-select the same account.
        headers.append("set-cookie", buildClearCookie(SESSION_COOKIE));
      }
      return new Response(null, { status: 302, headers });
    }
    // Already authenticated — render the consent page.
    // Rebuild the form-action URL deterministically from validated
    // params instead of echoing `url.search` back into HTML. Echoing
    // the raw search string would mean an attacker-supplied unknown
    // query param survives into the form post; rebuilding gates the
    // round-trip on values we already validated.
    const formActionUrl = new URL(url.pathname, url.origin);
    formActionUrl.searchParams.set("client_id", parsed.client_id);
    formActionUrl.searchParams.set("redirect_uri", parsed.redirect_uri);
    formActionUrl.searchParams.set("response_type", parsed.response_type);
    formActionUrl.searchParams.set("code_challenge", parsed.code_challenge);
    formActionUrl.searchParams.set(
      "code_challenge_method",
      parsed.code_challenge_method,
    );
    if (parsed.state !== null) formActionUrl.searchParams.set("state", parsed.state);
    if (parsed.scope !== null) formActionUrl.searchParams.set("scope", parsed.scope);
    if (resource !== null) formActionUrl.searchParams.set("resource", resource);
    // Same validated params plus `prompt=login`, so "different account"
    // re-enters this handler and takes the forceLogin branch above. `prompt`
    // is deliberately absent from `formActionUrl`: it is a GET-only concern
    // and the POST must not carry it.
    const switchAccountUrl = new URL(formActionUrl);
    switchAccountUrl.searchParams.set("prompt", "login");
    return htmlResponse(
      consentPage({
        clientName: client.client_name,
        userEmail: session!.user_email,
        formAction: formActionUrl.pathname + formActionUrl.search,
        switchAccountHref:
          switchAccountUrl.pathname + switchAccountUrl.search,
      }),
    );
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Which button was pressed. The POST carries its OAuth params in the query
  // string, so the body is still unread here and this is its only consumer.
  let action: string | null = null;
  const consentCt = req.headers.get("content-type") ?? "";
  if (consentCt.includes("application/x-www-form-urlencoded")) {
    try {
      action = new URLSearchParams(await req.text()).get("action");
    } catch {
      return new Response("could not parse consent form body", { status: 400 });
    }
  }

  // Refusal is delivered to the client via the redirect URI (RFC 6749
  // §4.1.2.1), never as a bare page — otherwise the client sits waiting for a
  // callback that never arrives. Deliberately ABOVE the session check:
  // `redirect_uri` is already known-registered, so a denial needs no live
  // session, and an expired cookie must not turn Cancel into a 401 dead end.
  if (action === "deny") {
    return redirectAuthError(
      parsed.redirect_uri,
      parsed.state,
      "access_denied",
      "the user declined the authorization request",
    );
  }
  // Anything other than an explicit `allow` is rejected. A missing field must
  // never read as consent.
  if (action !== "allow") {
    return new Response("missing or unknown consent action", { status: 400 });
  }

  // POST = user clicked Allow. Must have a valid session — otherwise
  // someone is replaying the form across an expired cookie.
  if (!sessionValid) {
    return new Response(
      "session expired — restart the connect flow from your client",
      { status: 401 },
    );
  }

  // Re-fetch the Tako API token at consent time so token rotations on
  // trytako.com are always reflected in newly-issued OAuth grants. The
  // session cookie carries an encrypted Stytch session JWT (not a cached
  // Tako token), so we decrypt it, present it to Tako, and use whatever
  // current token Tako returns.
  const stytchSessionJwt = await decryptAesGcm(
    session!.enc_stytch_session_jwt,
    cfg.encKey,
  );
  if (stytchSessionJwt === null) {
    // Cookie was tampered, OAUTH_ENC_KEY rotated, or otherwise unreadable.
    // Force the user back through /login for a fresh Stytch round-trip.
    return htmlResponse(
      sessionExpiredPage(
        "Your session is no longer valid. Please sign in again.",
      ),
      401,
      { "set-cookie": buildClearCookie(SESSION_COOKIE) },
    );
  }
  let takoToken: string;
  try {
    takoToken = await mintTakoApiKey(env, stytchSessionJwt, client.client_name);
  } catch (err) {
    if (err instanceof IdentityError) {
      if (err.kind === "at_cap") {
        return htmlResponse(
          sessionExpiredPage(
            "You have too many active Tako API keys. Revoke one at " +
              "trytako.com → settings → API tokens, then retry the connection.",
          ),
          400,
        );
      }
      if (err.kind === "unauthorized") {
        // Stytch session was revoked or expired — force re-login by
        // clearing the now-useless session cookie.
        //
        // Log it: a 401/403 here is ALSO what a Worker↔Django misconfiguration
        // looks like (TAKO-3754 — the Worker sent the wrong session-cookie
        // NAME to staging, so Django saw no cookie and 403'd). Without this
        // line the two are indistinguishable and a config break masquerades
        // as a user's expired sign-in with nothing in `wrangler tail`.
        console.error(
          "Tako rejected the Stytch session at /authorize POST:",
          err.status,
          err.message,
        );
        return htmlResponse(
          sessionExpiredPage(
            "Your Tako sign-in expired. Please sign in again.",
          ),
          401,
          { "set-cookie": buildClearCookie(SESSION_COOKIE) },
        );
      }
      console.error(
        "Tako identity lookup failed at /authorize POST:",
        err.kind,
        err.message,
      );
      return htmlResponse(
        sessionExpiredPage(
          "Could not retrieve your Tako API token. Please try again.",
        ),
        502,
      );
    }
    throw err;
  }
  const enc_tako_token = await encryptAesGcm(takoToken, cfg.encKey);

  const now = Math.floor(Date.now() / 1000);
  const codeClaims: AuthCodeClaims = {
    type: "auth_code",
    client_id: parsed.client_id,
    redirect_uri: parsed.redirect_uri,
    code_challenge: parsed.code_challenge,
    scope: parsed.scope ?? "mcp",
    user_id: session!.user_id,
    user_email: session!.user_email,
    enc_tako_token,
    resource,
    exp: now + AUTH_CODE_TTL_S,
    jti: crypto.randomUUID(),
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

/**
 * Friendly HTML page shown when /authorize POST cannot complete because
 * of a session-or-Tako-side error. Reuses the same look as the consent
 * page; clears the session cookie inline if the session is unrecoverable.
 */
function sessionExpiredPage(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tako — sign-in required</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #555; --border: #ddd; --accent: #111; --on-accent: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f5f5f5; --bg: #0b0b0b; --muted: #aaa; --border: #2a2a2a; --accent: #fff; --on-accent: #111; }
  }
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; margin: 0; padding: 3rem 1.5rem; max-width: 28rem; margin-inline: auto; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.3rem; margin: 0 0 0.5rem; }
  p { color: var(--muted); line-height: 1.55; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  a.btn { flex: 1; text-align: center; padding: 0.75rem 1rem; font-size: 1rem; font-weight: 500; border-radius: 0.5rem; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); text-decoration: none; }
  a.btn:hover { opacity: 0.85; }
</style>
</head>
<body>
<h1>Sign-in required</h1>
<p>${safe}</p>
<div class="actions">
  <a class="btn" href="javascript:history.back()">Go back</a>
</div>
</body>
</html>`;
}

function consentPage(args: {
  clientName: string;
  userEmail: string;
  formAction: string;
  switchAccountHref: string;
}): string {
  const safeName = escapeHtml(args.clientName);
  const safeEmail = escapeHtml(args.userEmail);
  const safeAction = escapeHtml(args.formAction);
  const safeSwitch = escapeHtml(args.switchAccountHref);
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
  /* row-reverse so Cancel READS on the left while Allow stays FIRST in the
     DOM — with two submit buttons the Enter key activates whichever comes
     first in tree order, and that default must never be "deny". */
  form { margin-top: 1.5rem; display: flex; flex-direction: row-reverse; gap: 0.75rem; }
  .switch { margin-top: 0.9rem; font-size: 0.85rem; }
  .switch a { color: var(--muted); }
  button { flex: 1; padding: 0.75rem 1rem; font-size: 1rem; font-weight: 500; border-radius: 0.5rem; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  /* Keyed on the VALUE, not on type=submit. Both buttons are submits now —
     that is what carries the allow/deny decision — so a type selector fills
     them identically and the destructive choice ends up looking exactly like
     the affirmative one. Only Allow gets the accent.
     NOTE: this block sits inside a JS template literal, so no backticks in
     these comments; they terminate the string. */
  button[value="allow"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  button:hover { opacity: 0.85; }
</style>
</head>
<body>
<h1>Connect ${safeName} to Tako</h1>
<p>${safeName} is requesting access to your Tako account. Approving will let it call the Tako MCP server on your behalf.</p>
<div class="who"><span class="who-dot"></span> Signed in as <strong>${safeEmail}</strong></div>
<form method="POST" action="${safeAction}">
  <button type="submit" name="action" value="allow">Allow</button>
  <button type="submit" name="action" value="deny">Cancel</button>
</form>
<p class="switch"><a href="${safeSwitch}">Not you? Sign in with a different account</a></p>
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

  // `iss` for issued tokens is this server's own origin (per-env).
  const issuer = serverIssuer(req);

  const grant_type = params.get("grant_type");
  if (grant_type === null) {
    return jsonError("invalid_request", "grant_type is required", 400);
  }
  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(params, issuer, cfg);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshGrant(params, issuer, cfg);
  }
  return jsonError(
    "unsupported_grant_type",
    `grant_type \`${grant_type}\` is not supported`,
    400,
  );
}

/**
 * Single-use enforcement for grant tokens (OAuth 2.1 §4.1.2 for auth
 * codes, §4.3.1 for refresh tokens). On the first redemption we record
 * the token's `jti` in Workers Cache for the remainder of its TTL; on
 * any subsequent redemption the cache hit short-circuits with
 * `invalid_grant`.
 *
 * Caveats (deliberate, see TAKO-2701):
 * - Workers Cache is per-colo, not global. A captured token redeemed at
 *   edge A and replayed at edge B would not see edge B's empty cache.
 *   In practice, a single OAuth client (Claude.ai's backend, ChatGPT's
 *   backend) is sticky to one colo per session, so this catches realistic
 *   replay scenarios. Cross-colo replay would itself be a strong signal
 *   warranting an upgrade to KV-backed enforcement.
 * - Workers Cache is best-effort LRU. The 60s auth-code TTL fits easily
 *   inside any practical eviction window, so auth-code coverage is hard.
 *   The 14-day refresh-token TTL is long enough that LRU eviction is
 *   plausible under memory pressure — refresh-replay protection is
 *   correspondingly weaker than auth-code protection. KV-backed enforcement
 *   is the answer if/when refresh replay becomes a hard requirement.
 * - Check-then-put is non-atomic. `cache.match` and `cache.put` are two
 *   separate awaits, so two concurrent redemptions of the same `jti`
 *   inside one isolate can both observe a cache miss before either write
 *   lands, and both succeed. Sequential replay (the realistic threat) is
 *   serialized correctly; concurrent replay is best-effort. KV's atomic
 *   CAS would close this window if/when it matters.
 *
 * Rolling cutover (`jti` undefined): tokens minted before this code
 * shipped have no `jti` claim. `verifyJwt` validates signature + `exp`
 * only — the runtime cast to `RefreshTokenClaims` does not enforce
 * shape — so `claims.jti` is `undefined` for legacy tokens. If we keyed
 * the cache on that, every legacy token would collide on a single
 * `…/undefined` slot and the first post-deploy refresh by any user
 * would lock out every other still-active session. We instead bypass
 * enforcement for tokens without `jti`; they remain redeemable for the
 * remainder of their natural TTL. New tokens (post-deploy) carry `jti`
 * and get full enforcement. The bypass becomes dead code once all
 * legacy refresh tokens age out (≤14 days) and can be removed in a
 * follow-up — at which point `RefreshTokenClaims.jti` should also be
 * tightened from `string | undefined` back to required `string`.
 */
async function checkAndMarkRedeemed(
  kind: "auth-code" | "refresh-token",
  jti: string | undefined,
  ttlSeconds: number,
): Promise<Response | null> {
  if (!jti) return null;
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/oauth-${kind}/${jti}`);
  if (await cache.match(cacheKey)) {
    const description =
      kind === "auth-code"
        ? "authorization code already redeemed"
        : "refresh token already redeemed";
    return jsonError("invalid_grant", description, 400);
  }
  await cache.put(
    cacheKey,
    new Response("1", {
      headers: { "Cache-Control": `max-age=${ttlSeconds}` },
    }),
  );
  return null;
}

/**
 * Validate the optional RFC 8707 `resource` form param at `/token` (the MCP
 * auth spec has it as a MUST on token requests too) and reconcile it with the
 * resource the grant is already bound to. Returns the effective resource to
 * audience the issued tokens with, or an OAuth error Response.
 */
function resolveTokenResource(
  requestedRaw: string | null,
  boundResource: string | null,
  origin: string,
): { resource: string | null } | { error: Response } {
  if (requestedRaw === null) return { resource: boundResource };
  const canonical = canonicalizeResource(requestedRaw);
  if (canonical === null || !isServerResource(canonical, origin)) {
    return {
      error: jsonError(
        "invalid_target",
        `unknown resource; this server is ${origin}/mcp`,
        400,
      ),
    };
  }
  if (boundResource !== null && canonical !== boundResource) {
    return {
      error: jsonError(
        "invalid_target",
        "requested resource does not match the resource bound to this grant",
        400,
      ),
    };
  }
  return { resource: canonical };
}

async function handleAuthorizationCodeGrant(
  params: URLSearchParams,
  issuer: string,
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
  // Belt-and-suspenders against confused-deputy / token-leak scenarios:
  // PKCE alone is sufficient per the spec for public clients, but if
  // the form body carries a `client_id` it MUST match the one bound to
  // the auth code. A mismatch is a strong signal worth surfacing.
  const formClientId = params.get("client_id");
  if (formClientId !== null && formClientId !== claims.client_id) {
    return jsonError(
      "invalid_grant",
      "client_id does not match authorization request",
      400,
    );
  }
  const expectedChallenge = await sha256B64Url(code_verifier);
  if (claims.code_challenge !== expectedChallenge) {
    return jsonError("invalid_grant", "PKCE verifier does not match", 400);
  }
  const replay = await checkAndMarkRedeemed(
    "auth-code",
    claims.jti,
    AUTH_CODE_TTL_S,
  );
  if (replay !== null) return replay;
  const resolved = resolveTokenResource(
    params.get("resource"),
    claims.resource ?? null,
    issuer,
  );
  if ("error" in resolved) return resolved.error;
  return issueTokens(
    {
      scope: claims.scope,
      user_id: claims.user_id,
      user_email: claims.user_email,
      enc_tako_token: claims.enc_tako_token,
    },
    issuer,
    resolved.resource,
    cfg,
  );
}

async function handleRefreshGrant(
  params: URLSearchParams,
  issuer: string,
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
  // Reject a refresh token bound to a different origin/resource than the one it
  // is presented to (`issuer` == this request's origin). Without this, a token
  // for host A redeemed at host B would mint an access token with iss=B, aud=A
  // that `/mcp` at B then 401s forever (dead-end loop), and — on staging, where
  // workers.dev + custom domain share a signing key — a token would launder its
  // audience to another host through a single refresh. Legacy tokens with no
  // iss/aud are tolerated (re-audienced to this origin's default at issue).
  if (typeof claims.iss === "string" && claims.iss !== issuer) {
    return jsonError(
      "invalid_grant",
      "refresh token was issued for a different server",
      400,
    );
  }
  if (typeof claims.aud === "string" && !isServerResource(claims.aud, issuer)) {
    return jsonError(
      "invalid_grant",
      "refresh token audience does not match this server",
      400,
    );
  }
  const replay = await checkAndMarkRedeemed(
    "refresh-token",
    claims.jti,
    REFRESH_TOKEN_TTL_S,
  );
  if (replay !== null) return replay;
  const resolved = resolveTokenResource(
    params.get("resource"),
    // Carry the audience forward across rotation. Legacy refresh tokens
    // predate the claim (undefined) → default to this origin's /mcp at issue.
    claims.resource ?? null,
    issuer,
  );
  if ("error" in resolved) return resolved.error;
  return issueTokens(
    {
      scope: claims.scope,
      user_id: claims.user_id,
      user_email: claims.user_email,
      enc_tako_token: claims.enc_tako_token,
    },
    issuer,
    resolved.resource,
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
  issuer: string,
  resource: string | null,
  cfg: OAuthConfig,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  // `iss` is the authorization-server issuer (bare origin); `aud` binds the
  // token to the resource server (the `/mcp` endpoint). When the client named
  // a resource, `aud` equals it (already validated == `${origin}/mcp`);
  // otherwise it defaults to `${origin}/mcp` so every token is audienced.
  const aud = resource ?? `${issuer}/mcp`;
  const accessClaims: AccessTokenClaims = {
    type: "access",
    scope: identity.scope,
    user_id: identity.user_id,
    user_email: identity.user_email,
    enc_tako_token: identity.enc_tako_token,
    iss: issuer,
    aud,
    exp: now + ACCESS_TOKEN_TTL_S,
  };
  const refreshClaims: RefreshTokenClaims = {
    type: "refresh",
    scope: identity.scope,
    user_id: identity.user_id,
    user_email: identity.user_email,
    enc_tako_token: identity.enc_tako_token,
    iss: issuer,
    aud,
    resource,
    exp: now + REFRESH_TOKEN_TTL_S,
    jti: crypto.randomUUID(),
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
 * Render the login page. Two entry points:
 *
 *  - **Google**, driven by Stytch's vanilla-js SDK over their CDN, configured
 *    with `STYTCH_PUBLIC_TOKEN`. On success Stytch redirects to the URL passed
 *    as `login_redirect_url` with `?token=...` and a
 *    `&stytch_token_type=oauth|magic_links` discriminator, which we point at
 *    `/oauth/stytch_callback`.
 *  - **Email + password**, a plain server-side form POST to `/login/password`
 *    that never touches the SDK, so the password cannot pass through
 *    CDN-delivered script. Rendered only when the limiter bindings that endpoint
 *    fails closed on are present — see `hasLoginLimiters`.
 *
 * The magic link is deliberately gone: it sends the user out of the browser
 * mid-OAuth-dance, and the state cookie it has to outlive is 10 minutes.
 */
export function handleLogin(req: Request, env: Env): Response {
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const url = new URL(req.url);
  const callbackUrl = `${url.origin}/oauth/stytch_callback`;
  const webBase = safePublicBase(env);
  // Closed-set lookup, not free text — see `loginErrorFor`.
  const errorCode = url.searchParams.get("error");
  return htmlResponse(
    loginPage({
      stytchPublicToken: cfg.stytch.publicToken,
      callbackUrl,
      error: errorCode === null ? null : loginErrorFor(errorCode, webBase),
      webBase,
      // The form is only honest when the endpoint behind it can actually run —
      // see `hasLoginLimiters`.
      passwordEnabled: hasLoginLimiters(env),
    }),
  );
}

/**
 * The public web origin, or `null` when it cannot be resolved.
 *
 * `resolvePublicBase` THROWS — on an absent value, a trailing slash, an
 * unparseable URL, a non-http scheme. It feeds only the optional deep links on
 * this page, so a bad value must cost those links and nothing else. Letting it
 * propagate would take the entire sign-in page to a bare 500, **including
 * Google sign-in** — the one path the limiter's fail-closed design goes out of
 * its way to preserve. A misconfigured origin is exactly the kind of edit
 * (`PUBLIC_BASE_URL: "https://tako.com/"`) that reaches production unnoticed.
 */
function safePublicBase(env: Env): string | null {
  try {
    return resolvePublicBase(env);
  } catch (err) {
    console.error(
      "[login] public base URL unusable, omitting the footer links:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Whether password sign-in can be served at all.
 *
 * `handleLoginPassword` fails closed without BOTH limiter bindings, so this is
 * the same predicate it uses. `handleLogin` gates the form on it: rendering
 * email/password inputs whose every submit 503s is worse than not offering
 * them, and the SDK's own fallback copy points the user at that form.
 */
function hasLoginLimiters(env: Env): boolean {
  return (
    typeof env.LOGIN_RATE_LIMITER?.limit === "function" &&
    typeof env.LOGIN_EMAIL_RATE_LIMITER?.limit === "function"
  );
}

/** A rendered error message, plus an optional recovery link. */
interface LoginErrorCopy {
  text: string;
  link?: { href: string; label: string };
}

/**
 * Copy for the error codes `/login/password` and `/oauth/stytch_callback` hand
 * back to `/login` via `?error=`.
 *
 * A CLOSED set, mapped server-side. The redirect param is
 * attacker-controllable, so rendering arbitrary text from it would turn the
 * sign-in page into a phishing surface ("your session expired, call this
 * number"). Unknown codes return `null` and render nothing at all.
 *
 * The split mirrors Tako's own `PasswordSignInPage.tsx`:
 * `invalid_credentials` deliberately absorbs unknown-email AND wrong-password.
 * `no_user_password` and `reset_password` stay distinct, which DOES let one
 * junk-password POST learn that an address exists — accepted deliberately: with
 * the magic link gone, a passwordless account that is told "incorrect email or
 * password" has no way to discover that Google is its way in. Tako's own
 * sign-in page has the same property, so this leaks nothing that is not already
 * public, and both cases are recoverable from the page as it stands.
 */
function loginErrorFor(code: string, webBase: string | null): LoginErrorCopy | null {
  switch (code) {
    case "invalid_credentials":
      return { text: "Incorrect email or password." };
    case "missing_fields":
      return { text: "Enter both your email and password." };
    case "no_user_password":
      return {
        text: "This account signs in with Google. Use “Continue with Google” above.",
      };
    case "reset_password":
      return {
        text: "Your password needs to be reset.",
        ...(webBase === null
          ? {}
          : {
              link: {
                href: `${webBase}/login/forgot-password`,
                label: "Get a reset link",
              },
            }),
      };
    case "rate_limited":
      return { text: "Too many sign-in attempts. Wait a minute and try again." };
    case "server_error":
      return { text: "Something went wrong signing you in. Please try again." };
    // This Worker has no second-factor UI. Do NOT send these users to Google:
    // the Google callback resolves through the SAME `parseAuthenticateResponse`
    // (MFA in Stytch is a policy on the user, not on the primary factor), so if
    // Stytch reports the second factor there too, "use Google" is the exact
    // loop this copy exists to prevent. Tako's own `/login/mfa` is the only
    // place that can complete the factor.
    case "mfa_required":
      return {
        text: "This account uses two-factor authentication, which isn’t supported here.",
        ...(webBase === null
          ? {}
          : { link: { href: `${webBase}/login/mfa`, label: "Finish signing in on Tako" } }),
      };
    default:
      return null;
  }
}

/**
 * Map a Stytch failure to one of `LOGIN_ERROR_COPY`'s codes.
 *
 * Stytch reports wrong-password as `invalid_credentials`/401 and unknown-email
 * as `email_not_found`/`user_not_found`/404; both collapse to
 * `invalid_credentials` here. Only the two actionable states survive as
 * themselves.
 */
function loginErrorCode(err: StytchError): string {
  switch (err.errorType) {
    case "mfa_required":
      return "mfa_required";
    case "no_user_password":
      return "no_user_password";
    case "reset_password":
    case "password_reset_required":
      return "reset_password";
    case "invalid_credentials":
    case "email_not_found":
    case "user_not_found":
    case "password_does_not_match":
      return "invalid_credentials";
    default:
      // An unmapped 401/404 is still a credential failure as far as the user
      // is concerned; anything else is ours, not theirs.
      return err.status === 401 || err.status === 404
        ? "invalid_credentials"
        : "server_error";
  }
}

/**
 * `POST /login/password` — authenticate an email + password against Stytch and
 * resume the OAuth dance, landing in exactly the same place Google does.
 *
 * Ordering is deliberate: method → config → same-site → per-IP meter → field
 * presence → per-email meter → Stytch. Every gate that can reject without
 * touching a password check runs first, so the expensive, attackable call is
 * last. The per-email meter sits AFTER field validation on purpose; see below.
 */
export async function handleLoginPassword(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const cfg = readConfig(env);
  if (cfg === null) return oauthDisabledResponse();
  const url = new URL(req.url);

  // CSRF. A cross-site POST is rejected outright on `Sec-Fetch-Site`, which the
  // browser sets and page JS cannot spoof. `same-site` is rejected too, so a
  // `*.tako.com` subdomain is not trusted either.
  //
  // A MISSING header (curl, an older browser) is allowed through, and what makes
  // that safe is NOT the limiter below — a limiter bounds volume, and a forced
  // login needs exactly one request. The real control is that `tako_oauth_state`
  // is `SameSite=Lax` (`cookies.ts`), so a cross-site POST arrives without it
  // and `completeStytchLogin` bails at its missing-state branch BEFORE it
  // appends the session `Set-Cookie`. That ordering is load-bearing: building
  // the response headers before the state check would silently reintroduce
  // forced login for header-less clients. `handlers.test.ts` pins it.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return new Response("cross-site form post rejected", { status: 403 });
  }

  // Fail-closed on BOTH limiters — see `Env.LOGIN_RATE_LIMITER`.
  const ipLimiter = env.LOGIN_RATE_LIMITER;
  const emailLimiter = env.LOGIN_EMAIL_RATE_LIMITER;
  if (!hasLoginLimiters(env) || ipLimiter === undefined || emailLimiter === undefined) {
    console.error(
      "[login] a login rate-limit binding is unbound — refusing password " +
        "sign-in (Google sign-in unaffected). Declare LOGIN_RATE_LIMITER and " +
        "LOGIN_EMAIL_RATE_LIMITER under `ratelimits`.",
    );
    return errorPage(
      503,
      "Password sign-in is unavailable on this deployment. " +
        "Use “Continue with Google”.",
    );
  }

  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  // The sender's own axis is charged for every attempt, valid or not, so
  // fieldless spam is never free to whoever sends it.
  if (!(await meterOrNull(ipLimiter, `login:ip:${ip}`))) {
    return rateLimited(url, ip);
  }

  const body = await req.formData().catch(() => null);
  const email = String(body?.get("email") ?? "").trim();
  const password = String(body?.get("password") ?? "");

  // Validate fields BEFORE metering the email axis. Metering first meant 8 junk
  // POSTs a minute against a known address — no password guess needed — held
  // that address in the `rate_limited` redirect from arbitrary IPs, with copy
  // that blamed the victim. Only attempts that reach a real credential check may
  // consume someone else's bucket.
  if (email === "" || password === "") {
    return redirectToLogin(url, "missing_fields");
  }

  // Two axes, because neither covers the other: per-IP misses one account
  // sprayed from many hosts, per-email misses one host walking a list. Separate
  // BINDINGS because a Cloudflare `ratelimits` limit is per-binding, and the
  // email bucket is deliberately looser than the IP bucket — it is the axis an
  // attacker can aim at a victim.
  //
  // Neither axis is a hard bound, and the fail-closed decision above does not
  // pretend otherwise: `ratelimits` counts PER COLO, and this repo's own
  // measurements (`workers/README.md`, "Measured behaviour") show a cold burst
  // admitting ~115 requests regardless of the configured limit. So these buckets
  // dampen stuffing and make it visible in `wrangler tail`; the real bound on
  // guessing a single password is Stytch's own per-user lockout. The endpoint
  // still refuses to serve without them, because "dampened and logged" and
  // "wide open and silent" are not the same posture on an unauthenticated
  // password check.
  const emailKey = await sha256B64Url(email.toLowerCase());
  if (!(await meterOrNull(emailLimiter, `login:email:${emailKey}`))) {
    return rateLimited(url, ip);
  }

  let stytchResult: StytchAuthenticateResult;
  try {
    stytchResult = await authenticateStytchPassword(cfg.stytch, email, password);
  } catch (err) {
    if (err instanceof StytchError) {
      const code = loginErrorCode(err);
      // Log the classification, never the credentials. `err.message` is built
      // by `stytch.ts` from the path and status only.
      console.error(
        "[login] password sign-in failed:",
        code,
        err.errorType ?? err.status,
      );
      return redirectToLogin(url, code);
    }
    throw err;
  }
  return completeStytchLogin(req, url, cfg, stytchResult);
}

/**
 * Charge one hit against `key`, reporting whether the caller may proceed.
 *
 * Returns `false` both when the bucket is empty and when the binding THROWS. A
 * limiter that errors must not fail open on an unauthenticated password check —
 * that is the failure mode the whole fail-closed posture exists for.
 */
async function meterOrNull(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (err) {
    console.error(
      "[login] rate-limit binding threw; treating as limited:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * The rate-limited response. A 302 rather than a 429 because this is a browser
 * form post and the message belongs on the page — which means the status code
 * carries no signal for abuse monitoring, so log it here instead. IP only: the
 * email is the thing being guessed at.
 */
function rateLimited(url: URL, ip: string): Response {
  console.warn("[login] password sign-in rate-limited", `ip=${ip}`);
  return redirectToLogin(url, "rate_limited");
}

/**
 * Bounce back to the sign-in page with a closed-set error code. Never carries
 * the email or password — a redirect URL lands in browser history, `Referer`
 * headers, and proxy logs.
 */
function redirectToLogin(url: URL, code: string): Response {
  const target = new URL("/login", url.origin);
  target.searchParams.set("error", code);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

/**
 * Encode a string as a JS string literal safe to embed inside a
 * `<script>` block. `JSON.stringify` is the standard JS escape, but a
 * literal `</script>` sequence inside the resulting string would still
 * close the surrounding tag — replace `<` with `<` to suppress
 * that. Do NOT pass the value through `escapeHtml` first: the
 * resulting `&amp;`/`&#39;` would corrupt the JS literal at runtime
 * and the Stytch SDK would receive garbage tokens / URLs.
 */
function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

interface LoginPageOptions {
  stytchPublicToken: string;
  callbackUrl: string;
  /** Closed-set copy for `?error=`, or `null` to render an empty error slot. */
  error: LoginErrorCopy | null;
  /** Public web origin, or `null` when unresolvable — see `safePublicBase`. */
  webBase: string | null;
  /** Whether to render the email/password form at all — see `hasLoginLimiters`. */
  passwordEnabled: boolean;
}

function loginPage(opts: LoginPageOptions): string {
  const { stytchPublicToken, callbackUrl, error, webBase, passwordEnabled } = opts;
  // `publicToken` and `callbackUrl` are embedded as JS string literals via
  // `jsStringLiteral`, not HTML-escaped — they live inside <script>, not in
  // HTML attributes or text. The error copy is the reverse: it lands in HTML
  // text, so it goes through `escapeHtml`. It is already a value from the
  // closed `loginErrorFor` set, so this is belt-and-suspenders.
  const errorLink =
    error?.link === undefined
      ? ""
      : ` <a href="${escapeHtml(error.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(error.link.label)}</a>`;
  const safeError = error === null ? "" : `${escapeHtml(error.text)}${errorLink}`;
  // Deep links into Tako's real web app, which owns account creation, password
  // reset, and MFA. Routes verified against `routeTree.gen.ts`
  // (`/login/forgot-password`, `/signup`) — a dead link here is precisely the
  // kind of thing a plugin reviewer clicks first. Omitted entirely when the
  // origin is unusable, rather than taking the page down with them.
  const footer =
    webBase === null
      ? ""
      : `
  <p class="foot"><a href="${escapeHtml(`${webBase}/login/forgot-password`)}" target="_blank" rel="noopener noreferrer">Forgot password?</a></p>
  <p class="foot">New to Tako? <a href="${escapeHtml(`${webBase}/signup`)}" target="_blank" rel="noopener noreferrer">Create an account</a></p>`;
  // The divider only makes sense between two alternatives.
  const passwordBlock = !passwordEnabled
    ? ""
    : `
  <div class="divider">or</div>

  <form method="POST" action="/login/password" autocomplete="on">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="username"
             inputmode="email" autocapitalize="none" spellcheck="false" placeholder="you@company.com">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required
             autocomplete="current-password" placeholder="Your password">
    </div>
    <button type="submit" class="btn-primary">Sign in</button>
  </form>`;
  // The SDK's own failure copy may only point at the form when there IS one.
  const sdkFallback = passwordEnabled
    ? "Google sign-in is unavailable. Use your email and password below."
    : "Google sign-in is unavailable. Please try again in a moment.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Tako</title>
<!-- favicon.svg is the LIGHT-theme asset (dark ink); favicon-light.svg is the
     DARK-theme one. The names read backwards, so the icons array in mcp.ts is
     the reference. Media-scoped rel=icon is honoured by Chromium and ignored
     elsewhere, which is why the unconditional light link stays last as the
     fallback rather than being replaced. -->
<link rel="icon" href="/icons/favicon-light.svg" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icons/favicon.svg">
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --surface: #ffffff; --fg: #141413; --muted: #73726c;
    --line: #e5e4df; --line-strong: #d3d1ca; --accent: #141413;
    --on-accent: #ffffff; --error-fg: #b4241f; --error-bg: #fdf3f2;
    --error-line: #f3d3d1; --focus: #6b6a64; --shadow: 0 1px 2px rgba(20,20,19,.04), 0 8px 24px -12px rgba(20,20,19,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191817; --surface: #201f1e; --fg: #f5f4ef; --muted: #a3a29c;
      --line: #34332f; --line-strong: #44433d; --accent: #f5f4ef;
      --on-accent: #191817; --error-fg: #f79f9a; --error-bg: #2a1d1c;
      --error-line: #4a2e2c; --focus: #8a8880; --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 2rem 1.25rem; background: var(--bg);
    color: var(--fg);
    font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 25rem; background: var(--surface);
    border: 1px solid var(--line); border-radius: 14px; padding: 2rem 1.75rem;
    box-shadow: var(--shadow);
  }
  .mark { width: 34px; height: 34px; display: block; margin: 0 0 1.25rem; }
  h1 { font-size: 1.3rem; line-height: 1.25; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 0.375rem; }
  .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
  label { display: block; font-size: 0.8rem; font-weight: 500; margin: 0 0 0.375rem; }
  input {
    width: 100%; padding: 0.625rem 0.75rem; font-size: 0.9375rem; font-family: inherit;
    color: var(--fg); background: transparent; border: 1px solid var(--line-strong);
    border-radius: 8px; transition: border-color .12s ease, box-shadow .12s ease;
  }
  input:focus-visible {
    outline: none; border-color: var(--focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 18%, transparent);
  }
  .field { margin-bottom: 0.875rem; }
  button {
    width: 100%; padding: 0.625rem 1rem; font: inherit; font-size: 0.9375rem;
    font-weight: 500; border-radius: 8px; cursor: pointer;
    transition: opacity .12s ease, border-color .12s ease;
  }
  button:hover { opacity: 0.88; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .btn-primary { background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent); }
  .btn-social {
    background: transparent; color: var(--fg); border: 1px solid var(--line-strong);
    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  }
  .btn-social svg { width: 17px; height: 17px; flex: none; }
  .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0; color: var(--muted); font-size: 0.75rem; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .err {
    display: flex; gap: 0.5rem; padding: 0.625rem 0.75rem; margin: 0 0 1.25rem;
    background: var(--error-bg); border: 1px solid var(--error-line);
    border-radius: 8px; color: var(--error-fg); font-size: 0.85rem;
  }
  .err:empty { display: none; }
  .foot { margin: 1.25rem 0 0; font-size: 0.8125rem; color: var(--muted); text-align: center; }
  .foot + .foot { margin-top: 0.5rem; }
  a { color: var(--fg); text-decoration: none; border-bottom: 1px solid var(--line-strong); }
  a:hover { border-bottom-color: var(--fg); }
</style>
</head>
<body>
<main class="card">
  <!-- A picture element rather than one img: the mark is a dark-ink glyph, so
       on a dark host it renders dark-on-dark and all but disappears. The img
       stays the light-theme fallback for a host that states no preference. -->
  <picture>
    <source srcset="/icons/favicon-light.svg" media="(prefers-color-scheme: dark)">
    <img class="mark" src="/icons/favicon.svg" alt="Tako" width="34" height="34">
  </picture>
  <h1>Sign in to Tako</h1>
  <p class="sub">Authorize this connection with your Tako account.</p>

  <div class="err" id="err" role="alert" aria-live="polite">${safeError}</div>

  <button type="button" class="btn-social" id="google">
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
    Continue with Google
  </button>

${passwordBlock}
${footer}
</main>

<!-- Stytch's vanilla JS SDK, used for the Google redirect only. Loaded over
     their CDN without Subresource Integrity because Stytch publishes a rolling
     URL and breaks SRI pins on every revision. Trade-off: a compromise of
     js.stytch.com would let an attacker run JS on this page. That is a
     narrower exposure than it looks for Google (a redirect start, no secrets
     here) but NOT for the password field, which is why the password path is a
     plain server-side form POST that never touches the SDK. -->
<script src="https://js.stytch.com/stytch.js"></script>
<script>
  (function() {
    var publicToken = ${jsStringLiteral(stytchPublicToken)};
    var callbackUrl = ${jsStringLiteral(callbackUrl)};
    var errEl = document.getElementById("err");
    // textContent, never innerHTML — this sink must stay inert even though
    // every message it receives is a server-side literal.
    function showError(msg) { errEl.textContent = msg || ""; }
    // Server-rendered so it cannot promise a form that is not on the page.
    var sdkFallback = ${jsStringLiteral(sdkFallback)};

    var client;
    try {
      client = Stytch(publicToken);
    } catch (e) {
      showError(sdkFallback);
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
        showError(sdkFallback);
      }
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
      // Route through the SAME closed-set copy the password path uses, rather
      // than interpolating `error_type` into a 502. Two reasons: users must
      // never see an internal Stytch code (this branch used to render "Stytch
      // authentication failed (mfa_required)"), and the same condition must not
      // produce two different messages depending on which factor the user
      // picked. `loginErrorFor` decides what each code says in one place.
      return redirectToLogin(url, loginErrorCode(err));
    }
    throw err;
  }

  return completeStytchLogin(req, url, cfg, stytchResult);
}

/**
 * Turn an authenticated Stytch result into our session cookie and resume the
 * OAuth dance at `/authorize`.
 *
 * Shared by the redirect callback (Google) and `POST /login/password`, because
 * "how a user becomes logged in" must have exactly one implementation. A
 * second copy would be a second place for the session-cookie claims, the TTL,
 * or the state-cookie handling to drift — on the code path that authorizes
 * access to someone's Tako account.
 */
async function completeStytchLogin(
  req: Request,
  url: URL,
  cfg: OAuthConfig,
  stytchResult: StytchAuthenticateResult,
): Promise<Response> {
  // Step 2 — encrypt the Stytch session JWT and stash it in our own
  // session cookie. We deliberately do NOT fetch the Tako API token
  // here. Caching the Tako token in the session cookie would mean
  // a token rotation at trytako.com followed by a connector-reconnect
  // within the cookie's TTL would re-use the stale cached token. By
  // keeping the Stytch JWT instead and re-fetching the Tako token on
  // every POST /authorize, rotations are always reflected.
  const enc_stytch_session_jwt = await encryptAesGcm(
    stytchResult.session_jwt,
    cfg.encKey,
  );
  const userEmail = primaryEmail(stytchResult.user);
  const sessionClaims: SessionCookieClaims = {
    type: "session",
    user_id: stytchResult.user.user_id,
    user_email: userEmail,
    enc_stytch_session_jwt,
    exp: Math.floor(Date.now() / 1000) + SESSION_COOKIE_MAX_AGE_S,
  };
  const sessionJwt = await signJwt(sessionClaims, cfg.signKey);

  // Step 4 — read the tako_oauth_state cookie, which carries the
  // original OAuth params Claude.ai sent to /authorize. If absent
  // we have no idea where to send the user; surface a friendly error.
  const stateRaw = readCookie(req, STATE_COOKIE);
  if (stateRaw === null) {
    // Reachable on a SUCCESSFUL sign-in, and more easily since password login
    // arrived: `tako_oauth_state` lives 10 minutes from `/authorize`, and a
    // mistype → `invalid_credentials` → retry → `rate_limited` ("wait a minute")
    // loop can now spend that window inside this page. The TTL is deliberately
    // NOT extended on retry — re-signing it would let one authorization request
    // live indefinitely — so the fix is copy that says what happened and what
    // to do, instead of a bare "request was lost".
    return errorPage(
      400,
      "You signed in successfully, but this connection request expired " +
        "(it stays valid for 10 minutes). Nothing is wrong with your account — " +
        "start the connection again from the app you were connecting, and " +
        "you will not need to sign in twice.",
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
  // `typeof === "string"` (not `!== null`) so a state cookie minted by pre-PR
  // code — which has no `resource` key and is `undefined` at runtime — doesn't
  // rebuild `?resource=undefined` and hard-fail the resumed authorize.
  if (typeof stateClaims.resource === "string")
    authorizeUrl.searchParams.set("resource", stateClaims.resource);

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
