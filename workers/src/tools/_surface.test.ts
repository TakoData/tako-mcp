/**
 * The widget exposure boundary, pinned end to end from User-Agent to
 * registered surface.
 *
 * The requirement this encodes: the chart widget and the tool that exists to
 * produce one (`tako_visualize`) reach the three hosts that render widgets
 * inline — ChatGPT, the ChatGPT desktop app (codex), and claude.ai / Claude
 * Desktop — and NOTHING else. Generic MCP clients keep the portable
 * inline-PNG path and must opt in explicitly with `?tools=visualize` if they
 * want the tool at all.
 *
 * Why a table and not per-case assertions: the boundary is enforced by two
 * separate things agreeing — `detectMcpClient`'s UA buckets and
 * `isWidgetClient`'s membership — and widening either one silently widens
 * the surface. A matrix makes an accidental widening show up as a diff on a
 * row that was supposed to say `false`.
 */
import { describe, expect, it } from "vitest";

import { detectMcpClient } from "../mcp.js";
import {
  isChatGptFamilyClient,
  isToolOnSurface,
  isWidgetClient,
} from "./_surface.js";
import type { McpClientKind } from "./types.js";

interface Row {
  ua: string;
  label: string;
  kind: McpClientKind;
  /** Receives widget `_meta` (and so is a candidate for default-on visualize). */
  widget: boolean;
}

const CLIENTS: Row[] = [
  { ua: "ChatGPT/1.0", label: "ChatGPT connector", kind: "chatgpt", widget: true },
  {
    ua: "ChatGPT/1.0 (+https://chatgpt.com)",
    label: "ChatGPT connector, long form",
    kind: "chatgpt",
    widget: true,
  },
  { ua: "openai-mcp/1.0", label: "OpenAI-family tooling", kind: "chatgpt", widget: true },
  {
    ua: "Claude-User/1.0",
    label: "claude.ai / Claude Desktop connector",
    kind: "claude",
    widget: true,
  },
  // Deliberately NOT a widget client: a terminal cannot render one, and the
  // `claude-code` check runs before the broad `claude` substring match for
  // exactly this reason. This row is the one most likely to be "fixed" by
  // mistake — the plugin ships to Claude Code, so it reads like an omission.
  {
    ua: "claude-code/2.1.220 (sdk-cli)",
    label: "Claude Code CLI / Agent SDK",
    kind: "unknown",
    widget: false,
  },
  // The ChatGPT desktop app renders the same interactive iframe as
  // chatgpt.com from its `codex-sandbox://` webview. Widget membership
  // DEPENDS on tako.com's `frame-ancestors` allowing the `codex-sandbox:`
  // scheme (TakoData/tako#29218) — on a backend without that deploy the
  // iframe is blocked and the app shows a grey tile, so don't revert that
  // header without flipping this row back to false.
  {
    ua: "codex-mcp-client/0.148.0-alpha.9",
    label: "ChatGPT desktop app / Codex runtime",
    kind: "codex",
    widget: true,
  },
  { ua: "cursor-vscode/1.0", label: "Cursor", kind: "unknown", widget: false },
  { ua: "Windsurf/1.0", label: "Windsurf", kind: "unknown", widget: false },
  { ua: "python-httpx/0.27.0", label: "generic HTTP client", kind: "unknown", widget: false },
  { ua: "", label: "no User-Agent", kind: "unknown", widget: false },
];

describe("widget exposure boundary", () => {
  for (const row of CLIENTS) {
    describe(`${row.label} (${row.ua === "" ? "no UA" : row.ua})`, () => {
      it(`classifies as "${row.kind}"`, () => {
        expect(detectMcpClient(row.ua)).toBe(row.kind);
      });

      it(`${row.widget ? "receives" : "is denied"} widget metadata`, () => {
        expect(isWidgetClient(detectMcpClient(row.ua))).toBe(row.widget);
      });

      it(`${row.widget ? "has" : "does not have"} tako_visualize by default`, () => {
        const kind = detectMcpClient(row.ua);
        expect(
          isToolOnSurface("tako_visualize", kind, new Set(), "authenticated"),
        ).toBe(row.widget);
      });
    });
  }

  it("exposes the widget to exactly three client kinds", () => {
    // Guards against a kind being added to `isWidgetClient` without anyone
    // revisiting what that means for the default surface. `"codex"` is a
    // member only because tako.com's `frame-ancestors` allows
    // `codex-sandbox:` (TakoData/tako#29218).
    const kinds: McpClientKind[] = ["chatgpt", "claude", "codex", "unknown"];
    expect(kinds.filter(isWidgetClient)).toEqual(["chatgpt", "claude", "codex"]);
  });

  it("puts exactly chatgpt and codex in the ChatGPT product family", () => {
    const kinds: McpClientKind[] = ["chatgpt", "claude", "codex", "unknown"];
    expect(kinds.filter(isChatGptFamilyClient)).toEqual(["chatgpt", "codex"]);
  });

  it("gives codex the full ChatGPT tool split", () => {
    // The desktop app is the same product as chatgpt.com on the tool
    // surface (verified live against the app 2026-08-13). Split pair in
    // when opted in, dispatch+poll agent out even when asked for:
    expect(
      isToolOnSurface("tako_agent_start", "codex", new Set(["tako_agent_start"]), "authenticated"),
    ).toBe(true);
    expect(
      isToolOnSurface("tako_agent_start", "unknown", new Set(["tako_agent_start"]), "authenticated"),
    ).toBe(false);
    expect(
      isToolOnSurface("tako_agent", "codex", new Set(["tako_agent"]), "authenticated"),
    ).toBe(false);
    // Anonymous family listing keeps the auth-gated submitted tool visible
    // so the host can offer link-account from the descriptor — a surface
    // `unknown` clients never see.
    expect(isToolOnSurface("tako_contents", "codex", new Set(), "free")).toBe(true);
    expect(isToolOnSurface("tako_contents", "unknown", new Set(), "free")).toBe(false);
  });

  it("lets a non-widget client opt in explicitly", () => {
    // The escape hatch stays open — denying the DEFAULT surface must not deny
    // the tool outright, or `?tools=visualize` would be a silent no-op.
    expect(
      isToolOnSurface(
        "tako_visualize",
        "unknown",
        new Set(["tako_visualize"]),
        "authenticated",
      ),
    ).toBe(true);
  });

  it("never exposes tako_visualize to an anonymous connection", () => {
    // Default-on is an OPT-IN gate concession, not a free-tier one: the
    // free-tier gate runs first, so no client — spoofed UA included — gets a
    // priced, card-minting write without authenticating. ChatGPT is the one
    // client that still LISTS it anonymously (for the link-account UI), and
    // `mcp.ts` blocks the call at dispatch.
    for (const kind of ["claude", "unknown"] as McpClientKind[]) {
      expect(isToolOnSurface("tako_visualize", kind, new Set(), "free")).toBe(
        false,
      );
      expect(
        isToolOnSurface("tako_visualize", kind, new Set(["tako_visualize"]), "free"),
      ).toBe(false);
    }
  });
});
