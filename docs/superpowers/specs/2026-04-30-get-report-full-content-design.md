# `get_report` / `wait_for_report` — full report content with interactive charts

**Date:** 2026-04-30
**Owner:** Juan
**Status:** Approved (brainstorm complete)

## Problem

Today `get_report` and `wait_for_report` return Django's report detail JSON (sections in `result`, export URLs in `export_urls`, `webpage_url`). Callers see what looks like a "summary" because:

- The structured `result` field is opaque (`unknown`) and the LLM tends to paraphrase it.
- The full rendered report (the same content the user sees at `webpage_url`) is only available via `markdown_url`, which neither tool fetches.
- Charts referenced in the report aren't rendered in chat at all — even though the `open_chart_ui` widget infrastructure already exists.

Goal: when the report is complete, deliver the full markdown body and the report's charts as interactive widgets (on hosts that support them) directly from `get_report` / `wait_for_report`, so the LLM can show the user the actual report instead of summarizing it.

## Non-goals

- No new Django endpoints. Everything must work against existing `/api/v1/internal/reports/{id}/` + the export URLs it returns.
- No port of the Tako web app's report viewer chrome (sidebar TOC, citation chips, header, version dropdown). Body + charts only.
- No effect on non-completed states. `pending` / `running` / `failed` / `cancelled` responses keep their current shape.
- No backwards-incompatible changes — the new fields are additive, the new input flag defaults to the user-friendly behavior.

## High-level decision

`include_full_content: boolean` (default `true`) on both tools. When `true` AND `status === "completed"`:

