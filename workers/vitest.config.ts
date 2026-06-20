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
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
