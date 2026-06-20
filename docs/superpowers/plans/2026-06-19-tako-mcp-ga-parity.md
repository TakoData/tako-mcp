# tako-mcp GA-API Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan targets the separate `TakoData/tako-mcp` repo** (canonical tree = `workers/`), NOT the Tako monorepo. All paths below are relative to `tako-mcp/workers/` unless noted. Run commands from `tako-mcp/workers/`.

**Goal:** Bring the canonical (Cloudflare Workers) tako-mcp tool set to parity with Tako's GA public API — rename the two existing GA-aligned tools to the `tako_*` convention and add `tako_contents` + `tako_agent` — reusing the server's existing patterns (ToolModule, djangoGet/djangoPost, progress-notification polling, per-client gating, auto-generated registry).

**Architecture:** Each tool is one file under `src/tools/<name>.ts` exporting `default … satisfies ToolModule<typeof inputSchema, Output>`. `scripts/gen-registry.ts` scans those files to emit `src/tools/_registry.ts` (barrel) + `../registry/server.json`; `mcp.ts` loops the barrel to register tools with the MCP SDK. Tools reach Django via `djangoGet`/`djangoPost` (inject `X-API-Key` from `ctx.token`). Long-running tools poll + emit `ctx.sendProgress(...)` to keep the per-call timeout fresh; ChatGPT (whose Apps SDK ignores progress) gets a split start/wait pair gated in `mcp.ts`.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk` v1.29.0, Zod, Cloudflare Workers (`wrangler`), Vitest (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- **BREAKING rename, no aliases:** `knowledge_search` → `tako_search`, `grounding` → `tako_answer`. Bump the server version (`registry/server.json` `version`, `package.json`) and add a changelog/README deprecation note. Do NOT keep old names as aliases.
- **Scope the rename to the 4 GA tools only.** Leave the non-GA tools as-is this pass: `get_chart_image`, `open_chart_ui`, `create_chart`, `create_report`/`get_report`/`list_reports`/`export_report`, `get_credit_balance`, and the ChatGPT deep-search split (`start_deep_knowledge_search`/`wait_for_knowledge_search`). (A follow-up may standardize their names.)
- **`tako_search` keeps calling the legacy endpoint** `POST /api/v1/knowledge_search` (it has fast + deep + async). Do NOT repoint to `/api/v3/search` — v3 is fast-only (deep is backlog TAKO-3183). Add a code comment + the note in Task 1.
- **Tools are hand-written; the registry is generated.** After any tool add/rename/edit, run `npm run registry:gen` and commit the regenerated `_registry.ts` + `registry/server.json`. CI runs `npm run registry:check` (fails on drift).
- **Auth is connection-level** (OAuth/Bearer handled in `mcp.ts`/`auth.ts`). Tools receive `ctx.token`; never touch headers. New tools require zero auth code.
- **Parse-don't-coerce:** every handler re-validates the backend payload through its `outputSchema` and throws an actionable error on mismatch (mirror `grounding.ts`).
- **Billing caveat (call out in PR + `tako_agent` description):** `tako_agent` over MCP is **unbilled for PAYG orgs** until TAKO-3245 (Agent API metering) lands. Do not gate on it, but flag it.
- Backend client signatures (from `src/django.ts`): `djangoPost<T>(env, token, path, body, opts?: { timeoutMs?: number })` and `djangoGet<T>(env, token, path, opts?: { query?: Record<string,string|number|boolean>; timeoutMs?: number })`.

---

## File Structure

- `src/tools/knowledge_search.ts` → **rename** to `src/tools/tako_search.ts` (tool `name` + file).
- `src/tools/grounding.ts` → **rename** to `src/tools/tako_answer.ts` (tool `name`, endpoint, output shape).
- `src/tools/tako_contents.ts` → **new**.
- `src/tools/tako_agent.ts` → **new** (dispatch + poll + progress).
- `src/tools/_registry.ts`, `../registry/server.json` → **regenerated** (do not hand-edit).
- `src/mcp.ts` → touch only if the ChatGPT split for `tako_agent` is added (Task 4) or a tool name is referenced by string (grep first).
- `src/tools/*.test.ts` → rename/add to match.
- `README.md`, `llms.txt`, `llms-full.txt`, `AGENTS.md`, `package.json`, `../registry/server.json` version → docs/version (Task 6).

---

## Task 1: Rename `knowledge_search` → `tako_search` (keep legacy endpoint)

**Files:**
- Rename: `src/tools/knowledge_search.ts` → `src/tools/tako_search.ts`
- Rename: `src/tools/knowledge_search.test.ts` → `src/tools/tako_search.test.ts`
- Modify: any `mcp.ts` / other references to the string `"knowledge_search"` as a *tool name* (NOT the endpoint path)
- Regenerate: `src/tools/_registry.ts`, `../registry/server.json`

**Interfaces:**
- Produces: a tool named `tako_search` with the same input/output schema and the same `/api/v1/knowledge_search` endpoint calls as before.

- [ ] **Step 1: Rename the files (preserve git history)**
```bash
cd tako-mcp/workers
git mv src/tools/knowledge_search.ts src/tools/tako_search.ts
git mv src/tools/knowledge_search.test.ts src/tools/tako_search.test.ts
```

- [ ] **Step 2: Change the tool name (only the `name` field + the endpoint comment)**
In `src/tools/tako_search.ts`, change the tool object's `name`:
```ts
  name: "tako_search",
```
Leave every `djangoGet`/`djangoPost` path untouched (`/api/v1/knowledge_search`, `/api/v1/knowledge_search/async/status/`). Add this comment above the first endpoint call:
```ts
    // Intentionally the LEGACY /api/v1/knowledge_search endpoint: it supports
    // fast + deep + async. /api/v3/search is fast-only today — repoint here
    // once v3 gains deep support (TAKO-3183).
```

- [ ] **Step 3: Find any tool-name string references**
```bash
grep -rn '"knowledge_search"' src/ | grep -v knowledge_search/async | grep -v /api/v1/knowledge_search
```
Expected: matches only in `mcp.ts`/test fixtures that key off the tool *name* (e.g. dynamic-resource wiring, CHATGPT gating lists). Update each to `"tako_search"`. Do NOT touch the deep-search ChatGPT tools' own names or the endpoint paths.

- [ ] **Step 4: Update the test name references**
In `src/tools/tako_search.test.ts`, update any `expect(tool.name).toBe("knowledge_search")` → `"tako_search"` and the import path (now `./tako_search.js`).

- [ ] **Step 5: Regenerate the registry**
```bash
npm run registry:gen
```
Expected: `_registry.ts` now imports `tako_search`; `../registry/server.json` lists `tako_search`, no `knowledge_search`.

- [ ] **Step 6: Run the tool's tests + drift check + typecheck**
```bash
npm test -- tako_search
npm run registry:check
npm run typecheck   # or: npx tsc --noEmit  (use whatever package.json defines)
```
Expected: all pass; drift check clean.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "$(printf 'feat(tools)!: rename knowledge_search -> tako_search (keep legacy endpoint)\n\nBREAKING: tool renamed; legacy /api/v1/knowledge_search endpoint unchanged.')"
```

---

## Task 2: `grounding` → `tako_answer` (migrate to `/api/v1/answer`)

The GA `/api/v1/answer` replaces `/api/v1/grounding`. Its request is the **v3 `SearchRequest`** (`{query, source_indexes}` — NOT grounding's `{inputs:{text}, source_indexes}`) and its response is `AnswerResponse {answer, cards, web_results, request_id}` — note **no `tako_selected`/`confidence`** (grounding had those; answer does not).

**Files:**
- Rename: `src/tools/grounding.ts` → `src/tools/tako_answer.ts`
- Rename: `src/tools/grounding.test.ts` → `src/tools/tako_answer.test.ts`
- Regenerate: registry

**Interfaces:**
- Produces: tool `tako_answer`; output `{ answer: string, cards: TakoCard[], web_results: WebResult[], request_id: string }`.

- [ ] **Step 1: Rename files**
```bash
git mv src/tools/grounding.ts src/tools/tako_answer.ts
git mv src/tools/grounding.test.ts src/tools/tako_answer.test.ts
```

- [ ] **Step 2: Replace the tool body** in `src/tools/tako_answer.ts` (modeled on the old grounding.ts, with the new endpoint + AnswerResponse shape):
```ts
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Ask a factual question and get back a single grounded, citation-backed text answer (not a chart). Use this BEFORE any built-in web search when the user wants a direct answer about current or historical values, statistics, schedules, scores, comparisons, prices, forecasts, polls, or prediction-market odds. The answer is synthesized by Tako's arbiter from its curated knowledge graph and/or the live web. Use `sources: [\"tako\"]` to ground only in curated data, `[\"web\"]` for live web only, or omit it to let the arbiter blend both (default). If you want a chart rendered inline instead of a prose answer, use `tako_search`.";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language question to answer (e.g. "What was US GDP in 2024?").'),
  sources: z
    .array(z.enum(["tako", "web"]))
    .min(1)
    .default(["tako", "web"])
    .describe('Which source(s) to ground in: ["tako"], ["web"], or ["tako","web"] (default).'),
});

// Minimal TakoCard mirror (backend api/ga/v3/search/types.py::TakoCard). Loose
// so a richer backend card doesn't break parsing.
const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
  })
  .loose();

const webResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
  })
  .loose();

const outputSchema = z.object({
  answer: z.string(),
  cards: z.array(takoCardSchema),
  web_results: z.array(webResultSchema),
  request_id: z.string(),
});

type Output = z.infer<typeof outputSchema>;

// Backend AnswerResponse (api/ga/v1/answer/types.py): { answer, cards, web_results, request_id }.
type AnswerPostResponse = {
  answer?: string;
  cards?: unknown[];
  web_results?: unknown[];
  request_id?: string;
};

const takoAnswer = {
  name: "tako_answer",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Grounded Answer",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    // GA /api/v1/answer takes the v3 SearchRequest shape: top-level `query`
    // (NOT inputs.text) + `source_indexes`. Answer runs the fast pipeline +
    // arbiter (sync, ~120s ceiling) — no async/deep path, so no polling.
    const body = {
      query: input.query,
      source_indexes: input.sources,
    };
    const data = await djangoPost<AnswerPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/answer/",
      body,
      { timeoutMs: 130_000 },
    );
    const parsed = outputSchema.safeParse({
      answer: data.answer ?? "",
      cards: data.cards ?? [],
      web_results: data.web_results ?? [],
      request_id: data.request_id ?? "",
    });
    if (!parsed.success) {
      throw new Error(
        "Tako answer endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoAnswer;
```
> Note: `country_code`/`locale` were grounding inputs but are not top-level on the v3 `SearchRequest`; dropped here. If `SearchRequest` later exposes them (or `output_settings`/`effort`), add to `inputSchema` + `body` then.

- [ ] **Step 3: Rewrite the test** `src/tools/tako_answer.test.ts` to mock `djangoPost` returning `{answer, cards, web_results, request_id}` and assert: tool name is `tako_answer`, the POST path is `/api/v1/answer/`, the body has `query` + `source_indexes`, and the parsed output. Mirror the structure of the other `*.test.ts` (import the default, call `.handler(input, fakeCtx)` with a mocked `djangoPost`).

- [ ] **Step 4: Run + regen + check**
```bash
npm test -- tako_answer
npm run registry:gen && npm run registry:check
npm run typecheck
```
Expected: pass; registry shows `tako_answer`, no `grounding`.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "$(printf 'feat(tools)!: grounding -> tako_answer on GA /api/v1/answer\n\nBREAKING: tool renamed; endpoint migrated from /api/v1/grounding to\n/api/v1/answer; output is {answer,cards,web_results,request_id} (drops\ntako_selected/confidence).')"
```

---

## Task 3: `tako_contents` (new) → `POST /api/v1/contents`

`/api/v1/contents` takes one `url` per request and returns `ContentsResponse {contents: [ContentItem], request_id}` where `ContentItem = {format, url (presigned), expires_at, cost, source_url}`. Tako-card URL → CSV; any other URL → web-text. Per the design: return the presigned download URL always, and **inline the text** when the artifact is text (web).

**Files:**
- Create: `src/tools/tako_contents.ts`
- Create: `src/tools/tako_contents.test.ts`
- Regenerate: registry

**Interfaces:**
- Consumes: `djangoPost`, `djangoGet` from `../django.js`; `ToolModule` from `./types.js`.
- Produces: tool `tako_contents`; output `{ format: string, download_url: string, expires_at: string, source_url: string, text: string | null }`.

- [ ] **Step 1: Write the test first** `src/tools/tako_contents.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../django.js", () => ({
  djangoPost: vi.fn(),
  djangoGet: vi.fn(),
}));

import { djangoPost } from "../django.js";
import tool from "./tako_contents.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

describe("tako_contents", () => {
  it("returns the presigned URL + metadata for a card CSV (no inline text)", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ format: "csv", url: "https://signed/csv", expires_at: "2026-06-20T00:00:00Z", cost: 0, source_url: "https://tako.com/card/abc" }],
      request_id: "r1",
    });
    const out = await tool.handler({ url: "https://tako.com/card/abc" }, ctx);
    expect(tool.name).toBe("tako_contents");
    expect(out.format).toBe("csv");
    expect(out.download_url).toBe("https://signed/csv");
    expect(out.text).toBeNull();
  });

  it("inlines text for a web-text artifact", async () => {
    vi.mocked(djangoPost).mockResolvedValue({
      contents: [{ format: "text", url: "https://signed/txt", expires_at: "2026-06-20T00:00:00Z", cost: 1, source_url: "https://example.com/a" }],
      request_id: "r2",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello world"));
    const out = await tool.handler({ url: "https://example.com/a" }, ctx);
    expect(out.format).toBe("text");
    expect(out.text).toBe("hello world");
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**
```bash
npm test -- tako_contents
```
Expected: FAIL (module `./tako_contents.js` not found).

- [ ] **Step 3: Implement** `src/tools/tako_contents.ts`:
```ts
/**
 * `tako_contents` — fetch the downloadable content behind a result URL.
 * Wraps `POST /api/v1/contents`. A Tako card URL resolves to a CSV of the
 * card's data; any other URL resolves to the page's extracted text. One URL
 * per call. Returns a short-lived presigned download URL; for web-text we also
 * inline the text so the model can read it directly.
 */
