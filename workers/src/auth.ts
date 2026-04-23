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
 * RFC 6750 §2.1 `b64token` production:
 *
 *     b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
 *
 * This intentionally rejects characters that are legal elsewhere in an
 * `Authorization` header value — notably spaces (which would signal a
 * malformed multi-token header), commas (which would be a legal
 * multi-challenge response like `Bearer abc, Basic xyz`), and quotes.
 * Catching these here gives the caller a clean "malformed" signal
 * instead of forwarding garbage to Django and getting a confusing 401.
 */
const B64TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

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

  // Enforce RFC 6750 §2.1 `b64token` charset. Rejects space-in-token
  // (`Bearer a b`), comma-separated challenges (`Bearer abc, Basic xyz`),
  // and any other non-b64token characters. Without this check we would
  // forward garbage to Django and produce a confusing upstream 401.
  if (!B64TOKEN_RE.test(rest)) {
    throw new BearerAuthError(
      "malformed",
      "Bearer token contains invalid characters (RFC 6750 §2.1 b64token)",
    );
  }

  return rest;
}

/**
 * JSON-RPC 2.0 error object shape — the `error` field of a JSON-RPC response.
 * Exported so Phase 2 tool wiring can build the full response envelope
 * (`{ jsonrpc: "2.0", id, error }`) with the correct `id` from the request.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: { kind: BearerAuthErrorKind };
}

/**
 * Single code for all Bearer auth failures. Falls inside the JSON-RPC 2.0
 * implementation-defined server-error range (-32000 to -32099). The specific
 * failure mode is carried in `data.kind` so clients that want to distinguish
 * "missing" from "malformed" from "empty" can, but the HTTP 401 response path
 * stays uniform for the common case.
 */
export const BEARER_AUTH_JSON_RPC_CODE = -32001;

/**
 * Map a `BearerAuthError` to a JSON-RPC error object. Centralizing the shape
 * here prevents the 8 Phase 2 tool wirings from each inventing their own
 * 401 response and drifting into divergent messages / codes. Callers are
 * still responsible for the outer response envelope and HTTP status.
 */
export function bearerAuthErrorToJsonRpc(err: BearerAuthError): JsonRpcError {
  return {
    code: BEARER_AUTH_JSON_RPC_CODE,
    message: err.message,
    data: { kind: err.kind },
  };
}
