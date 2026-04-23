import { describe, expect, it } from "vitest";

import {
  BEARER_AUTH_JSON_RPC_CODE,
  BearerAuthError,
  bearerAuthErrorToJsonRpc,
  extractBearer,
} from "./auth.js";

describe("extractBearer", () => {
  it("returns the token on the happy path", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer sk-abc-123" },
    });
    expect(extractBearer(req)).toBe("sk-abc-123");
  });

  it("accepts a lowercase `bearer` scheme (case-insensitive per RFC 6750)", () => {
    const req = new Request("https://example.com/", {
      headers: { authorization: "bearer sk-abc-123" },
    });
    expect(extractBearer(req)).toBe("sk-abc-123");
  });

  it("accepts mixed-case `BeArEr`", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "BeArEr token-xyz" },
    });
    expect(extractBearer(req)).toBe("token-xyz");
  });

  it("throws MissingBearerError when Authorization header is absent", () => {
    const req = new Request("https://example.com/");
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("missing");
    }
  });

  it("throws MalformedBearerError for Basic scheme", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("malformed");
    }
  });

  it("throws EmptyBearerError for a bare `Bearer` with no token", () => {
    // Note: per HTTP spec the platform strips trailing whitespace from
    // header values, so `Authorization: Bearer ` (space, empty token)
    // and `Authorization: Bearer` (no space at all) are indistinguishable
    // by the time they reach `request.headers.get(...)`. We classify
    // both as "empty" — the more actionable error for clients (they
    // forgot to include the token).
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("empty");
    }
  });

  it("throws EmptyBearerError for `Bearer ` (trailing space gets stripped on the wire)", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer " },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("empty");
    }
  });

  it("throws MalformedBearerError when more than one space separates scheme and token", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer  sk-abc-123" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("malformed");
    }
  });

  it("throws MalformedBearerError when the token contains an internal space", () => {
    // `Bearer a b` — the b64token grammar in RFC 6750 §2.1 disallows
    // spaces, so even though we split on the first space, any further
    // spaces must be rejected.
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer a b" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("malformed");
    }
  });

  it("throws MalformedBearerError for comma-separated multi-challenge values", () => {
    // `Bearer abc, Basic xyz` is a legal RFC 7235 multi-challenge
    // response, but not a valid single-token request value. Rejecting
    // here gives callers a clean "malformed" signal instead of
    // forwarding garbage to Django.
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer abc, Basic xyz" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("malformed");
    }
  });

  it("throws MalformedBearerError for non-b64token characters (e.g. `!`)", () => {
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer abc!def" },
    });
    try {
      extractBearer(req);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BearerAuthError);
      expect((err as BearerAuthError).kind).toBe("malformed");
    }
  });
});

describe("bearerAuthErrorToJsonRpc", () => {
  it("maps a `missing` error to the shared JSON-RPC code with kind in data", () => {
    const err = new BearerAuthError("missing", "Authorization header is required");
    const rpc = bearerAuthErrorToJsonRpc(err);
    expect(rpc.code).toBe(BEARER_AUTH_JSON_RPC_CODE);
    expect(rpc.message).toBe("Authorization header is required");
    expect(rpc.data).toEqual({ kind: "missing" });
  });

  it("preserves the `malformed` discriminant in data.kind", () => {
    const err = new BearerAuthError("malformed", "bad scheme");
    expect(bearerAuthErrorToJsonRpc(err).data).toEqual({ kind: "malformed" });
  });

  it("preserves the `empty` discriminant in data.kind", () => {
    const err = new BearerAuthError("empty", "Bearer token is empty");
    expect(bearerAuthErrorToJsonRpc(err).data).toEqual({ kind: "empty" });
  });

  it("uses a code inside the JSON-RPC implementation-defined server-error range", () => {
    const err = new BearerAuthError("missing", "x");
    const { code } = bearerAuthErrorToJsonRpc(err);
    // JSON-RPC 2.0 reserves -32000..-32099 for implementation-defined server errors.
    expect(code).toBeLessThanOrEqual(-32000);
    expect(code).toBeGreaterThanOrEqual(-32099);
  });
});
