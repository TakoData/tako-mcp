# Graph API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three thin graph-primitive MCP tools (`tako_graph_search`, `tako_graph_related`, `tako_graph_node`) and let `tako_search` + `tako_answer` pin resolved graph nodes, so agents can discover what data Tako has and ground their retrieval on it.

**Architecture:** Each graph tool is a single `ToolModule` file under `workers/src/tools/` that wraps one `GET /api/beta/graph/*` endpoint via the existing `djangoGet` transport, guards the raw response against the generated wire schema, and returns a hand-written output facade (the same wire-guard/facade split `tako_search` already uses, which avoids `z.lazy` in advertised JSON schema). A shared `_graph.ts` module holds the node/relation facades and the multi-`q` union/dedupe merge helper. `tako_search`/`tako_answer` gain `node_ids` + `strict` inputs mapped into `sources.data`, and `tako_search` surfaces each card's graph `nodes`.

**Tech Stack:** TypeScript, Cloudflare Workers, Zod, Vitest, generated Zod schemas from `openapi/sdk.yaml`.

## Global Constraints

- All new tool query params are **scalar** — pass them through `djangoGet`'s `query` option (which serializes scalars only via `URLSearchParams`). No changes to `django.ts`.
- Graph endpoints are called with the `/api` prefix: `/api/beta/graph/search`, `/api/beta/graph/related`, `/api/beta/graph/node/{id}` (mirrors `tako_search` calling `/api/v3/search/`).
- Immutability: never mutate inputs or shared objects; build new objects (project coding style). Local accumulators created inside a function are fine.
- Every backend response is validated against its generated schema (`GraphSearchResponse`, `GraphRelatedResponse`, `GraphNode`, `SearchRequest`, `SearchResponse`, `AnswerResponse`) before mapping; on failure throw an actionable, retry-suggesting `Error` (match existing wording style: `"Tako <x> endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team."`).
- Adding a tool file requires: (1) add its name to `MCP_TOOL_ALLOWLIST` in `workers/scripts/gen-registry.ts`, (2) run `npm run registry:gen` to regenerate `workers/src/tools/_registry.ts` and `registry/server.json`. The registry parity test fails otherwise.
- `sources.data.node_ids` max 20; `strict` default false. Backend requires `node_ids` non-empty when `strict` is true.
- NER `label` enum values (verbatim): `PERSON, ORG, GPE, LOC, PRODUCT, EVENT, LANGUAGE, MONEY, METRIC, STOCK_TICKER, WEBSITE`.
- `GraphNodeType` enum: `metric`, `entity`.
- All commands run from `workers/` unless noted. Verify commands: `npm run typecheck`, `npm run test`, `npm run registry:check`, `npm run schemas:check`.

---

### Task 1: Shared graph facades + multi-`q` merge helper

**Files:**
- Create: `workers/src/tools/_graph.ts`
- Test: `workers/src/tools/_graph.test.ts`

**Interfaces:**
- Consumes: `GraphRelatedResponse` type from `../generated/schemas.js`.
- Produces:
  - `graphNodeSchema: z.ZodObject` — facade: `{ id: string, type: "metric"|"entity", name: string, aliases?: string[], description?: string|null, subtype?: string|null, label?: string|null }`
  - `graphRelationSchema: z.ZodObject` — facade: `{ key, kind, label, items: graphNode[], total, total_capped, next_cursor?: string|null }`
  - `graphSearchOutputShape` — `{ results: graphNode[], inferred_labels?: string[]|null }`
  - `graphRelatedOutputShape` — `{ node: graphNode, relations?: graphRelation[]|null, relation?: graphRelation|null, inferred_labels?: string[]|null }`
  - `mergeRelatedResponses(responses: GraphRelatedResponse[]): GraphRelatedResponse`

- [ ] **Step 1: Write the failing test**

Create `workers/src/tools/_graph.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { GraphRelatedResponse } from "../generated/schemas.js";
import { mergeRelatedResponses } from "./_graph.js";

const node = (id: string, name: string) =>
  ({ id, type: "metric" as const, name });

const hub = { id: "tesla-x1", type: "entity" as const, name: "Tesla" };

describe("mergeRelatedResponses — drill mode", () => {
  it("unions and dedupes relation.items by node id across responses", () => {
    const a: GraphRelatedResponse = {
      node: hub,
      relation: {
        key: "metrics", kind: "data", label: "Metrics",
        items: [node("rev-1", "Revenue"), node("shared-9", "Average Wages")],
        total: 2, total_capped: false, next_cursor: null,
      },
    };
    const b: GraphRelatedResponse = {
      node: hub,
      relation: {
        key: "metrics", kind: "data", label: "Metrics",
        items: [node("sales-2", "Sales"), node("shared-9", "Average Wages")],
        total: 2, total_capped: true, next_cursor: null,
      },
    };

    const merged = mergeRelatedResponses([a, b]);

    expect(merged.relation?.items.map((n) => n.id)).toEqual([
      "rev-1", "shared-9", "sales-2",
    ]);
    expect(merged.relation?.total).toBe(3);
    expect(merged.relation?.total_capped).toBe(true); // OR of inputs
    expect(merged.relation?.next_cursor).toBeNull();
  });
});

describe("mergeRelatedResponses — overview mode", () => {
  it("unions groups by key and items within a group by id", () => {
    const a: GraphRelatedResponse = {
      node: hub,
      relations: [
        { key: "metrics", kind: "data", label: "Metrics",
          items: [node("rev-1", "Revenue")], total: 1, total_capped: false },
      ],
    };
    const b: GraphRelatedResponse = {
      node: hub,
      relations: [
        { key: "metrics", kind: "data", label: "Metrics",
          items: [node("rev-1", "Revenue"), node("sales-2", "Sales")],
          total: 2, total_capped: false },
        { key: "entities", kind: "data", label: "Entities",
          items: [node("ford-3", "Ford")], total: 1, total_capped: false },
      ],
    };

    const merged = mergeRelatedResponses([a, b]);

    const metrics = merged.relations?.find((g) => g.key === "metrics");
    const entities = merged.relations?.find((g) => g.key === "entities");
    expect(metrics?.items.map((n) => n.id)).toEqual(["rev-1", "sales-2"]);
    expect(metrics?.total).toBe(2);
    expect(entities?.items.map((n) => n.id)).toEqual(["ford-3"]);
    // first-seen order preserved
    expect(merged.relations?.map((g) => g.key)).toEqual(["metrics", "entities"]);
  });

  it("unions and dedupes inferred_labels", () => {
    const a: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG"] };
    const b: GraphRelatedResponse = { node: hub, relations: [], inferred_labels: ["ORG", "PRODUCT"] };
    const merged = mergeRelatedResponses([a, b]);
    expect(merged.inferred_labels).toEqual(["ORG", "PRODUCT"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- _graph`
