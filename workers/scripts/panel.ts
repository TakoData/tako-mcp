#!/usr/bin/env tsx
/**
 * The MCP test panel: a local dashboard for exercising this server by hand.
 *
 * WHY THIS EXISTS, and what it tests that nothing else does:
 *   - `smoke` asserts the protocol works. `golden` asserts routing answers are
 *     right. Neither shows you WHAT THE MODEL SEES — and almost every fix in
 *     the routing work was a change to what the model sees (which channel a
 *     field rides in, how a coverage list is worded, whether a `next_call` is
 *     runnable). Reading that requires eyes, not assertions.
 *   - Agent mode is the only check that closes the loop: it hands Claude the
 *     server's REAL `instructions` (from the initialize handshake) and the REAL
 *     tool descriptions, then shows which tool it picked and with which
 *     arguments. That is the actual deliverable of the instruction work, and no
 *     unit test can cover it.
 *
 * Runs entirely locally and talks to whatever MCP target you point it at, so a
 * branch can be exercised end-to-end BEFORE it deploys anywhere: start
 * `wrangler dev`, point the panel at it, and you are driving the branch code
 * against the real backend.
 *
 * The panel is served from this process, so the browser only ever talks to its
 * own origin — no CORS, and no API token ever reaches the page. Tokens stay in
 * this process, read from the environment.
 *
 * Usage:
 *   npm run panel                      # serves http://localhost:8801
 *   PANEL_PORT=9000 npm run panel
 *
 * Environment (all optional — the panel degrades to whatever is present):
 *   TAKO_STAGING_API_KEY   auth for the local + staging targets
 *   TAKO_PROD_API_KEY      auth for the prod target
 *   LOCAL_MCP_URL          default http://localhost:8799
 *   ANTHROPIC_API_KEY      enables agent mode; raw mode works without it
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { GOLDEN_CASES } from "./golden-queries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PANEL_PORT ?? 8801);

// Claude's own default. Overridable from the panel; kept here so the default
// tracks the model the server is actually tuned against.
const DEFAULT_MODEL = "claude-opus-5";
const MAX_AGENT_TURNS = 8;

interface Target {
  id: string;
  label: string;
  url: string;
  token: string | undefined;
  /** True when calls here spend real money on a real account. */
  live: boolean;
}

/**
 * Targets are derived from the environment rather than hardcoded, so the panel
 * never offers a target it cannot authenticate — a 401 three clicks in reads
 * like a bug in the branch under test.
 */
function buildTargets(): Target[] {
  const staging = process.env.TAKO_STAGING_API_KEY;
  const prod = process.env.TAKO_PROD_API_KEY;
  return [
    {
      id: "local",
      label: "local wrangler dev (the branch you are on)",
      url: process.env.LOCAL_MCP_URL ?? "http://localhost:8799",
      token: staging,
      live: false,
    },
    {
      id: "staging",
      label: "mcp.staging.tako.com (deployed staging)",
      url: "https://mcp.staging.tako.com",
      token: staging,
      live: false,
    },
    {
      id: "prod",
      label: "mcp.tako.com (PRODUCTION — real spend)",
      url: "https://mcp.tako.com",
      token: prod,
      live: true,
    },
  ].filter((t) => t.token !== undefined || t.id === "local");
}

const TARGETS = buildTargets();
const targetById = (id: string): Target | undefined => TARGETS.find((t) => t.id === id);

// ---------------------------------------------------------------------------
// MCP connections
// ---------------------------------------------------------------------------

interface Connected {
  client: Client;
  instructions: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

/**
 * One live client per target, cached. Reconnecting per call would work but
 * hides a class of bug worth seeing: a server that only misbehaves on the
 * second call of a session.
 */
const pool = new Map<string, Connected>();

async function connect(target: Target): Promise<Connected> {
  const cached = pool.get(target.id);
  if (cached !== undefined) return cached;

  const client = new Client({ name: "tako-mcp-panel", version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (target.token !== undefined) headers.Authorization = `Bearer ${target.token}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${target.url}/mcp`), {
    requestInit: { headers },
  });
  // `as never`: the SDK's Transport declares `sessionId: string` while the
  // streamable client's is `string | undefined`, which
  // exactOptionalPropertyTypes rejects. Same cast smoke.ts and golden.ts use.
  await client.connect(transport as never);

  const listed = await client.listTools();
  const connected: Connected = {
    client,
    // The REAL server instructions, straight off the initialize handshake.
    // Feeding these to the model verbatim is what makes agent mode a test of
    // the instruction work rather than of a prompt written here.
    instructions: client.getInstructions() ?? "",
    tools: listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    })),
  };
  pool.set(target.id, connected);
  return connected;
}

