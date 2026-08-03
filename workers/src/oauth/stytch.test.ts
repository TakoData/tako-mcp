import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateStytchPassword,
  authenticateStytchToken,
  primaryEmail,
  StytchError,
} from "./stytch.js";

const cfg = {
  projectId: "project-test-abc",
  secret: "secret-test-xyz",
  baseUrl: "https://test.stytch.com",
};

const OK_BODY = {
  session_jwt: "aaa.bbb.ccc",
  user: { user_id: "user-test-1", emails: [{ email: "eric@trytako.com" }] },
};

function ok(body: unknown = OK_BODY, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticateStytchPassword", () => {
  it("posts email + password to the passwords endpoint with Basic auth", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    const result = await authenticateStytchPassword(
      cfg,
      "eric@trytako.com",
      "correct horse battery staple",
    );
    expect(result.session_jwt).toBe("aaa.bbb.ccc");
    expect(result.user.user_id).toBe("user-test-1");

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://test.stytch.com/v1/passwords/authenticate");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      "Basic " + btoa(`${cfg.projectId}:${cfg.secret}`),
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      email: "eric@trytako.com",
      password: "correct horse battery staple",
      session_duration_minutes: 60,
    });
  });

  it("surfaces the Stytch error_type so the caller can map it to copy", async () => {
    // The whole point of keeping `error_type` is that `no_user_password` and
    // `invalid_credentials` get different user-facing messages — collapsing
    // them here would strand a Google-signup user with no usable hint.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ error_type: "no_user_password" }, 401),
    );
    await expect(
      authenticateStytchPassword(cfg, "eric@trytako.com", "pw"),
    ).rejects.toMatchObject({ errorType: "no_user_password", status: 401 });
  });

  it("rejects a 401 with no parseable error_type as a StytchError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    await expect(
      authenticateStytchPassword(cfg, "eric@trytako.com", "pw"),
    ).rejects.toBeInstanceOf(StytchError);
  });

  it("rejects a 2xx whose body is missing session_jwt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ user: OK_BODY.user }));
    await expect(
      authenticateStytchPassword(cfg, "eric@trytako.com", "pw"),
    ).rejects.toBeInstanceOf(StytchError);
  });

  it("rejects a 2xx whose user has no email addresses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ session_jwt: "a.b.c", user: { user_id: "u", emails: [] } }),
    );
    await expect(
      authenticateStytchPassword(cfg, "eric@trytako.com", "pw"),
    ).rejects.toBeInstanceOf(StytchError);
  });

  it("never puts the password in the thrown message", async () => {
    // A StytchError message can reach a log line; a password must not.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ error_type: "invalid_credentials" }, 401),
    );
    const err = await authenticateStytchPassword(
      cfg,
      "eric@trytako.com",
      "sup3rs3cret",
    ).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("sup3rs3cret");
  });
});

describe("authenticateStytchToken still shares the response contract", () => {
  it("normalizes the oauth response the same way", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    const result = await authenticateStytchToken(cfg, "tok", "oauth");
    expect(primaryEmail(result.user)).toBe("eric@trytako.com");
  });

  it("still routes magic_links to its own endpoint", async () => {
    // The callback keeps accepting magic-link tokens even though the login
    // page no longer offers them: links already sent must not 400.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await authenticateStytchToken(cfg, "tok", "magic_links");
    expect(String(spy.mock.calls[0]![0])).toContain("/v1/magic_links/authenticate");
  });
});
