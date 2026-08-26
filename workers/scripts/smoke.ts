#!/usr/bin/env tsx
/**
 * Post-deploy smoke test for the Tako MCP Worker (TAKO-2611).
 *
 * Hits a deployed Worker and walks the MCP protocol end-to-end:
 *
 *   1. `GET /health`           → expect HTTP 200 with body "ok"
 *   1b. Surface split           → anonymous /mcp/chatgpt 401s with a
 *                                 www-authenticate challenge; authenticated
 *                                 /mcp/chatgpt lists the submitted surface
 *                                 (securitySchemes + boolean idempotentHint);
 *                                 anonymous /mcp serves the auth-invariant
 *                                 listing and refuses tako_contents /
 *                                 include_contents:true with sign-in copy
 *                                 (soft-skipped when the target has no
 *                                 free-tier bindings, e.g. local wrangler dev)
 *   2. MCP `initialize`        → handshake completes
 *   3. MCP `tools/list`        → connects with every tool named in `?tools=`
 *                                 (an allowlist that REPLACES the defaults);
 *                                 hard-asserts the canary tools and that
 *                                 `tako_agent` is present
 *   4. MCP Apps widget assertion on `tako_search` (soft-warn on miss)
 *   5. Per-tool MCP `tools/call` canaries:
 *        a. `tako_search "US GDP"`        — non-empty results (read-only)
 *        a2. `tako_available_data "US GDP"` — summary + a match with node_id (read-only)
 *        b. `tako_answer "US GDP"`        — answer text returned (read-only)
 *        c. `tako_contents {url from search}` — inline data (default) + presigned download_url (mode:"url"), both read-only
 *        d. `tako_credit_balance`         — `details.credit_balance`
 *                                           must be a number or numeric string (read-only)
 *        e. `tako_visualize`              — creates a card (charges 1 credit)
 *   6. Native-card proxy on the card step 5e just created — all three of its
 *      routes, since the feature is only as live as its weakest one:
 *        - `/embed-html/`: 404 soft-warns (path gated off via `PUBLIC_CDN_URL`),
 *          200 hard-asserts inert content type, a nonzero CDN rewrite, no
 *          leaked `csrfToken`, and the presence of the data-proxy shim
 *        - `/cdn-asset/`: one rewritten asset is actually FETCHED, preferring
 *          the JS entry bundle
 *        - `/embed-data/{pub_id}`: called with a body shaped exactly like the
 *          card's own, asserting JSON with `component_data` back — and then
 *          called again with a non-empty `pub_id`, asserting 400, because that
 *          body would otherwise reach an upstream WRITE with no ownership check
 *
 * Step 6 is where the checks that catch a NO-ERROR-SIGNAL failure live, and
 * every one of them is here because that failure shipped:
 *   - a `PUBLIC_CDN_URL` naming the wrong CloudFront distribution answers 200,
 *     mounts the card, and draws no chart;
 *   - a missing or 502-ing `/embed-data/` draws the chart and then shows
 *     "There was an error loading the data." on every tab the page did not
 *     inline, which is most of them on a multi-tab card;
 *   - a relaxed pub_id gate is invisible from the outside until someone
 *     overwrites a card with it.
 *
 * Excluded by design:
 *   - `tako_agent` — long-running; presence is asserted in step 3 but the
 *     tool is not called
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

// Imported rather than spelled out, so the route this asserts against cannot
// drift from the route the worker serves and the shim points at.
import { EMBED_DATA_PREFIX } from "../src/embed_proxy.js";

// Imported for the same reason: the visualize step validates the deployed
// result against the tool's OWN `outputSchema`, so a field the tool stops
// advertising breaks this file's typecheck instead of only its post-deploy
// run. Reading a dropped field is exactly how this file's old `card_id`
// assert kept the deploy smoke red for 17 days after PR #210 removed it.
import takoVisualize from "../src/tools/tako_visualize.js";

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
// 1b. Surface split (spec 2026-08-25): /mcp is the generic surface with an
//     anonymous tier; /mcp/chatgpt requires OAuth. Raw JSON-RPC over fetch —
//     the SDK client is reserved for the authenticated walk below.
// ---------------------------------------------------------------------------
const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const rpc = (id: number, method: string, params: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

// (b) Anonymous /mcp/chatgpt → 401 challenge (never the free tier).
{
  const res = await fetch(`${baseUrl}/mcp/chatgpt`, {
    method: "POST",
    headers: JSON_RPC_HEADERS,
    body: rpc(1, "tools/list", {}),
  });
  assert(
    res.status === 401,
    `anonymous POST /mcp/chatgpt expected 401, got ${res.status}`,
  );
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert(
    challenge.includes("resource_metadata="),
    `/mcp/chatgpt 401 lacks a www-authenticate resource_metadata challenge (got ${JSON.stringify(challenge)})`,
  );
  ok("anonymous /mcp/chatgpt → 401 with www-authenticate challenge");
}

// (c) Authenticated /mcp/chatgpt lists the submitted surface with top-level
//     securitySchemes and explicit boolean idempotentHint on every tool.
{
  // `?tools=agent,answer` on the URL: the chatgpt listing is FIXED at
  // submission (spec D2), so the param must change nothing here.
  const res = await fetch(`${baseUrl}/mcp/chatgpt?tools=agent,answer`, {
    method: "POST",
    headers: { ...JSON_RPC_HEADERS, authorization: `Bearer ${apiToken}` },
    body: rpc(2, "tools/list", {}),
  });
  assert(res.status === 200, `authenticated /mcp/chatgpt tools/list → ${res.status}`);
  const body = (await res.json()) as {
    result?: {
      tools?: Array<{
        name: string;
        securitySchemes?: unknown;
        annotations?: { idempotentHint?: unknown };
      }>;
    };
  };
  const tools = body.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  const CHATGPT_EXPECTED = [
    "tako_available_data",
    "tako_contents",
    "tako_graph_related",
    "tako_search",
    "tako_visualize",
  ];
  assert(
    names.join(",") === CHATGPT_EXPECTED.join(","),
    `/mcp/chatgpt listing is not the submitted five tools (got: ${names.join(", ")})`,
  );
  for (const t of tools) {
    assert(
      Array.isArray(t.securitySchemes),
      `/mcp/chatgpt descriptor ${t.name} lacks top-level securitySchemes`,
    );
    assert(
      typeof t.annotations?.idempotentHint === "boolean",
      `/mcp/chatgpt descriptor ${t.name} lacks a boolean idempotentHint`,
    );
  }
  ok(
    `authenticated /mcp/chatgpt → ${names.length} tools (${names.join(", ")}), securitySchemes + idempotentHint on all`,
  );
}

// (a, d, e) Anonymous generic surface. Environments without the free-tier
// bindings (e.g. a bare local `wrangler dev` with no FREE_TIER_API_KEY
// secret) 401 anonymous requests by design — soft-skip there so the smoke
// stays runnable locally.
{
  const listRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: JSON_RPC_HEADERS,
    body: rpc(3, "tools/list", {}),
  });
  if (listRes.status === 401) {
    console.warn(
      "⚠ anonymous /mcp → 401 (free-tier bindings not configured on this target); skipping anonymous-surface asserts",
    );
  } else {
    assert(listRes.status === 200, `anonymous /mcp tools/list → ${listRes.status}`);
    const body = (await listRes.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name).sort();
    const expected = [
      "tako_available_data",
      "tako_contents",
      "tako_credit_balance",
      "tako_graph_related",
      "tako_search",
    ];
    assert(
      JSON.stringify(names) === JSON.stringify(expected),
      `anonymous /mcp listing is [${names.join(", ")}], expected [${expected.join(", ")}]`,
    );
    ok(`anonymous /mcp → auth-invariant listing (${names.join(", ")})`);

    const authRequiredKind = async (
      id: number,
      name: string,
      args: Record<string, unknown>,
    ): Promise<void> => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: JSON_RPC_HEADERS,
        body: rpc(id, "tools/call", { name, arguments: args }),
      });
      assert(res.status === 200, `anonymous ${name} call → HTTP ${res.status}`);
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          _meta?: Record<string, { kind?: string }>;
        };
      };
      assert(
        body.result?.isError === true &&
          body.result._meta?.["tako/error"]?.kind === "auth_required",
        `anonymous ${name} call expected the auth_required tool error, got ${JSON.stringify(body).slice(0, 300)}`,
      );
    };
    await authRequiredKind(4, "tako_contents", {
      url: "https://trytako.com/card/smoke",
    });
    ok("anonymous tako_contents → sign-in instructions (auth_required)");
    await authRequiredKind(5, "tako_search", {
      query: "US GDP",
      include_contents: true,
    });
    ok("anonymous tako_search include_contents:true → refused (auth_required)");
  }
}

// ---------------------------------------------------------------------------
// 2-5. MCP protocol via the SDK client
// ---------------------------------------------------------------------------
// Name every tool the smoke exercises: `?tools=` is an allowlist that
// replaces the defaults (spec D1), so a default tool left out here is not
// listed. This also smoke-tests the `?tools=` path itself.
const transport = new StreamableHTTPClientTransport(
  new URL(
    `${baseUrl}/mcp?tools=tako_search,tako_answer,tako_contents,tako_available_data,tako_visualize,tako_credit_balance,tako_graph_related,tako_agent`,
  ),
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
  const requiredTools = ["tako_search", "tako_answer", "tako_contents", "tako_available_data", "tako_visualize", "tako_credit_balance", "tako_graph_related"];
  for (const required of requiredTools) {
    if (!toolNames.includes(required)) {
      fail(
        `tools/list does not include ${required} (got: ${toolNames.join(", ")})`,
      );
    }
  }
  ok(`tools/list → ${tools.length} tools (${toolNames.join(", ")})`);

  // `tako_agent` is named in the allowlist above. We do NOT call it — it
  // runs long.
  const hasAgent = toolNames.includes("tako_agent");
  assert(hasAgent, `expected an agent tool in tools/list (got: ${toolNames.join(", ")})`);
  ok("agent tool present");

  // ----- MCP Apps wiring per surface --------------------------------------
  // The generic surface (/mcp, this client) must NOT declare widget
  // metadata — it ships the portable inline PNG instead (spec D14/D15).
  // The chatgpt surface's widget wiring is asserted below via raw fetch:
  // `_meta` carries the ui:// URI, and `resources/list` exposes a resource
  // at that URI with the MCP Apps mimeType.
  const searchTool = tools.find((t) => t.name === "tako_search");
  assert(searchTool, "tako_search missing from tools/list");
  const genericWidgetUri = (
    searchTool?._meta as { ui?: { resourceUri?: string } } | undefined
  )?.ui?.resourceUri;
  assert(
    genericWidgetUri === undefined,
    `generic /mcp listing declares widget metadata (${JSON.stringify(genericWidgetUri)}) — the widget belongs to /mcp/chatgpt only`,
  );
  ok("generic /mcp → no widget metadata (inline PNG path)");
  {
    const listRes = await fetch(`${baseUrl}/mcp/chatgpt`, {
      method: "POST",
      headers: { ...JSON_RPC_HEADERS, authorization: `Bearer ${apiToken}` },
      body: rpc(6, "tools/list", {}),
    });
    const listBody = (await listRes.json()) as {
      result?: {
        tools?: Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }>;
      };
    };
    const chatgptSearch = (listBody.result?.tools ?? []).find(
      (t) => t.name === "tako_search",
    );
    const widgetUri = chatgptSearch?._meta?.ui?.resourceUri;
    if (typeof widgetUri !== "string" || !widgetUri.startsWith("ui://")) {
      console.warn(
        `[warn] /mcp/chatgpt tako_search._meta.ui.resourceUri missing or not a ui:// URI ` +
          `(got: ${JSON.stringify(widgetUri)}) — inline chart render may be broken`,
      );
    } else {
      const resRes = await fetch(`${baseUrl}/mcp/chatgpt`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, authorization: `Bearer ${apiToken}` },
        body: rpc(7, "resources/list", {}),
      });
      const resBody = (await resRes.json()) as {
        result?: { resources?: Array<{ uri: string; mimeType?: string }> };
      };
      const widget = (resBody.result?.resources ?? []).find(
        (r) => r.uri === widgetUri,
      );
      if (!widget) {
        console.warn(
          `[warn] /mcp/chatgpt resources/list does not include ${widgetUri}`,
        );
      } else if (widget.mimeType !== "text/html;profile=mcp-app") {
        console.warn(
          `[warn] widget ${widgetUri} mimeType is ${JSON.stringify(widget.mimeType)} ` +
            `(expected "text/html;profile=mcp-app")`,
        );
      } else {
        ok(`/mcp/chatgpt → MCP Apps widget at ${widgetUri} (${widget.mimeType})`);
      }
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

  // ----- d) tako_credit_balance ------------------------------------------
  // Asserts `credit_balance` is present and either a number or a numeric
  // string (DRF can serialize DecimalField as either depending on
  // `coerce_to_string` — see the loose schema in tako_credit_balance.ts).
  // A rename or removal of the field on the backend produces a red smoke
  // instead of a green one with `<unset>` printed.
  const cbResult = await callOk(client, "tako_credit_balance", {});
  const cbStructured = cbResult.structuredContent as
    | { details?: Record<string, unknown> }
    | undefined;
  assert(cbStructured, "tako_credit_balance missing structuredContent");
  assert(
    cbStructured.details && typeof cbStructured.details === "object",
    "tako_credit_balance.details is not an object",
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
    `tako_credit_balance.details.credit_balance is not a number or numeric string: ${JSON.stringify(balance)}`,
  );
  ok(`tako_credit_balance → details.credit_balance=${balanceNumeric}`);

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
  const tvParsed = takoVisualize.outputSchema.safeParse(tvResult.structuredContent);
  assert(
    tvParsed.success,
    `tako_visualize structuredContent does not match its outputSchema: ` +
      JSON.stringify(tvParsed.error?.issues ?? []).slice(0, 400),
  );
  const tvStructured = tvParsed.data;
  // `pub_id`, not `card_id` — PR #210 dropped `card_id` from the schema
  // (OpenAI app review: one id in front of the model, not two) and `pub_id`
  // carries the identical string. Both are `.optional()` in `autoChainShape`,
  // so the parse above cannot assert presence; these two do.
  assert(
    typeof tvStructured.pub_id === "string" && tvStructured.pub_id.length > 0,
    "tako_visualize returned no pub_id",
  );
  assert(
    typeof tvStructured.embed_url === "string" && /^https?:\/\//.test(tvStructured.embed_url),
    `tako_visualize.embed_url is not http(s): ${JSON.stringify(tvStructured?.embed_url)}`,
  );
  ok(`tako_visualize → pub_id ${tvStructured.pub_id}`);

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
  // A 404 FAILS on a deployed env, and only warns off one.
  //
  // It was a warning everywhere in the first draft, which got this exactly
  // backwards: a 404 on `mcp.tako.com` is precisely the outcome that means the
  // binding never took effect — the whole subject of this check — and warnings
  // exit 0, so it would have been reported by a green job whose log nobody
  // opens. Both deployed envs now set `PUBLIC_CDN_URL`, so there is no
  // legitimate 404 there to cry wolf about. Off a deployed env (a local
  // `wrangler dev` with no binding) it stays a warning, because there the
  // absence is the expected configuration rather than a regression.
  const isDeployedTarget = /^https:\/\/mcp(\.staging)?\.tako\.com$/.test(baseUrl);
  // The two 404s are told apart by body, because conflating them would report
  // "feature off" for a live route: a declined route falls through to the
  // router's generic `not found`, while a live route whose pub_id did not
  // resolve upstream answers `chart not found` (`embed_proxy.ts`, the
  // `response.status === 404` branch). The latter stays a warning even on a
  // deployed env — it means the route IS serving, and the likeliest cause is lag
  // between creating a card and its embed page existing, which is not something
  // to redden a deploy over.
  const nativeRes = await fetch(
    `${baseUrl}/embed-html/${encodeURIComponent(tvStructured.pub_id)}`,
  );
  const nativeBody = await nativeRes.text();
  if (nativeRes.status === 404) {
    if (nativeBody.includes("chart not found")) {
      console.warn(
        `[warn] /embed-html/ → 404 "chart not found": the route is LIVE, but ` +
          `card ${tvStructured.pub_id} did not resolve upstream (likely lag ` +
          `between creating it and its embed page existing).`,
      );
    } else {
      // Deliberately does NOT name a cause. An ABSENT `PUBLIC_CDN_URL` and a
      // MALFORMED one produce byte-identical responses: `resolveProxyOrigins`
      // catches the throw from any resolver and declines, so the router answers
      // the same generic body either way. Since promoting this feature is
      // exactly "type a new URL into the production block", "set but broken" —
      // a single trailing slash will do it — is the likelier of the two, and
      // reporting it as a deliberate configuration choice would send the reader
      // the wrong way. The worker logs the real cause; the smoke cannot read
      // worker logs, so it points there instead of guessing.
      const why =
        `/embed-html/ → 404 "${nativeBody.trim()}": the native-card path is ` +
        `not serving here. PUBLIC_CDN_URL is either unset or malformed (both ` +
        `decline identically) — grep the worker log for "native-card proxy ` +
        `disabled" to tell which. Charts on claude.ai render as a static dark ` +
        `PNG, not an interactive host-themed card.`;
      if (isDeployedTarget) fail(why);
      console.warn(`[warn] ${why}`);
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
    // `/cdn-asset/` on THIS origin. Zero occurrences means the distribution in
    // `PUBLIC_CDN_URL` does not match the one this page references.
    //
    // Origin-qualified, not a bare `/cdn-asset/` substring. `rewriteCdnUrls`
    // writes `${widgetOrigin}${CDN_ASSET_PREFIX}` and `widgetOrigin` prefers the
    // `PUBLIC_MCP_URL` binding over the request origin — so a prod deploy
    // carrying a staging value would emit `https://mcp.staging.tako.com/cdn-asset/…`,
    // satisfy a bare substring check, and serve every asset in the widget from
    // the wrong worker. That is the same copy-paste class as the bug this PR
    // fixes, so the check names the origin it expects.
    const expectedPrefix = `${baseUrl}/cdn-asset/`;
    assert(
      nativeBody.includes(expectedPrefix),
      `/embed-html/ returned 200 but rewrote no CDN urls to ${expectedPrefix} — ` +
        `either PUBLIC_CDN_URL does not match the distribution this env's embed ` +
        `page references (prod: d12w4pyrrczi5e, staging: d1iyjvzoctsna), or ` +
        `PUBLIC_MCP_URL names a different worker. The card will mount and no ` +
        `chart will draw. See the worker log for the 0-rewrite warning.`,
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

    // Then actually FETCH one, because everything above is still only a claim
    // about a string. `embed_proxy.ts` calls these two routes "one feature" —
    // the page is useless without its assets — and until something retrieves an
    // asset, a syntactically valid, page-matching `PUBLIC_CDN_URL` behind a
    // distribution that does not serve `archive/` passes every check here and
    // still draws no chart.
    //
    // It also converts the count-flattened-to-a-boolean weakness above into
    // something with teeth. `ASSET_PATH_PREFIX` confinement is MEASURED, not
    // structural, so a frontend build that moves the entry bundle out of
    // `archive/` while leaving the fonts in would keep `rewrites > 0` and a
    // green check. Fetching the JS specifically — Card.js is the one asset whose
    // absence means no chart at all — is what notices.
    const assetUrls = [
      ...nativeBody.matchAll(
        new RegExp(`${expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\\s)]+`, "g"),
      ),
    ].map((m) => m[0]);
    assert(assetUrls.length > 0, `no rewritten asset urls to fetch`);
    // Prefer the JS entry bundle; fall back to the first asset when the naming
    // changes, so this degrades to "fetched something" rather than to a skip.
    const probeAsset = assetUrls.find((u) => u.endsWith(".js")) ?? assetUrls[0]!;
    const assetRes = await fetch(probeAsset);
    const assetPath = probeAsset.slice(baseUrl.length);
    assert(
      assetRes.status === 200,
      `rewritten asset ${assetPath} → ${assetRes.status}. The page rewrote its ` +
        `CDN urls, but this origin cannot actually serve them: PUBLIC_CDN_URL ` +
        `names a distribution that does not serve the "archive/" tree, or the ` +
        `asset moved out of it. The card mounts and no chart draws.`,
    );
    // `ACAO: *` is not cosmetic here: a module script is always a CORS fetch, so
    // without this header the widget's Card.js load fails even though the bytes
    // arrived. This is the exact header the proxy exists to add.
    assert(
      assetRes.headers.get("access-control-allow-origin") === "*",
      `rewritten asset ${assetPath} lacks "access-control-allow-origin: *" — a ` +
        `type="module" script is always a CORS fetch, so the widget cannot load ` +
        `it. Adding that header is this route's entire reason to exist.`,
    );
    ok(`/cdn-asset/ → 200 with ACAO:* for ${assetPath.slice(0, 72)}`);

    // Third leg: the card's own tab-data endpoint.
    //
    // This is the leg whose failure is loudest to a USER and completely silent
    // here without a check. The page inlines `component_data` for the tab it
    // opens on and fetches every other tab at click time. Everything above can
    // be green — page proxied, assets served, chart drawn — while eleven of the
    // Nvidia card's twelve tabs say "There was an error loading the data.",
    // which is exactly what shipped and what a user reported.
    //
    // Two distinct things to check, because either alone passes while broken:
    const dataUrl = `${baseUrl}${EMBED_DATA_PREFIX}${tvStructured.pub_id}`;
    assert(
      nativeBody.includes(dataUrl),
      `/embed-html/ served a page with no data-proxy shim pointing at ` +
        `${dataUrl}. Every tab the page did not inline will render "There was an ` +
        `error loading the data." — the card's own fetch resolves against the ` +
        `widget sandbox's origin without it.`,
    );

    // ...and then actually call it, the way `Card.js` does: POST the card's viz
    // config, which the page carries in its `config-json` island. A shim
    // pointing at a route that 502s upstream is the same user-visible failure as
    // no shim at all.
    const island =
      /<script id="config-json" type="application\/json">([\s\S]*?)<\/script>/.exec(
        nativeBody,
      );
    if (island === null) {
      // A `console.warn` alone would have turned this whole leg into a skip that
      // exits 0: an id change, an attribute reorder, or the proxy altering the
      // tag and every assertion below is silently not run while the job stays
      // green. That is the failure this file already argues against for the
      // `/embed-html/` 404 a few lines up, so it gets the same treatment.
      const why =
        `could not find the config-json island in the proxied page, so ` +
        `${EMBED_DATA_PREFIX} went unexercised — the leg that proves tabs load at ` +
        `all. The island is where Card.js reads the viz config it posts; if it ` +
        `was renamed, this check needs updating rather than deleting.`;
      if (isDeployedTarget) fail(why);
      console.warn(`[warn] ${why}`);
    } else {
      const config = JSON.parse(island[1]!) as { params?: unknown };
      assert(
        config.params !== undefined,
        `config-json island has no \`params\` — the body Card.js posts is built ` +
          `from it, so this check cannot speak for the real request shape`,
      );
      const dataRes = await fetch(dataUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `pub_id` is `window.frameElement?.id ?? ""` in the page, and that is
        // "" in every cross-origin embed — including the one ChatGPT renders,
        // where tabs work. So "" is the real shape, not a shortcut.
        body: JSON.stringify({ ...config.params, pub_id: "", dark_mode: false }),
      });
      const dataType = dataRes.headers.get("content-type") ?? "";
      assert(
        dataRes.status === 200,
        `${dataUrl} → ${dataRes.status} for a request shaped exactly like the ` +
          `card's own. A 413 means MAX_DATA_REQUEST_BYTES is under what a real ` +
          `viz config weighs; a 400 means the pub_id gate rejected a body the ` +
          `page itself would send; a 502 means the upstream ` +
          `/knowledge/get_data/ contract moved. Either way every non-initial tab ` +
          `shows an error.`,
      );
      assert(
        dataRes.headers.get("access-control-allow-origin") === "*",
        `${dataUrl} answered 200 without "access-control-allow-origin: *" ` +
          `— the widget cannot read it, which is the whole reason to proxy`,
      );
      assert(
        dataType.includes("application/json"),
        `${dataUrl} must answer JSON (Card.js calls .json() on it), got ` +
          `${JSON.stringify(dataType)}`,
      );
      const payload = (await dataRes.json()) as Record<string, unknown>;
      assert(
        "component_data" in payload,
        `${dataUrl} returned JSON with no \`component_data\` — the key the ` +
          `card renders from. The route is reachable and the contract has moved.`,
      );
      ok(`${EMBED_DATA_PREFIX} → 200 JSON with component_data, ACAO:*`);

      // And the write gate, which is the reason this route is safe to expose at
      // all. `/knowledge/get_data/` overwrites `ChartConfig.viz_config` for any
      // non-empty `pub_id` in the body, with no ownership check, `csrf_exempt`
      // and unauthenticated — and `ACAO: *` here removes the CORS allowlist that
      // otherwise keeps a drive-by page off it. Asserted post-deploy because
      // `findUpstreamWrite` passing its unit tests says nothing about whether the
      // build that is actually serving traffic still calls it.
      //
      // Safe to send: a refusal is the assertion. If this ever returns 200 the
      // card in the body would have been overwritten, which is why the body is
      // this card's OWN config — the one the smoke just created and does not
      // mind — rather than an arbitrary pub_id.
      const writeRes = await fetch(dataUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...config.params,
          pub_id: tvStructured.pub_id,
          dark_mode: false,
        }),
      });
      assert(
        writeRes.status === 400,
        `${dataUrl} accepted a body carrying a non-empty pub_id ` +
          `(${writeRes.status}, expected 400). That body reaches ` +
          `/knowledge/get_data/, which overwrites that card's stored viz_config ` +
          `and data with no ownership check — from any origin, since this route ` +
          `answers ACAO:*. The gate in findUpstreamWrite is not running in the ` +
          `deployed build.`,
      );
      ok(`${EMBED_DATA_PREFIX} → 400 on a non-empty pub_id (write gate holds)`);
    }
  }
} finally {
  await client.close().catch(() => {
    // ignore close errors — we already have the answer we care about
  });
}

console.log("\n✅ smoke passed");
