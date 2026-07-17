# Graph API integration for tako-mcp — design

**Date:** 2026-07-17
**Status:** Approved design, ready for implementation planning
**Author:** Eric (with Claude)

## 1. Summary

Add Tako's data-graph capability to the MCP server as three thin primitive
tools that map 1:1 to the graph HTTP endpoints, and extend the two existing
retrieval tools (`tako_search`, `tako_answer`) to pin resolved graph nodes.

The graph endpoints let an agent discover **what data Tako actually has** before
(or alongside) a search — so it composes queries that hit, pins the exact nodes
it resolved, and honestly reports what's missing. Graph calls are free and
efficient, so the tools are designed to be used liberally.

**New tools:**

- `tako_graph_search` — resolve a name → graph node(s)
- `tako_graph_related` — a node → what it connects to
- `tako_graph_node` — hydrate a node id → full node detail

**Modified tools:**

- `tako_search` — expose `node_ids` + `strict`; surface typed card `nodes`
- `tako_answer` — expose `node_ids` + `strict`

## 2. Background & current state

- Tools live as one-file-per-tool `ToolModule`s under `workers/src/tools/`,
  auto-registered via codegen (`npm run registry:gen`). The registry barrel,
  `registry/server.json`, and the runtime tool list are all emitted from the
  same scan and cannot drift.
- The graph endpoints and their response schemas **already exist** in
  `openapi/sdk.yaml` and are already generated into
  `workers/src/generated/schemas.ts`: `GraphSearchResponse`,
  `GraphRelatedResponse`, `GraphRelationPage`, `GraphNode`, `GraphRelation`,
  `GraphNodeType`, `NerLabel`, `EntityClassName`, plus `TakoCardNode`.
- The backend `SearchRequest` schema **already supports**
  `sources.data.node_ids` (max 20) and `sources.data.strict`. Both
  `tako_search` and `tako_answer` POST a `SearchRequest`-shaped body
  (`/api/v3/search/` and `/api/v1/answer/` respectively), so both can pin
  nodes — but neither MCP tool exposes those inputs today.
- `tako_search` card output uses a `.loose()` schema, so backend `nodes`
  currently pass through untyped and undocumented.
- `django.ts` `djangoGet` supports scalar query params only (no repeated/array
  params). All graph query params are scalar (even `types` is a comma-separated
  string), so **no transport changes are needed**.

### Design philosophy

The tools are **thin primitives**; the workflow intelligence lives in the tool
**descriptions**. A raw MCP client never loads the `tako-graph-agent` skill, so
the proven strategies (entity-vs-metric resolution, overview-as-coverage-map,
grounded composition, gaps reporting) must be encoded in the descriptions as
**strong encouragement, not enforcement**. Server-side orchestration was
considered and rejected — it would take fine control (which nodes, parallel
timing, when to skip) away from the agent.

## 3. Tools

### 3.1 `tako_graph_search` — resolve a name → node(s)

Maps to `GET /api/beta/graph/search`.

**Input:**

| field | type | notes |
|---|---|---|
| `q` | string, required | search text, min 2 chars |
| `types` | `"entity" \| "metric"` | single choice; sent as the API's comma-separated string. Decide "thing vs measure" up front — don't mix. |
| `label` | NER enum, optional | boost (not a filter): `PERSON, ORG, GPE, LOC, PRODUCT, EVENT, LANGUAGE, MONEY, METRIC, STOCK_TICKER, WEBSITE`. Omit to let `infer_label` run. |
| `infer_label` | boolean, optional, default true | auto-detect labels from `q` |
| `limit` | integer, optional, default 20, max 50 | |

**Output:** validated against `GraphSearchResponse` →
`{ results: GraphNode[], inferred_labels? }`. Each node carries
`id, name, type, subtype, label, aliases, description`.

**Description encodes:** decide entity-vs-metric up front; `label` is a boost,
not a filter (read `subtype`/`label` on the node to actually pick); run this in
**parallel** with a `tako_search`/`tako_answer` for narrow queries; graph calls
are free — use liberally.

### 3.2 `tako_graph_related` — a node → what it connects to

Maps to `GET /api/beta/graph/related`.

**Input:**

