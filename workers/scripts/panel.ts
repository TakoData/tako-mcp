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

/**
 * Load `.env` ourselves.
 *
 * Nothing in this repo sources `.env` for a plain `npm run` — wrangler reads its
 * own vars and the other scripts expect keys already exported. So a key sitting
 * in `.env` reached this process only if you remembered to export it by hand,
 * which meant "I added the key" and "agent mode is off" were true at the same
 * time. Reading the file here removes that whole class of confusion.
 *
 * Existing environment wins: an explicitly exported key must beat the file, so
 * `ANTHROPIC_API_KEY=... npm run panel` still overrides.
 */
const originalEnv = new Map(Object.entries(process.env));
const loadedEnvFiles: string[] = [];
for (const candidate of [join(HERE, "..", "..", ".env"), join(HERE, "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
    // Put back anything the file overwrote that was already set explicitly.
    for (const [key, value] of originalEnv) process.env[key] = value;
    loadedEnvFiles.push(candidate);
  } catch {
    // Absent or unreadable: not an error, the vars may simply be exported.
  }
}

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
// Agent mode: let Claude route, and watch every step of it
// ---------------------------------------------------------------------------

/**
 * A `next_call` this server handed the model, kept so the next tool call can be
 * checked against it.
 *
 * This is the single most useful thing the panel reports. The whole
 * discovery-to-fetch design rests on the model running the emitted handle
 * VERBATIM — and the failure mode is silent: the model reads the handle, then
 * issues its own almost-identical call without `strict`, which is the variant
 * measured to do nothing. Watching for that is the difference between "the
 * instructions look right" and "the instructions work".
 */
interface PendingHandle {
  fromTool: string;
  call: { tool?: string; query?: string; node_ids?: string[]; strict?: boolean };
}

type Adherence = "verbatim" | "deviated" | "ignored" | null;

/** Did this call run the pending handle as issued? */
function checkAdherence(
  pending: PendingHandle | null,
  toolName: string,
  args: Record<string, unknown>,
): { adherence: Adherence; detail: string } {
  if (pending === null) return { adherence: null, detail: "" };
  const want = pending.call;
  if (toolName !== want.tool) {
    return { adherence: "ignored", detail: `handle named ${String(want.tool)}, model called ${toolName}` };
  }
  const diffs: string[] = [];
  if (args.query !== want.query) diffs.push(`query: wanted ${JSON.stringify(want.query)}, sent ${JSON.stringify(args.query)}`);
  const sentIds = Array.isArray(args.node_ids) ? (args.node_ids as string[]) : [];
  const wantIds = want.node_ids ?? [];
  if (JSON.stringify(sentIds) !== JSON.stringify(wantIds)) {
    diffs.push(`node_ids: wanted ${JSON.stringify(wantIds)}, sent ${JSON.stringify(sentIds)}`);
  }
  if (args.strict !== want.strict) diffs.push(`strict: wanted ${String(want.strict)}, sent ${String(args.strict)}`);
  return diffs.length === 0
    ? { adherence: "verbatim", detail: "ran the emitted handle exactly" }
    : { adherence: "deviated", detail: diffs.join("; ") };
}

/** One SSE event out to the browser. */
type Emit = (event: string, data: unknown) => void;

/**
 * Run one question through Claude with this server's tools attached, streaming
 * every step as it happens.
 *
 * Streaming is not polish: an agent run makes several real network calls and can
 * take half a minute, and a panel that shows nothing until it finishes is
 * indistinguishable from one that has hung.
 *
 * `includeStructured` is a real experiment knob. Our design puts the machine
 * handles (node ids, `next_call`) in `structuredContent`, and MCP clients differ
 * on whether they forward it. Turning it off shows how the server behaves for a
 * text-only client — the pessimistic case every instruction has to survive.
 */
async function runAgent(
  target: Target,
  question: string,
  model: string,
  includeStructured: boolean,
  emit: Emit,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    emit("error", {
      message:
        "ANTHROPIC_API_KEY is not set. Add it to .env at the repo root and restart the panel (the panel reads .env itself). Raw mode works without it.",
    });
    return;
  }

  const { instructions, tools } = await connect(target);
  emit("start", {
    model,
    target: target.id,
    tools: tools.map((t) => t.name),
    instructions,
    include_structured: includeStructured,
    // The exact published description of each tool the model is choosing
    // between — the other half of what actually drives routing.
    tool_descriptions: Object.fromEntries(tools.map((t) => [t.name, t.description])),
  });

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: question },
  ];
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let pending: PendingHandle | null = null;

  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn += 1) {
    emit("turn", { turn });
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
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
    } catch (err) {
      emit("error", { message: `could not reach the Anthropic API: ${String(err)}` });
      return;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 600);
      emit("error", {
        message: `Anthropic API ${res.status}`,
        detail: body,
        hint: res.status === 401
          ? "That key was rejected. Check ANTHROPIC_API_KEY in .env — a Console key starts with `sk-ant-`."
          : res.status === 404
            ? `The model name may be wrong for this account: ${model}`
            : "",
      });
      return;
    }
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    tokensIn += body.usage?.input_tokens ?? 0;
    tokensOut += body.usage?.output_tokens ?? 0;
    emit("usage", { tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost });

    for (const block of body.content) {
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        emit("text", { text: block.text });
      }
    }
    if (body.stop_reason !== "tool_use") {
      emit("done", {
        stop_reason: body.stop_reason,
        turns: turn,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
      });
      return;
    }

    messages.push({ role: "assistant", content: body.content });
    const toolResults: unknown[] = [];
    for (const block of body.content) {
      if (block.type !== "tool_use" || block.name === undefined) continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      const { adherence, detail } = checkAdherence(pending, block.name, args);
      emit("tool_call", {
        tool: block.name,
        input: args,
        adherence,
        adherence_detail: detail,
        expected: pending?.call ?? null,
      });

      const report = await callTool(target, block.name, args);
      cost += report.cost_usd ?? 0;

      // What the model gets back, byte for byte. Surfacing this is the point:
      // if routing goes wrong, the cause is almost always in here.
      const parts: string[] = [report.error ?? report.text];
      if (includeStructured && report.structuredContent !== null) {
        parts.push(`structuredContent:\n${JSON.stringify(report.structuredContent)}`);
      }
      const sentToModel = parts.join("\n\n");

      emit("tool_result", {
        tool: block.name,
        ok: report.ok,
        isError: report.isError || !report.ok,
        ms: report.ms,
        text: report.error ?? report.text,
        structuredContent: report.structuredContent,
        chars_text: report.chars,
        chars_structured: report.structured_chars,
        approx_tokens: report.approx_tokens,
        cost_usd: report.cost_usd,
        next_call: report.next_call,
        sent_to_model: sentToModel,
        sent_chars: sentToModel.length,
      });
      emit("usage", { tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost });

      // A fresh handle supersedes the old one; a call that produced none clears
      // it, so adherence is only ever judged against a handle actually on offer.
      pending = report.next_call == null
        ? null
        : { fromTool: block.name, call: report.next_call as PendingHandle["call"] };

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: sentToModel,
        ...(report.isError || !report.ok ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  emit("done", {
    stop_reason: `hit the ${MAX_AGENT_TURNS}-turn ceiling`,
    turns: MAX_AGENT_TURNS,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
  });
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
      // Server-sent events, so each step lands in the UI as it happens rather
      // than the page sitting blank for half a minute.
      if (req.method === "POST" && url.pathname === "/api/agent") {
        const body = await readBody(req);
        const target = targetById(String(body.target));
        if (target === undefined) return json(res, 400, { error: "unknown target" });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const emit: Emit = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          await runAgent(
            target,
            String(body.question ?? ""),
            String(body.model ?? DEFAULT_MODEL),
            body.include_structured !== false,
            emit,
          );
        } catch (err) {
          // Any unexpected throw still has to reach the UI — an SSE stream that
          // just stops looks identical to a hang.
          emit("error", { message: String(err) });
        }
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  })();
});

