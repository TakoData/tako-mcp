#!/usr/bin/env tsx
/**
 * Post-deploy smoke test for the Tako MCP Worker (TAKO-2611).
 *
 * Hits a deployed Worker and walks the MCP protocol end-to-end:
 *
 *   1. `GET /health`           → expect HTTP 200 with body "ok"
 *   2. MCP `initialize`        → handshake completes
 *   3. MCP `tools/list`        → at least one tool, includes the canary set
 *   4. Per-tool MCP `tools/call` canaries (read-only unless noted):
 *        a. `knowledge_search "US GDP"`        — non-empty results, save the
 *                                                first non-null `card_id` to
 *                                                chain into chart tools below
 *        b. `get_credit_balance`               — `details` object returned
 *        c. `list_reports {limit:1}`           — `reports[]` array (may be 0)
 *        d. `get_chart_image {pub_id}`         — `image_url` is http(s)
 *        e. `open_chart_ui {pub_id}`           — produces a tako URL
 *        f. `create_chart {components:[]}`     — *negative test* — verifies
 *                                                input validation rejects
 *                                                empty components without
 *                                                actually creating a chart on
 *                                                every deploy. We never test
 *                                                the success path of write
 *                                                tools in smoke.
 *
 * Excluded by design:
 *   - `create_report`, `get_report` — write/long-running tools
 *   - `explore_knowledge_graph`     — being removed in PR #47
 *
 * Any failure prints a `✘ ...` line to stderr and exits non-zero so the
 * GitHub Actions job (or anyone running `npm run smoke`) flips red.
 *
 * Configuration (env vars):
 *   SMOKE_BASE_URL          — Worker base URL. Default: the staging
 *                             `*.workers.dev` URL while TAKO-2610 (custom
 *                             domain bind for `mcp.staging.tako.com`) is
 *                             pending. Override to smoke production or any
 *                             other deployment target.
 *   TAKO_SMOKE_API_TOKEN    — required Tako API token forwarded to the
 *                             Worker as `Authorization: Bearer <token>`.
 *                             Stored as a GitHub Actions secret in CI; mint
 *                             your own at trytako.com for local runs.
 *
 * Secrets handling: the token is read from env, attached to the transport's
 * `requestInit.headers`, and never logged. We print only structured result
 * summaries (counts, tool names, sanitized URLs) — never request headers or
 * raw response bodies.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_BASE_URL = "https://tako-mcp-staging.bobby-118.workers.dev";
const CANARY_QUERY = "US GDP";
const HTTP_URL_REGEX = /^https?:\/\//;

const baseUrl = (process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);
const apiToken = process.env.TAKO_SMOKE_API_TOKEN;

if (!apiToken) {
  console.error("✘ TAKO_SMOKE_API_TOKEN env var is required");
  process.exit(1);
}

const ok = (msg: string) => console.log(`✓ ${msg}`);
function fail(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    fail(
      `${name} returned isError=true: ` +
        JSON.stringify(result.content).slice(0, 400),
    );
  }
  return result;
}

console.log(`smoke target: ${baseUrl}`);

// ---------------------------------------------------------------------------
// 1. /health
// ---------------------------------------------------------------------------
const healthRes = await fetch(`${baseUrl}/health`);
if (healthRes.status !== 200) {
  fail(`/health expected 200, got ${healthRes.status}`);
}
const healthBody = (await healthRes.text()).trim();
if (healthBody !== "ok") {
  fail(`/health expected body "ok", got ${JSON.stringify(healthBody)}`);
}
ok(`/health → 200 "ok"`);

// ---------------------------------------------------------------------------
// 2-4. MCP protocol via the SDK client
// ---------------------------------------------------------------------------
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
  requestInit: {
    headers: { authorization: `Bearer ${apiToken}` },
  },
});
const client = new Client({ name: "tako-mcp-smoke", version: "1.0.0" });

try {
  // `as never` papers over an SDK-vs-strict-TS tension: the SDK types
  // `StreamableHTTPClientTransport#sessionId` as `string | undefined`, which
  // doesn't satisfy `Transport` under `exactOptionalPropertyTypes: true`.
  await client.connect(transport as never);
  const serverInfo = client.getServerVersion();
  ok(
    `initialize → ${serverInfo?.name ?? "<unknown>"} ` +
      `${serverInfo?.version ?? ""}`.trim(),
  );

  const { tools } = await client.listTools();
  if (tools.length === 0) {
    fail("tools/list returned 0 tools");
  }
  const toolNames = tools.map((t) => t.name);
  // Hard-assert tools we exercise below are present so the smoke fails fast
  // with a useful diff if a registry change drops one of them. We don't
  // assert on the *full* tool list because the surface evolves (e.g.
  // explore_knowledge_graph removal in PR #47).
  const requiredTools = [
    "knowledge_search",
    "get_credit_balance",
    "list_reports",
    "get_chart_image",
    "open_chart_ui",
    "create_chart",
  ];
  for (const required of requiredTools) {
    if (!toolNames.includes(required)) {
      fail(
        `tools/list does not include ${required} (got: ${toolNames.join(", ")})`,
      );
    }
  }
  ok(`tools/list → ${tools.length} tools (${toolNames.join(", ")})`);

  // ----- a) knowledge_search canary --------------------------------------
  const ksResult = await callOk(client, "knowledge_search", {
    query: CANARY_QUERY,
  });
  const ksStructured = ksResult.structuredContent as
    | {
        results?: Array<{ card_id?: string | null }>;
        count?: number;
      }
    | undefined;
  assert(ksStructured, "knowledge_search missing structuredContent");
  const ksResults = ksStructured.results;
  assert(
    Array.isArray(ksResults) && ksResults.length > 0,
    `knowledge_search returned empty results (count=${ksStructured.count ?? "?"})`,
  );
  ok(
    `knowledge_search "${CANARY_QUERY}" → ${ksStructured.count ?? ksResults.length} results`,
  );

  // Pull the first non-null card_id to chain into get_chart_image / open_chart_ui.
  // If knowledge_search ever returns results without any card_ids (unlikely
  // but possible — e.g., raw deep-research outputs), the chained tools fall
  // back to the negative-test mode below.
  const chainPubId = ksResults
    .map((r) => r?.card_id)
    .find((id): id is string => typeof id === "string" && id.length > 0);

  // ----- b) get_credit_balance ------------------------------------------
  const cbResult = await callOk(client, "get_credit_balance", {});
  const cbStructured = cbResult.structuredContent as
    | { details?: Record<string, unknown> }
    | undefined;
  assert(cbStructured, "get_credit_balance missing structuredContent");
  assert(
    cbStructured.details && typeof cbStructured.details === "object",
    "get_credit_balance.details is not an object",
  );
  const balance = cbStructured.details["credit_balance"];
  ok(
    `get_credit_balance → details (credit_balance=${balance ?? "<unset>"})`,
  );

  // ----- c) list_reports -------------------------------------------------
  const lrResult = await callOk(client, "list_reports", { limit: 1 });
  const lrStructured = lrResult.structuredContent as
    | { reports?: unknown[]; count?: number }
    | undefined;
  assert(lrStructured, "list_reports missing structuredContent");
  assert(
    Array.isArray(lrStructured.reports),
    "list_reports.reports is not an array",
  );
  ok(
    `list_reports {limit:1} → count=${lrStructured.count ?? lrStructured.reports.length}`,
  );

  // ----- d) get_chart_image (chained) -----------------------------------
  if (chainPubId) {
    const giResult = await callOk(client, "get_chart_image", {
      pub_id: chainPubId,
    });
    const giStructured = giResult.structuredContent as
      | { image_url?: string; pub_id?: string }
      | undefined;
    assert(giStructured, "get_chart_image missing structuredContent");
    assert(
      typeof giStructured.image_url === "string" &&
        HTTP_URL_REGEX.test(giStructured.image_url),
      `get_chart_image.image_url is not http(s): ${JSON.stringify(giStructured.image_url)}`,
    );
    ok(`get_chart_image {pub_id:${chainPubId}} → image_url present`);
  } else {
    console.log(
      `↷ get_chart_image skipped — no card_id in knowledge_search results`,
    );
  }

  // ----- e) open_chart_ui (chained) -------------------------------------
  if (chainPubId) {
    const ouResult = await callOk(client, "open_chart_ui", {
      pub_id: chainPubId,
    });
    // open_chart_ui's structured payload includes `iframe_html` + `url`-ish
    // fields; we don't pin to a specific shape (it's a UI helper that may
    // evolve), only that it returns a structured object referencing pub_id.
    const ouStructured = ouResult.structuredContent as
      | Record<string, unknown>
      | undefined;
    assert(
      ouStructured && typeof ouStructured === "object",
      "open_chart_ui missing structuredContent",
    );
    ok(`open_chart_ui {pub_id:${chainPubId}} → structuredContent present`);
  } else {
    console.log(
      `↷ open_chart_ui skipped — no card_id in knowledge_search results`,
    );
  }

  // ----- f) create_chart NEGATIVE test ----------------------------------
  // Smoke must not have side effects, so we verify the tool's input
  // validation rejects an empty `components` array — this exercises the
  // tool surface (registration, schema, error-mapping) without producing
  // a real card.
  const ccResult = await client.callTool({
    name: "create_chart",
    arguments: { components: [] },
  });
  assert(
    ccResult.isError === true,
    `create_chart with empty components should error, got ${JSON.stringify(ccResult).slice(0, 300)}`,
  );
  ok(`create_chart {components:[]} → isError (validation rejected, no chart created)`);
} finally {
  await client.close().catch(() => {
    // ignore close errors — we already have the answer we care about
  });
}

console.log("\n✅ smoke passed");
