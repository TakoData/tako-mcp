import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { surfaceForPath } from "../src/surface.js";
import {
  CONNECTED_SERVER_URL,
  MCP_CONFIG_PATH,
  PLUGIN_DIR,
  PLUGIN_MANIFEST_PATH,
  SUBMISSION_PATH,
  packagedManifest,
  packagedMcpConfig,
  reviewTestCases,
  writePackageManifests,
  type McpConfig,
  type PluginManifest,
  type Submission,
  type SubmissionTestCase,
} from "./chatgpt-plugin.js";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_WIDTH_PX = 706;
const MIN_SCREENSHOT_HEIGHT_PX = 800;
const MAX_SCREENSHOT_HEIGHT_PX = 1720;

function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function submissionCase(overrides: Partial<SubmissionTestCase> = {}): SubmissionTestCase {
  return {
    description: "Look up a figure.",
    user_prompt: "Using Tako, what's Apple's market cap?",
    file_attachment_urls: null,
    tools_triggered: "tako_search",
    expected_output: "tako_search returns Apple's market cap.",
    expected_output_url: null,
    ...overrides,
  };
}

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    app_info: { subtitle: "Premium live data & web search" },
    test_cases: [submissionCase()],
    negative_test_cases: [
      submissionCase({
        description: "Don't trigger on a story.",
        user_prompt: "Write a bedtime story.",
        tools_triggered: null,
        expected_output: "The app isn't invoked.",
      }),
    ],
    ...overrides,
  };
}

function plugin(openai: Partial<PluginManifest["extensions"]["com.openai"]> = {}): PluginManifest {
  return {
    version: "1.0.0",
    extensions: {
      "com.openai": {
        interface: { shortDescription: "Tako", longDescription: "Tako.", defaultPrompt: [] },
        ...openai,
      },
    },
  };
}

function committedManifest(): PluginManifest {
  return JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, "utf8")) as PluginManifest;
}

function committedSubmission(): Submission {
  return JSON.parse(readFileSync(SUBMISSION_PATH, "utf8")) as Submission;
}

function committedMcpConfig(): McpConfig {
  return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")) as McpConfig;
}

function mcpConfig(urls: string[]): McpConfig {
  return {
    mcpServers: Object.fromEntries(
      urls.map((url, index) => [`server${index}`, { type: "streamable-http", url }]),
    ),
  };
}

describe("reviewTestCases", () => {
  it("renames the submission fields to the package's review fields", () => {
    expect(reviewTestCases(submission())).toEqual({
      positive: [
        {
          description: "Look up a figure.",
          prompt: "Using Tako, what's Apple's market cap?",
          tools_triggered: "tako_search",
          expected_behavior: "tako_search returns Apple's market cap.",
        },
      ],
      negative: [{ description: "Don't trigger on a story.", prompt: "Write a bedtime story." }],
    });
  });

  it("keeps attachment and output URLs when a case sets them", () => {
    const [positive] = reviewTestCases(
      submission({
        test_cases: [
          submissionCase({
            file_attachment_urls: ["https://example.com/data.csv"],
            expected_output_url: "https://example.com/answer",
          }),
        ],
      }),
    ).positive;
    expect(positive?.file_attachment_urls).toEqual(["https://example.com/data.csv"]);
    expect(positive?.expected_output_url).toBe("https://example.com/answer");
  });

  it("rejects a positive case that names no tool", () => {
    expect(() =>
      reviewTestCases(submission({ test_cases: [submissionCase({ tools_triggered: null })] })),
    ).toThrow(/tools_triggered/);
  });
});

describe("packagedManifest", () => {
  it("adds the test cases and keeps the rest of the review block", () => {
    const packaged = packagedManifest(
      plugin({ review: { demo_recording_url: "https://example.com/demo" } }),
      submission(),
    );
    expect(packaged.extensions["com.openai"].review).toEqual({
      demo_recording_url: "https://example.com/demo",
      test_cases: reviewTestCases(submission()),
    });
  });

  it("refuses a plugin.json that declares its own test cases", () => {
    expect(() =>
      packagedManifest(plugin({ review: { test_cases: { positive: [], negative: [] } } }), submission()),
    ).toThrow(/chatgpt-app-submission\.json/);
  });
});

describe("packagedMcpConfig", () => {
  it("accepts one server at the connected URL", () => {
    const config = mcpConfig([CONNECTED_SERVER_URL]);
    expect(packagedMcpConfig(config)).toEqual(config);
  });

  it("refuses a config with no servers", () => {
    expect(() => packagedMcpConfig(mcpConfig([]))).toThrow(/exactly one/);
  });

  it("refuses a config with two servers", () => {
    expect(() =>
      packagedMcpConfig(mcpConfig([CONNECTED_SERVER_URL, "https://mcp.tako.com/mcp"])),
    ).toThrow(/exactly one/);
  });

  it("refuses a server at another URL", () => {
    expect(() => packagedMcpConfig(mcpConfig(["https://mcp.tako.com/mcp/openai"]))).toThrow(
      /OpenAI support/,
    );
  });
});

describe("writePackageManifests", () => {
  it("writes plugin.json and mcp.json at the package root", () => {
    const stagingDir = mkdtempSync(join(tmpdir(), "chatgpt-plugin-"));
    try {
      writePackageManifests(stagingDir);
      expect(readdirSync(stagingDir).sort()).toEqual(["mcp.json", "plugin.json"]);
      expect(JSON.parse(readFileSync(join(stagingDir, "mcp.json"), "utf8"))).toEqual(
        committedMcpConfig(),
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

describe("committed ChatGPT plugin listing", () => {
  const listing = committedManifest().extensions["com.openai"].interface;

  it("packages without error", () => {
    expect(() => packagedManifest(committedManifest(), committedSubmission())).not.toThrow();
  });

  it("uses the same subtitle as chatgpt-app-submission.json", () => {
    expect(listing.shortDescription).toBe(committedSubmission().app_info.subtitle);
  });

  it("fits OpenAI's listing limits", () => {
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    expect(listing.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of listing.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
  });

  it("declares only the tako server at the connected URL, over Streamable HTTP with no headers", () => {
    expect(committedMcpConfig().mcpServers).toEqual({
      tako: { type: "streamable-http", url: CONNECTED_SERVER_URL },
    });
  });

  it("keeps the connected server URL on the chatgpt surface", () => {
    expect(
      surfaceForPath(new URL(CONNECTED_SERVER_URL).pathname),
      "OpenAI can't move the connected server through an upload; keep this path in MCP_PATHS",
    ).toBe("chatgpt");
  });

  it("points every screenshot at a packaged 2x PNG under 5 MiB", () => {
    for (const screenshot of listing.screenshots ?? []) {
      expect(screenshot).toMatch(/^\.\/assets\/.+\.png$/);
      const file = resolve(PLUGIN_DIR, screenshot);
      expect(existsSync(file), screenshot).toBe(true);
      expect(statSync(file).size).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
      const { width, height } = pngSize(file);
      expect(width, screenshot).toBe(SCREENSHOT_WIDTH_PX);
      expect(height, screenshot).toBeGreaterThanOrEqual(MIN_SCREENSHOT_HEIGHT_PX);
      expect(height, screenshot).toBeLessThanOrEqual(MAX_SCREENSHOT_HEIGHT_PX);
    }
  });
});
