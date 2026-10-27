import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SubmissionTestCase = {
  description: string;
  user_prompt: string;
  file_attachment_urls: string[] | null;
  tools_triggered: string | null;
  expected_output: string;
  expected_output_url: string | null;
};

export type Submission = {
  app_info: { subtitle: string };
  test_cases: SubmissionTestCase[];
  negative_test_cases: SubmissionTestCase[];
};

export type PositiveReviewCase = {
  description: string;
  prompt: string;
  tools_triggered: string;
  expected_behavior: string;
  file_attachment_urls?: string[];
  expected_output_url?: string;
};

export type NegativeReviewCase = {
  description: string;
  prompt: string;
};

export type ReviewTestCases = {
  positive: PositiveReviewCase[];
  negative: NegativeReviewCase[];
};

export type OpenAiInterface = {
  shortDescription: string;
  longDescription: string;
  defaultPrompt: string[];
  screenshots?: string[];
};

export type OpenAiExtension = {
  interface: OpenAiInterface;
  review?: { test_cases?: ReviewTestCases; [key: string]: unknown };
  publication?: { release_notes?: string };
};

export type PluginManifest = {
  version: string;
  extensions: { "com.openai": OpenAiExtension };
  [key: string]: unknown;
};

export type McpServerEntry = {
  type: string;
  url: string;
  [key: string]: unknown;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>;
};

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const PLUGIN_DIR = resolve(REPO_ROOT, "chatgpt-plugin");
export const PLUGIN_MANIFEST_PATH = resolve(PLUGIN_DIR, "plugin.json");
export const MCP_CONFIG_PATH = resolve(PLUGIN_DIR, "mcp.json");
export const SUBMISSION_PATH = resolve(REPO_ROOT, "chatgpt-app-submission.json");
export const CONNECTED_SERVER_URL = "https://mcp.tako.com/mcp/chatgpt";

function positiveReviewCase(testCase: SubmissionTestCase): PositiveReviewCase {
  if (testCase.tools_triggered === null) {
    throw new Error(
      `chatgpt-app-submission.json: positive test case "${testCase.description}" has no tools_triggered, which OpenAI requires for a positive case`,
    );
  }
  return {
    description: testCase.description,
    prompt: testCase.user_prompt,
    tools_triggered: testCase.tools_triggered,
    expected_behavior: testCase.expected_output,
    ...(testCase.file_attachment_urls === null ? {} : { file_attachment_urls: testCase.file_attachment_urls }),
    ...(testCase.expected_output_url === null ? {} : { expected_output_url: testCase.expected_output_url }),
  };
}

export function reviewTestCases(submission: Submission): ReviewTestCases {
  return {
    positive: submission.test_cases.map(positiveReviewCase),
    negative: submission.negative_test_cases.map(({ description, user_prompt }) => ({
      description,
      prompt: user_prompt,
    })),
  };
}

export function packagedManifest(plugin: PluginManifest, submission: Submission): PluginManifest {
  const openai = plugin.extensions["com.openai"];
  if (openai.review?.test_cases !== undefined) {
    throw new Error(
      "chatgpt-plugin/plugin.json declares review.test_cases. Edit the test cases in chatgpt-app-submission.json instead; build.sh writes them into the package.",
    );
  }
  return {
    ...plugin,
    extensions: {
      ...plugin.extensions,
      "com.openai": {
        ...openai,
        review: { ...openai.review, test_cases: reviewTestCases(submission) },
      },
    },
  };
}

export function packagedMcpConfig(config: McpConfig): McpConfig {
  const servers = Object.values(config.mcpServers);
  const [server] = servers;
  if (server === undefined || servers.length > 1) {
    throw new Error(
      `chatgpt-plugin/mcp.json declares ${servers.length} MCP servers. The portal accepts plugin-level test cases only when the package declares exactly one.`,
    );
  }
  if (server.url !== CONNECTED_SERVER_URL) {
    throw new Error(
      `chatgpt-plugin/mcp.json declares ${server.url}, but the connected server is ${CONNECTED_SERVER_URL}. An upload can't change a connected server's URL; a new URL goes through OpenAI support.`,
    );
  }
  return config;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePackageManifests(stagingDir: string): void {
  const manifest = packagedManifest(
    readJson<PluginManifest>(PLUGIN_MANIFEST_PATH),
    readJson<Submission>(SUBMISSION_PATH),
  );
  const mcpConfig = packagedMcpConfig(readJson<McpConfig>(MCP_CONFIG_PATH));
  writeJson(resolve(stagingDir, "plugin.json"), manifest);
  writeJson(resolve(stagingDir, "mcp.json"), mcpConfig);
}

function main(): void {
  const stagingDir = process.argv[2];
  if (stagingDir === undefined) {
    throw new Error("usage: tsx scripts/chatgpt-plugin.ts <staging directory>");
  }
  writePackageManifests(stagingDir);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
