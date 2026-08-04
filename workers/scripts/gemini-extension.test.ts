/**
 * Guards on the Gemini CLI extension: `gemini-extension.json`, the `commands/`
 * TOML files, and the context file they point at.
 *
 * Why this needs its own guard rather than a careful review: the Gemini CLI
 * extension surface fails SILENTLY in three separate places, all verified
 * against the loader source (google-gemini/gemini-cli, `extension-manager.ts`
 * and `services/FileCommandLoader.ts`):
 *
 *   1. A `commands/*.toml` file that fails `@iarna/toml` parsing, or that is
 *      missing the required `prompt` key, is SKIPPED. `parseAndAdaptFile`
 *      returns null and the command simply never appears. Same shape as the
 *      SKILL.md frontmatter bug guarded in `skills.test.ts`: dead on every
 *      install, nothing in CI to say so.
 *   2. `contextFileName` is resolved and then `.filter(existsSync)`, so a typo in
 *      the path drops the extension's entire context with no error.
 *   3. An `mcpServers.*.headers` value is the dangerous one, and the reason
 *      assertion `serves the free tier with no credentials` exists. Extension
 *      configs get `${VAR}` env substitution, and an UNSET variable resolves to
 *      the literal string `${VAR}` (see `utils/envVarResolver.ts`:
 *      "Missing: $UNDEFINED_VAR // Returns $UNDEFINED_VAR"). Sending
 *      `Authorization: Bearer ${TAKO_API_KEY}` at mcp.tako.com was probed live
 *      and returns **401** `Bearer token contains invalid characters
 *      (RFC 6750 §2.1 b64token)`; `Bearer ` (empty) returns 401 `Bearer token
 *      is empty`. Either one takes the server from "3 free tools, works with
 *      zero setup" to "completely broken until the user finds and sets an env
 *      var". No credentials at all returns 200 with the three free tools. So
 *      the correct config has NO headers block, and the tempting improvement,
 *      "add an Authorization header wired to a `settings` entry so users can
 *      paste a token", is the specific regression this test blocks. The token
 *      path is `/mcp auth tako` (OAuth, auto-discovered via the server's
 *      WWW-Authenticate + DCR endpoints) or a hand-added header in the user's
 *      own `~/.gemini/settings.json`.
 *
 * Also pinned here: `name`, because two separate things derive from it and
 * neither is the repo name. The install directory is
 * `~/.gemini/extensions/<name>` (`new ExtensionStorage(newExtensionName)`), and
 * the gallery id is `@<owner>/<name>`. The scaffolding advice to rename the
 * repo to match is unnecessary: 687 of the 1,398 entries in
 * geminicli.com/extensions.json have `extensionName !== repo name`.
 *
 * Runs under the `scripts` vitest project (plain node, filesystem access).
 */
import fs from "node:fs";
import path from "node:path";

import toml from "@iarna/toml";
import { describe, expect, it } from "vitest";

