import { defineConfig } from "vitest/config";

// Third vitest project, for the build-script tests (scripts/*.test.ts).
//
// These existed and NEVER RAN. `vitest.config.ts` includes only
// `src/**/*.test.ts` (deliberately — its @cloudflare/vitest-pool-workers
// runtime cannot load the node APIs these scripts use) and
// `vitest.widget.config.ts` only `test/widget/**`, so
// `scripts/gen-registry.test.ts` and `scripts/gen-schemas.test.ts` matched
// neither glob. 20 assertions, including the llms-full.txt drift guard's own
// tests, silently dead — and they looked alive because `scripts/tsconfig.json`
// typechecks them.
//
// Plain node: these test pure functions over strings and JSON, and the scripts
// they cover run under tsx in CI, not in workerd.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    environment: "node",
  },
});