| field | type | notes |
|---|---|---|
| `node_id` | string, required | opaque public id from a search/related result or a card node |
| `relation` | string, optional | relation key to drill: `metrics`, `entities`, `siblings`, `part_of`, `members`, or `rel:<phrase>`. Omit for the overview. |
| `q` | `string \| string[]`, optional | case-insensitive substring filter on name+aliases. See multi-`q` below. |
| `label` | NER enum, optional | boost |
| `infer_label` | boolean, optional, default true | |
| `cursor` | string, optional | pagination |
| `limit` | integer, optional, default 50, max 100 | |

The deprecated `relation_type` param is intentionally **not** exposed.

**Two modes:**

- **Overview (no `relation`, no `q`) = the coverage map.** Returns every
  relation group (`metrics`, `entities`, `rel:*` edges, `siblings`,
  `part_of`/`members`) as `relations[]`, each `{key, kind, label, items
  (preview), total, total_capped}`. This is the middle-ground workhorse for
  "what does Tako have on X?".
- **Drill (`relation=<key>`)** returns a single `relation` with `items[]`,
  `total`, `next_cursor`.

**`q` is optional — do NOT always pass it.** Pass `q` only when targeting a
specific metric/thing; it floats substring matches to the top.

**Multiple `q` (server-side fan-out).** `q` accepts `string | string[]`. Because
`q` is substring-matched and a metric has many names, an array like
`["revenue","sales","net income"]` catches all variants in one tool call. The
handler issues **one graph call per `q` value in parallel** and **unions +
dedupes items by node id**:

- In overview responses, union items within each relation group keyed by
  `relation.key` (dedupe by node id per group).
- In drill responses, union `relation.items` (dedupe by node id).
- A single string behaves exactly like the raw endpoint.

This is the one deliberate enrichment beyond a strict 1:1 primitive; it is
justified because graph calls are free/efficient and metric-name variance is
the common case.

**Output:** validated against `GraphRelatedResponse` (overview →
`relations[]`; drill → `relation`), after the union/dedupe merge when multiple
`q` values were given. The merged result preserves the `GraphRelatedResponse`
shape so downstream validation is unchanged.

**Description encodes:** overview is the coverage map (no `q` needed); use `q`
(and multi-`q` for name variants) to target; items live in
`relations[]`/`relation.items[]` (not `results`); `total_capped: true` → render
as `N+` and narrow with `q`; empty `items` is a normal answer, not a failure;
the honesty caveat — a node's related metrics are **table-level** (metrics in
datasets that cover the entity), so a listed metric is strong evidence, not
proof; `/v3/search` is the final validator.

### 3.3 `tako_graph_node` — hydrate an id → full node

Maps to `GET /api/beta/graph/node/{id}`.

**Input:** `id` (string, required — path param).

**Output:** validated against `GraphNode`.

**Purpose:** hydrate a slim node id (e.g. one returned on a `tako_search` card's
`nodes`, which carry only `id/name/type`) into full detail — `aliases`,
`subtype`, `label`, `description`.

### 3.4 `tako_search` extension

- **New inputs:** `node_ids: string[]` (max 20) and `strict: boolean` (default
  false), mapped in `buildSearchBody` to `sources.data.node_ids` /
  `sources.data.strict`.
