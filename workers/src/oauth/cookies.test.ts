import { describe, expect, it } from "vitest";

import {
  buildClearCookie,
  buildSetCookie,
  readCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "./cookies.js";

describe("buildSetCookie", () => {
  it("includes all required attributes", () => {
    const cookie = buildSetCookie("foo", "bar", { maxAgeSeconds: 600 });
    expect(cookie).toContain("foo=bar");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("does not set a Domain attribute (cookie scoped to Worker host)", () => {
    const cookie = buildSetCookie("foo", "bar", { maxAgeSeconds: 600 });
    expect(cookie).not.toContain("Domain");
  });

  it("respects sameSite override", () => {
    const cookie = buildSetCookie("foo", "bar", {
      maxAgeSeconds: 60,
      sameSite: "Strict",
    });
    expect(cookie).toContain("SameSite=Strict");
  });
});

describe("buildClearCookie", () => {
  it("emits an empty value with Max-Age=0", () => {
    const cookie = buildClearCookie(SESSION_COOKIE);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });
});

describe("readCookie", () => {
  it("returns null when no Cookie header", () => {
    const req = new Request("https://example.com/");
    expect(readCookie(req, "foo")).toBeNull();
  });

  it("returns null when target cookie not present", () => {
    const req = new Request("https://example.com/", {
      headers: { cookie: "other=1; another=2" },
    });
    expect(readCookie(req, "foo")).toBeNull();
  });

  it("extracts a single cookie", () => {
    const req = new Request("https://example.com/", {
      headers: { cookie: "foo=bar" },
    });
    expect(readCookie(req, "foo")).toBe("bar");
  });

  it("extracts the right cookie from a multi-cookie header", () => {
    const req = new Request("https://example.com/", {
      headers: {
        cookie: `${STATE_COOKIE}=state-jwt; ${SESSION_COOKIE}=session-jwt; other=ok`,
      },
    });
    expect(readCookie(req, STATE_COOKIE)).toBe("state-jwt");
    expect(readCookie(req, SESSION_COOKIE)).toBe("session-jwt");
    expect(readCookie(req, "other")).toBe("ok");
  });

  it("does not match cookies whose names share a prefix", () => {
    const req = new Request("https://example.com/", {
      headers: { cookie: "fooBar=1; foo=2" },
    });
    expect(readCookie(req, "foo")).toBe("2");
  });
});