1. Fetch `markdown_url` to get the full report body.
2. Regex-extract up to 6 chart `pub_id`s from the markdown body, in document order, deduped.
3. Render chart content based on the calling host:
   - **ChatGPT** → one MCP Apps widget (`ui://tako/embed/report/{report_id}`) embedding markdown + N chart iframes inline.
   - **claude.ai** → no widget; emit N inline `image` content blocks (one base64'd PNG per chart) + the markdown body as a text content block.

Otherwise (status non-terminal, or `include_full_content: false`) — same response as today, no extra HTTP, no token cost.

## Design

### Tool input schema (both tools)

```ts
include_full_content: z
  .boolean()
  .default(true)
  .describe(
    "When true (default) and status is 'completed', the response inlines the full report markdown body and renders chart widgets. Pass `false` for a status-only check (skips the markdown fetch and chart rendering — cheaper, smaller response).",
  ),
```

### Shared output shape (`_report_shape.ts`)

Three new fields on `reportOutputShape`:

```ts
markdown_body: z.string().nullable(),    // full report markdown when fetched, else null
chart_pub_ids: z.array(z.string()),      // up to 6, document order, deduped
charts_truncated: z.boolean(),           // true if report had >6 charts
```

Population rules:

| Branch | `markdown_body` | `chart_pub_ids` | `charts_truncated` |
|---|---|---|---|
| `status !== "completed"` | `null` | `[]` | `false` |
| `include_full_content: false` | `null` | `[]` | `false` |
| `markdown_url` missing or fetch fails | `null` | `[]` | `false` |
| Markdown body > 12 KB | truncated with `…[report continues]` marker | (extracted before truncation) | (computed before truncation) |
| Happy path | full body | up to 6 ids | `true` iff body referenced more |

### Tool description additions

Both tools' descriptions gain:

> When `status === 'completed'` and `include_full_content` is true, the response carries the full markdown body and up to 6 interactive chart widgets (charts beyond the cap are linked in the markdown). Surface the markdown_body to the user verbatim — do NOT summarize it.

### Data flow per `tools/call`

1. **Detail fetch** (unchanged): `GET /api/v1/internal/reports/{id}/`.
2. **Short-circuit:** if non-terminal status OR `include_full_content === false` → return current shape.
3. **Markdown fetch:** `fetch(markdown_url)` with 8 s timeout. On any failure → log, set `markdown_body = null`, continue (graceful degrade).
4. **Pub_id extraction:** regex over the markdown body matching the configured `PUBLIC_BASE_URL` host: `/(?:embed|c)/([A-Za-z0-9_-]+)`. Dedupe in document order, take first 6, set `charts_truncated` if more existed.
5. **Host detection:** reuse the UA / `clientId` switch from commit `4248c35` (the one already gating `open_chart_ui`).
6. **Branch on host:**
   - **ChatGPT** → emit one widget via `appUiResource`. Widget HTML embeds markdown + N chart iframes. Markdown body and pub_id list ride in `_meta` (off the LLM's context — same trick `open_chart_ui` uses for its image data URI).
   - **claude.ai** → no widget. `extraContentBlocks` returns N inline `image` blocks (one base64'd PNG per chart, fetched via the same path `open_chart_ui.extraContentBlocks` uses). Markdown body goes into a text content block.

### Widget bundle (`_report_widget.ts`, new)

Pulled out of `get_report.ts` because both `get_report` and `wait_for_report` share it. Mirrors how `open_chart_ui.ts` carries its widget HTML inline today.

**Resource registration:** dynamic only (no static URI). Each `tools/call` resolves to `ui://tako/embed/report/{report_id}` and the resource read renders the widget HTML with the report's data baked in. No postMessage handshake required — same shape as the dynamic chart variant in `open_chart_ui`.

**HTML structure:**

```html
<!doctype html>
<html style="height: ${initialHeight}px">
<head>
  <meta name="x-tako-widget" content="get_report/v1">
  <style>
    body { font: 15px/1.6 system-ui; color: #e6e6e6; background: #0f1115; padding: 20px; }
    h1, h2, h3 { color: #fff; margin-top: 1.5em; }
    .tako-chart-embed { width: 100%; aspect-ratio: 1.91/1; border: 0; margin: 12px 0; }
    .tako-link-fallback { color: #4aa9ff; }
  </style>
</head>
<body>
  ${renderedMarkdownHtmlWithChartIframesInlineReplaced}
  <script>
    if (window.openai?.notifyIntrinsicHeight) {
      window.openai.notifyIntrinsicHeight(document.body.scrollHeight);
    }
  </script>
</body>
</html>
```

**Markdown → HTML:** `marked` library. Output sanitized with a tight allowlist (no `<script>`, no `on*` attrs, no inline `style`). The library cost is ~30 KB to the Worker bundle — accepted to avoid hand-rolling a markdown subset that would render arbitrary report content wrong.

**Chart placement:** inline-replace. Scan the rendered HTML for `<a href="https://${publicBase}/(embed|c)/{pub_id}/...">` matches. For each of the first 6 pub_ids, replace its anchor with an `<iframe src="${embedUrl}" class="tako-chart-embed">`. Charts beyond the cap stay as their original `<a>` link. Order respects document order automatically.

**`frameDomains`:** `[resolvePublicBase(env)]` — the inner chart iframes' origin. Same value `open_chart_ui` uses.

### File layout

| File | Change |
|---|---|
| `workers/src/tools/_report_shape.ts` | Add three new fields to `reportOutputShape`, factor out the markdown-fetch + pub_id-extraction + branch helpers used by both tools. |
| `workers/src/tools/get_report.ts` | Add `include_full_content` to input schema. Wire `appUiResource` (ChatGPT) and `extraContentBlocks` (claude.ai). Update tool description. |
| `workers/src/tools/wait_for_report.ts` | Same as `get_report` — keep the two tools in lockstep. |
| `workers/src/tools/_report_widget.ts` (new) | `buildReportWidgetHtml({ markdownBody, chartPubIds, embedUrlBase, … })` plus URI pattern constant. |
| `workers/src/mcp.ts` | Extend the existing per-tool host-conditional path so `get_report` / `wait_for_report` follow the same widget-vs-image switch as `open_chart_ui`. |
| `package.json` | Add `marked` dependency. |

### Subrequest budget

1 detail fetch + 1 markdown fetch + up to 6 chart PNG fetches (claude.ai branch only) = 8 worst case. Cloudflare Workers caps at 50 (free) / 1000 (paid). Fine.

### Token budget

Markdown body in the LLM context is capped at 12 KB (truncate with `…[report continues]` marker). Chart base64 stays in `_meta`, not in `structuredContent`, so it doesn't count against the LLM's context window. Mirrors the existing `open_chart_ui` pattern that routes its ~250 KB image data URI through `_meta` to dodge claude.ai's "Tool result too large" guard.

### Error / partial-success behavior

| Failure | Tool result | Caller experience |
|---|---|---|
| `markdown_url` missing or 404 | `markdown_body: null`, `chart_pub_ids: []`, success | Status-only response (current behavior). LLM falls back to `webpage_url`. |
| Markdown body > 12 KB | Truncated with marker | Charts and pub_ids extracted from full body; LLM tells user the body was truncated and offers `webpage_url`. |
| `marked` throws | Widget HTML render falls back to plaintext markdown body (no iframes) | Charts not interactive; tool call still succeeds. |
| Chart PNG fetch fails (claude.ai) | That image block dropped; others continue | User sees fewer inline images; tool call succeeds. |
| ChatGPT widget resource read errors | Resource read returns a fallback HTML with markdown body + click-through link | User sees a non-interactive but readable report; tool call succeeds. |
| Pub_id regex finds 0 matches | `chart_pub_ids: []`, no widget rendered | Markdown-only response. |

The driver: never fail the tool call over a presentation hiccup. The LLM can always fall back to `webpage_url` since every response carries one.

## Testing strategy

### `_report_shape.test.ts` (new)

- Markdown extraction: dedupes pub_ids, respects document order, caps at 6, sets `charts_truncated` correctly above the cap.
- Pub_id regex: matches `/embed/{id}` and `/c/{id}`; ignores embed URLs from a different host (only the configured `PUBLIC_BASE_URL`).
- Markdown body truncation at 12 KB inserts the marker and stays under the cap.
- HTML render: `marked` output with chart-link → iframe replacement; sanitizer strips `<script>`, `on*` attrs, inline `style`.

### `get_report.test.ts` additions

- `include_full_content: false` → no markdown / chart fetches happen (mock fetch sequence asserts only the detail call).
- `status === "running"` with `include_full_content: true` → still no extra fetches; `markdown_body: null`, `chart_pub_ids: []`.
- `status === "completed"` happy path, claude.ai UA → markdown body in text content, N base64 image blocks in content, no widget meta.
- `status === "completed"` happy path, ChatGPT UA → `_meta.ui.resourceUri` points at the dynamic report URI; widget HTML renders with markdown + N iframes via `resources/read`.
- markdown_url fetch fails → tool call succeeds, `markdown_body: null`, `chart_pub_ids: []`, no charts rendered.

### `wait_for_report.test.ts` additions

- One test mirroring the `get_report` happy path on the terminal-completed branch — confirms shared shape stays in lockstep. Existing polling tests untouched.

### `_report_widget.test.ts` (new)

- `buildReportWidgetHtml` with sample inputs → snapshot the shape, assert no `<script>` from sanitization, assert iframe `src` lands on the configured embed origin.
- Fallback render when `markdownBody` is null but `chartPubIds` is non-empty (rare-but-defensive).

## Open questions resolved during brainstorm

| Question | Decision |
|---|---|
| Architecture for "interactive charts in chat" | A1 — single widget rendering markdown + N chart iframes inline (no Tako web viewer chrome). Pixel-fidelity to the web report viewer (sidebar/citations) is out of scope. |
| Tools affected | Both `get_report` and `wait_for_report` (keep them in lockstep on the shared `_report_shape`). |
| API surface | Single flag `include_full_content` (default `true`). Not two separate flags for markdown vs charts. |
| Chart pub_id extraction source | Regex over the markdown body (no Django shape dependency). |
| Chart cap | 6, hard cap. Predictable cost; rest stay as markdown links. |
| Host split | ChatGPT → widget; claude.ai → inline images + markdown text. Matches existing `open_chart_ui` UA gate (commit `4248c35`). |
| Markdown rendering | `marked` library (~30 KB) — robust handling of arbitrary report content beats hand-rolling a subset. |
| Chart placement in widget | Inline-replace at the link site (preserves narrative flow), not bottom-stack. |

## Risk callouts

- **MCP Apps spec is one widget per tool call.** "One widget per chart" isn't achievable; the design uses one report-level widget that contains N chart iframes. Confirmed with user.
- **claude.ai gets the lesser experience** — no in-chat interactivity, just static images + click-through links. Same constraint that already shapes `open_chart_ui`.
- **`marked` adds a dependency.** ~30 KB to the Worker bundle, well within Cloudflare's 1 MB script-size cap; sanitization layer is required to avoid XSS via report content.
- **Token budget for 12 KB markdown.** Some long reports may truncate. The `…[report continues]` marker plus the always-present `webpage_url` keep the user reachable to the full content.
