/**
 * Stytch HTTP client. The Worker authenticates users by handing the Stytch
 * redirect-token (received on `/oauth/stytch_callback`) to Stytch's
 * authenticate API, which returns a session JWT we'll then use to call
 * Tako on the user's behalf.
 *
 * Direct HTTP rather than `@stytch/node`:
 * - The SDK pulls in Node-specific deps that Workers' `nodejs_compat`
 *   layer doesn't fully cover.
 * - We use exactly two Stytch endpoints; pulling in the SDK is overkill.
 *
 * Authentication is HTTP Basic with `project_id:secret`. Both come from
 * Worker secrets (see `env.ts`). The base URL switches between
 * `test.stytch.com` and `api.stytch.com` depending on the project.
 */

import type { StytchAuthenticateResult } from "./types.js";

export type StytchTokenKind = "oauth" | "magic_links";

export class StytchError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;

  constructor(message: string, status: number, errorType?: string) {
    super(message);
    this.name = "StytchError";
    this.status = status;
    this.errorType = errorType;
  }
}

export interface StytchConfig {
  /** Stytch project ID. e.g. `project-test-...` (test) or `project-live-...`. */
  projectId: string;
  /** Stytch project secret. Treated as a Worker secret. */
  secret: string;
  /**
   * Base URL of Stytch's API. `https://test.stytch.com` for test projects,
   * `https://api.stytch.com` for live. No trailing slash.
   */
  baseUrl: string;
}

function authHeader(cfg: StytchConfig): string {
  // btoa is available in Workers; no need for Buffer. Stytch expects
  // the standard HTTP Basic encoding of `project_id:secret`.
  return "Basic " + btoa(`${cfg.projectId}:${cfg.secret}`);
}

/**
 * Exchange a Stytch redirect-token for a session JWT + user identity.
 *
 * Routes to the right Stytch endpoint based on the `stytch_token_type`
 * query parameter we received on the redirect:
 * - `oauth` → POST /v1/oauth/authenticate
 * - `magic_links` → POST /v1/magic_links/authenticate
 *
 * Both endpoints take a `{ token }` body and return a similar response
 * shape; we normalize to `StytchAuthenticateResult`.
 */
export async function authenticateStytchToken(
  cfg: StytchConfig,
  token: string,
  kind: StytchTokenKind,
): Promise<StytchAuthenticateResult> {
  const path =
    kind === "oauth"
      ? "/v1/oauth/authenticate"
      : "/v1/magic_links/authenticate";

  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(cfg),
    },
    body: JSON.stringify({
      token,
      // 60 minutes is enough to walk through the rest of the OAuth
      // dance (consent → /token call). The session is later wrapped
      // into our own session cookie and the Stytch JWT is discarded
      // immediately after we use it to fetch the Tako token.
      session_duration_minutes: SESSION_DURATION_MINUTES,
    }),
  });

  return parseAuthenticateResponse(response, path);
}

/**
 * Session lifetime we ask Stytch for. Long enough to finish the OAuth dance
 * (consent → `/token`); the JWT is wrapped into our own session cookie and
 * discarded right after it mints the Tako key.
 */
const SESSION_DURATION_MINUTES = 60;

/**
 * Authenticate an email + password directly against Stytch.
 *
 * Server-side rather than through the browser SDK, unlike Tako's own
 * `PasswordSignInPage`: this Worker already exchanges OAuth and magic-link
 * tokens the same way, and keeping the session JWT server-side means the
 * password flow reuses the existing session-cookie minting untouched instead
 * of introducing a second way to become logged in.
 *
 * `error_type` is preserved on the thrown `StytchError` because the caller
 * MUST distinguish the failures — notably `no_user_password`, which means the
 * account exists but signed up via Google. Collapsing that into "incorrect
 * email or password" would strand a Google user on a page that no longer
 * offers a magic link.
 *
 * The password is never interpolated into a message or a URL — `StytchError`
 * messages reach `console.error`.
 */
export async function authenticateStytchPassword(
  cfg: StytchConfig,
  email: string,
  password: string,
): Promise<StytchAuthenticateResult> {
  const path = "/v1/passwords/authenticate";
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(cfg),
    },
    body: JSON.stringify({
      email,
      password,
      session_duration_minutes: SESSION_DURATION_MINUTES,
    }),
  });

  return parseAuthenticateResponse(response, path);
}

/**
 * Shared response contract for every Stytch authenticate endpoint. One parser
 * so the token and password paths cannot disagree about what a valid session
 * looks like — they feed the same session-cookie minting downstream, so a
 * shape one accepts and the other rejects would be a latent auth bug.
 */
async function parseAuthenticateResponse(
  response: Response,
  path: string,
): Promise<StytchAuthenticateResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new StytchError(
      `Stytch ${path} returned ${response.status} with non-JSON body`,
      response.status,
    );
  }

  if (!response.ok) {
    const errType =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>)["error_type"] === "string"
        ? ((payload as Record<string, unknown>)["error_type"] as string)
        : undefined;
    throw new StytchError(
      `Stytch ${path} failed with ${response.status}`,
      response.status,
      errType,
    );
  }

  const obj = payload as Record<string, unknown>;
  const session_jwt = obj["session_jwt"];
  const user = obj["user"];
  // MFA: Tako has `/login/mfa` and `/login/mfa-setup` routes, so accounts with
  // a second factor exist. For those, Stytch answers 200 with an
  // `intermediate_session_token` and NO usable `session_jwt` — the caller must
  // complete the second factor before a session exists. This Worker
  // implements no second-factor UI, so name the case instead of letting it
  // fall into the generic "missing session_jwt" bucket, which would surface as
  // "something went wrong" and send the user in circles.
  const intermediate = obj["intermediate_session_token"];
  if (
    (typeof session_jwt !== "string" || session_jwt.length === 0) &&
    typeof intermediate === "string" &&
    intermediate.length > 0
  ) {
    throw new StytchError(
      `Stytch ${path} requires a second factor`,
      response.status,
      "mfa_required",
    );
  }
  if (typeof session_jwt !== "string" || session_jwt.length === 0) {
    throw new StytchError(
      `Stytch ${path} response missing session_jwt`,
      response.status,
    );
  }
  if (typeof user !== "object" || user === null) {
    throw new StytchError(
      `Stytch ${path} response missing user`,
      response.status,
    );
  }
  const userObj = user as Record<string, unknown>;
  const user_id = userObj["user_id"];
  const emails = userObj["emails"];
  if (typeof user_id !== "string") {
    throw new StytchError(
      `Stytch ${path} user missing user_id`,
      response.status,
    );
  }
  if (!Array.isArray(emails)) {
    throw new StytchError(
      `Stytch ${path} user missing emails array`,
      response.status,
    );
  }
  const normalizedEmails = emails
    .filter(
      (e): e is { email: string } =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>)["email"] === "string",
    )
    .map((e) => ({ email: e.email }));
  if (normalizedEmails.length === 0) {
    throw new StytchError(
      `Stytch ${path} user has no email addresses`,
      response.status,
    );
  }

  return {
    session_jwt,
    user: {
      user_id,
      emails: normalizedEmails,
    },
  };
}

/**
 * Pull the primary email out of a Stytch user record. Stytch users can
 * have multiple emails; the first one is conventionally the primary.
 */
export function primaryEmail(user: StytchAuthenticateResult["user"]): string {
  const first = user.emails[0];
  if (first === undefined) {
    throw new Error("Stytch user has no emails — should be unreachable");
  }
  return first.email;
}
