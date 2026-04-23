/**
 * Test-only stub for `ajv`.
 *
 * The MCP SDK imports `ajv` statically as its default JSON schema validator,
 * but we always pass `CfWorkerJsonSchemaValidator` so the default is never
 * constructed. ajv's CJS + `require("./refs/data.json")` pattern trips up
 * the vitest-pool-workers module loader, so we alias it to this stub.
 *
 * If anything ever does try to construct it during a test, we throw loudly
 * instead of silently running a broken validator.
 */
export default class AjvStub {
  constructor() {
    throw new Error(
      "ajv stub: the MCP SDK's Ajv validator was instantiated in a Workers test runtime. " +
        "Ensure McpServer is constructed with { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }.",
    );
  }
}
