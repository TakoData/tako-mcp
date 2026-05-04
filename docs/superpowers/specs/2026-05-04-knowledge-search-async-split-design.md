# Knowledge search — split deep polling into a separate tool

**Status:** Approved
**Date:** 2026-05-04
**Owner:** Juan Fassio
**Linear:** TBD (sibling to TAKO-2686)

## Problem

`knowledge_search` currently runs `fast` synchronously, and if `fast` returns
zero cards it auto-escalates to the async `deep` (Orca) pipeline and polls the
status endpoint server-side for up to 290s.

This auto-escalation works at the *Worker* level but consistently times out
at the *MCP client* level:

- The TS MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60s.
- Most MCP clients we care about (Claude Desktop, Cursor, the tako.com agent
  / playground) do not pass `options.timeout` and have no UI to override it.
- Deep (Orca) pipeline runs are routinely 60–300s.

Result: invoking `knowledge_search` with `search_effort: "deep"` — explicitly
or via the auto-escalation path — surfaces a `TimeoutError` to the user even
though the backend task is healthy and would have completed.

## Decision

Move the deep-polling responsibility from the Worker to the **agent**, by
splitting the async path across two tools, mirroring the existing
`create_report` → `wait_for_report` pattern. The two-tool flow is shaped so
every individual tool call comfortably finishes inside a 60s client timeout.

We deliberately keep this as **two tools, not three** — a single
`knowledge_search` entry point that auto-escalates remains the natural
agent surface; a separate `start_knowledge_search` would collide with it
and force the agent to choose between near-identical tools per call.

We also drop `medium` and `auto` from the `search_effort` enum. They are
in-between modes that don't earn their surface area: `fast` is the cheap
sync path and `deep` is the thorough async path — those two cover the
useful behavior, and removing the others means no agent needs to choose
between four near-identical options.

## Tool surface (after this change)

### `knowledge_search` (modified)

Single entry point. Polymorphic return — either synchronous results or a
task handle.

**Input schema**

```ts
{
  query: string,                         // unchanged
  count: number (1–20, default 10),      // default raised from 5 → 10 to match web UI
  search_effort?: "fast" | "deep",       // enum reduced; medium/auto removed
  country_code: string (default "US"),   // unchanged
  locale: string (default "en-US"),      // unchanged
}
```

**Behavior**

| `search_effort` value | Behavior |
|---|---|
| omitted (default) | Run `fast` sync. If 0 results → kick off `deep` async, return `{ task_id, status: "pending", … }`. If results → return them. |
| `"fast"` | Run `fast` sync, no escalation. Return whatever fast finds (including empty). |
| `"deep"` | POST `/api/v1/knowledge_search` with `search_effort: "deep"`. Almost always returns 202 `{ task_id, status: "pending" }` → return that immediately. If the backend ever returns sync cards (theoretical fast path), surface them on the sync results path. **No server-side polling.** |

**Output schema** — discriminated union:

```ts
// Sync results path (fast hit, or default-with-fast-results)
{
  results: Visualization[],
  count: number,
  pub_id?: string,
  embed_url?: string,
  image_url?: string,
  dark_mode?: boolean,
  width?: number,
  height?: number,
}

// Async kick-off path (explicit deep, or default-fast-empty escalation)
{
  task_id: string,
  status: "pending",
  message: string,        // human-readable hint pointing the agent at wait_for_knowledge_search
  search_effort: "deep",  // discriminator for the agent
}
```

