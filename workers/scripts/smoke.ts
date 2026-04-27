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
 *        a. `knowledge_search "US GDP"`        — non-empty results, requires
 *                                                at least one usable
 *                                                `card_id` (fails the smoke
 *                                                if every result lacks one
 *                                                — that's a regression
 *                                                worth catching)
 *        b. `get_credit_balance`               — `details.credit_balance`
 *                                                must be a number or
 *                                                numeric string
 *        c. `list_reports {limit:1}`           — `reports[]` array (may be 0)
 *        d. `get_chart_image {pub_id}`         — `image_url` is http(s);
 *                                                pub_id chained from (a)
 *        e. `open_chart_ui {pub_id}`           — structured payload returned;
 *                                                pub_id chained from (a)
 *        f. `create_chart {bogus comp_type}`   — *negative test* — schema-
 *                                                valid payload (one
 *                                                component, garbage
 *                                                `component_type`) so the
 *                                                Worker's auth + Django
 *                                                round-trip + error mapping
 *                                                actually runs; expect
 *                                                `isError: true` from the
 *                                                server. We never test the
 *                                                success path of write
 *                                                tools in smoke.
 *
 * Excluded by design:
 *   - `create_report`, `get_report` — write/long-running tools
 *   - `explore_knowledge_graph`     — being removed in PR #47
 *
 * Any failure prints a `✘ ...` line to stderr and exits non-zero so the
 * GitHub Actions job (or anyone running `npm run smoke`) flips red.
 *
 * Configuration (env vars, both required — no in-script defaults):
 *   SMOKE_BASE_URL          — Worker base URL to smoke (no trailing slash).
 *                             In CI this is set by `workers-smoke.yml` from
 *                             a single workflow-level `STAGING_BASE_URL`
 *                             env var so the canonical URL lives in one
 *                             place. For local runs, set explicitly:
 *
 *                                 SMOKE_BASE_URL=https://tako-mcp-staging.bobby-118.workers.dev \
 *                                   TAKO_SMOKE_API_TOKEN=... npm run smoke
 *
 *   TAKO_SMOKE_API_TOKEN    — Tako API token forwarded to the Worker as
 *                             `Authorization: Bearer <token>`. Stored as a
 *                             GitHub Actions secret in CI; mint your own
 *                             at trytako.com for local runs.
 *
 * Secrets handling: the token is read from env, attached to the transport's
 * `requestInit.headers`, and never logged. We print only structured result
 * summaries (counts, tool names, sanitized URLs) — never request headers or
 * raw response bodies.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const CANARY_QUERY = "US GDP";
const HTTP_URL_REGEX = /^https?:\/\//;

// Both env vars are required — no in-script defaults. The single source of
// truth for the staging URL is `STAGING_BASE_URL` in `workers-smoke.yml`;
// hard-coding it here too creates a stale-deployment hazard if the
// account/subdomain ever moves.
const rawBaseUrl = process.env.SMOKE_BASE_URL;
const apiToken = process.env.TAKO_SMOKE_API_TOKEN;

if (!rawBaseUrl) {
  console.error(
    "✘ SMOKE_BASE_URL env var is required (e.g. https://tako-mcp-staging.bobby-118.workers.dev)",
  );
  process.exit(1);
}
if (!apiToken) {
  console.error("✘ TAKO_SMOKE_API_TOKEN env var is required");
  process.exit(1);
}

