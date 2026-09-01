import { describe, expect, it } from "vitest";

import {
  CALLER_HEADER,
  type CallerStamp,
  callerUserAgent,
  serializeCallerHeader,
} from "./caller.js";

const BASE: CallerStamp = {
  surface: "generic",
  authMode: "oauth",
  serverVersion: "1.0.0",
};

describe("caller header", () => {
  it("names the header", () => {
    expect(CALLER_HEADER).toBe("X-Tako-Caller");
  });

  it("builds the worker User-Agent from the server version", () => {
    expect(callerUserAgent(BASE)).toBe("tako-mcp/1.0.0");
  });

  it("serializes the minimum stamp as channel, surface, tier", () => {
    expect(serializeCallerHeader(BASE)).toBe("channel=mcp, surface=generic, tier=oauth");
  });

  it("adds tool and a quoted client User-Agent when present", () => {
    expect(
      serializeCallerHeader({
        ...BASE,
        surface: "chatgpt",
        authMode: "anonymous",
        tool: "tako_search",
        clientUserAgent: "claude-code/1.2.3",
      }),
    ).toBe(
      'channel=mcp, surface=chatgpt, tier=anonymous, tool=tako_search, client_ua="claude-code/1.2.3"',
    );
  });

  it("escapes quotes and backslashes in the client User-Agent", () => {
    expect(serializeCallerHeader({ ...BASE, clientUserAgent: 'a "b" c\\d' })).toBe(
      'channel=mcp, surface=generic, tier=oauth, client_ua="a \\"b\\" c\\\\d"',
    );
  });

  it("replaces control characters and non-ASCII so a UA cannot inject a header or item", () => {
    const header = serializeCallerHeader({
      ...BASE,
      clientUserAgent: "evil\r\nX-Injected: 1, channel=direct, é",
    });
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header).toBe(
      'channel=mcp, surface=generic, tier=oauth, client_ua="evil  X-Injected: 1, channel=direct,  "',
    );
  });

  it("caps the client User-Agent at 200 characters", () => {
    const header = serializeCallerHeader({ ...BASE, clientUserAgent: "x".repeat(500) });
    const quoted = header.slice(header.indexOf('client_ua="') + 'client_ua="'.length, -1);
    expect(quoted).toHaveLength(200);
  });

  it("drops an empty client User-Agent instead of emitting an empty string", () => {
    expect(serializeCallerHeader({ ...BASE, clientUserAgent: "" })).toBe(
      "channel=mcp, surface=generic, tier=oauth",
    );
  });

  it("sanitizes a tool name to token characters", () => {
    expect(serializeCallerHeader({ ...BASE, tool: "weird tool,name" })).toContain(
      "tool=weird_tool_name",
    );
  });
});
