/**
 * Bearer-token extraction from the incoming MCP HTTP request.
 *
 * The Worker authenticates the *connection* via a Bearer token that the
 * MCP client sends in the `Authorization` header. We forward that token
 * downstream to Django as `X-API-Key` (see `django.ts`). Token validity
 * is the Django backend's problem — this helper only normalizes the
 * header shape per RFC 6750 §2.1.
 */

export type BearerAuthErrorKind = "missing" | "malformed" | "empty";

/**
 * Thrown when the `Authorization` header cannot be parsed into a usable
 * Bearer token. Phase 2 tool wiring is responsible for turning this
 * into a JSON-RPC `401` response — this module just signals the
 * failure mode via the `kind` discriminant.
 */
export class BearerAuthError extends Error {
  readonly kind: BearerAuthErrorKind;

  constructor(kind: BearerAuthErrorKind, message: string) {
    super(message);
    this.name = "BearerAuthError";
    this.kind = kind;
  }
}

/**
 * Extract the Bearer token from `request.headers.get("Authorization")`.
 *
 * Accepts the RFC 6750 scheme case-insensitively (`Bearer`, `bearer`,
 * `BeArEr`, …). Requires a single ASCII space between the scheme and
 * the token, and a non-empty token. Does not validate the token value
 * against Django — Django answers `401` on a bad token and we forward.
 *
 * @throws BearerAuthError (kind="missing")   — header absent
 * @throws BearerAuthError (kind="malformed") — wrong scheme, no space,
 *                                             multiple spaces, etc.
 * @throws BearerAuthError (kind="empty")     — scheme ok, token empty
 */
export function extractBearer(request: Request): string {
  const header = request.headers.get("authorization");
  if (header === null) {
    throw new BearerAuthError(
      "missing",
      "Authorization header is required",
    );
  }

  // Strict RFC 6750 shape: `Bearer <token>` with exactly one space.
  // We split on the first space only so tokens containing `=` etc.
  // pass through verbatim. Additional whitespace between scheme and
  // token is ambiguous and rejected.
  const firstSpace = header.indexOf(" ");

  // Bare scheme with no token. Note that per HTTP spec the platform
  // strips trailing whitespace from header values, so `Bearer` and
  // `Bearer ` (trailing space, empty token) normalize to the same
  // string by the time we see them. We call this case "empty" — it
  // is the more actionable error for clients: they sent the scheme
  // but forgot the token.
  if (firstSpace === -1) {
    if (header.toLowerCase() === "bearer") {
      throw new BearerAuthError(
        "empty",
        "Bearer token is empty",
      );
    }
    throw new BearerAuthError(
      "malformed",
      "Authorization header must be of the form `Bearer <token>`",
    );
  }

  const scheme = header.slice(0, firstSpace);
  const rest = header.slice(firstSpace + 1);

  if (scheme.toLowerCase() !== "bearer") {
    throw new BearerAuthError(
      "malformed",
      `Authorization scheme must be Bearer (got \`${scheme}\`)`,
    );
  }

  // Reject a second space immediately after the scheme separator —
  // `Bearer  token` (two spaces) is not valid per RFC 6750.
  if (rest.startsWith(" ")) {
    throw new BearerAuthError(
      "malformed",
      "Authorization header must have exactly one space between scheme and token",
    );
  }

  if (rest.length === 0) {
    throw new BearerAuthError(
      "empty",
      "Bearer token is empty",
    );
  }

  return rest;
}
