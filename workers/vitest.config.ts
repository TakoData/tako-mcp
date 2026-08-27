import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// `import.meta.url` is valid at runtime with module: "es2022" but TS's stock
// typings for ImportMeta don't include `.url` unless the node lib is pulled
// in. Cast locally to keep this config file free of @types/node.
const configDir = new URL(
  ".",
  (import.meta as unknown as { url: string }).url,
).pathname;

export default defineWorkersConfig({
  resolve: {
    // The MCP SDK statically imports `ajv` (its default JSON schema
    // validator). We pass in `CfWorkerJsonSchemaValidator` at runtime so the
    // Ajv code path is never exercised — but its module still has to load,
    // and ajv's CJS + `require("./refs/data.json")` pattern doesn't resolve
    // cleanly inside the vitest-pool-workers runtime. Aliasing to a noop
    // stub (whose default export is never constructed) sidesteps it.
    //
    // Production bundles via wrangler/esbuild handle the ajv import fine, so
    // this stub is test-only; if anything ever does try to construct the
    // stub it will throw loudly rather than silently misbehave.
    alias: [
      { find: /^ajv$/, replacement: `${configDir}test/stubs/ajv.mjs` },
      {
        find: /^ajv-formats$/,
        replacement: `${configDir}test/stubs/ajv-formats.mjs`,
      },
    ],
  },
  test: {
    // Scope to src/ explicitly: the widget DOM tests under test/widget/
    // run in a separate node-environment project (vitest.widget.config.ts)
    // because jsdom can't load inside the workers-pool runtime. Without
    // this include, vitest's default glob would pull them into this pool
    // and they'd fail on `require("jsdom")`.
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // One workerd instance per test file exhausts macOS's ephemeral port
        // range, so the second `npm test` inside a minute fails while every
        // test still passes. Each instance fetches every module from its own
        // module-fallback service over a fresh loopback connection with no
        // keep-alive - ~40 test files is ~10,000 sockets per run, parked in
        // TIME_WAIT for ~60s against a 16,384-port range (49152-65535).
        // connect() then fails as `No such module "node:vm"`, a missing
        // @vitest/mocker, or an ECONNREFUSED rejection at teardown - never as
        // a recognisable port error. CI is unaffected (fresh container).
        //
        // singleWorker shares one runtime and one module cache: ~10,000
        // sockets -> ~400, four back-to-back runs green, same wall time.
        // Tradeoff: module-level state now persists BETWEEN test files.
        singleWorker: true,
      },
    },
  },
});
