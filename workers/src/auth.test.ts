import { describe, expect, it } from "vitest";

import {
  BearerAuthError,
  extractBearer,
} from "./auth";

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
});