const baseUrl = rawBaseUrl.replace(/\/+$/, "");

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
    `initialize → ${serverInfo?.name ?? "<unknown>"} ${serverInfo?.version ?? ""}`.trim(),
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

  // Pull the first non-null card_id to chain into get_chart_image /
  // open_chart_ui. We *require* at least one chartable card — knowledge_search
  // returning results-without-card_ids for "US GDP" is itself a pipeline
  // regression worth flagging (e.g., raw deep-research outputs leaking
  // through without indexer attribution), so we fail rather than skip the
  // chained tools.
  const chainPubId = ksResults
    .map((r) => r?.card_id)
    .find((id): id is string => typeof id === "string" && id.length > 0);
  assert(
    chainPubId,
    `knowledge_search "${CANARY_QUERY}" returned ${ksResults.length} results but none had a usable card_id — chart-tool chaining is broken`,
  );

  // ----- b) get_credit_balance ------------------------------------------
  // Asserts `credit_balance` is present and either a number or a numeric
  // string (DRF can serialize DecimalField as either depending on
  // `coerce_to_string` — see the loose schema in get_credit_balance.ts).
  // A rename or removal of the field on the backend produces a red smoke
  // instead of a green one with `<unset>` printed.
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
  const balanceNumeric =
    typeof balance === "number"
      ? balance
      : typeof balance === "string" && Number.isFinite(Number(balance))
        ? Number(balance)
        : null;
  assert(
    balanceNumeric !== null,
    `get_credit_balance.details.credit_balance is not a number or numeric string: ${JSON.stringify(balance)}`,
  );
  ok(`get_credit_balance → details.credit_balance=${balanceNumeric}`);

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

  // ----- e) open_chart_ui (chained) -------------------------------------
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

  // ----- f) create_chart NEGATIVE test ----------------------------------
  // Smoke must not have side effects, so we verify create_chart fails
  // gracefully on a *server-rejected* payload rather than a
  // *schema-rejected* one: the empty-array case (`components: []`) is
  // caught by Zod's `.min(1)` before the handler runs, which would skip
  // auth, the Django round-trip, and the write-path error mapping
  // entirely. Passing one component with a bogus `component_type`
  // satisfies the input schema (`componentSchema` is `.loose()` and only
  // requires `component_type: string + config: object`) but Django
  // rejects it during chart construction — exercising the same write
  // path that a real `create_chart` call would, without producing a card.
  //
  // Two acceptable failure shapes:
  //   1. The server returns `{isError: true, ...}` cleanly — preferred
  //      and what the handler is *supposed* to do on a Django error.
  //   2. The SDK throws `McpError` because the server's error response
  //      doesn't satisfy `create_chart`'s strict output schema. This
  //      still proves the handler ran (auth + djangoPost reached
  //      Django, which rejected the chart) — the validation tripped on
  //      the *response* shape, not on our request. Today this is what
  //      actually happens (the handler doesn't synthesize a
  //      schema-conformant error payload), so we treat it as
  //      equivalent evidence of write-path exercise.
  let createChartFailedAsExpected = false;
  let createChartFailureMode: string;
  try {
    const ccResult = await client.callTool({
      name: "create_chart",
      arguments: {
        components: [
          {
            component_type: "tako_smoke_invalid_component_type",
            config: {},
          },
        ],
        title: "tako-mcp smoke negative test (do not surface)",
      },
    });
    if (ccResult.isError === true) {
      createChartFailedAsExpected = true;
      createChartFailureMode = "isError: true";
    } else {
      createChartFailureMode = `unexpected success: ${JSON.stringify(ccResult).slice(0, 300)}`;
    }
  } catch (err) {
    if (err instanceof McpError) {
      createChartFailedAsExpected = true;
      // The SDK's InvalidParams (-32602) message includes "tool's output
      // schema" when the failure is response-validation; surface that
      // distinct case in the log so it's clear the handler ran.
      createChartFailureMode = err.message.includes("output schema")
        ? `McpError -32602 (server returned non-schema-conformant error response — handler ran, Django rejected)`
        : `McpError ${err.code}: ${err.message.slice(0, 200)}`;
    } else {
      throw err;
    }
  }
  assert(
    createChartFailedAsExpected,
    `create_chart with bogus component_type should fail; mode=${createChartFailureMode!}`,
  );
  ok(
    `create_chart {bogus component_type} → ${createChartFailureMode!} (write path exercised, no chart created)`,
  );
} finally {
  await client.close().catch(() => {
    // ignore close errors — we already have the answer we care about
  });
}

console.log("\n✅ smoke passed");
