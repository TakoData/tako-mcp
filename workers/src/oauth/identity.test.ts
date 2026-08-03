import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityError, mintTakoApiKey } from "./identity.js";

const env = { DJANGO_BASE_URL: "https://api.example.com" } as never;
const JWT = "aaa.bbb.ccc"; // passes the JWT-shape guard

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintTakoApiKey", () => {
  it("posts client_name and returns the show-once key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ key: "tako_sk_RAW" }), { status: 201 }));
    const key = await mintTakoApiKey(env, JWT, "Claude");
    expect(key).toBe("tako_sk_RAW");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/api/v1/internal/mcp/api_key/");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ client_name: "Claude" });
    expect((init!.headers as Record<string, string>).cookie).toContain(JWT);
  });

  it("maps 401 to unauthorized", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(mintTakoApiKey(env, JWT, "Claude")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("maps 400 (cap) to at_cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "too many" }), { status: 400 }));
    await expect(mintTakoApiKey(env, JWT, "Claude")).rejects.toMatchObject({ kind: "at_cap" });
  });

  it("maps a non-2xx to transport", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(mintTakoApiKey(env, JWT, "Claude")).rejects.toMatchObject({ kind: "transport" });
  });

  it("treats an empty/missing key field as a parse error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ key: "" }), { status: 201 }));
    await expect(mintTakoApiKey(env, JWT, "Claude")).rejects.toMatchObject({ kind: "parse" });
  });

  // The Stytch session cookie is NAME-namespaced on the `.staging.tako.com`
  // zone (see `sessionCookieName`). Sending the default name there means Django
  // reads no cookie at all and 403s, which the caller surfaces as the
  // misleading "Your Tako sign-in expired." Table mirrors the `cases` in
  // tako's `app/backend/auth/stytch/cookie_name_contract.json`.
  const COOKIE_NAME_CASES: ReadonlyArray<readonly [string, string]> = [
    ["https://staging.tako.com", "stytch_session_jwt_staging"],
    ["https://developer.staging.tako.com", "stytch_session_jwt_staging"],
    ["https://tako.com", "stytch_session_jwt"],
    ["https://www.tako.com", "stytch_session_jwt"],
    ["https://developer.tako.com", "stytch_session_jwt"],
    ["http://localhost:8000", "stytch_session_jwt"],
    ["https://staging.trytako.com", "stytch_session_jwt"],
  ];

  for (const [base, expectedName] of COOKIE_NAME_CASES) {
    it(`sends the ${expectedName} cookie for ${base}`, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ key: "tako_sk_RAW" }), { status: 201 }));
      await mintTakoApiKey({ DJANGO_BASE_URL: base } as never, JWT, "Claude");
      const cookie = (fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>).cookie;
      expect(cookie).toBe(`${expectedName}=${JWT}`);
    });
  }

  it("rejects a malformed stytch JWT before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(mintTakoApiKey(env, "not-a-jwt", "Claude")).rejects.toBeInstanceOf(IdentityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
