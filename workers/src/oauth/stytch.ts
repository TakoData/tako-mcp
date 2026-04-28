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
      session_duration_minutes: 60,
    }),
  });

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
