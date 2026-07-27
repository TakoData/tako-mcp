import { defineConfig } from "vitest/config";

// Second vitest project for the widget DOM tests (test/widget/). The main
// suite runs inside @cloudflare/vitest-pool-workers, whose workerd runtime
// cannot load jsdom (Node APIs) — and the widget HTML can't execute inside
// workerd anyway. These tests run in plain Node and drive the widget
// script through jsdom instead, so the template-literal bundle that ships
// to claude.ai / ChatGPT actually EXECUTES in CI rather than being
// string-matched. Wired into `npm test` after the main suite.
export default defineConfig({
  test: {
    include: ["test/widget/**/*.test.ts"],
    environment: "node",
  },
});
