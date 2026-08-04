#!/usr/bin/env tsx
/**
 * Post-deploy smoke test for the Tako MCP Worker (TAKO-2611).
 *
 * Hits a deployed Worker and walks the MCP protocol end-to-end:
 *
 *   1. `GET /health`           → expect HTTP 200 with body "ok"
 *   2. MCP `initialize`        → handshake completes
 *   3. MCP `tools/list`        → connects with `?tools=agent,visualize,credits,graph`
 *                                 (those tools are opt-in — see `_optional.ts`);
 *                                 hard-asserts the canary tools incl. the three
 *                                 graph primitives; loosely asserts at least
 *                                 one agent tool is present
 *   4. MCP Apps widget assertion on `tako_search` (soft-warn on miss)
 *   5. Per-tool MCP `tools/call` canaries:
 *        a. `tako_search "US GDP"`        — non-empty results (read-only)
 *        a2. `tako_available_data "US GDP"` — summary + a match with node_id (read-only)
 *        b. `tako_answer "US GDP"`        — answer text returned (read-only)
 *        c. `tako_contents {url from search}` — inline data (default) + presigned download_url (mode:"url"), both read-only
 *        d. `get_credit_balance`          — `details.credit_balance`
 *                                           must be a number or numeric string (read-only)
 *        e. `tako_visualize`              — creates a card (charges 1 credit)
 *   6. Native-card proxy (`/embed-html/`) on the card step 5e just created —
 *      404 soft-warns (path gated off via `PUBLIC_CDN_URL`), 200 hard-asserts
 *      inert content type, a nonzero CDN rewrite, and no leaked `csrfToken`
 *
 * The step-6 rewrite assertion is the one check here that exists to catch a
 * failure with NO error signal: a `PUBLIC_CDN_URL` naming the wrong CloudFront
 * distribution answers 200, mounts the card, and draws no chart.
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
// Opt in to the optional tools the smoke exercises (see `_optional.ts`):
// `agent` for the agent-presence assert, `visualize` and `credits` for the
// tool calls below, `graph` for the primitives' presence assert. This also
// smoke-tests the `?tools=` opt-in path itself.
const transport = new StreamableHTTPClientTransport(
  new URL(`${baseUrl}/mcp?tools=agent,visualize,credits,graph`),
  {
    requestInit: {
      headers: { authorization: `Bearer ${apiToken}` },
    },
  },
);
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
  const requiredTools = ["tako_search", "tako_answer", "tako_contents", "tako_available_data", "tako_visualize", "get_credit_balance", "tako_graph_search", "tako_graph_related", "tako_graph_node"];
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

  // ----- a2) tako_available_data canary ---------------------------------
  // Free graph pipeline (search → related). Assert the natural-language
  // summary and at least one resolved match with a node_id.
  const adResult = await callOk(client, "tako_available_data", {
    q: CANARY_QUERY,
  });
  const adStructured = adResult.structuredContent as
    | {
        found?: boolean;
        summary?: string;
        matches?: Array<{ node_id?: string }>;
      }
    | undefined;
  assert(adStructured, "tako_available_data missing structuredContent");
  // The prose summary and the coverage-name lists render into the TEXT
  // channel; structuredContent carries the machine handles (found,
  // matches[].node_id, next_call). Assert each where it actually lives.
  const adText = (adResult.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  assert(adText.length > 0, "tako_available_data returned empty text");
  assert(
    Array.isArray(adStructured.matches) && adStructured.matches.length > 0 &&
      typeof adStructured.matches[0]?.node_id === "string",
    "tako_available_data returned no matches with a node_id",
  );
  ok(`tako_available_data "${CANARY_QUERY}" → ${adStructured.matches.length} matches with node_ids`);

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
  // Default mode is "inline": the card's CSV comes back in `data` (20-row
  // default; raise max_rows up to 2,000), with download_url null.
  const tcInline = await callOk(client, "tako_contents", { url: topResultUrl });
  // tako_contents is BATCHED: the payload rides in `results[]`, one entry per
  // requested url, with `cost` at the envelope root. Reading `.data` off the
  // root predates that change and always came back undefined.
  const tcInlineStructured = tcInline.structuredContent as
    | { cost?: number; results?: Array<{ data?: string | null; total_rows?: number | null; download_url?: string | null }> }
    | undefined;
  assert(tcInlineStructured, "tako_contents (inline) missing structuredContent");
  const tcFirst = tcInlineStructured.results?.[0];
  assert(
    typeof tcFirst?.data === "string" && tcFirst.data.length > 0,
    `tako_contents inline mode returned no data: ${JSON.stringify(tcInlineStructured)?.slice(0, 160)}`,
  );
  ok(`tako_contents {url} → inline data present (${tcFirst?.total_rows ?? "?"} rows)`);

  // mode:"url" returns a short-lived presigned download link instead.
  const tcUrl = await callOk(client, "tako_contents", { url: topResultUrl, mode: "url" });
  const tcUrlStructured = tcUrl.structuredContent as
    | { results?: Array<{ download_url?: string | null }> }
    | undefined;
  assert(tcUrlStructured, "tako_contents (url) missing structuredContent");
  const tcUrlFirst = tcUrlStructured.results?.[0];
  assert(
    typeof tcUrlFirst?.download_url === "string" &&
      /^https?:\/\//.test(tcUrlFirst.download_url),
    `tako_contents.download_url is not http(s): ${JSON.stringify(tcUrlFirst?.download_url)}`,
  );
  ok(`tako_contents {url, mode:"url"} → download_url present`);

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

  // ----- e) tako_visualize canary (creates a tiny card; CHARGES 1 CREDIT) ----
  const tvResult = await callOk(client, "tako_visualize", {
    title: "MCP smoke test",
    components: [
      { component_type: "header", config: { title: "MCP smoke test" } },
      {
        component_type: "categorical_bar",
        config: {
          datasets: [
            { label: "Smoke", units: "USD", data: [{ x: "A", y: 1 }, { x: "B", y: 2 }] },
          ],
        },
      },
    ],
  });
  const tvStructured = tvResult.structuredContent as
    | { card_id?: string; embed_url?: string }
    | undefined;
  assert(tvStructured, "tako_visualize missing structuredContent");
  assert(
    typeof tvStructured.card_id === "string" && tvStructured.card_id.length > 0,
    "tako_visualize returned no card_id",
  );
  assert(
    typeof tvStructured.embed_url === "string" && /^https?:\/\//.test(tvStructured.embed_url),
    `tako_visualize.embed_url is not http(s): ${JSON.stringify(tvStructured?.embed_url)}`,
  );
  ok(`tako_visualize → card_id ${tvStructured.card_id}`);

  // -------------------------------------------------------------------------
  // 6. Native-card proxy — the interactive/themed chart path on claude.ai
  // -------------------------------------------------------------------------
  // Why this is asserted post-deploy rather than left to unit tests: its
  // defining failure mode is SILENCE. `PUBLIC_CDN_URL` naming the wrong
  // CloudFront distribution rewrites zero urls, the proxy still answers 200,
  // the card still mounts, and no chart ever draws — a break with no error
  // anywhere. Unit tests cannot see it because the value under test is the
  // deployed binding, and the widget's own failure log lands in a sandboxed
  // iframe console nobody reads. So the deployed page is the only place the
  // question can be asked.
  //
  // Reuses the card `tako_visualize` just created, so there is no hardcoded
  // pub_id fixture to rot.
  //
  // 404 is NOT a failure, and that distinction is the point. The route is
  // gated on `PUBLIC_CDN_URL`, so a 404 can mean the native-card path is
  // switched off in this environment — a legitimate configuration (local dev,
  // or a deliberate rollback), not a regression. Failing on it would make the
  // smoke cry wolf about a choice. What DOES fail is 200-but-broken: the route
  // is live and answering, yet the rewrite it exists to perform did not happen.
  //
  // The two 404s are told apart by body, because conflating them would report
  // "feature off" for a live route: a declined route falls through to the
  // router's generic `not found`, while a live route whose pub_id did not
  // resolve upstream answers `chart not found` (`embed_proxy.ts`, the
  // `response.status === 404` branch). Both stay warnings — the second is most
  // likely lag between creating the card and its embed page existing, which is
  // not something to redden a deploy over.
  const nativeRes = await fetch(
    `${baseUrl}/embed-html/${encodeURIComponent(tvStructured.card_id)}`,
  );
  const nativeBody = await nativeRes.text();
  if (nativeRes.status === 404) {
    if (nativeBody.includes("chart not found")) {
      console.warn(
        `[warn] /embed-html/ → 404 "chart not found": the route is LIVE, but ` +
          `card ${tvStructured.card_id} did not resolve upstream (likely lag ` +
          `between creating it and its embed page existing).`,
      );
    } else {
      console.warn(
        `[warn] /embed-html/ → 404 "${nativeBody.trim()}": the native-card ` +
          `path is OFF here (PUBLIC_CDN_URL unset). Charts on claude.ai ` +
          `render as a static dark PNG, not an interactive host-themed card.`,
      );
    }
  } else {
    assert(
      nativeRes.status === 200,
      `/embed-html/ expected 200 or 404, got ${nativeRes.status} (${nativeBody.trim().slice(0, 120)})`,
    );
    // Inert content type is a security invariant, not a nicety: this is the
    // OAuth origin, so the proxy must never hand the browser a document it
    // will execute. A drift to text/html here is a real regression.
    const nativeType = nativeRes.headers.get("content-type") ?? "";
    assert(
      nativeType.includes("text/plain"),
      `/embed-html/ must answer text/plain on the OAuth origin, got ${JSON.stringify(nativeType)}`,
    );
    // The rewrite is what makes the card renderable: Card.js is a
    // `type="module"` script, always a CORS fetch, and the CDN reflects CORS
    // for tako.com alone — so every asset url must be pointed back at
    // `/cdn-asset/`. Zero occurrences means the distribution in
    // `PUBLIC_CDN_URL` does not match the one this page references.
    assert(
      nativeBody.includes("/cdn-asset/"),
      `/embed-html/ returned 200 but rewrote no CDN urls — PUBLIC_CDN_URL ` +
        `does not match the distribution this env's embed page references ` +
        `(prod: d12w4pyrrczi5e, staging: d1iyjvzoctsna). The card will mount ` +
        `and no chart will draw. See the worker log for the 0-rewrite warning.`,
    );
    // Belt-and-braces, stated honestly: the handler already refuses to serve a
    // body whose `csrfToken` it failed to strip (`embed_proxy.ts`, the
    // `!removedCsrf && html.includes("csrfToken")` 502), so on a correct build
    // this can never fire. It is here to catch a DEPLOY of a build where that
    // gate regressed — the one thing a unit test cannot check, since it asserts
    // against source rather than against what is actually serving traffic.
    assert(
      !nativeBody.includes("csrfToken"),
      `/embed-html/ leaked a csrfToken into a body bound for a third-party sandbox`,
    );
    ok(`/embed-html/ → 200 text/plain, CDN urls rewritten, no csrfToken`);
  }
} finally {
  await client.close().catch(() => {
    // ignore close errors — we already have the answer we care about
  });
}

console.log("\n✅ smoke passed");