/** Repo root. This file lives at `workers/scripts/`. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const COMMANDS_DIR = path.join(REPO_ROOT, "commands");

interface GeminiExtensionManifest {
  name?: string;
  version?: string;
  description?: string;
  contextFileName?: string;
  mcpServers?: Record<
    string,
    { httpUrl?: string; url?: string; headers?: Record<string, string> }
  >;
}

function manifest(): GeminiExtensionManifest {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "gemini-extension.json"), "utf8"),
  ) as GeminiExtensionManifest;
}

function commandFileNames(): string[] {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((entry) => entry.endsWith(".toml"))
    .sort();
}

describe("gemini extension manifest", () => {
  const version = fs
    .readFileSync(path.join(REPO_ROOT, "version.txt"), "utf8")
    .trim();

  it("sits at the absolute repo root", () => {
    // The gallery crawler and `gemini extensions install <repo>` both read the
    // manifest from the repo root only; in a subdirectory it is invisible.
    expect(
      fs.existsSync(path.join(REPO_ROOT, "gemini-extension.json")),
    ).toBe(true);
  });

  it("declares a name the loader accepts, and that names the install dir", () => {
    const name = manifest().name;
    expect(name).toBe("tako");
    // `validateName` in extension-manager.ts throws on anything else.
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it("pins the manifest to the released version", () => {
    // release-please bumps this via `extra-files`, same as plugin.json. A
    // manual edit that skips it ships a gallery card with a stale version.
    expect(manifest().version).toBe(version);
  });

  it("carries a description for the gallery card", () => {
    const description = manifest().description ?? "";
    expect(description.length).toBeGreaterThan(40);
    // A sanity ceiling, not a style rule. Gallery descriptions run to a median
    // of 88 chars with real entries near 290, and ours is a deliberate ~400 to
    // carry both halves of the product, so this only catches a runaway paste.
    expect(description.length).toBeLessThan(600);
  });

  it("sells both halves of the product, not just the data", () => {
    // The first draft of this description led with "data your agent cannot get
    // from the open web", which reads as "this is not a web search tool":
    // wrong on the product and inconsistent with `registry/metadata.json`,
    // which leads with web search. Tako searches proprietary data AND the full
    // web in the same call (`sources` defaults to ["data","web"] in
    // `tako_search.ts`), and the gallery card is the one line most people read
    // before deciding, so it has to carry both.
    const description = (manifest().description ?? "").toLowerCase();
    expect(description).toContain("web search");
    expect(description).toMatch(/licensed|proprietary/);
  });

  it("points its MCP server at the production endpoint", () => {
    expect(manifest().mcpServers?.tako?.httpUrl).toBe(
      "https://mcp.tako.com/mcp",
    );
  });

  it("serves the free tier with no credentials", () => {
    // See the header comment: any headers block here resolves to a malformed
    // Bearer token for users who have not set the env var, and mcp.tako.com
    // 401s the whole connection instead of falling back to anonymous.
    for (const [name, server] of Object.entries(manifest().mcpServers ?? {})) {
      expect(server.headers, `${name} must not send headers`).toBeUndefined();
    }
  });

  it("points contextFileName at a file that exists", () => {
    const declared = manifest().contextFileName;
    expect(declared).toBeDefined();
    // `${/}` is the platform path separator, hydrated at config load time.
    const relative = declared!.replaceAll("${/}", path.sep);
    expect(fs.existsSync(path.join(REPO_ROOT, relative))).toBe(true);
  });
});

describe("gemini extension commands", () => {
  it("ships the three Tako commands", () => {
    expect(commandFileNames()).toEqual([
      "chart.toml",
      "coverage.toml",
      "data.toml",
    ]);
  });

  for (const fileName of commandFileNames()) {
    describe(fileName, () => {
      const raw = fs.readFileSync(path.join(COMMANDS_DIR, fileName), "utf8");

      it("parses with the loader's own TOML parser", () => {
        // Gemini CLI uses @iarna/toml 2.2.5 and silently skips files it
        // cannot parse, so parse with the same library rather than eyeballing.
        expect(() => toml.parse(raw)).not.toThrow();
      });

      it("declares a non-empty prompt and description", () => {
        const parsed = toml.parse(raw) as {
          prompt?: unknown;
          description?: unknown;
        };
        // `prompt` is required by TomlCommandDefSchema; without `description`
        // the command lists as "Custom command from <file>.toml".
        expect(typeof parsed.prompt).toBe("string");
        expect((parsed.prompt as string).trim().length).toBeGreaterThan(0);
        expect(typeof parsed.description).toBe("string");
        expect((parsed.description as string).trim().length).toBeGreaterThan(0);
      });

      it("consumes the user's argument", () => {
        const { prompt } = toml.parse(raw) as { prompt: string };
        // Without the placeholder the loader appends the raw args instead of
        // injecting them, so a command written as a template silently ignores
        // where the author meant the question to land.
        expect(prompt).toContain("{{args}}");
      });

      it("does not trip shell or file injection", () => {
        const { prompt } = toml.parse(raw) as { prompt: string };
        // `!{...}` runs a shell command (confirmation prompt), `@{...}` reads a
        // file. Neither is intended in these prompts.
        expect(prompt).not.toContain("!{");
        expect(prompt).not.toContain("@{");
      });
    });
  }
});

describe("gemini extension skills", () => {
  it("exposes the same bundled skills Claude Code ships", () => {
    // Gemini discovers `SKILL.md` and `*/SKILL.md` under the extension's
    // `skills/` directory, which is the very directory the Claude plugin uses, so the
    // three research skills ride along with no duplication. Frontmatter
    // validity is guarded in `skills.test.ts`.
    const discovered = fs
      .readdirSync(path.join(REPO_ROOT, "skills"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(
            path.join(REPO_ROOT, "skills", entry.name, "SKILL.md"),
          ),
      )
      .map((entry) => entry.name)
      .sort();
    expect(discovered).toEqual([
      "tako-financial-research",
      "tako-macroeconomics",
      "tako-web-traffic",
    ]);
  });
});