/** Drop a cached connection so the next call reconnects (target restarted). */
function evict(id: string): void {
  const c = pool.get(id);
  pool.delete(id);
  void c?.client.close().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Reading a tool result
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const textOf = (result: ToolResult): string => {
  const blocks = result.content as Array<{ type?: string; text?: string }> | undefined;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
};

/**
 * Approximate token count. Deliberately labelled as approximate in the UI: the
 * exact number depends on the model's tokenizer, and shipping a wrong-but-
 * precise-looking figure is worse than an honest estimate. Agent mode shows
 * EXACT counts instead, because the API reports them.
 */
const approxTokens = (chars: number): number => Math.round(chars / 3.6);

/** Tako's own billed cost for a call, when the tool reports it. */
function takoCost(structured: unknown): number | null {
  const usage = (structured as { usage?: { total_cost_usd?: unknown } } | null | undefined)?.usage;
  const cost = usage?.total_cost_usd;
  return typeof cost === "number" ? cost : null;
}

interface CallReport {
  ok: boolean;
  isError: boolean;
  ms: number;
  text: string;
  chars: number;
  approx_tokens: number;
  structuredContent: unknown;
  structured_chars: number;
  /** Present so the panel can offer "run this verbatim" as one click. */
  next_call: unknown;
  cost_usd: number | null;
  error?: string;
}

async function callTool(
  target: Target,
  name: string,
  args: Record<string, unknown>,
): Promise<CallReport> {
  const started = Date.now();
  const blank = (): Omit<CallReport, "ok" | "error"> => ({
    isError: false, ms: Date.now() - started, text: "", chars: 0, approx_tokens: 0,
    structuredContent: null, structured_chars: 0, next_call: null, cost_usd: null,
  });
  let result: ToolResult;
  try {
    const { client } = await connect(target);
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    // A dead target is the common case (wrangler not running, or restarted).
    // Evict so the next attempt reconnects instead of reusing a dead socket.
    evict(target.id);
    return { ok: false, ...blank(), error: String(err) };
  }
  const text = textOf(result);
  const structured = result.structuredContent ?? null;
  const structuredJson = structured === null ? "" : JSON.stringify(structured, null, 2);
  return {
    ok: true,
    isError: result.isError === true,
    ms: Date.now() - started,
    text,
    chars: text.length,
    approx_tokens: approxTokens(text.length + structuredJson.length),
    structuredContent: structured,
    structured_chars: structuredJson.length,
    next_call: (structured as { next_call?: unknown } | null)?.next_call ?? null,
    cost_usd: takoCost(structured),
  };
}

// ---------------------------------------------------------------------------
// Agent mode: let Claude route, and watch what it picks
// ---------------------------------------------------------------------------

interface TraceStep {
  kind: "text" | "tool_call" | "stop";
  text?: string;
  tool?: string;
  input?: unknown;
  result?: {
    isError: boolean;
    ms: number;
    chars: number;
    cost_usd: number | null;
    next_call: unknown;
    preview: string;
  };
}

/**
 * Run one question through Claude with this server's tools attached.
 *
 * `includeStructured` is a real experiment knob, not a convenience: our design
 * puts the machine handles (node ids, `next_call`) in `structuredContent`, and
 * MCP clients differ on whether they forward it to the model. Turning it off
 * shows how the server behaves for a client that only passes the text channel —
 * which is the pessimistic case every instruction here has to survive.
 */
async function runAgent(
  target: Target,
  question: string,
  model: string,
  includeStructured: boolean,
): Promise<{ ok: boolean; error?: string; trace: TraceStep[]; tokens: { in: number; out: number }; cost_usd: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY is not set — add it to .env (it is gitignored) and restart the panel. Raw mode works without it.",
      trace: [], tokens: { in: 0, out: 0 }, cost_usd: 0,
    };
  }

  const { instructions, tools } = await connect(target);
  const trace: TraceStep[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: question },
  ];
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        // The server's OWN instructions as the system prompt — exactly the
        // channel a real MCP client puts them in.
        system: instructions,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages,
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`,
        trace, tokens: { in: tokensIn, out: tokensOut }, cost_usd: cost,
      };
    }
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    tokensIn += body.usage?.input_tokens ?? 0;
    tokensOut += body.usage?.output_tokens ?? 0;

    for (const block of body.content) {
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        trace.push({ kind: "text", text: block.text });
      }
    }
    if (body.stop_reason !== "tool_use") {
      trace.push({ kind: "stop", text: body.stop_reason });
      break;
    }

    messages.push({ role: "assistant", content: body.content });
    const toolResults: unknown[] = [];
    for (const block of body.content) {
      if (block.type !== "tool_use" || block.name === undefined) continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      const report = await callTool(target, block.name, args);
      cost += report.cost_usd ?? 0;
      trace.push({
        kind: "tool_call",
        tool: block.name,
        input: args,
        result: {
          isError: report.isError || !report.ok,
          ms: report.ms,
          chars: report.chars + report.structured_chars,
          cost_usd: report.cost_usd,
          next_call: report.next_call,
          preview: (report.error ?? report.text).slice(0, 600),
        },
      });
      // What the model gets back. Text always; structuredContent only when the
      // knob is on, mirroring how clients actually differ.
      const parts: string[] = [report.error ?? report.text];
      if (includeStructured && report.structuredContent !== null) {
        parts.push(`structuredContent:\n${JSON.stringify(report.structuredContent)}`);
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: parts.join("\n\n"),
        ...(report.isError || !report.ok ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { ok: true, trace, tokens: { in: tokensIn, out: tokensOut }, cost_usd: cost };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, unknown>;
};

/**
 * Presets come from the golden case set, so the panel always offers the exact
 * queries the regression suite pins — including the ones that used to fail
 * (poisoned aliases, nonsense phrases, swapped arguments). One source, so a new
 * golden case shows up here for free.
 */
const presets = GOLDEN_CASES.map((c) => ({
  id: c.id,
  why: c.why,
  tool: "tako_available_data",
  args: c.args as Record<string, unknown>,
}));

const server = createServer((req, res) => {
  void (async (): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = readFileSync(join(HERE, "panel.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        json(res, 200, {
          targets: TARGETS.map((t) => ({ id: t.id, label: t.label, url: t.url, live: t.live })),
          presets,
          agent_enabled: process.env.ANTHROPIC_API_KEY !== undefined,
          default_model: DEFAULT_MODEL,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/tools") {
        const { target: id } = await readBody(req);
        const target = targetById(String(id));
        if (target === undefined) return json(res, 400, { error: "unknown target" });
        try {
          const { tools, instructions } = await connect(target);
          json(res, 200, { tools, instructions });
        } catch (err) {
          evict(target.id);
          json(res, 200, { error: String(err), tools: [], instructions: "" });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/call") {
        const body = await readBody(req);
        const target = targetById(String(body.target));
        if (target === undefined) return json(res, 400, { error: "unknown target" });
        const name = String(body.name);
        const args = (body.arguments ?? {}) as Record<string, unknown>;
        json(res, 200, await callTool(target, name, args));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/agent") {
        const body = await readBody(req);
        const target = targetById(String(body.target));
        if (target === undefined) return json(res, 400, { error: "unknown target" });
        json(
          res,
          200,
          await runAgent(
            target,
            String(body.question ?? ""),
            String(body.model ?? DEFAULT_MODEL),
            body.include_structured !== false,
          ),
        );
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`\n  Tako MCP panel → http://localhost:${PORT}\n`);
  for (const t of TARGETS) {
    const auth = t.token === undefined ? "NO TOKEN" : "authed";
    console.log(`    ${t.id.padEnd(8)} ${t.url}  (${auth})`);
  }
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    console.log("\n    agent mode OFF — set ANTHROPIC_API_KEY to enable it (raw mode works without)\n");
  } else {
    console.log("\n    agent mode ON\n");
  }
});