/** Where a key came from, so "I added the key" and "agent mode is off" can
 *  never both be true without the reason being on screen. */
const keySource = (name: string): string => {
  if (process.env[name] === undefined) return "not set";
  return originalEnv.has(name) ? "from environment" : "from .env";
};

server.listen(PORT, () => {
  console.log(`\n  Tako MCP panel → http://localhost:${PORT}`);
  console.log(`  (the worker itself is on :8799 — opening that shows a 404, which is expected)\n`);
  console.log(
    loadedEnvFiles.length > 0
      ? `  .env loaded: ${loadedEnvFiles.join(", ")}`
      : "  .env: none found (expecting keys to be exported)",
  );
  console.log("");
  for (const t of TARGETS) {
    const auth = t.token === undefined ? "NO TOKEN" : "authed";
    console.log(`    ${t.id.padEnd(8)} ${t.url}  (${auth})`);
  }
  console.log("");
  console.log(`    TAKO_STAGING_API_KEY  ${keySource("TAKO_STAGING_API_KEY")}`);
  console.log(`    ANTHROPIC_API_KEY     ${keySource("ANTHROPIC_API_KEY")}`);
  console.log(
    process.env.ANTHROPIC_API_KEY === undefined
      ? "\n    agent mode OFF — add ANTHROPIC_API_KEY to .env and restart (raw mode works without)\n"
      : "\n    agent mode ON\n",
  );
});