- **Surface card nodes:** the backend returns `nodes` on each card **by
  default**; add a typed `nodes: [{ id, name, type }]` to the card output
  (matching the API's `TakoCardNode` shape). This closes the discovery loop —
  even a plain `tako_search` reveals pinnable ids for a refined follow-up.
- **Description encodes:** pin the ids you resolved via the graph tools; the
  `strict` caveat — it is *documented* as a hard filter to pinned nodes but was
  **not enforced in staging tests**, so rely on the pin boost, not on `strict`
  for exclusion; skip `web` when confident Tako has the data.

### 3.5 `tako_answer` extension

- **New inputs:** same `node_ids: string[]` (max 20) + `strict: boolean`
  (default false), mapped in `buildAnswerBody` to `sources.data.node_ids` /
  `sources.data.strict`.
- Answer POSTs the same `SearchRequest` body, so this is a symmetric change; it
  lets graph discovery ground prose answers, not just charts.

## 4. Workflow guidance (encoded in descriptions)

Descriptions steer three bands, and explicitly state that graph discovery feeds
**both** `tako_search` and `tako_answer`:

- **Narrow (1 entity + 1 metric):** fire `tako_graph_search` (entity) **in
  parallel** with the search/answer — the graph call confirms/contextualizes
  while retrieval runs.
- **Medium ("what does Tako have on X"):** resolve the entity via
  `tako_graph_search` → `tako_graph_related` **overview** (no `q`) to read the
  coverage map → pin the few useful nodes into `tako_search`/`tako_answer`.
- **Broad/research ("all Tesla financials"):** break the question into entities
  + metrics (+ optional NER labels) → resolve entities → `tako_graph_related`
  with **multi-`q`** metric variants (+ optional `label` boost) to enumerate
  entity×metric combos → filter to the useful nodes → pin them with `strict`
  into a graph-grounded `tako_search`/`tako_answer`. Skip `web` when confident
  Tako has the data; use `web` only when Tako plausibly lacks it.

**Framing line in each graph tool:** graph calls are free and efficient — use
them liberally to learn what advantageous data Tako has before (or alongside)
any search or answer.

**Gaps honesty:** report what the graph can't ground as explicit gaps
("Tako has X and Y, but not Z"). But the graph is not the whole index — price /
market-quote data especially lives outside the graph, so a thin graph result
for an entity Tako obviously covers is a cue to run an entity-level search, not
to declare a gap.

## 5. Shared implementation details

- **Path prefix:** graph paths in `openapi/sdk.yaml` are `/beta/graph/*`, but
  tools call Django with the `/api` prefix (as `tako_search` calls
  `/api/v3/search/`): `/api/beta/graph/search`, `/api/beta/graph/related`,
  `/api/beta/graph/node/{id}`. Exact trailing-slash convention to be verified
  against staging during implementation.
- **Transport:** `djangoGet` with scalar `query` params. `types` is passed as a
  comma-separated string. No changes to `django.ts`.
- **Wire guards:** each handler `safeParse`s the raw response against the
  generated schema before mapping (same pattern as `tako_search`), throwing a
  retry-suggesting error on drift — keeping the tools locked to
  `openapi/sdk.yaml`.
- **Error handling:** reuse the existing `DjangoError` subclasses. A 400 (bad
  `label`, malformed node id) surfaces its body; empty results return normally
  (empty `results`/`items` is a valid outcome, not an error).
- **Immutability:** handlers build new request/response objects; no mutation of
  inputs (per project coding style).
- **Registration:** dropping the three new files under `workers/src/tools/` and
  running `npm run registry:gen` wires them into the barrel and
  `registry/server.json` automatically.

## 6. Testing

Per-tool unit tests mirroring the existing `*.test.ts` files, using
`__test_helpers.ts` stubs:

- `tako_graph_search`: input → query mapping, wire-contract guard against
  `GraphSearchResponse`, 400/error paths, empty-results path.
- `tako_graph_related`: overview vs drill; single-`q` and **multi-`q`
  fan-out/union/dedupe** (assert dedupe by node id and per-group union);
  `total_capped` passthrough; empty `items` path.
- `tako_graph_node`: id → path mapping; `GraphNode` guard; 404/400 paths.
- `buildSearchBody` / `buildAnswerBody`: new `node_ids` + `strict` mapping into
  `sources.data`; typed card `nodes` surfaced in `tako_search` output.

Registry/schema codegen tests already auto-cover registration. Target the
project's 80% coverage bar.

## 7. Out of scope

- Server-side orchestration / a `tako_graph_discover` meta-tool (rejected in
  favor of thin primitives + guidance).
- Rate-limit / 429 retry logic in transport (`django.ts` leaves retries out of
  scope by design; descriptions mention backoff only as agent guidance).
- MCP Apps widgets for the graph tools (they return data, not charts).
- Any change to `openapi/sdk.yaml` or the generated schemas — the graph
  contract already exists there.

## 8. Open questions / risks

- **Trailing-slash convention** for `/api/beta/graph/*` — verify against
  staging during implementation.
- **`strict` semantics** — documented as a hard filter but unverified in
  staging; descriptions must not over-promise exclusion.
- **Multi-`q` merge semantics** — the union/dedupe is defined per relation
  group by node id; confirm the overview merge reads well when different `q`
  values hit different groups.