import { z } from "zod";

import { djangoPost } from "../django.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Fetch the underlying content behind a result URL. A Tako card URL returns a CSV of the card's data; any other URL returns the page's extracted full text. Pass a single `url` (a TakoCard.webpage_url or a web result URL). Returns a short-lived `download_url`; for web pages the extracted `text` is also inlined so you can read it directly.";

const MAX_INLINE_CHARS = 200_000; // cap inlined web text to keep responses sane

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe("The result URL to fetch content for (a Tako card URL → CSV; any other URL → page text)."),
});

const outputSchema = z.object({
  format: z.string(),
  download_url: z.string(),
  expires_at: z.string(),
  source_url: z.string(),
  text: z.string().nullable(),
});

type Output = z.infer<typeof outputSchema>;

type ContentItem = { format?: string; url?: string; expires_at?: string; cost?: number; source_url?: string };
type ContentsPostResponse = { contents?: ContentItem[]; request_id?: string };

const takoContents = {
  name: "tako_contents",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Fetch Contents",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<Output> {
    const data = await djangoPost<ContentsPostResponse>(
      ctx.env,
      ctx.token,
      "/api/v1/contents/",
      { url: input.url },
      { timeoutMs: 60_000 },
    );
    const item = data.contents?.[0];
    if (!item || !item.url) {
      throw new Error(
        "Tako contents endpoint returned no downloadable content for that URL.",
      );
    }
    const isText = (item.format ?? "").toLowerCase() === "text";
    let text: string | null = null;
    if (isText) {
      // Inline the extracted web text so the model can read it without a
      // second tool call. Best-effort: a fetch failure still returns the URL.
      try {
        const resp = await fetch(item.url);
        if (resp.ok) {
          const body = await resp.text();
          text = body.length > MAX_INLINE_CHARS ? body.slice(0, MAX_INLINE_CHARS) + "\n...[truncated]" : body;
        }
      } catch {
        text = null;
      }
    }
    const parsed = outputSchema.safeParse({
      format: item.format ?? "",
      download_url: item.url,
      expires_at: item.expires_at ?? "",
      source_url: item.source_url ?? input.url,
      text,
    });
    if (!parsed.success) {
      throw new Error("Tako contents endpoint returned an unexpected shape.");
    }
    return parsed.data;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default takoContents;
```

- [ ] **Step 4: Run to verify pass**
```bash
npm test -- tako_contents
```
Expected: PASS (2 tests).

- [ ] **Step 5: Regenerate registry + typecheck**
```bash
npm run registry:gen && npm run registry:check && npm run typecheck
```
Expected: `tako_contents` present; pass.

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "$(printf 'feat(tools): add tako_contents (POST /api/v1/contents)\n\nReturns the presigned download URL; inlines extracted web text.')"
```

---

## Task 4: `tako_agent` (new) → Agent API dispatch + poll + progress

`POST /api/v1/agent/runs` body `{query, effort: "deep"}` → `AgentRun` (`{run_id, object:"agent.run", thread_id?, status: queued|running|completed|failed, created_at, completed_at?, result?: {answer?, cards: TakoCard[], request_id?}, error?: {code, message}}`). Poll `GET /api/v1/agent/runs/{run_id}` until `status` is `completed` or `failed`, emitting `ctx.sendProgress` each poll (reuse the `pollDeep` shape from `tako_search.ts`). For ChatGPT (no progress-reset support) register a split `tako_agent_start` + `tako_agent_wait` pair, gated in `mcp.ts` exactly like the existing `start_deep_knowledge_search`/`wait_for_knowledge_search`.

**Files:**
- Create: `src/tools/tako_agent.ts` (the Claude/default single tool: dispatch + internal poll)
- Create: `src/tools/tako_agent_start.ts` + `src/tools/tako_agent_wait.ts` (ChatGPT split)
- Create: `src/tools/tako_agent.test.ts`
- Modify: `src/mcp.ts` — add the two split tool names to the ChatGPT-only gating list (mirror `CHATGPT_ONLY_TOOL_NAMES`), and exclude single `tako_agent` for chatgpt
- Regenerate: registry

**Interfaces:**
- Consumes: `djangoPost`, `djangoGet`; `ToolModule`, `ToolContext` from `./types.js`.
- Produces: tools `tako_agent` (default), `tako_agent_start` (→ `{ run_id, status }`), `tako_agent_wait` (→ AgentRun result). Shared poll helper `pollAgentRun(ctx, runId)`.

- [ ] **Step 1: Write the test first** `src/tools/tako_agent.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../django.js", () => ({ djangoPost: vi.fn(), djangoGet: vi.fn() }));
import { djangoPost, djangoGet } from "../django.js";
import tool from "./tako_agent.js";

const ctx = { token: "t", env: {} as never, client: "claude" as const, sendProgress: vi.fn() };

describe("tako_agent", () => {
  it("dispatches a deep run, polls to completion, emits progress, returns the result", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_1", status: "queued" });
    vi.mocked(djangoGet)
      .mockResolvedValueOnce({ run_id: "run_1", status: "running" })
      .mockResolvedValueOnce({ run_id: "run_1", status: "completed", result: { answer: "42", cards: [] } });

    const out = await tool.handler({ query: "analyze X" }, ctx);

    expect(tool.name).toBe("tako_agent");
    expect(vi.mocked(djangoPost).mock.calls[0][2]).toBe("/api/v1/agent/runs");
    expect(vi.mocked(djangoPost).mock.calls[0][3]).toMatchObject({ query: "analyze X", effort: "deep" });
    expect(ctx.sendProgress).toHaveBeenCalled();
    expect(out.status).toBe("completed");
    expect(out.result?.answer).toBe("42");
  });

  it("surfaces a failed run with its error", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: "run_2", status: "queued" });
    vi.mocked(djangoGet).mockResolvedValue({ run_id: "run_2", status: "failed", error: { code: "x", message: "boom" } });
    const out = await tool.handler({ query: "q" }, ctx);
    expect(out.status).toBe("failed");
    expect(out.error?.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run to verify it fails**
```bash
npm test -- tako_agent
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the shared schemas + poll helper + default tool** `src/tools/tako_agent.ts`:
```ts
/**
 * `tako_agent` — run Tako's deep data-pipeline agent (transformations,
 * aggregations, multi-hop reasoning). Wraps the Agent API:
 *   POST /api/v1/agent/runs            (dispatch; returns { run_id, status })
 *   GET  /api/v1/agent/runs/{run_id}   (poll until completed|failed)
 * Runs ~30-90s, so we poll and emit notifications/progress each iteration to
 * keep the per-call timeout fresh (clients with resetTimeoutOnProgress). For
 * ChatGPT (no progress support) a split tako_agent_start/tako_agent_wait pair
 * is registered instead (see mcp.ts).
 *
 * BILLING: agent runs over MCP are not yet metered for PAYG orgs (TAKO-3245).
 */
import { z } from "zod";

import { djangoGet, djangoPost } from "../django.js";
import type { ToolContext, ToolModule } from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_TRANSIENT_ERRORS = 2;

const DESCRIPTION =
  "Run Tako's deep research agent for complex, multi-step data questions — transformations, aggregations, comparisons across many entities, and multi-hop reasoning that a single search/answer can't satisfy. Runs up to ~90s; returns a synthesized `answer` plus supporting Tako chart `cards`. Use `tako_search`/`tako_answer` for simple lookups; reach for this only when the question genuinely needs reasoning over multiple retrievals.";

export const inputSchema = z.object({
  query: z.string().min(1).describe("The deep/analytical question for the agent to work through."),
});

const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
  })
  .loose();

const agentRunSchema = z.object({
  run_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  result: z
    .object({
      answer: z.string().nullable().optional(),
      cards: z.array(takoCardSchema).default([]),
      request_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
type AgentRunWire = {
  run_id?: string;
  status?: string;
  result?: unknown;
  error?: unknown;
};

/** Dispatch a deep agent run. Returns the run_id. */
export async function dispatchAgentRun(ctx: ToolContext, query: string): Promise<string> {
  const data = await djangoPost<AgentRunWire>(
    ctx.env,
    ctx.token,
    "/api/v1/agent/runs",
    { query, effort: "deep" },
    { timeoutMs: 30_000 },
  );
  if (!data.run_id) {
    throw new Error("Tako agent dispatch returned no run_id.");
  }
  return data.run_id;
}

/** Poll an agent run to a terminal state, emitting progress each iteration. */
export async function pollAgentRun(ctx: ToolContext, runId: string): Promise<AgentRun> {
  let transient = 0;
  let pollCount = 0;
  // Budget: poll every 5s; the SDK timeout is kept fresh by sendProgress.
  while (true) {
    let wire: AgentRunWire;
    try {
      wire = await djangoGet<AgentRunWire>(ctx.env, ctx.token, `/api/v1/agent/runs/${runId}`, {
        timeoutMs: 30_000,
      });
      transient = 0;
    } catch (err) {
      // Tolerate a couple of transient transport blips while the run continues.
      if (++transient > MAX_TRANSIENT_ERRORS) throw err;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const parsed = agentRunSchema.safeParse({
      run_id: wire.run_id ?? runId,
      status: wire.status ?? "running",
      result: wire.result ?? null,
      error: wire.error ?? null,
    });
    if (!parsed.success) {
      throw new Error("Tako agent run endpoint returned an unexpected shape.");
    }
    if (parsed.data.status === "completed" || parsed.data.status === "failed") {
      return parsed.data;
    }
    pollCount += 1; // MCP requires progress to strictly increase per token.
    await ctx.sendProgress(pollCount, { message: `Agent running… (${parsed.data.status})` });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const takoAgent = {
  name: "tako_agent",
  description: DESCRIPTION,
  inputSchema,
  outputSchema: agentRunSchema,
  annotations: {
    title: "Tako: Deep Agent",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx): Promise<AgentRun> {
    const runId = await dispatchAgentRun(ctx, input.query);
    return pollAgentRun(ctx, runId);
  },
} satisfies ToolModule<typeof inputSchema, AgentRun>;

export default takoAgent;
```

- [ ] **Step 4: Run to verify pass**
```bash
npm test -- tako_agent
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add the ChatGPT split tools**
Create `src/tools/tako_agent_start.ts` (dispatch only → `{ run_id, status: "queued" }`, reusing `dispatchAgentRun`) and `src/tools/tako_agent_wait.ts` (input `{ run_id: string }` → `pollAgentRun(ctx, input.run_id)`). Model their structure on the existing `start_deep_knowledge_search.ts` / `wait_for_knowledge_search.ts` (same annotations + `satisfies ToolModule`). Import the shared `dispatchAgentRun`/`pollAgentRun`/`inputSchema` from `./tako_agent.js`.

- [ ] **Step 6: Gate per client in `mcp.ts`**
Find the existing ChatGPT-only gating (grep for `CHATGPT_ONLY_TOOL_NAMES` or `start_deep_knowledge_search` in `src/mcp.ts`). Add `tako_agent_start` + `tako_agent_wait` to that ChatGPT-only set, and add `tako_agent` to the set excluded **for** chatgpt (mirror exactly how `knowledge_search` is excluded for chatgpt while the split pair is included). Run:
```bash
grep -n "CHATGPT_ONLY_TOOL_NAMES\|start_deep_knowledge_search\|knowledge_search" src/mcp.ts
```
and apply the same pattern with the agent tool names.

- [ ] **Step 7: Regen + full tool tests + drift + typecheck**
```bash
npm run registry:gen && npm run registry:check
npm test -- tako_agent
npm run typecheck
```
Expected: registry lists `tako_agent`, `tako_agent_start`, `tako_agent_wait`; pass.

- [ ] **Step 8: Commit**
```bash
git add -A
git commit -m "$(printf 'feat(tools): add tako_agent (Agent API dispatch+poll) + ChatGPT split\n\nReuses the deep-search progress-notification polling pattern. NB: agent\nruns over MCP are unbilled for PAYG orgs until TAKO-3245.')"
```

---

## Task 5: Docs, version bump, deprecation note

**Files:**
- Modify: `README.md`, `llms.txt`, `llms-full.txt`, `AGENTS.md`
- Modify: `package.json` (`version`), `../registry/server.json` (`version` — regenerated, but bump the source if version lives in a tool/config the generator reads)

- [ ] **Step 1: Version bump + changelog/deprecation note**
Bump the minor (or major, since it's breaking) version in `package.json`. Add a short "Breaking changes" section to `README.md`:
```markdown
## Breaking changes (vX.Y.0)
- `knowledge_search` → **`tako_search`** (endpoint unchanged).
- `grounding` → **`tako_answer`** (now backed by GA `/api/v1/answer`; result is `{answer, cards, web_results, request_id}`).
- New: **`tako_contents`**, **`tako_agent`**.
Update any client config or agent prompts that referenced the old tool names.
```

- [ ] **Step 2: Update the tool reference + install docs**
In `README.md`, `AGENTS.md`, `llms.txt`, `llms-full.txt`: replace `knowledge_search`/`grounding` references with `tako_search`/`tako_answer`, and add `tako_contents` + `tako_agent` to the tool tables/reference. Install instructions (URLs/headers) are unchanged — only tool names/descriptions move.

- [ ] **Step 3: Regenerate registry (picks up the version) + final full test suite**
```bash
npm run registry:gen && npm run registry:check
npm test
npm run typecheck
```
Expected: full suite green; `registry/server.json` version bumped and lists exactly the renamed + new tools.

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "$(printf 'docs: tako_* tool rename + tako_contents/tako_agent reference; version bump\n\nBREAKING: documents the knowledge_search->tako_search /\ngrounding->tako_answer rename.')"
```

---

## Final verification (before PR)
- [ ] `npm test` — all tool + integration tests pass.
- [ ] `npm run registry:check` — no drift; `registry/server.json` lists `tako_search`, `tako_answer`, `tako_contents`, `tako_agent`, the two `tako_agent_*` split tools, and the unchanged non-GA tools; no `knowledge_search`/`grounding`.
- [ ] `npm run typecheck` clean.
- [ ] `wrangler deploy --dry-run` (or the repo's build script) succeeds.
- [ ] Optional: `scripts/smoke.ts` against staging once deployed.
- [ ] PR body notes: BREAKING tool rename + version bump; and the TAKO-3245 billing caveat for `tako_agent`.

## Notes / deferrals captured
- **`tako_search` stays on legacy `/api/v1/knowledge_search`** until v3/search gains deep (TAKO-3183).
- **Monorepo OpenAPI→MCP codegen (TAKO-3246) intentionally NOT pursued** — tako-mcp already has hand-written-tools + generated-registry + drift-check; this plan is the hand-update.
- **Non-GA tools** (reports/chart/credit + ChatGPT deep-search split) keep their current names this pass; standardizing them to `tako_*` is a possible follow-up.
- **Python legacy tree (`src/tako_mcp/`)** is not updated here (lower priority).
- **`tako_answer` localization** (`country_code`/`locale`) dropped unless the v3 `SearchRequest` exposes them.