Expected: FAIL — `Cannot find module './_graph.js'` / `mergeRelatedResponses is not a function`.

- [ ] **Step 3: Write the implementation**

Create `workers/src/tools/_graph.ts`:

```ts
/**
 * Shared facades + helpers for the graph primitive tools
 * (tako_graph_search / tako_graph_related / tako_graph_node).
 *
 * The generated schemas (GraphNode, GraphRelatedResponse, …) are the wire
 * contract each tool safeParses against. These hand-written facades are the
 * tools' *advertised* output shapes — flat, no z.lazy — mirroring the
 * wire-guard/facade split tako_search already uses so the MCP SDK can emit
 * clean JSON schema for outputs.
 */
import { z } from "zod";

import type { GraphNode, GraphRelatedResponse } from "../generated/schemas.js";

/** Advertised graph-node facade. subtype/label are stringified enums on the
 *  wire; the facade keeps them as loose strings so a new enum value never
 *  breaks the advertised contract. */
export const graphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["metric", "entity"]),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  subtype: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
});

/** Advertised relation-group facade. next_cursor is present only on a drilled
 *  page (relation), absent on overview groups (relations[]). */
export const graphRelationSchema = z.object({
  key: z.string(),
  kind: z.string(),
  label: z.string(),
  items: z.array(graphNodeSchema),
  total: z.number().int(),
  total_capped: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});

export const graphSearchOutputShape = {
  results: z.array(graphNodeSchema),
  inferred_labels: z.array(z.string()).nullable().optional(),
} as const;

export const graphRelatedOutputShape = {
  node: graphNodeSchema,
  relations: z.array(graphRelationSchema).nullable().optional(),
  relation: graphRelationSchema.nullable().optional(),
  inferred_labels: z.array(z.string()).nullable().optional(),
} as const;

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Union + dedupe (by node id) a set of graph/related responses fetched for
 * different `q` filters into a single response. Called only when the caller
 * passed multiple `q` values — a single response is returned unchanged by the
 * handler and never reaches here.
 *
 * Merged totals reflect the union of returned items, not a server count
 * (multi-`q` is a client-side convenience over the free graph endpoint).
 */
export function mergeRelatedResponses(
  responses: GraphRelatedResponse[],
): GraphRelatedResponse {
  const base = responses[0];
  if (base === undefined) {
    throw new Error("mergeRelatedResponses: empty response list");
  }

  const inferredFlat = dedupeStrings(
    responses.flatMap((r) => r.inferred_labels ?? []),
  );
  const inferred_labels = inferredFlat.length > 0 ? inferredFlat : undefined;

  // Drill mode: every response carries `.relation` for the same key.
  if (base.relation != null) {
    const items = dedupeNodes(responses.flatMap((r) => r.relation?.items ?? []));
    return {
      node: base.node,
      relation: {
        key: base.relation.key,
        kind: base.relation.kind,
        label: base.relation.label,
        items,
        total: items.length,
        total_capped: responses.some((r) => r.relation?.total_capped === true),
        next_cursor: null,
      },
      inferred_labels,
    };
  }

  // Overview mode: union groups by key (first-seen order), union items by id.
  const order: string[] = [];
  const groups = new Map<string, GraphRelatedResponse["relations"] extends
    (infer T)[] | null | undefined ? T : never>();
  for (const r of responses) {
    for (const g of r.relations ?? []) {
      const existing = groups.get(g.key);
      if (existing === undefined) {
        order.push(g.key);
        groups.set(g.key, { ...g, items: [...g.items] });
      } else {
        const items = dedupeNodes([...existing.items, ...g.items]);
        groups.set(g.key, {
          ...existing,
          items,
          total: items.length,
          total_capped: existing.total_capped || g.total_capped,
        });
      }
    }
  }
  return {
    node: base.node,
    relations: order.map((k) => groups.get(k)!),
    inferred_labels,
  };
}
```

