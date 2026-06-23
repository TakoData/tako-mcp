#!/usr/bin/env tsx
/**
 * Post-deploy smoke test for the Tako MCP Worker (TAKO-2611).
 *
 * Hits a deployed Worker and walks the MCP protocol end-to-end:
 *
 *   1. `GET /health`           → expect HTTP 200 with body "ok"
 *   2. MCP `initialize`        → handshake completes
 *   3. MCP `tools/list`        → 7-tool surface present; hard-asserts
 *                                 the 4 non-gated canary tools; loosely
 *                                 asserts at least one agent tool is present
 *   4. MCP Apps widget assertion on `tako_search` (soft-warn on miss)
 *   5. Per-tool MCP `tools/call` canaries (read-only):
 *        a. `tako_search "US GDP"`        — non-empty results
 *        b. `tako_answer "US GDP"`        — answer text returned
 *        c. `tako_contents {url from search}` — download_url returned
 *        d. `get_credit_balance`          — `details.credit_balance`
 *                                           must be a number or numeric string
 *
 * Excluded by design:
 *   - `tako_agent` / `tako_agent_start` / `tako_agent_wait` — long-running;
 *     presence is asserted in step 3 but the tools are not called
 *   - removed tools (reporting, chart-authoring) — see Tasks 2–3 cleanup
 *   - `explore_knowledge_graph` — removed in PR #47
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
 *                                 SMOKE_BASE_URL=https://mcp.staging.tako.com \
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

const CANARY_QUERY = "US GDP";

// Both env vars are required — no in-script defaults. The single source of
// truth for the staging URL is `STAGING_BASE_URL` in `workers-smoke.yml`;
// hard-coding it here too creates a stale-deployment hazard if the
// account/subdomain ever moves.
const rawBaseUrl = process.env.SMOKE_BASE_URL;
const apiToken = process.env.TAKO_SMOKE_API_TOKEN;

if (!rawBaseUrl) {
  console.error(
    "✘ SMOKE_BASE_URL env var is required (e.g. https://mcp.staging.tako.com)",
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
// 2-5. MCP protocol via the SDK client
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
  const requiredTools = ["tako_search", "tako_answer", "tako_contents", "get_credit_balance"];
  for (const required of requiredTools) {
    if (!toolNames.includes(required)) {
      fail(
        `tools/list does not include ${required} (got: ${toolNames.join(", ")})`,
      );
    }
  }
  ok(`tools/list → ${tools.length} tools (${toolNames.join(", ")})`);

  // Loose agent-presence check — the agent split is client-gated so the
  // smoke client's UA may register tako_agent (unsplit) or tako_agent_start
  // (split). We do NOT call agent tools — they run long.
  const hasAgent = toolNames.includes("tako_agent") || toolNames.includes("tako_agent_start");
  assert(hasAgent, `expected an agent tool in tools/list (got: ${toolNames.join(", ")})`);
  ok("agent tool present");

  // ----- MCP Apps wiring on tako_search ----------------------------------
  // The widget bundle must be advertised two ways: the tool listing carries
  // `_meta.ui.resourceUri`, and `resources/list` exposes a resource at that
  // URI with the MCP Apps mimeType. Without both, MCP Apps clients
  // (claude.ai, ChatGPT) silently fall back to the static-image path and
  // we lose the interactive embed. Soft-warn if either is missing rather
  // than failing — the smoke is still useful for the search/answer paths
  // even if the widget piece broke in this deploy.
  const searchTool = tools.find((t) => t.name === "tako_search");
  assert(searchTool, "tako_search missing from tools/list");
  const widgetUri = (searchTool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui
    ?.resourceUri;
  if (typeof widgetUri !== "string" || !widgetUri.startsWith("ui://")) {
    console.warn(
      `[warn] tako_search._meta.ui.resourceUri missing or not a ui:// URI ` +
        `(got: ${JSON.stringify(widgetUri)}) — inline chart render may be broken`,
    );
  } else {
    const { resources } = await client.listResources();
    const widget = resources.find((r) => r.uri === widgetUri);
    if (!widget) {
      console.warn(
        `[warn] resources/list does not include ${widgetUri} ` +
          `(got: ${resources.map((r) => r.uri).join(", ") || "<none>"})`,
      );
    } else if (widget.mimeType !== "text/html;profile=mcp-app") {
      console.warn(
        `[warn] widget ${widgetUri} mimeType is ${JSON.stringify(widget.mimeType)} ` +
          `(expected "text/html;profile=mcp-app")`,
      );
    } else {
      ok(`tako_search → MCP Apps widget at ${widgetUri} (${widget.mimeType})`);
    }
  }

  // ----- a) tako_search canary --------------------------------------
  const ksResult = await callOk(client, "tako_search", {
    query: CANARY_QUERY,
  });
  const ksStructured = ksResult.structuredContent as
    | {
        cards?: Array<{ card_id?: string | null; webpage_url?: string | null }>;
      }
    | undefined;
  assert(ksStructured, "tako_search missing structuredContent");
  const ksCards = ksStructured.cards;
  assert(
    Array.isArray(ksCards) && ksCards.length > 0,
    "tako_search returned no cards",
  );
  ok(`tako_search "${CANARY_QUERY}" → ${ksCards.length} cards`);

  // Capture the top card's webpage_url to chain into tako_contents below.
  const topResultUrl = ksCards[0]?.webpage_url;
  assert(
    typeof topResultUrl === "string" && topResultUrl.length > 0,
    "tako_search top card has no webpage_url to feed tako_contents",
  );

  // ----- b) tako_answer canary ------------------------------------------
  const taResult = await callOk(client, "tako_answer", {
    query: CANARY_QUERY,
  });
  const taStructured = taResult.structuredContent as
    | { answer?: string; cards?: unknown[]; web_results?: unknown[] }
    | undefined;
  assert(taStructured, "tako_answer missing structuredContent");
  assert(
    typeof taStructured.answer === "string" && taStructured.answer.length > 0,
    "tako_answer.answer is not a non-empty string",
  );
  ok(`tako_answer "${CANARY_QUERY}" → answer (${taStructured.answer.length} chars)`);

  // ----- c) tako_contents canary (chained from the top search result) ----
  const tcResult = await callOk(client, "tako_contents", { url: topResultUrl });
  const tcStructured = tcResult.structuredContent as
    | { download_url?: string; text?: string | null }
    | undefined;
  assert(tcStructured, "tako_contents missing structuredContent");
  assert(
    typeof tcStructured.download_url === "string" &&
      /^https?:\/\//.test(tcStructured.download_url),
    `tako_contents.download_url is not http(s): ${JSON.stringify(tcStructured?.download_url)}`,
  );
  ok(`tako_contents {url} → download_url present`);

  // ----- d) get_credit_balance ------------------------------------------
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
  // Reject empty / whitespace-only strings explicitly: `Number("")` and
  // `Number("   ")` both coerce to `0` (which Number.isFinite happily
  // accepts), which would otherwise let a backend bug return "" and look
  // like a real `0`-credit balance. DRF's DecimalField won't produce that
  // in practice, but the check is free.
  const balanceNumeric =
    typeof balance === "number"
      ? balance
      : typeof balance === "string" &&
          balance.trim() !== "" &&
          Number.isFinite(Number(balance))
        ? Number(balance)
        : null;
  assert(
    balanceNumeric !== null,
    `get_credit_balance.details.credit_balance is not a number or numeric string: ${JSON.stringify(balance)}`,
  );
  ok(`get_credit_balance → details.credit_balance=${balanceNumeric}`);
} finally {
  await client.close().catch(() => {
    // ignore close errors — we already have the answer we care about
  });
}

console.log("\n✅ smoke passed");
