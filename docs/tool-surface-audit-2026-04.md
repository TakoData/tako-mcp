# Tool Surface Audit — April 2026

**Status:** Draft for Bobby's review.
**Ticket:** [TAKO-2599](https://linear.app/trytako/issue/TAKO-2599/tool-surface-audit-endpoint-addremove-proposal).
**Related:** Spec PR [tako#23362](https://github.com/TakoData/tako/pull/23362) (original port design).

## Executive summary

The tako-mcp TypeScript port is scheduled as a faithful re-implementation of the 8 Python tools. This audit revisits that scope to answer Bobby's 4th ask: *"suggest 1–2 endpoints to add or remove from the tool surface, with rationale."*

**Recommendations:**

- **Port all 8 tools as planned for Phase 2.** The current surface holds up. No tool is strictly redundant, the "1 tool per user intent" shape is right for MCP, and the cost of porting a tool is small relative to the risk of removing one that turns out to be used. Keep everything; revisit removals later with production telemetry in hand.
- **No new tools in Phase 2.** The audit surfaced four candidate additions (`ask_tako`, `list_reports`, `create_report`, `get_report`) that would meaningfully expand what agents can do with Tako. They are documented at the end of this doc as future candidates but are explicitly **out of scope for Phase 2** — revisit after the TypeScript port is shipping and we have real usage telemetry for the current 8.
- **Post-Phase-2 monitoring.** Once the TypeScript MCP is in production, add per-tool instrumentation and check real usage over 30 days. The `explore_knowledge_graph` hypothesis (that LLMs skip it in favor of direct `knowledge_search`) can be validated then; if usage is <5% it's a safe remove. Doing this post-port instead of pre-port avoids blocking Phase 2 on a telemetry decision.

---

## Current 8 tools — audit

Each tool is audited against: purpose, endpoint it hits, input/output shape, where the underlying endpoint is used in the Tako web app (agent-mirroring vs agent-native), and redundancy with peers.

### Agent-native primitives (no web UI equivalent)

These endpoints exist specifically for programmatic consumers — the Tako web app does not call them. MCP is one of their intended callers.

| # | Tool | Endpoint | Purpose | I/O |
|---|---|---|---|---|
| 4 | `explore_knowledge_graph` | `POST /api/v1/explore/` | Discover entities/metrics/cohorts/time-periods available in Tako's KG, typically as a pre-step to disambiguate `knowledge_search` queries. | In: `query`, optional `node_types[]`, `limit`. Out: `{entities[], metrics[], cohorts[], time_periods[], total_matches}`. |
| 5 | `list_chart_schemas` | `GET /api/v1/thin_viz/default_schema/` | List available chart templates (bar, line, pie, choropleth, etc.). First step of the 3-step chart-creation flow. | In: none. Out: `{schemas: [{name, description, components}], count}`. |
| 6 | `get_chart_schema` | `GET /api/v1/thin_viz/default_schema/{name}/` | Fetch the exact data shape a chart template expects. Second step of chart creation. | In: `schema_name`. Out: `{name, description, components, template}`. |
| 7 | `create_chart` | `POST /api/v1/thin_viz/default_schema/{name}/create/` | Create a chart from raw data using a schema template. Third step of chart creation. Only **write** tool in the current surface. | In: `schema_name`, `components[]`, optional `source`. Out: `{card_id, title, description, webpage_url, embed_url, image_url}`. |

### UI-mirroring primitives (also called by the web app)

These endpoints are wrapped by UI features in the Tako web app; the MCP tools give Claude parity with what a human Tako user sees.

| # | Tool | Endpoint | Web app caller | Purpose | I/O |
|---|---|---|---|---|---|
| 1 | `knowledge_search` | `POST /api/v1/knowledge_search` | The main search bar on the home page (uses `/async/` variant in web, sync in MCP). `components/shared/api/dispatchSearch.ts`. | Semantic search over Tako's curated chart knowledge base. Returns matching cards with `card_id`, title, description, url, source. | In: `query`, `count`, `search_effort`, `country_code`, `locale`. Out: `{results[], count}`. |
| 2 | `get_chart_image` | `GET /api/v1/image/{pub_id}/` | Every chart thumbnail/preview image in the app (search results, library grid, report embeds). `components/shared/chartImageUrl.ts`. | Get a static PNG URL for a chart. Used when agents want to embed a chart as an image. | In: `pub_id`, `dark_mode`. Out: `{image_url, pub_id, dark_mode}`. |
| 3 | `get_card_insights` | `GET /api/v1/internal/chart-configs/{pub_id}/chart-insights/` | The "AI insights" bullets on insight cards in the Insights / reports flow. `pages/insights/`. | Get AI-generated analysis of a chart's data: bullet-point takeaways + narrative description. | In: `pub_id`, `effort`. Out: `{pub_id, insights, description}`. |
| 8 | `open_chart_ui` | (no backend call — returns MCP-UI HTML wrapping `/embed/{pub_id}/`) | Every interactive chart iframe in the app — share modal previews, saved-view cards, insights deck cards, report embeds. | Return an MCP-UI `UIResource` that renders an interactive chart iframe. | In: `pub_id`, `dark_mode`, `width`, `height`. Out: `[UIResource]`. |

### Redundancy analysis

- **`knowledge_search` vs `explore_knowledge_graph`** — these target different intents. `knowledge_search` is "find a chart on this topic"; `explore_knowledge_graph` is "tell me what entities/metrics exist so I can formulate a better search." In practice LLMs tend to skip the second step and go straight to `knowledge_search`, which is why we suspect `explore_knowledge_graph` is under-used (see removal proposal below).
- **`list_chart_schemas` → `get_chart_schema` → `create_chart`** — these compose as a single 3-step workflow. They are not redundant; each is load-bearing. `list_chart_schemas` is discovery, `get_chart_schema` is type-specific contract, `create_chart` is the action. This mirrors the `list_report_types → create_report` pattern we'd follow if reports are added later.
- **`get_chart_image` vs `open_chart_ui`** — complementary, not redundant. `get_chart_image` returns a PNG URL (compact, embeddable in text responses). `open_chart_ui` returns an MCP-UI interactive iframe (rich, explorable). Both have valid use cases.
- **`get_card_insights`** — no redundancy. It's the only tool that returns a narrative interpretation of a chart.

### Real-world caller patterns

We do not have MCP-side telemetry today — tako-mcp runs without a `DD_SERVICE` tag, and its Python log lines don't emit per-tool counts at INFO or higher level. What we can measure comes from the Django backend's access logs:

- The backend is instrumented as `service:django` in Datadog (`devops/tf/ecs.tf:529`).
- MCP's outbound HTTP client uses `httpx`, so calls appear with `http.useragent:python-httpx*`, distinguishing them from browser traffic (which uses standard browser UAs).
- This lets us count per-endpoint hits for MCP-originated traffic without backend instrumentation changes.

A Datadog query for post-Phase-2 monitoring appears below.

---

## Proposal: port all 8 as planned, no Phase 2 removals

**Recommendation:** Execute Phase 2 as originally scoped — port every current tool, including `explore_knowledge_graph`. Do not propose a removal in this audit.

### Why not propose a removal now

1. **We lack production telemetry.** The current Python MCP server has no `DD_SERVICE` tag and does not emit per-tool INFO logs that Datadog would capture. Any removal decision today would be based on hypotheses, not measurements.
2. **Porting cost is small; removal cost is high.** Porting `explore_knowledge_graph` is a self-contained ticket (~130 lines of Python → TypeScript). Removing a tool that an external integration depends on is a breaking change requiring deprecation comms. When the asymmetry runs that direction, the conservative move is to keep.
3. **The hypothesis that `explore_knowledge_graph` is under-used is plausible but not validated.** Its tool description tells LLMs to use it *before* `knowledge_search` ("to disambiguate queries"), and modern LLMs don't usually take a two-step discover-then-query path — they query directly. The endpoint also has zero Tako web-frontend callers, so its entire usage is MCP + external API. But "plausible" isn't "proven." Defer until we can measure.

### Post-Phase-2 monitoring plan

Once the TypeScript MCP is deployed (it will ship with Cloudflare Workers observability enabled per `workers/wrangler.jsonc`), add per-tool counters and re-audit after 30 days of production traffic.

Interim measurement via Django logs is possible today with this Datadog query:

```
service:django http.useragent:python-httpx* @http.url_path:(
  "/api/v1/explore/"
  OR "/api/v1/knowledge_search"
  OR "/api/v1/thin_viz/default_schema"
  OR "/api/v1/image/*"
  OR "/api/v1/internal/chart-configs/*/chart-insights/"
)
```

Group by `@http.url_path`, count, sort descending. If `/api/v1/explore/` is <5% of the total across MCP-UA traffic over 30 days, that's a signal worth acting on in a follow-up audit. If the Datadog Django integration tags the path field differently (`@http.url_details.path` or `@http.url`), APM's Service → django → Resources tab is the fallback.

---

## Deferred: candidate additions to consider after Phase 2

These are **not proposed for Phase 2**. They are documented here so the audit is complete and so Bobby can weigh in on which, if any, should be picked up as follow-up tickets once the TypeScript port is shipping.

### 1. `ask_tako` — wraps `POST /api/external/v1/query` (Orca thread query, external facade)

**Why it's a candidate.** The current 8 tools let Claude search pre-indexed charts and render them, but cannot synthesize new visualizations from raw knowledge-graph data. A comparative question like *"how are Ford sales doing vs Tesla?"* likely has no pre-built card — `knowledge_search` returns two tangentially related charts and Claude must reconcile them from PNGs. Orca's thread pipeline synthesizes a new comparison chart from raw data, which is a genuinely different capability.

**Why it's a clean fit.** Tako already ships an external-facing facade over the thread pipeline at `POST /api/external/v1/query`, with request shape `{query, thread_id?}` and response `{thread_id, message_id, text, visualizations[]}`. No new backend work is required. MCP would wrap the endpoint with `thread_id` hidden from the agent (Claude provides the conversational state itself; exposing `thread_id` creates two parallel conversations to keep in sync).

**Cost.** Every call runs the full Orca pipeline and consumes credits. Agents would over-trigger relative to `knowledge_search` — but for analytical/comparative questions that's the correct behavior, not a leak.

**Key caveat.** The external endpoint strips artifacts, SQL, and methodology from its response (see `external_views.py:246`). Agents can get the narrative + visualizations but not the intermediate datasets Orca built during analysis. Matches the ["Artifacts" tab in the thread UI](https://tako.com) isn't exposed; if agents need that access later we'd need either (a) a separate `get_thread_artifacts` tool or (b) a backend change.

### 2. Reports bundle (3 tools) — first-class report creation from MCP

Reports are a major Tako product feature invisible to MCP today. A report is a multi-section analytical document (like a Google Doc / PDF) that Tako generates autonomously from a brief, with chart embeds, narrative, citations, and PDF/PPTX export. Creation is async (30s–5min).

**Proposed tools:**

- `list_reports({limit?, status?}) → [{report_id, title, report_type, status, created_at, credit_cost}]` — wraps `GET /api/v1/internal/reports/`. Required for Claude to find report IDs from prior sessions.
- `create_report({report_type, title, research_objective, config?}) → {report_id, status: "pending", credit_cost, estimated_runtime_seconds}` — wraps `POST /api/v1/internal/reports/`. Kicks off async generation.
- `get_report(report_id) → {status, title, sections?, export_urls?, ...}` — wraps `GET /api/v1/internal/reports/{id}/`. Unified status + content; Claude polls this until `status === "completed"`.

**Known backend gap.** No endpoint exposes the list of valid `report_type` values (only a Python registry: `get_all_report_types()` in `backend/reports/types/registry.py`). A `list_report_types` MCP tool would require a small backend addition (e.g. `GET /api/v1/internal/reports/types/`). For interim use, Claude can learn valid types by trial — the create endpoint returns them in its validation error.

**Why it's deferred.** Reports introduce the **first async/polling tool pattern** into the TypeScript MCP server. Every tool in the Phase 2 port is synchronous request/response. The async pattern deserves its own design pass — timeout behavior, polling cadence hints, how the tool registry (TAKO-2600) represents long-running tools, credit-confirmation UX. Retrofitting it alongside Phase 2 risks rushing those decisions.

### Not proposed (considered and declined)

- **Thread primitives as separate tools (`start_thread`, `continue_thread`).** `ask_tako` covers this use case with a simpler shape. Claude maintains conversational state natively; exposing `thread_id` would create two parallel conversations.
- **Insights V3 `/analyze` pipeline.** Powerful (field-plan → hypothesize → analyze) but a multi-step async pipeline. Worth revisiting in a dedicated design ticket, not now.
- **Report scheduling, sharing via email, versioning, block edits.** Human UI workflows, not agent primitives.
- **Raw CSV data access for knowledge-base charts (`get_chart_data` / `/api/v1/csv/{pub_id}/`).** Blocked on backend: the CSV endpoint today only serves user-uploaded dataset cards, not the knowledge-base cards `knowledge_search` returns (see `app/backend/knowledge/api/views.py:1272`). Requires a backend change to unblock.

---

## Acceptance criteria mapping

Per TAKO-2599:

- [x] Audit doc authored at `docs/tool-surface-audit-2026-04.md`.
- [ ] Merged to `main` (awaiting review).
- [ ] Phase 2 tickets in the Tako MCP project updated accordingly:
  - **No changes.** All existing port tickets (TAKO-2602 through TAKO-2609) proceed as scheduled, including TAKO-2604 for `explore_knowledge_graph`.
  - No new Phase 2 tickets created — new-tool candidates are deferred, not scheduled.

## Open questions for Bobby

1. **Are you aligned on deferring all new-tool adds until Phase 2 completes?** Or do you want any of the four candidates (`ask_tako`, `list_reports`, `create_report`, `get_report`) to be scheduled as Phase 2 work now?
2. **Post-Phase-2 telemetry — add per-tool counters in the TypeScript MCP?** This is cheap to add during the port (a single `logger.info(tool_name, ...)` with structured fields, or Cloudflare Workers Analytics custom events) and makes the 30-day re-audit possible. Worth doing as part of Phase 2 hygiene, not as its own ticket.
