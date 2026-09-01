#!/usr/bin/env tsx
/**
 * Golden-query harness: routing regression tests against a live deployment.
 *
 * The unit suite pins pure logic against fixtures. This pins the thing fixtures
 * cannot: that the tool still ROUTES correctly against the real graph. Every
 * routing bug fixed in this area was found by live calls and would have been
 * invisible to the unit tests — the gate promoting rank-2 noise over the right
 * metric, `label` leaking into the metric probe, `Employment Index` vouching
 * for itself through a broader alias.
 *
 * Design, and why it differs from `smoke.ts`:
 *   - smoke asserts the PROTOCOL works (handshake, tool list, every tool
 *     returns something). This asserts the ANSWERS are right.
 *   - Assertions are invariants, never fixtures: the retrieval backend is
 *     nondeterministic (identical tako_search requests returned 1, 2, then 1
 *     cards), so exact card sets would flake. Resolution IS deterministic, so
 *     that is what gets pinned.
 *   - Expectations are hand-checked (see golden-queries.ts). A token-overlap
 *     scorer was tried and measured to over-credit.
 *
 * Cost: the resolution cases are FREE (graph endpoints only). Only
 * EXECUTABLE_CASE_IDS spend priced calls, and that list is deliberately short.
 * Pass --free to skip them entirely.
 *
 * Usage:
 *   GOLDEN_BASE_URL=https://mcp.staging.tako.com \
 *     TAKO_GOLDEN_API_TOKEN=... npm run golden [-- --free]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { EXECUTABLE_CASE_IDS, GOLDEN_CASES, type GoldenCase } from "./golden-queries.js";

const rawBaseUrl = process.env.GOLDEN_BASE_URL ?? process.env.SMOKE_BASE_URL;
const apiToken = process.env.TAKO_GOLDEN_API_TOKEN ?? process.env.TAKO_SMOKE_API_TOKEN;
const freeOnly = process.argv.includes("--free");

if (!rawBaseUrl) {
  console.error("✘ GOLDEN_BASE_URL (or SMOKE_BASE_URL) is required");
  process.exit(1);
}
if (!apiToken) {
  console.error("✘ TAKO_GOLDEN_API_TOKEN (or TAKO_SMOKE_API_TOKEN) is required");
  process.exit(1);
}
const baseUrl = rawBaseUrl.replace(/\/+$/, "");

const failures: string[] = [];
const ok = (msg: string): void => console.log(`✓ ${msg}`);
const bad = (id: string, msg: string): void => {
  console.error(`✘ ${id}: ${msg}`);
  failures.push(`${id}: ${msg}`);
};

type Result = Awaited<ReturnType<Client["callTool"]>>;

const textOf = (result: Result): string => {
  const blocks = result.content as Array<{ type?: string; text?: string }> | undefined;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
};

const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

function checkCase(c: GoldenCase, result: Result): void {
  const text = textOf(result);
  const s = (result.structuredContent ?? {}) as {
    found?: boolean;
    next_call?: unknown;
    entity?: { name?: string } | null;
    metric?: { name?: string } | null;
  };
  const e = c.expect;

  if (e.entity !== undefined) {
    // The lookup path reports a resolved entity; the discovery path names it
    // in the rendered text instead.
    const got = s.entity?.name ?? text;
    if (!has(got, e.entity)) bad(c.id, `entity should contain ${JSON.stringify(e.entity)}, got ${JSON.stringify(s.entity?.name ?? text.slice(0, 80))}`);
  }
  if (e.metric !== undefined && !has(s.metric?.name ?? "", e.metric)) {
    bad(c.id, `metric should contain ${JSON.stringify(e.metric)}, got ${JSON.stringify(s.metric?.name)}`);
  }
  if (e.found !== undefined && s.found !== e.found) {
    bad(c.id, `found should be ${e.found}, got ${String(s.found)}`);
  }
  if (e.nextCall !== undefined && (s.next_call != null) !== e.nextCall) {
    bad(c.id, `next_call presence should be ${e.nextCall}, got ${s.next_call == null ? "null" : "present"}`);
  }
  for (const needle of e.absent ?? []) {
    if (has(text, needle)) bad(c.id, `text must NOT contain ${JSON.stringify(needle)}`);
  }
  for (const needle of e.present ?? []) {
    // next_call renders into the text as `tool: query`; the JSON fallback
    // still lets a needle target the structured handle directly.
    if (!has(text, needle) && !has(JSON.stringify(s.next_call ?? {}), needle)) {
      bad(c.id, `text must contain ${JSON.stringify(needle)}`);
    }
  }
  if (e.maxChars !== undefined && text.length > e.maxChars) {
    bad(c.id, `response is ${text.length} chars, over the ${e.maxChars} budget`);
  }
}

async function main(): Promise<void> {
  console.log(`golden target: ${baseUrl}${freeOnly ? " (free cases only)" : ""}`);
  const client = new Client({ name: "tako-golden", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiToken}` } },
  });
  // `as never` papers over the same SDK-vs-strict-TS tension smoke.ts hits:
  // the SDK's Transport declares `sessionId: string` while the streamable
  // client's is `string | undefined`, which exactOptionalPropertyTypes rejects.
  await client.connect(transport as never);

  for (const c of GOLDEN_CASES) {
    let result: Result;
    try {
      result = await client.callTool({ name: "tako_available_data", arguments: c.args });
    } catch (err) {
      bad(c.id, `call threw: ${String(err)}`);
      continue;
    }
    if (result.isError) {
      bad(c.id, `isError=true: ${textOf(result).slice(0, 120)}`);
      continue;
    }
    const before = failures.length;
    checkCase(c, result);
    if (failures.length === before) ok(`${c.id} — ${c.why.slice(0, 68)}`);
  }

  // Execute a few emitted next_calls verbatim. This is the contract the whole
  // pipeline rests on: the handle must actually retrieve. Priced, so short.
  if (!freeOnly) {
    for (const id of EXECUTABLE_CASE_IDS) {
      const c = GOLDEN_CASES.find((x) => x.id === id);
      if (!c) continue;
      const res = await client.callTool({ name: "tako_available_data", arguments: c.args });
      const nc = (res.structuredContent as { next_call?: { tool: string; query: string } | null } | undefined)?.next_call;
      if (nc == null) {
        bad(`${id}:exec`, "no next_call to execute");
        continue;
      }
      const out = await client.callTool({
        name: nc.tool,
        arguments: { query: nc.query, sources: ["data"] },
      });
      const cards = (textOf(out).match(/^### /gm) ?? []).length;
      // Zero cards is a legitimate outcome (the graph knows metrics that have
      // no card), so this asserts the call SUCCEEDS, not that data exists.
      if (out.isError) bad(`${id}:exec`, `next_call errored: ${textOf(out).slice(0, 120)}`);
      else ok(`${id}:exec — next_call ran verbatim → ${cards} cards`);
    }
  }

  await client.close();

  console.log("");
  if (failures.length > 0) {
    console.error(`✘ ${failures.length} golden failure(s):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log(`✓ all ${GOLDEN_CASES.length} golden cases passed`);
}

main().catch((err: unknown) => {
  console.error("✘ golden harness crashed:", err);
  process.exit(1);
});