> Note: if the `Map` generic expression above fails to typecheck in your TS version, replace it with `new Map<string, NonNullable<GraphRelatedResponse["relations"]>[number]>()`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- _graph && npm run typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add workers/src/tools/_graph.ts workers/src/tools/_graph.test.ts
git commit -m "feat: shared graph facades + multi-q merge helper"
```

---

### Task 2: `tako_graph_search` tool

**Files:**
- Create: `workers/src/tools/tako_graph_search.ts`
- Test: `workers/src/tools/tako_graph_search.test.ts`
- Modify: `workers/scripts/gen-registry.ts` (add `"tako_graph_search"` to `MCP_TOOL_ALLOWLIST`)
- Regenerate: `workers/src/tools/_registry.ts`, `registry/server.json`

**Interfaces:**
- Consumes: `graphSearchOutputShape` from `./_graph.js`; `GraphSearchResponse` from `../generated/schemas.js`; `djangoGet` from `../django.js`; `ToolModule` from `./types.js`.
- Produces: default export `tako_graph_search` (`ToolModule`), name `"tako_graph_search"`.

- [ ] **Step 1: Write the failing test**

Create `workers/src/tools/tako_graph_search.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoGraphSearch from "./tako_graph_search.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, client: "claude",
};

const RESULTS = {
  results: [
    { id: "tesla-x1", type: "entity", name: "Tesla", subtype: "Companies",
      label: "ORG", aliases: ["TSLA"], description: "EV maker" },
  ],
  inferred_labels: ["ORG"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_graph_search", () => {
  it("tool name is tako_graph_search", () => {
    expect(takoGraphSearch.name).toBe("tako_graph_search");
  });

  it("sends q/types/label/limit as query params to /api/beta/graph/search", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, RESULTS)]);

    const out = await takoGraphSearch.handler(
      { q: "Tesla", types: "entity", label: "ORG", infer_label: true, limit: 5 },
      CTX,
    );

    const req = requestFrom(fetchMock.mock.calls[0]);
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/beta/graph/search");
    expect(req.method).toBe("GET");
    expect(url.searchParams.get("q")).toBe("Tesla");
    expect(url.searchParams.get("types")).toBe("entity");
    expect(url.searchParams.get("label")).toBe("ORG");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(req.headers.get("X-API-Key")).toBe("sk-test");

    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.id).toBe("tesla-x1");
    expect(out.inferred_labels).toEqual(["ORG"]);
  });

  it("omits optional params when not provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, { results: [] })]);
    await takoGraphSearch.handler({ q: "Tesla" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.has("types")).toBe(false);
    expect(url.searchParams.has("label")).toBe(false);
  });

  it("rejects q shorter than 2 chars", () => {
    expect(() => takoGraphSearch.inputSchema.parse({ q: "a" })).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { results: "not-an-array" })]);
    await expect(takoGraphSearch.handler({ q: "Tesla" }, CTX)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tako_graph_search`
Expected: FAIL — `Cannot find module './tako_graph_search.js'`.

- [ ] **Step 3: Write the implementation**

Create `workers/src/tools/tako_graph_search.ts`:

```ts
/**
 * `tako_graph_search` — resolve a name to Tako data-graph node(s).
 *
 * Wraps `GET /api/beta/graph/search`. Free + fast. The resolved node ids pin
 * into tako_search / tako_answer (sources.data.node_ids). Wire-guarded against
 * the generated GraphSearchResponse; returns the flat graphSearchOutputShape
 * facade.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphSearchResponse } from "../generated/schemas.js";
import { graphSearchOutputShape } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION =
  "Resolve a name to Tako data-graph node(s) so you can see **what data Tako has** and pin exact nodes into `tako_search`/`tako_answer`. Decide up front whether you're resolving a **thing** (`types: \"entity\"`) or a **measure** (`types: \"metric\"`) — don't mix them in one call. Results are popularity-ordered; read each node's `subtype`/`label`/`description` to pick the right one. `label` is a ranking **boost, not a filter** (off-label nodes still return) — omit it to let `infer_label` auto-detect from `q`. Graph calls are free and efficient: for a narrow 1-entity/1-metric question, run this **in parallel** with your `tako_search`/`tako_answer`; for broader questions, resolve entities here then call `tako_graph_related` to discover their metrics. Each node's `id` pins into `sources.data.node_ids`.";

const inputSchema = z.object({
  q: z.string().min(2).describe("Search text (min 2 chars)."),
  types: z.enum(["entity", "metric"]).optional().describe(
    'Resolve a "thing" ("entity") or a "measure" ("metric"). Omit to search both.',
  ),
  label: z.enum(NER_LABELS).optional().describe(
    "NER label to prefer (boost, not a filter). Omit to let infer_label run.",
  ),
  infer_label: z.boolean().optional().describe(
    "Auto-detect labels from q (default true server-side). Set false to disable.",
  ),
  limit: z.number().int().min(1).max(50).optional().describe(
    "Max results (default 20, max 50).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphSearchOutputShape);
type Output = z.infer<typeof outputSchema>;

const tako_graph_search = {
  name: "tako_graph_search",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input: Input, ctx): Promise<Output> {
    const query: Record<string, string | number | boolean> = { q: input.q };
    if (input.types !== undefined) query.types = input.types;
    if (input.label !== undefined) query.label = input.label;
    if (input.infer_label !== undefined) query.infer_label = input.infer_label;
    if (input.limit !== undefined) query.limit = input.limit;

    const data = await djangoGet<unknown>(
      ctx.env, ctx.token, "/api/beta/graph/search",
      { query, timeoutMs: 15_000 },
    );

    const wire = GraphSearchResponse.safeParse(data);
    if (!wire.success) {
      throw new Error(
        "Tako graph/search endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return wire.data as Output;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_search;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tako_graph_search && npm run typecheck`
Expected: PASS (5 tests). If typecheck flags `wire.data as Output`, the facade and generated shapes diverged — re-check field names.

- [ ] **Step 5: Register the tool**

Edit `workers/scripts/gen-registry.ts` — add `"tako_graph_search"` to `MCP_TOOL_ALLOWLIST` (keep alphabetical grouping tidy):

```ts
export const MCP_TOOL_ALLOWLIST = [
  "get_credit_balance",
  "tako_agent",
  "tako_agent_start",
  "tako_agent_wait",
  "tako_answer",
  "tako_contents",
  "tako_graph_search",
  "tako_search",
  "tako_visualize",
] as const;
```

Then regenerate:

Run: `npm run registry:gen`
Expected: `workers/src/tools/_registry.ts` and `registry/server.json` updated to include `tako_graph_search`.

- [ ] **Step 6: Verify registry + full test suite**

Run: `npm run registry:check && npm run test`
Expected: registry check passes; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add workers/src/tools/tako_graph_search.ts workers/src/tools/tako_graph_search.test.ts \
  workers/scripts/gen-registry.ts workers/src/tools/_registry.ts registry/server.json
git commit -m "feat: tako_graph_search tool"
```

---

### Task 3: `tako_graph_node` tool

**Files:**
- Create: `workers/src/tools/tako_graph_node.ts`
- Test: `workers/src/tools/tako_graph_node.test.ts`
- Modify: `workers/scripts/gen-registry.ts` (add `"tako_graph_node"`)
- Regenerate: `workers/src/tools/_registry.ts`, `registry/server.json`

**Interfaces:**
- Consumes: `graphNodeSchema` from `./_graph.js`; `GraphNode` from `../generated/schemas.js`; `djangoGet`; `ToolModule`.
- Produces: default export `tako_graph_node`, name `"tako_graph_node"`. Uses `GET /api/beta/graph/node/{id}` (id is a **path** segment, URL-encoded).

- [ ] **Step 1: Write the failing test**

Create `workers/src/tools/tako_graph_node.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoGraphNode from "./tako_graph_node.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, client: "claude",
};

const NODE = {
  id: "tesla-x1", type: "entity", name: "Tesla",
  aliases: ["TSLA"], subtype: "Companies", label: "ORG",
  description: "EV maker",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_graph_node", () => {
  it("tool name is tako_graph_node", () => {
    expect(takoGraphNode.name).toBe("tako_graph_node");
  });

  it("requests /api/beta/graph/node/{id} with the id url-encoded", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, NODE)]);
    const out = await takoGraphNode.handler({ id: "tesla x1" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.pathname).toBe("/api/beta/graph/node/tesla%20x1");
    expect(out.id).toBe("tesla-x1");
    expect(out.aliases).toEqual(["TSLA"]);
  });

  it("rejects an empty id", () => {
    expect(() => takoGraphNode.inputSchema.parse({ id: "" })).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { id: 123 })]);
    await expect(takoGraphNode.handler({ id: "tesla-x1" }, CTX)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tako_graph_node`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `workers/src/tools/tako_graph_node.ts`:

```ts
/**
 * `tako_graph_node` — hydrate a single graph-node id into full detail.
 *
 * Wraps `GET /api/beta/graph/node/{id}`. Use it when you hold a bare node id
 * (e.g. from a tako_search card's slim `nodes`) and need aliases/subtype/label
 * to compose a grounded query. Wire-guarded against the generated GraphNode.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphNode } from "../generated/schemas.js";
import { graphNodeSchema } from "./_graph.js";
import type { ToolModule } from "./types.js";

const DESCRIPTION =
  "Hydrate a single graph-node `id` into full detail (name, `aliases`, `subtype`, `label`, `description`). Use it when you have a bare node id — e.g. one returned on a `tako_search` card's `nodes` (which carry only id/name/type) — and need its aliases/subtype to compose a grounded query or confirm what it is. Free and efficient.";

const inputSchema = z.object({
  id: z.string().min(1).describe("Opaque public node id (as returned by graph search/related or on a card's nodes)."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = graphNodeSchema;
type Output = z.infer<typeof outputSchema>;

const tako_graph_node = {
  name: "tako_graph_node",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Node",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input: Input, ctx): Promise<Output> {
    const path = `/api/beta/graph/node/${encodeURIComponent(input.id)}`;
    const data = await djangoGet<unknown>(ctx.env, ctx.token, path, {
      timeoutMs: 15_000,
    });

    const wire = GraphNode.safeParse(data);
    if (!wire.success) {
      throw new Error(
        "Tako graph/node endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
      );
    }
    return wire.data as Output;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_node;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tako_graph_node && npm run typecheck`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the tool**

Edit `workers/scripts/gen-registry.ts` — add `"tako_graph_node"` to `MCP_TOOL_ALLOWLIST` (before `"tako_graph_search"`). Then:

Run: `npm run registry:gen`
Expected: `_registry.ts` and `registry/server.json` include `tako_graph_node`.

- [ ] **Step 6: Verify**

Run: `npm run registry:check && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/src/tools/tako_graph_node.ts workers/src/tools/tako_graph_node.test.ts \
  workers/scripts/gen-registry.ts workers/src/tools/_registry.ts registry/server.json
git commit -m "feat: tako_graph_node tool"
```

---

### Task 4: `tako_graph_related` tool (with multi-`q` fan-out)

**Files:**
- Create: `workers/src/tools/tako_graph_related.ts`
- Test: `workers/src/tools/tako_graph_related.test.ts`
- Modify: `workers/scripts/gen-registry.ts` (add `"tako_graph_related"`)
- Regenerate: `workers/src/tools/_registry.ts`, `registry/server.json`

**Interfaces:**
- Consumes: `graphRelatedOutputShape`, `mergeRelatedResponses` from `./_graph.js`; `GraphRelatedResponse` from `../generated/schemas.js`; `djangoGet`; `ToolModule`.
- Produces: default export `tako_graph_related`, name `"tako_graph_related"`. `q` accepts `string | string[]`; multiple values fan out to parallel `GET /api/beta/graph/related` calls, merged via `mergeRelatedResponses`.

- [ ] **Step 1: Write the failing test**

Create `workers/src/tools/tako_graph_related.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoGraphRelated from "./tako_graph_related.js";
import {
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test", env: ENV, sendProgress: noopSendProgress, client: "claude",
};

const hub = { id: "tesla-x1", type: "entity", name: "Tesla" };
const metricsPage = (items: { id: string; name: string }[], capped = false) => ({
  node: hub,
  relation: {
    key: "metrics", kind: "data", label: "Metrics",
    items: items.map((i) => ({ id: i.id, type: "metric", name: i.name })),
    total: items.length, total_capped: capped, next_cursor: null,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_graph_related", () => {
  it("tool name is tako_graph_related", () => {
    expect(takoGraphRelated.name).toBe("tako_graph_related");
  });

  it("overview: sends only node_id when no relation/q", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { node: hub, relations: [] }),
    ]);
    await takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.pathname).toBe("/api/beta/graph/related");
    expect(url.searchParams.get("node_id")).toBe("tesla-x1");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("relation")).toBe(false);
  });

  it("single q string: one call, response returned unchanged", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, metricsPage([{ id: "rev-1", name: "Revenue" }], true)),
    ]);
    const out = await takoGraphRelated.handler(
      { node_id: "tesla-x1", relation: "metrics", q: "revenue" }, CTX,
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
    const url = new URL(requestFrom(fetchMock.mock.calls[0]).url);
    expect(url.searchParams.get("q")).toBe("revenue");
    expect(url.searchParams.get("relation")).toBe("metrics");
    expect(out.relation?.total_capped).toBe(true); // unchanged passthrough
  });

  it("multi q array: fans out one call per value and unions/dedupes items", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, metricsPage([
        { id: "rev-1", name: "Revenue" }, { id: "shared-9", name: "Average Wages" },
      ])),
      jsonResponse(200, metricsPage([
        { id: "sales-2", name: "Sales" }, { id: "shared-9", name: "Average Wages" },
      ])),
    ]);
    const out = await takoGraphRelated.handler(
      { node_id: "tesla-x1", relation: "metrics", q: ["revenue", "sales"] }, CTX,
    );
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(out.relation?.items.map((n) => n.id)).toEqual([
      "rev-1", "shared-9", "sales-2",
    ]);
    expect(out.relation?.total).toBe(3);
  });

  it("rejects an empty q array", () => {
    expect(() =>
      takoGraphRelated.inputSchema.parse({ node_id: "x", q: [] }),
    ).toThrow();
  });

  it("throws an actionable error on a mis-shaped response", async () => {
    mockFetchSequence([jsonResponse(200, { node: hub, relations: "nope" })]);
    await expect(
      takoGraphRelated.handler({ node_id: "tesla-x1" }, CTX),
    ).rejects.toThrow(/unexpected shape/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tako_graph_related`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `workers/src/tools/tako_graph_related.ts`:

```ts
/**
 * `tako_graph_related` — explore what a resolved graph node connects to.
 *
 * Wraps `GET /api/beta/graph/related`. Overview mode (no relation, no q) is the
 * coverage map; drill mode (relation=<key>) pages one group. `q` accepts a
 * string OR an array of strings — because q is substring-matched and a metric
 * has many names, an array fans out to parallel calls and the results are
 * unioned/deduped by node id (graph calls are free). Wire-guarded against the
 * generated GraphRelatedResponse.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { GraphRelatedResponse } from "../generated/schemas.js";
import { graphRelatedOutputShape, mergeRelatedResponses } from "./_graph.js";
import type { ToolModule } from "./types.js";

const NER_LABELS = [
  "PERSON", "ORG", "GPE", "LOC", "PRODUCT", "EVENT", "LANGUAGE",
  "MONEY", "METRIC", "STOCK_TICKER", "WEBSITE",
] as const;

const DESCRIPTION =
  "Explore what a resolved graph node connects to — the map of **what data Tako has** for it. Call with just `node_id` for the **overview**: an ordered set of relation groups (`metrics`, `entities`, `rel:*` named edges like `rel:competes_with`, `siblings`, `part_of`/`members`), each with a preview and `total`/`total_capped` (a capped total means 'N+' — narrow to see more). Pass `relation=<key>` to page one group. `q` is an **optional** case-insensitive substring filter on name+aliases — use it only to target a specific metric/thing (e.g. `q: \"revenue\"`); omit it to browse coverage. Because `q` is substring-matched and a metric has many names, you may pass an **array** of `q` values (e.g. `[\"revenue\",\"sales\",\"net income\"]`) — each is fetched in parallel and the results are unioned/deduped for you. Honesty caveat: related metrics are **table-level** (metrics in datasets that cover the node), so a listed metric is strong evidence, not proof — `tako_search` is the final validator. Empty `items` is a normal answer. Graph calls are free — use them liberally to ground `tako_search`/`tako_answer`.";

const inputSchema = z.object({
  node_id: z.string().min(1).describe("Opaque public id of the node to explore."),
  relation: z.string().min(1).optional().describe(
    "Relation key to page: metrics, entities, siblings, part_of, members, or rel:<phrase>. Omit for the overview of all groups.",
  ),
  q: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
    .optional()
    .describe(
      "Optional case-insensitive substring filter on name+aliases. Pass an array to fetch multiple name-variants in parallel (results are unioned/deduped).",
    ),
  label: z.enum(NER_LABELS).optional().describe(
    "Prefer related nodes with this NER label (boost, not a filter).",
  ),
  infer_label: z.boolean().optional().describe(
    "Auto-detect labels from q (default true server-side, only when q is set).",
  ),
  cursor: z.string().min(1).optional().describe(
    "Pagination cursor (for a single drilled relation; intended for single-q use).",
  ),
  limit: z.number().int().min(1).max(100).optional().describe(
    "Page size (default 50, max 100).",
  ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object(graphRelatedOutputShape);
type Output = z.infer<typeof outputSchema>;

const tako_graph_related = {
  name: "tako_graph_related",
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  annotations: {
    title: "Tako: Graph Related",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(input: Input, ctx): Promise<Output> {
    // Normalise q into a list of filter values; `undefined` means "no q".
    const qList: (string | undefined)[] = Array.isArray(input.q)
      ? input.q
      : input.q !== undefined
        ? [input.q]
        : [undefined];

    const responses = await Promise.all(
      qList.map(async (qVal) => {
        const query: Record<string, string | number | boolean> = {
          node_id: input.node_id,
        };
        if (input.relation !== undefined) query.relation = input.relation;
        if (qVal !== undefined) query.q = qVal;
        if (input.label !== undefined) query.label = input.label;
        if (input.infer_label !== undefined) query.infer_label = input.infer_label;
        if (input.cursor !== undefined) query.cursor = input.cursor;
        if (input.limit !== undefined) query.limit = input.limit;

        const data = await djangoGet<unknown>(
          ctx.env, ctx.token, "/api/beta/graph/related",
          { query, timeoutMs: 15_000 },
        );
        const wire = GraphRelatedResponse.safeParse(data);
        if (!wire.success) {
          throw new Error(
            "Tako graph/related endpoint returned an unexpected shape. Retry once; if it persists, flag it to the Tako team.",
          );
        }
        return wire.data;
      }),
    );

    const result = responses.length === 1 ? responses[0]! : mergeRelatedResponses(responses);
    return result as Output;
  },
} satisfies ToolModule<typeof inputSchema, Output>;

export default tako_graph_related;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tako_graph_related && npm run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Register the tool**

Edit `workers/scripts/gen-registry.ts` — add `"tako_graph_related"` to `MCP_TOOL_ALLOWLIST` (before `"tako_graph_search"`). Then:

Run: `npm run registry:gen`
Expected: `_registry.ts` and `registry/server.json` include `tako_graph_related`.

- [ ] **Step 6: Verify**

Run: `npm run registry:check && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/src/tools/tako_graph_related.ts workers/src/tools/tako_graph_related.test.ts \
  workers/scripts/gen-registry.ts workers/src/tools/_registry.ts registry/server.json
git commit -m "feat: tako_graph_related tool with multi-q fan-out"
```

---

### Task 5: Extend `tako_search` — pin `node_ids`/`strict` + surface card `nodes`

**Files:**
- Modify: `workers/src/tools/tako_search.ts` (input schema + `buildSearchBody` + DESCRIPTION)
- Modify: `workers/src/tools/_search_results.ts` (add typed `nodes` to `takoCardSchema`)
- Modify: `workers/src/tools/tako_search.test.ts` (new cases)

**Interfaces:**
- Consumes: existing `SearchRequest` (its `sources.data` is `DataSourceSettings`, which already types `node_ids?: string[]` and `strict?: boolean`).
- Produces: `buildSearchBody` now emits `sources.data.node_ids` / `sources.data.strict`; `tako_search` output cards carry `nodes?: {id,name,type}[]`.

- [ ] **Step 1: Write the failing tests**

Add to `workers/src/tools/tako_search.test.ts` (inside a new `describe`, and extend an existing FULL_RESPONSE card with `nodes`). Add this block:

```ts
describe("tako_search graph grounding", () => {
  it("maps node_ids + strict into sources.data", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-g" }),
    ]);

    await takoSearch.handler(
      {
        query: "Tesla revenue",
        sources: ["data"],
        count: 10,
        include_contents: false,
        country_code: "US",
        locale: "en-US",
        node_ids: ["tesla-x1", "rev-9"],
        strict: true,
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: {
        count: 10,
        include_contents: false,
        node_ids: ["tesla-x1", "rev-9"],
        strict: true,
      },
    });
  });

  it("omits node_ids/strict when not provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { cards: [], web_results: [], request_id: "req-h" }),
    ]);
    await takoSearch.handler(
      { query: "q", sources: ["data"], count: 10, include_contents: false,
        country_code: "US", locale: "en-US" },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { count: 10, include_contents: false } });
  });

  it("surfaces each card's graph nodes in the output", async () => {
    mockFetchSequence([
      jsonResponse(200, {
        cards: [
          {
            card_id: "abc123",
            title: "Tesla Revenue",
            embed_url: "https://trytako.com/embed/abc123/",
            nodes: [
              { id: "tesla-x1", name: "Tesla", type: "entity" },
              { id: "rev-9", name: "Revenue", type: "metric" },
            ],
          },
        ],
        web_results: [],
        request_id: "req-n",
      }),
    ]);
    const out = await takoSearch.handler(
      { query: "Tesla revenue", sources: ["data"], count: 10,
        include_contents: false, country_code: "US", locale: "en-US" },
      CTX,
    );
    expect(out.cards[0]?.nodes).toEqual([
      { id: "tesla-x1", name: "Tesla", type: "entity" },
      { id: "rev-9", name: "Revenue", type: "metric" },
    ]);
  });
});
```

> If `takoSearch`/`bodyOf`/`requestFrom`/`mockFetchSequence` are not already imported in this test file, add them to the existing import block (mirror `tako_answer.test.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tako_search`
Expected: FAIL — `sources.data` lacks `node_ids`/`strict`; `out.cards[0].nodes` is `undefined`.

- [ ] **Step 3: Add typed `nodes` to the card facade**

Edit `workers/src/tools/_search_results.ts` — add a `nodes` field to `takoCardSchema` (right after `content`):

```ts
export const takoCardSchema = z
  .object({
    card_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
    // Inline card CSV — present only when include_contents was set for the tako source.
    content: resultContentSchema.nullable().optional(),
    // Graph nodes (entities/metrics) this card was built from, returned by the
    // backend by default. Slim shape (id/name/type) — pass these ids into
    // sources.data.node_ids to pin the same nodes in a follow-up search, or
    // hydrate with tako_graph_node for full detail.
    nodes: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.enum(["metric", "entity"]),
        }),
      )
      .nullable()
      .optional(),
  })
  .loose();
```

- [ ] **Step 4: Add `node_ids`/`strict` inputs to `tako_search`**

Edit `workers/src/tools/tako_search.ts` — add to the `inputSchema` object (after `locale`):

```ts
  node_ids: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "Graph node ids (from tako_graph_search / tako_graph_related, or a card's nodes) to PIN into the Tako data source. Pinned nodes get a strong retrieval boost. Max 20. Applies only to the 'data' source.",
    ),
  strict: z
    .boolean()
    .default(false)
    .describe(
      "Documented to return only cards matching a pinned node (requires node_ids). NOTE: not reliably enforced upstream — rely on the pin boost, not strict, for hard exclusion.",
    ),
```

- [ ] **Step 5: Map the new fields in `buildSearchBody`**

Edit `buildSearchBody` in `workers/src/tools/tako_search.ts` — replace the `data` source assignment block:

```ts
  if (input.sources.includes("data") || input.sources.includes("tako")) {
    const data: NonNullable<
      NonNullable<z.input<typeof SearchRequest>["sources"]>["data"]
    > = { count: input.count, include_contents: input.include_contents };
    if (input.node_ids !== undefined && input.node_ids.length > 0) {
      data.node_ids = input.node_ids;
    }
    if (input.strict) {
      data.strict = true;
    }
    sources.data = data;
  }
```

- [ ] **Step 6: Extend the DESCRIPTION**

Edit the `DESCRIPTION` constant in `workers/src/tools/tako_search.ts` — append this sentence to the end of the existing string (before the closing quote):

```
 **Grounding with the data graph:** resolve entities/metrics with `tako_graph_search` + `tako_graph_related`, then pass the resolved ids in `node_ids` (max 20) to pin them (strong retrieval boost). `strict` is documented to hard-filter to pinned nodes but is NOT reliably enforced — rely on the pin boost, not `strict`, for exclusion. Each returned card lists its graph `nodes` (id/name/type) — reuse those ids to refine. Skip `web` when you're confident Tako has the data.
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm run test -- tako_search && npm run typecheck`
Expected: PASS. The `satisfies z.input<typeof SearchRequest>` guard in `buildSearchBody` must still compile (proves `node_ids`/`strict` are contract-valid on `sources.data`).

- [ ] **Step 8: Regenerate registry (description/schema changed) + verify**

Run: `npm run registry:gen && npm run registry:check && npm run test`
Expected: `registry/server.json` reflects the updated `tako_search` schema/description; all pass.

- [ ] **Step 9: Commit**

```bash
git add workers/src/tools/tako_search.ts workers/src/tools/_search_results.ts \
  workers/src/tools/tako_search.test.ts registry/server.json
git commit -m "feat: pin graph node_ids/strict in tako_search and surface card nodes"
```

---

### Task 6: Extend `tako_answer` — pin `node_ids`/`strict`

**Files:**
- Modify: `workers/src/tools/tako_answer.ts` (input schema + `buildAnswerBody` + DESCRIPTION)
- Modify: `workers/src/tools/tako_answer.test.ts` (new cases)

**Interfaces:**
- Consumes: same `SearchRequest.sources.data` (`DataSourceSettings`) as Task 5. `tako_answer` sends no per-source `count`, so `data` here carries only `include_contents` (+ optional `node_ids`/`strict`).
- Produces: `buildAnswerBody` emits `sources.data.node_ids` / `sources.data.strict`.

- [ ] **Step 1: Write the failing tests**

Add to `workers/src/tools/tako_answer.test.ts` a new `describe`:

```ts
describe("tako_answer graph grounding", () => {
  it("maps node_ids + strict into sources.data", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);

    await takoAnswer.handler(
      {
        query: "Tesla revenue",
        sources: ["data"],
        include_contents: false,
        country_code: "US",
        locale: "en-US",
        node_ids: ["tesla-x1"],
        strict: true,
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({
      data: { include_contents: false, node_ids: ["tesla-x1"], strict: true },
    });
  });

  it("omits node_ids/strict when not provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, FULL_RESPONSE)]);
    await takoAnswer.handler(
      { query: "q", sources: ["data"], include_contents: false,
        country_code: "US", locale: "en-US" },
      CTX,
    );
    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]!));
    expect(body.sources).toEqual({ data: { include_contents: false } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tako_answer`
Expected: FAIL — `sources.data` lacks `node_ids`/`strict`.

- [ ] **Step 3: Add `node_ids`/`strict` inputs**

Edit `workers/src/tools/tako_answer.ts` — add to `inputSchema` (after `locale`) the SAME two fields as Task 5 Step 4 (`node_ids` array max 20 optional; `strict` boolean default false, with the same `.describe(...)` text). Repeat them here verbatim:

```ts
  node_ids: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "Graph node ids (from tako_graph_search / tako_graph_related) to PIN into the Tako data source. Pinned nodes get a strong retrieval boost. Max 20. Applies only to the 'data' source.",
    ),
  strict: z
    .boolean()
    .default(false)
    .describe(
      "Documented to return only cards matching a pinned node (requires node_ids). NOTE: not reliably enforced upstream — rely on the pin boost, not strict, for hard exclusion.",
    ),
```

- [ ] **Step 4: Map the new fields in `buildAnswerBody`**

Edit `buildAnswerBody` in `workers/src/tools/tako_answer.ts` — replace the `data` source assignment:

```ts
  if (input.sources.includes("data") || input.sources.includes("tako")) {
    const data: NonNullable<
      NonNullable<z.input<typeof SearchRequest>["sources"]>["data"]
    > = { include_contents: input.include_contents };
    if (input.node_ids !== undefined && input.node_ids.length > 0) {
      data.node_ids = input.node_ids;
    }
    if (input.strict) {
      data.strict = true;
    }
    sources.data = data;
  }
```

- [ ] **Step 5: Extend the DESCRIPTION**

Edit the `DESCRIPTION` in `workers/src/tools/tako_answer.ts` — append before the closing quote:

```
 **Grounding with the data graph:** resolve entities/metrics with `tako_graph_search` + `tako_graph_related`, then pass the resolved ids in `node_ids` (max 20) to pin them (strong retrieval boost). `strict` is documented to hard-filter to pinned nodes but is NOT reliably enforced — rely on the pin boost. Skip `web` when you're confident Tako has the data.
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test -- tako_answer && npm run typecheck`
Expected: PASS. The `satisfies z.input<typeof SearchRequest>` guard in `buildAnswerBody` must still compile.

- [ ] **Step 7: Regenerate registry + full verify**

Run: `npm run registry:gen && npm run registry:check && npm run schemas:check && npm run test && npm run typecheck`
Expected: all pass; `registry/server.json` reflects the updated `tako_answer` schema/description.

- [ ] **Step 8: Commit**

```bash
git add workers/src/tools/tako_answer.ts workers/src/tools/tako_answer.test.ts registry/server.json
git commit -m "feat: pin graph node_ids/strict in tako_answer"
```

---

## Final verification (after all tasks)

Run from `workers/`:

```bash
npm run typecheck && npm run test && npm run registry:check && npm run schemas:check
```

Expected: everything green. The MCP server now exposes `tako_graph_search`, `tako_graph_related`, `tako_graph_node`, and both `tako_search` and `tako_answer` accept `node_ids` + `strict`.

**Manual staging smoke (optional, verifies the two open questions from the spec):**
- Confirm the `/api/beta/graph/*` trailing-slash convention against staging (the plan uses no trailing slash — mirrors nothing existing since `tako_search` uses one; if staging 404s without a trailing slash, append `/` to the three paths and re-run tests, updating the expected `url.pathname` assertions).
- Confirm `strict` behavior (descriptions already hedge that it is not reliably enforced).

## Spec coverage self-check

- §3.1 `tako_graph_search` → Task 2. ✓
- §3.2 `tako_graph_related` incl. overview/drill, `q` optional, multi-`q` union/dedupe → Tasks 1 (merge) + 4. ✓
- §3.3 `tako_graph_node` → Task 3. ✓
- §3.4 `tako_search` node_ids/strict + surface typed card nodes → Task 5. ✓
- §3.5 `tako_answer` node_ids/strict → Task 6. ✓
- §4 workflow guidance in descriptions → embedded in Tasks 2/4/3 (parallel narrow, overview medium, multi-q broad; "graph is free"; gaps/table-level honesty) + Tasks 5/6 (grounding sentence). ✓
- §5 path prefix, scalar query via djangoGet, wire guards, error handling, immutability, registration → all tasks + Global Constraints. ✓
- §6 testing (per-tool, multi-q merge, buildSearchBody/buildAnswerBody, card nodes) → Tasks 1–6. ✓
- §7 out of scope (no orchestrator, no retry logic, no widgets, no schema edits) → respected; no tasks add them. ✓
- §8 open questions (trailing slash, strict, multi-q merge) → surfaced in Final verification + description hedges. ✓
```
