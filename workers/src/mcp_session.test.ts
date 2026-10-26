import { describe, expect, it } from "vitest";

import {
  initializeDeclaresUi,
  mintSessionId,
  sessionIdKind,
  sessionRendersUi,
} from "./mcp_session.js";

function initialize(capabilities: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities },
  };
}

const declaringInitialize = initialize({
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
});

describe("initializeDeclaresUi", () => {
  it("returns true when the initialize lists the MCP Apps mime type", () => {
    expect(initializeDeclaresUi(declaringInitialize)).toBe(true);
  });

  it.each([
    ["no extensions", initialize({})],
    [
      "a different mime type",
      initialize({
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } },
      }),
    ],
    [
      "mimeTypes as a string",
      initialize({
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: "text/html;profile=mcp-app" },
        },
      }),
    ],
    ["null extensions", initialize({ extensions: null })],
  ])("returns false for an initialize with %s", (_name, body) => {
    expect(initializeDeclaresUi(body)).toBe(false);
  });

  it.each([
    ["a tools/list request", { jsonrpc: "2.0", id: 2, method: "tools/list" }],
    ["a batch containing the initialize", [declaringInitialize]],
    ["undefined", undefined],
    ["a bare string", "initialize"],
  ])("returns undefined for %s", (_name, body) => {
    expect(initializeDeclaresUi(body)).toBeUndefined();
  });
});

describe("session ids", () => {
  it("mints a ui- id when the client renders UI", () => {
    expect(mintSessionId(true)).toMatch(/^ui-[0-9a-f-]{36}$/);
  });

  it("mints a noui- id when the client doesn't render UI", () => {
    expect(mintSessionId(false)).toMatch(/^noui-[0-9a-f-]{36}$/);
  });

  const cases: [string, string | null, boolean, string][] = [
    ["a ui id", mintSessionId(true), true, "ui"],
    ["a noui id", mintSessionId(false), false, "noui"],
    ["null", null, false, "absent"],
    ["an empty string", "", false, "absent"],
    ["an unrelated id", "abc", false, "other"],
    ["an uppercase prefix", "UI-x", false, "other"],
    ["a noui id that contains ui-", "noui-ui-x", false, "noui"],
  ];

  it.each(cases)("classifies %s", (_name, id, rendersUi, kind) => {
    expect(sessionRendersUi(id)).toBe(rendersUi);
    expect(sessionIdKind(id)).toBe(kind);
  });
});
