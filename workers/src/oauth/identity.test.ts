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

  it("rejects a malformed stytch JWT before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(mintTakoApiKey(env, "not-a-jwt", "Claude")).rejects.toBeInstanceOf(IdentityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
