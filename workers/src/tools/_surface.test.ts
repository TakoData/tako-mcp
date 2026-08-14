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

  // A per-kind expected-membership TABLE, not a filtered list: a fifth kind
  // added to the union in types.ts fails COMPILATION here until someone
  // writes down BOTH of its memberships — with the previous
  // `.filter(...).toEqual([...])` shape, satisfying the compiler only took
  // `newkind: true` in a fixture and the new kind landed silently on the
  // unknown surface (review finding on PR #239). Per-kind assertions are
  // also insertion-order independent, so reordering this literal can't
  // fail without a behavior change.
  //
  // The memberships gate different things and genuinely diverge (claude):
  // `widget` = receives widget `_meta` + default-on `tako_visualize`;
  // `family` = the ChatGPT product surface (agent split, anonymous
  // discoverable listing, securitySchemes injection). `codex` is a widget
  // member only because tako.com's `frame-ancestors` allows
  // `codex-sandbox:` (TakoData/tako#29218) AND the flip was validated live
  // against the desktop app.
  const EXPECTED_MEMBERSHIP: Record<
    McpClientKind,
    { widget: boolean; family: boolean }
  > = {
    chatgpt: { widget: true, family: true },
    claude: { widget: true, family: false },
    codex: { widget: true, family: true },
    unknown: { widget: false, family: false },
  };

  for (const [kind, expected] of Object.entries(EXPECTED_MEMBERSHIP) as Array<
    [McpClientKind, { widget: boolean; family: boolean }]
  >) {
    it(`membership table: ${kind} widget=${expected.widget} family=${expected.family}`, () => {
      expect(isWidgetClient(kind)).toBe(expected.widget);
      expect(isChatGptFamilyClient(kind)).toBe(expected.family);
    });
  }

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