The agent branches on whether `task_id` is present. The `message` field is
prescriptive (e.g. *"Deep search running. Call `wait_for_knowledge_search`
with this task_id until it returns COMPLETED."*) and the tool description
restates the contract.

The auto-chain widget fields (`pub_id`, `embed_url`, etc.) only appear on
the sync results path. On the async kick-off path the host renders no
chart — `wait_for_knowledge_search`'s COMPLETED response carries the same
widget fields so the chart auto-renders when the task finishes.

**Removed from the current implementation**

- `pollAsyncKnowledgeSearch` and the entire polling loop
- `POLL_INTERVAL_MS`, `POLL_BUDGET_MS`, `STATUS_REQUEST_TIMEOUT_MS`,
  `MAX_TRANSIENT_RETRIES`, `COMPLETED_STATE`, `FAILURE_STATES`
- `summarizeProgress`, `isTransientStatusError`
- The async-status types (`AsyncTaskStatus`, `AsyncTaskEvent`) move to
  `wait_for_knowledge_search.ts`
- `medium` and `auto` enum values

### `wait_for_knowledge_search` (new)

Server-side polling around the async knowledge-search status endpoint,
exact analogue of `wait_for_report`.

**Input schema**

```ts
{
  task_id: string,
  max_wait_seconds: number (1–50, default 50),
}
```

`max_wait_seconds` is hard-capped at 50s — same ceiling as
`wait_for_report` — to leave a 10s margin under the 60s client timeout.

**Behavior**

- GET `/api/v1/knowledge_search/async/status/?task_id=…&since_index=…`
- Loop with the same backoff as `wait_for_report`: 5s initial, +2s step,
  capped at 15s
- Lowercase the status field for casing-tolerant comparison
- Three terminal outcomes:
  - `COMPLETED` → return `{ results, count, …widget fields, timed_out: false }`
    (same shape as the sync path of `knowledge_search`, so the host
    renders the chart inline)
  - `FAILED` / `INTERRUPTED` → throw with `error` and progress summary
  - Budget exhausted → return last-known status fields with `timed_out: true`,
    agent loops by calling again with the same `task_id`

**Output schema**

```ts
// Same field shape as knowledge_search's sync results path
{
  results: Visualization[],
  count: number,
  pub_id?: string,
  embed_url?: string,
  image_url?: string,
  dark_mode?: boolean,
  width?: number,
  height?: number,
  timed_out: boolean,   // true → call wait_for_knowledge_search again with the same task_id
  status?: string,      // backend status when timed_out
  events_summary?: string,  // "N progress events; last: PLANNING" — same format as today
}
```

**`extraMeta` / `extraContentBlocks` / `appUiResource`** — copy from
`knowledge_search` so the auto-chain widget renders identically when the
deep task finishes via this tool.

## Agent flow (end-to-end)

1. Agent calls `knowledge_search({ query })`.
2. Two outcomes:
   - **Sync hit:** response has `results[]` with `count > 0` → done; chart
     auto-renders.
   - **Escalation:** response has `task_id` and `status: "pending"` → the
     agent reads the `message` field and chains.
3. Agent calls `wait_for_knowledge_search({ task_id })`.
4. Three outcomes:
   - `timed_out: false` and `results.length > 0` → done; chart auto-renders.
   - `timed_out: true` → loop step 3 with same `task_id` (cap at ~12 calls
     total, matching `wait_for_report`'s guidance).
   - Throws → surface error to user.

## Tests

Cover with vitest in `workers/src/tools/`:

### `knowledge_search.test.ts` (existing — update)

- Sync `fast` returning cards → results path, no task_id
- Sync `fast` returning 0 cards (default effort) → kick off `deep`, return
  task_id (no polling assertion)
- Explicit `search_effort: "fast"` returning 0 → return empty results
  (NOT escalated)
- Explicit `search_effort: "deep"` → POST returns 202 → tool returns
  task_id immediately; no GET against status endpoint
- Auto-chain widget fields present on sync hit, absent on async kick-off
- Validation: `medium` and `auto` rejected by zod (regression guard)

### `wait_for_knowledge_search.test.ts` (new)

Mirror `wait_for_report.test.ts`:

- COMPLETED on first poll → returns results + widget fields, `timed_out: false`
- COMPLETED after several PENDING polls → returns results, `timed_out: false`
- FAILED → throws with status + last event summary
- INTERRUPTED → throws
- Budget exhausted → returns `timed_out: true` with last status
- Transient 5xx within retry budget → recovers; sustained 5xx surfaces
- Casing tolerance: `"COMPLETED"` and `"completed"` both terminal
- Subrequest math: stays under 50 GETs (same envelope as wait_for_report)

## Migration / compatibility

- **External API contract:** `knowledge_search`'s schema *changes* —
  `medium` and `auto` are removed from the enum, the default `count`
  becomes 10, and the response gains a polymorphic shape. Any caller
  hard-coding `"medium"` will get a validation error. We treat this as
  acceptable because the hosted Worker is the canonical surface and we
  control the agent prompts; legacy Python `src/tako_mcp/` is left alone.
- **Registry regen:** run `npm run registry:gen` to refresh
  `workers/src/tools/_registry.ts` and `registry/server.json` (CI checks
  for drift).
- **Smoke test:** extend `workers/scripts/smoke.ts` to hit the new tool
  with a known-cheap query that triggers the async path (or skip if no
  staging task is queueable).

## Out of scope / explicitly not doing

- **`force_deep` / `force_fast` shortcut params.** Adding parameters to
  bypass auto-escalation. Easy to add later if a real use case appears;
  YAGNI for v1.
- **Server-sent progress notifications** (the original Option 1). Only
  helps clients that opt into `resetTimeoutOnProgress`, which the clients
  we care about don't. Not worth the plumbing.
- **Backend Orca timeout / latency improvements.** The 60–300s deep run
  is a property of `orchestrator_deep_config.py`; orthogonal to this
  work.
- **Updating the Python `src/tako_mcp/` implementation.** This change
  applies to `workers/` only. Python self-host stays on its current
  behavior until a separate decision is made.

## Open questions

None at write-time.
