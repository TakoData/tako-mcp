import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLUGIN_DIR,
  PLUGIN_MANIFEST_PATH,
  SUBMISSION_PATH,
  packagedManifest,
  reviewTestCases,
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
