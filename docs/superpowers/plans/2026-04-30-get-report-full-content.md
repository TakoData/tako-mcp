# `get_report` / `wait_for_report` — full content + interactive charts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Tako report reaches `status === "completed"`, `get_report` and `wait_for_report` deliver the full markdown body and up to 6 interactive chart widgets (ChatGPT) or inline static images + markdown (claude.ai) directly in the tool result.

**Architecture:** Add `include_full_content: boolean` (default `true`) to both tools. On terminal-completed, fetch `markdown_url`, regex-extract chart `pub_id`s from the body, then either register a dynamic MCP Apps widget (`ui://tako/embed/report/{report_id}`) for ChatGPT or emit inline base64 PNG content blocks for claude.ai — same UA-gated split that `open_chart_ui` already uses. Shared helpers live in `_report_shape.ts` and a new `_report_widget.ts` so both tools stay in lockstep.

**Tech Stack:** TypeScript, Cloudflare Workers, Zod, `@modelcontextprotocol/sdk`, vitest, `marked` (new dep).

**Spec:** `docs/superpowers/specs/2026-04-30-get-report-full-content-design.md`

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `workers/package.json` | Add `marked` dep | modify |
| `workers/src/tools/_report_shape.ts` | New fields on output shape; helpers `extractChartPubIds`, `fetchMarkdownBody`, `enrichReportOutputWithFullContent` | modify |
| `workers/src/tools/_report_widget.ts` | New: `buildReportWidgetHtml`, `REPORT_WIDGET_URI_PATTERN`, sanitizer | create |
| `workers/src/tools/get_report.ts` | Add `include_full_content` flag, wire `appUiResource` (dynamic) + `extraContentBlocks` | modify |
| `workers/src/tools/wait_for_report.ts` | Same as `get_report` for the terminal-completed branch | modify |
| `workers/src/tools/_report_shape.test.ts` | New: tests for extraction, fetch, enrichment | create |
| `workers/src/tools/_report_widget.test.ts` | New: tests for HTML build + sanitization | create |
| `workers/src/tools/get_report.test.ts` | New: full handler tests including widget + claude.ai paths | create |
| `workers/src/tools/wait_for_report.test.ts` | Add test for terminal-completed full-content branch | modify |
| `workers/registry/server.json` | Regenerated to reflect new input field | regen |

`mcp.ts` requires **no changes** — the existing widget-suppressed-on-claude logic + `extraContentBlocks` fallback path already handles the conditional split per `4248c35`.

---

## Task 1: Add `marked` dependency

**Files:**
- Modify: `workers/package.json`

- [ ] **Step 1: Add `marked` to dependencies**

Edit `workers/package.json`:

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0",
  "marked": "^14.1.4",
  "zod": "^4.3.6"
}
```

- [ ] **Step 2: Install**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm install
```

Expected: `marked` and its types added to `node_modules/`. No errors.

- [ ] **Step 3: Verify it imports in the Workers runtime context**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx tsx -e "import('marked').then(m => console.log(typeof m.marked))"
```

Expected output: `function`

- [ ] **Step 4: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/package.json workers/package-lock.json
git commit -m "$(cat <<'EOF'
chore(workers): add marked for report markdown rendering

Used by `_report_widget.ts` to render the report's markdown body inside
the get_report widget HTML. Sanitization layer is added on top in the
widget code, not via marked's options.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add new fields to `reportOutputShape` (no-fetch path)

**Files:**
- Modify: `workers/src/tools/_report_shape.ts`
- Test: `workers/src/tools/_report_shape.test.ts` (new)

- [ ] **Step 1: Write the failing test for default (non-completed) shape**

Create `workers/src/tools/_report_shape.test.ts`:

```ts
/**
 * Tests for shared report shape helpers used by `get_report` and
 * `wait_for_report`. Covers the new full-content branch
 * (markdown_body, chart_pub_ids, charts_truncated) and the
 * regex-based pub_id extraction.
 */
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  type ReportDetailResponse,
  shapeReportOutput,
} from "./_report_shape.js";

const ENV: Env = { DJANGO_BASE_URL: "https://trytako.com" };

describe("shapeReportOutput — full-content fields default to empty", () => {
  it("populates markdown_body=null, chart_pub_ids=[], charts_truncated=false on a non-completed report", () => {
    const data: ReportDetailResponse = {
      id: "rep_running",
      status: "running",
    };
    const out = shapeReportOutput(data, "rep_running", ENV);

    expect(out.markdown_body).toBeNull();
    expect(out.chart_pub_ids).toEqual([]);
    expect(out.charts_truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: FAIL — `markdown_body`, `chart_pub_ids`, `charts_truncated` don't exist on the output yet.

- [ ] **Step 3: Add the three new fields to `reportOutputShape` and `shapeReportOutput`**

Edit `workers/src/tools/_report_shape.ts`:

In `reportOutputShape` add (after `error_message`):

```ts
  // Populated only when status === "completed" AND the caller passed
  // include_full_content: true (the default). The markdown body is
  // truncated at 12 KB; charts beyond the cap of 6 stay as markdown
  // links in the body and aren't listed in chart_pub_ids.
  markdown_body: z.string().nullable(),
  chart_pub_ids: z.array(z.string()),
  charts_truncated: z.boolean(),
```

In `shapeReportOutput` return object, add (after `error_message: data.error_message ?? null,`):

```ts
    markdown_body: null,
    chart_pub_ids: [],
    charts_truncated: false,
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck (older tests use `out.export_urls` etc. — make sure additions don't break anything)**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_shape.ts workers/src/tools/_report_shape.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): add markdown_body/chart_pub_ids/charts_truncated to report shape

Three new fields on reportOutputShape, populated by the upcoming
full-content branch. Default values (null/[]/false) keep existing
get_report and wait_for_report responses unchanged on non-completed
reports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Implement `extractChartPubIds` helper

**Files:**
- Modify: `workers/src/tools/_report_shape.ts`
- Test: `workers/src/tools/_report_shape.test.ts`

- [ ] **Step 1: Add tests for chart pub_id extraction**

Append to `workers/src/tools/_report_shape.test.ts`:

```ts
import { extractChartPubIds, REPORT_CHART_CAP } from "./_report_shape.js";

describe("extractChartPubIds", () => {
  const PUBLIC_BASE = "https://tako.com";

  it("extracts a single pub_id from an /embed/{id} link", () => {
    const md = "See [this chart](https://tako.com/embed/abc123/?theme=dark) for details.";
    expect(extractChartPubIds(md, PUBLIC_BASE)).toEqual({
      pubIds: ["abc123"],
      truncated: false,
    });
  });

  it("extracts pub_ids from /c/{id} short links too", () => {
    const md = "Two charts: https://tako.com/c/aaa and https://tako.com/c/bbb";
    expect(extractChartPubIds(md, PUBLIC_BASE)).toEqual({
      pubIds: ["aaa", "bbb"],
      truncated: false,
    });
  });

  it("dedupes repeated pub_ids in document order", () => {
    const md = `
First mention https://tako.com/embed/dup/?x=1.
Some text.
Second mention https://tako.com/embed/dup/?x=2.
A third pub_id https://tako.com/embed/other/.
`;
    expect(extractChartPubIds(md, PUBLIC_BASE).pubIds).toEqual(["dup", "other"]);
  });

  it("ignores embed links from a different host", () => {
    const md = "Off-host: https://example.com/embed/nope and https://tako.com/embed/yes";
    expect(extractChartPubIds(md, PUBLIC_BASE).pubIds).toEqual(["yes"]);
  });

  it("caps at REPORT_CHART_CAP and sets truncated=true", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const md = ids.map((id) => `https://tako.com/embed/${id}`).join("\n");
    const out = extractChartPubIds(md, PUBLIC_BASE);
    expect(out.pubIds).toHaveLength(REPORT_CHART_CAP);
    expect(out.pubIds).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(out.truncated).toBe(true);
  });

  it("returns empty when no chart URLs are found", () => {
    const md = "# Just text\n\nNo charts here.";
    expect(extractChartPubIds(md, PUBLIC_BASE)).toEqual({
      pubIds: [],
      truncated: false,
    });
  });

  it("strips a trailing slash from publicBase before matching", () => {
    const md = "https://tako.com/embed/x";
    expect(extractChartPubIds(md, "https://tako.com/").pubIds).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: FAIL with "extractChartPubIds is not a function" or import error.

- [ ] **Step 3: Implement `extractChartPubIds` and `REPORT_CHART_CAP`**

Append to `workers/src/tools/_report_shape.ts` (above `shapeReportOutput`):

```ts
/**
 * Hard cap on the number of chart widgets / inline images the report
 * tools emit per `tools/call`. Above this cap, charts in the markdown
 * body stay as the original markdown links (clickable to open in a
 * new tab) but get no inline widget / image rendering. The cap exists
 * to bound the response size on claude.ai (each chart ships ~50–250 KB
 * base64'd) and the widget HTML on ChatGPT (each chart adds an iframe
 * which the host has to layout). Six picked empirically: typical Tako
 * reports cite 3–5 charts, so 6 covers the common case with one
 * margin to spare.
 */
export const REPORT_CHART_CAP = 6;

/**
 * Escape a string for safe inclusion in a regex character class /
 * pattern. JavaScript regexes treat `.`, `+`, `?`, etc. as
 * meta-characters; URLs and hostnames legitimately contain them, so
 * unescaped interpolation would over-match.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull chart `pub_id`s out of a Tako report's markdown body, in
 * document order, deduped, capped at {@link REPORT_CHART_CAP}.
 *
 * Matches Tako embed-page URLs that point at the configured public
 * base origin: `${publicBase}/embed/{pub_id}` and
 * `${publicBase}/c/{pub_id}`. Off-host links (e.g. external image
 * services) are ignored — only Tako-hosted charts can be re-rendered
 * as widgets.
 *
 * Returns `{ pubIds, truncated }` where `truncated` is `true` iff the
 * unique pub_id count exceeded the cap. Callers wire that into the
 * `charts_truncated` output field.
 */
export function extractChartPubIds(
  markdownBody: string,
  publicBase: string,
): { pubIds: string[]; truncated: boolean } {
  // Strip trailing slash so the regex doesn't double-match `//`.
  const base = publicBase.replace(/\/+$/, "");
  // `[A-Za-z0-9_-]+` matches Tako pub_id slugs (URL-safe, alphanumeric
  // plus underscore / dash). The `(?:embed|c)` alternation covers
  // both the long-form embed link and the short `/c/` permalink that
  // the report markdown export uses interchangeably.
  const pattern = new RegExp(
    `${escapeRegex(base)}/(?:embed|c)/([A-Za-z0-9_-]+)`,
    "g",
  );
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of markdownBody.matchAll(pattern)) {
    const id = match[1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const truncated = ordered.length > REPORT_CHART_CAP;
  return {
    pubIds: ordered.slice(0, REPORT_CHART_CAP),
    truncated,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_shape.ts workers/src/tools/_report_shape.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): extractChartPubIds helper for report markdown bodies

Regex-based extraction of Tako chart pub_ids from a report's markdown
body — matches `${publicBase}/embed/{id}` and `${publicBase}/c/{id}`,
dedupes in document order, caps at REPORT_CHART_CAP=6. Off-host links
are ignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement `fetchMarkdownBody` helper (with timeout + truncation)

**Files:**
- Modify: `workers/src/tools/_report_shape.ts`
- Test: `workers/src/tools/_report_shape.test.ts`

- [ ] **Step 1: Add tests for the markdown body fetcher**

Append to `workers/src/tools/_report_shape.test.ts`:

```ts
import { fetchMarkdownBody, MARKDOWN_BODY_BYTE_CAP } from "./_report_shape.js";
import { mockFetchOnce } from "./__test_helpers.js";
import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchMarkdownBody", () => {
  it("returns the body unchanged when it fits under the cap", async () => {
    const body = "# Hello\n\nA short report.";
    mockFetchOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );
    const out = await fetchMarkdownBody("https://exports.tako.com/r/x.md");
    expect(out).toBe(body);
  });

  it("truncates at MARKDOWN_BODY_BYTE_CAP and appends a continues marker", async () => {
    // Build a body over the cap. ASCII so 1 char === 1 byte.
    const hugeBody = "x".repeat(MARKDOWN_BODY_BYTE_CAP + 5_000);
    mockFetchOnce(
      new Response(hugeBody, {
        status: 200,
        headers: { "content-type": "text/markdown" },
      }),
    );
    const out = await fetchMarkdownBody("https://exports.tako.com/r/x.md");
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(MARKDOWN_BODY_BYTE_CAP + 64);
    expect(out).toMatch(/…\[report continues\]$/);
  });

  it("returns null when the response is non-2xx", async () => {
    mockFetchOnce(new Response("nope", { status: 404 }));
    expect(await fetchMarkdownBody("https://exports.tako.com/r/missing.md")).toBeNull();
  });

  it("returns null when content-type is not text-ish", async () => {
    // PDF redirect, HTML error page, etc. — we'd otherwise inline binary
    // garbage as the markdown body.
    mockFetchOnce(
      new Response("%PDF-1.4...", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    expect(await fetchMarkdownBody("https://exports.tako.com/r/x.pdf")).toBeNull();
  });

  it("returns null on a fetch throw (timeout etc.)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("aborted"))),
    );
    expect(await fetchMarkdownBody("https://exports.tako.com/r/x.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: FAIL — `fetchMarkdownBody` is not exported.

- [ ] **Step 3: Implement `fetchMarkdownBody` and `MARKDOWN_BODY_BYTE_CAP`**

Append to `workers/src/tools/_report_shape.ts` (above `extractChartPubIds`):

```ts
/**
 * Hard cap (in UTF-8 bytes) on the markdown body that goes into the
 * LLM's context window via `structuredContent.markdown_body`. Reports
 * can run tens of KB; without a cap a single get_report call could
 * burn 30%+ of a small client's context budget. 12 KB is enough for
 * a typical Tako agent_report (executive summary + 3-5 sections +
 * citations) without truncation, while still leaving headroom on
 * claude.ai's per-tool-result limit. Truncated bodies append the
 * marker {@link MARKDOWN_TRUNCATION_MARKER} so the LLM tells the
 * user the body was cut and offers `webpage_url` for the rest.
 */
export const MARKDOWN_BODY_BYTE_CAP = 12 * 1024;

/** Suffix appended when truncating; the LLM is told to surface this. */
export const MARKDOWN_TRUNCATION_MARKER = "\n\n…[report continues]";

/** Outer timeout on the markdown fetch — same value `open_chart_ui` uses for its PNG fetches. */
const MARKDOWN_FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch the rendered markdown body of a completed report. Returns
 * `null` on any non-OK / wrong-content-type / timeout — the caller
 * treats that as "no body available" and continues with the rest of
 * the response (graceful degrade — the user still gets the structured
 * data + `webpage_url`, just not the inlined body).
 *
 * Truncates over-cap bodies on a UTF-8 byte boundary (we can't just
 * `.substring()` blindly — that could split a multi-byte sequence;
 * but in practice report markdown is overwhelmingly ASCII, so we
 * truncate at the byte cap and round back to a safe code-point
 * boundary).
 */
export async function fetchMarkdownBody(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKDOWN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    // Accept text/* (markdown, plain). Reject HTML — an upstream
    // error page would otherwise inline an HTML 404 as the report
    // body. Reject binary types (pdf/pptx) too, even though
    // markdown_url should never point at them.
    const lower = contentType.toLowerCase();
    if (
      !lower.startsWith("text/markdown") &&
      !lower.startsWith("text/plain") &&
      !lower.startsWith("text/x-markdown")
    ) {
      return null;
    }
    const text = await response.text();
    if (text.length === 0) return null;
    // Encode-then-truncate to enforce the byte cap. UTF-8 bytes ===
    // code units only when the input is ASCII; non-ASCII chars
    // (emoji, accented letters) take 2-4 bytes each. Encoding to
    // bytes lets us truncate accurately even on non-ASCII input.
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength <= MARKDOWN_BODY_BYTE_CAP) return text;
    // Walk back to the last full UTF-8 code point boundary at or
    // before the cap so we don't ship invalid UTF-8 to the LLM.
    let cut = MARKDOWN_BODY_BYTE_CAP;
    while (cut > 0 && (encoded[cut] !== undefined && (encoded[cut]! & 0xc0) === 0x80)) {
      cut -= 1;
    }
    const truncated = new TextDecoder("utf-8").decode(encoded.slice(0, cut));
    return `${truncated}${MARKDOWN_TRUNCATION_MARKER}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_shape.ts workers/src/tools/_report_shape.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): fetchMarkdownBody helper with 12KB cap + UTF-8 boundary truncation

Pulls a report's rendered markdown body from markdown_url with an 8s
timeout. Caps at 12 KB UTF-8 bytes (truncating at a code-point
boundary so we don't ship invalid UTF-8) and appends a
[report continues] marker the LLM surfaces to the user. Returns null
on any failure path so the report tools degrade gracefully.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement `enrichReportOutputWithFullContent`

**Files:**
- Modify: `workers/src/tools/_report_shape.ts`
- Test: `workers/src/tools/_report_shape.test.ts`

- [ ] **Step 1: Add tests for the orchestrator**

Append to `workers/src/tools/_report_shape.test.ts`:

```ts
import {
  enrichReportOutputWithFullContent,
  type ReportOutput,
} from "./_report_shape.js";
import { jsonResponse, mockFetchOnce, mockFetchSequence } from "./__test_helpers.js";

describe("enrichReportOutputWithFullContent", () => {
  const baseEnv: Env = {
    DJANGO_BASE_URL: "https://trytako.com",
    PUBLIC_BASE_URL: "https://tako.com",
  };

  function baseOutput(overrides: Partial<ReportOutput> = {}): ReportOutput {
    return {
      report_id: "rep_x",
      status: null,
      title: null,
      report_type: null,
      research_objective: null,
      credit_cost: null,
      runtime_seconds: null,
      estimated_runtime_seconds: null,
      webpage_url: "https://tako.com/reports/rep_x?from=library",
      result: null,
      export_urls: null,
      thread_id: null,
      error_message: null,
      markdown_body: null,
      chart_pub_ids: [],
      charts_truncated: false,
      ...overrides,
    };
  }

  it("returns the input unchanged when status is not completed", async () => {
    const input = baseOutput({ status: "running" });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, true);
    expect(out).toEqual(input);
  });

  it("returns the input unchanged when includeFullContent is false", async () => {
    const input = baseOutput({
      status: "completed",
      export_urls: { markdown_url: "https://exports.tako.com/r/x.md" },
    });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, false);
    expect(out).toEqual(input);
  });

  it("returns the input unchanged when there is no markdown_url", async () => {
    const input = baseOutput({
      status: "completed",
      export_urls: { pdf_url: "https://exports.tako.com/r/x.pdf" },
    });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, true);
    expect(out).toEqual(input);
  });

  it("populates markdown_body and chart_pub_ids on the happy path", async () => {
    mockFetchOnce(
      new Response(
        "# Tesla report\n\nSee https://tako.com/embed/aaa and https://tako.com/embed/bbb.",
        { status: 200, headers: { "content-type": "text/markdown" } },
      ),
    );
    const input = baseOutput({
      status: "completed",
      export_urls: { markdown_url: "https://exports.tako.com/r/x.md" },
    });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, true);
    expect(out.markdown_body).toMatch(/^# Tesla report/);
    expect(out.chart_pub_ids).toEqual(["aaa", "bbb"]);
    expect(out.charts_truncated).toBe(false);
  });

  it("falls back to original output when markdown fetch fails", async () => {
    mockFetchOnce(new Response("nope", { status: 500 }));
    const input = baseOutput({
      status: "completed",
      export_urls: { markdown_url: "https://exports.tako.com/r/x.md" },
    });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, true);
    expect(out.markdown_body).toBeNull();
    expect(out.chart_pub_ids).toEqual([]);
    expect(out.charts_truncated).toBe(false);
  });

  it("treats COMPLETED (uppercase) as completed too", async () => {
    mockFetchOnce(
      new Response("# Hi", { status: 200, headers: { "content-type": "text/markdown" } }),
    );
    const input = baseOutput({
      status: "COMPLETED",
      export_urls: { markdown_url: "https://exports.tako.com/r/x.md" },
    });
    const out = await enrichReportOutputWithFullContent(input, baseEnv, true);
    expect(out.markdown_body).toBe("# Hi");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: FAIL — `enrichReportOutputWithFullContent` and `ReportOutput` not exported.

- [ ] **Step 3: Implement `enrichReportOutputWithFullContent` and export `ReportOutput`**

Edit `workers/src/tools/_report_shape.ts`:

Above `shapeReportOutput`, add:

```ts
/** Convenience export: the resolved output type from `reportOutputSchema`. */
export type ReportOutput = z.infer<typeof reportOutputSchema>;
```

At the bottom of the file, add:

```ts
/**
 * Apply the "full content" enrichment to a shaped report output.
 *
 * When `status === "completed"` (case-insensitive) AND the caller
 * passed `includeFullContent: true` AND the response carries a
 * `markdown_url`, fetch the markdown body and extract chart pub_ids
 * from it. Otherwise returns the input unchanged.
 *
 * Centralized here so `get_report` and `wait_for_report` can't drift
 * on which conditions trigger the enrichment. The handler tools call
 * this exactly once after `shapeReportOutput`.
 */
export async function enrichReportOutputWithFullContent(
  output: ReportOutput,
  env: Env,
  includeFullContent: boolean,
): Promise<ReportOutput> {
  if (!includeFullContent) return output;
  const status = (output.status ?? "").toLowerCase();
  if (status !== "completed") return output;
  const markdownUrl = output.export_urls?.markdown_url;
  if (typeof markdownUrl !== "string" || markdownUrl.length === 0) {
    return output;
  }
  const body = await fetchMarkdownBody(markdownUrl);
  if (body === null) return output;
  const publicBase = resolvePublicBase(env);
  const { pubIds, truncated } = extractChartPubIds(body, publicBase);
  return {
    ...output,
    markdown_body: body,
    chart_pub_ids: pubIds,
    charts_truncated: truncated,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_shape.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full test suite to make sure nothing else broke**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_shape.ts workers/src/tools/_report_shape.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): enrichReportOutputWithFullContent orchestrator

Glue layer that decides when to fetch markdown_url + extract chart
pub_ids vs. return the shaped output unchanged. Conditions: status
must be completed (case-insensitive), include_full_content must be
true, and export_urls.markdown_url must be present. Failures degrade
to the unchanged output — the report tools never fail over a
presentation hiccup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build the report widget HTML helper

**Files:**
- Create: `workers/src/tools/_report_widget.ts`
- Create: `workers/src/tools/_report_widget.test.ts`

- [ ] **Step 1: Write failing tests for `buildReportWidgetHtml` and the URI pattern**

Create `workers/src/tools/_report_widget.test.ts`:

```ts
/**
 * Tests for the report widget HTML builder. The widget renders a Tako
 * report's markdown body inline with `<iframe>` embeds for each chart
 * pub_id. Sanitizer strips dangerous HTML; chart links inside the
 * markdown are rewritten to iframes for the first N pub_ids.
 */
import { describe, expect, it } from "vitest";

import {
  REPORT_WIDGET_NAME,
  REPORT_WIDGET_URI_PATTERN,
  buildReportWidgetHtml,
} from "./_report_widget.js";

describe("REPORT_WIDGET_URI_PATTERN", () => {
  it("uses the same `ui://tako/embed/...` namespace as open_chart_ui", () => {
    expect(REPORT_WIDGET_URI_PATTERN).toBe("ui://tako/embed/report/{report_id}");
    expect(REPORT_WIDGET_NAME).toBe("get_report_widget");
  });
});

describe("buildReportWidgetHtml", () => {
  const PUBLIC_BASE = "https://tako.com";

  it("renders markdown headings and paragraphs with marked", () => {
    const html = buildReportWidgetHtml({
      markdownBody: "# Heading 1\n\nA paragraph of text.",
      chartPubIds: [],
      publicBase: PUBLIC_BASE,
    });
    expect(html).toContain("<h1>Heading 1</h1>");
    expect(html).toContain("<p>A paragraph of text.</p>");
  });

  it("replaces the first N chart links with <iframe>s in document order", () => {
    const md = `
First chart: [Chart A](https://tako.com/embed/aaa/?theme=dark).
Then [Chart B](https://tako.com/embed/bbb).
Then [Chart C](https://tako.com/embed/ccc).
`;
    const html = buildReportWidgetHtml({
      markdownBody: md,
      chartPubIds: ["aaa", "bbb", "ccc"],
      publicBase: PUBLIC_BASE,
    });
    expect(html).toContain('<iframe src="https://tako.com/embed/aaa/?theme=dark"');
    expect(html).toContain('<iframe src="https://tako.com/embed/bbb/?theme=dark"');
    expect(html).toContain('<iframe src="https://tako.com/embed/ccc/?theme=dark"');
    expect(html).toContain('class="tako-chart-embed"');
  });

  it("leaves chart links beyond the pubId list as <a> markdown links", () => {
    const md = `
[A](https://tako.com/embed/aaa)
[B](https://tako.com/embed/bbb)
[C](https://tako.com/embed/ccc)
`;
    const html = buildReportWidgetHtml({
      markdownBody: md,
      chartPubIds: ["aaa", "bbb"], // C is over the cap
      publicBase: PUBLIC_BASE,
    });
    expect(html.match(/<iframe/g) ?? []).toHaveLength(2);
    expect(html).toContain('<a href="https://tako.com/embed/ccc"');
  });

  it("strips <script> tags from rendered markdown", () => {
    // Hostile markdown body — marked itself escapes raw HTML by
    // default but we re-sanitize defensively.
    const md = "Hello <script>alert(1)</script> world";
    const html = buildReportWidgetHtml({
      markdownBody: md,
      chartPubIds: [],
      publicBase: PUBLIC_BASE,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("strips on* event-handler attributes", () => {
    // marked allows raw HTML in some configs; even if it didn't, the
    // sanitizer is defense-in-depth.
    const dirtyHtml = "Click <a href=\"#\" onclick=\"alert(1)\">me</a>";
    const html = buildReportWidgetHtml({
      markdownBody: dirtyHtml,
      chartPubIds: [],
      publicBase: PUBLIC_BASE,
    });
    expect(html).not.toMatch(/onclick=/i);
  });

  it("emits notifyIntrinsicHeight for ChatGPT host scaling", () => {
    const html = buildReportWidgetHtml({
      markdownBody: "x",
      chartPubIds: [],
      publicBase: PUBLIC_BASE,
    });
    expect(html).toContain("notifyIntrinsicHeight");
  });

  it("renders a fallback when markdownBody is null", () => {
    const html = buildReportWidgetHtml({
      markdownBody: null,
      chartPubIds: [],
      publicBase: PUBLIC_BASE,
    });
    // Some sort of "Open in browser" affordance — exact copy is in
    // the implementation, just confirm it has SOME non-empty body.
    expect(html).toContain("<body");
    expect(html.length).toBeGreaterThan(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_widget.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `_report_widget.ts`**

Create `workers/src/tools/_report_widget.ts`:

```ts
/**
 * `get_report` / `wait_for_report` widget bundle.
 *
 * Renders a Tako report's markdown body inline with one or more
 * `<iframe>` chart embeds. Used by ChatGPT's MCP Apps host (claude.ai
 * gets static images via `extraContentBlocks` instead — see
 * `mcp.ts`'s `widgetSuppressed` logic).
 *
 * Wire path: each `tools/call` resolves a per-call resource URI
 * `ui://tako/embed/report/{report_id}` (the dynamic-resource variant
 * declared by the tool's `appUiResource`). The Workers runtime calls
 * back into `renderHtml` for each `resources/read`, where this
 * builder runs against the report's markdown body and pub_id list.
 *
 * Why dynamic-only (no static URI like open_chart_ui): the widget
 * needs the report data baked into the HTML to render anything —
 * there is no postMessage handshake path that could deliver markdown
 * + N iframes after mount in a way claude.ai's snapshot-once layout
 * model would honor. ChatGPT's host honors the dynamic URI fine via
 * `_meta["openai/outputTemplate"]` (set per-call to the resolved
 * URI by `mcp.ts`).
 */
import { marked } from "marked";

/** RFC 6570 URI template registered as the ResourceTemplate. */
export const REPORT_WIDGET_URI_PATTERN = "ui://tako/embed/report/{report_id}";
/** Stable name for the SDK ResourceTemplate registration. */
export const REPORT_WIDGET_NAME = "get_report_widget";

/**
 * Initial widget height used in `notifyIntrinsicHeight`. The widget's
 * actual content height is measured via `document.body.scrollHeight`
 * inside the inlined script — this constant is only the fallback
 * placeholder height while CSS settles on first mount.
 */
const INITIAL_WIDGET_HEIGHT_PX = 600;

/** HTML-escape attribute / text content. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strip dangerous HTML constructs from `marked`'s rendered output.
 * Defense-in-depth: marked already escapes raw HTML by default, but
 * report markdown comes from an upstream we don't fully control, so
 * a tight allowlist on the boundary keeps a stray `<script>` or
 * inline `onerror` from making it into the iframe.
 *
 * Allowlist approach (subtract dangerous bits) rather than parse-and-
 * rebuild: the rendered HTML is small (<12 KB markdown body cap), so
 * regex-based stripping is acceptable. The patterns target:
 *   - `<script>` tags + their contents
 *   - `<style>` tags + their contents (no `style=""` values either —
 *     CSS injection vectors)
 *   - `on*` event-handler attributes on any tag
 *   - inline `style=""` attributes
 *   - `javascript:` URLs in href / src
 */
function sanitizeRenderedHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
    .replace(/\sstyle\s*=\s*'[^']*'/gi, "")
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
}

/**
 * For each pub_id in `chartPubIds`, find the FIRST `<a href=...>`
 * pointing at `${publicBase}/embed/{pub_id}` or `${publicBase}/c/{pub_id}`
 * (with optional trailing slash and query) in the rendered HTML and
 * replace that anchor with a `<iframe class="tako-chart-embed"
 * src="${embedUrl}">`. Anchors for pub_ids not in the list, or
 * additional anchors for already-replaced ids, are left alone.
 *
 * Replacing in document order so charts render where they're cited
 * in the prose (not appended at the bottom).
 */
function replaceChartLinksWithIframes(
  html: string,
  chartPubIds: readonly string[],
  publicBase: string,
): string {
  const base = publicBase.replace(/\/+$/, "");
  let out = html;
  for (const pubId of chartPubIds) {
    // Match: <a href="https://tako.com/embed/{pubId}/?theme=dark">label</a>
    // — capture original href to preserve theme/query.
    const escapedPubId = pubId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchorPattern = new RegExp(
      `<a\\s+href="(${escapedBase}/(?:embed|c)/${escapedPubId}(?:/[^"]*)?)"[^>]*>[^<]*</a>`,
      "i",
    );
    const match = anchorPattern.exec(out);
    if (match === null) continue;
    const href = match[1]!;
    // Force theme=dark on the iframe URL so the embedded chart
    // matches the widget's dark body. If the original href already
    // has `?theme=`, leave it alone; otherwise append.
    const themedHref = /[?&]theme=/.test(href)
      ? href
      : `${href}${href.includes("?") ? "&" : "?"}theme=dark`;
    const iframeHtml = `<iframe class="tako-chart-embed" src="${htmlEscape(
      themedHref,
    )}" frameborder="0" allow="fullscreen" loading="lazy"></iframe>`;
    out = out.replace(match[0], iframeHtml);
  }
  return out;
}

interface BuildReportWidgetHtmlInput {
  markdownBody: string | null;
  chartPubIds: readonly string[];
  publicBase: string;
}

/**
 * Build the full widget HTML for a report. Invoked once per
 * `resources/read` for the dynamic resource URI; the result is the
 * sandboxed iframe content the host renders inline in the chat.
 *
 * `markdownBody === null` falls back to a "no body available" widget
 * with a Tako homepage link so the user always has somewhere to go.
 */
export function buildReportWidgetHtml(input: BuildReportWidgetHtmlInput): string {
  const { markdownBody, chartPubIds, publicBase } = input;

  if (markdownBody === null || markdownBody.length === 0) {
    return `<!doctype html>
<html lang="en" style="height: 200px;">
<head>
<meta charset="utf-8" />
<meta name="x-tako-widget" content="get_report/v1-fallback" />
<title>Tako report</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: #0f1115; color: #e6e6e6; font: 14px system-ui, -apple-system, sans-serif; }
  .wrap { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; box-sizing: border-box; }
  a { color: #4aa9ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body style="height: 200px;">
<div class="wrap">
  <p>Report body unavailable. <a href="${htmlEscape(publicBase)}" target="_blank" rel="noopener noreferrer">Open Tako →</a></p>
</div>
</body>
</html>`;
  }

  // marked options: GFM features (tables, fenced code, autolinks)
  // are useful for Tako reports. `breaks: false` so single newlines
  // within a paragraph don't become `<br>` (markdown convention).
  let rendered = marked.parse(markdownBody, {
    gfm: true,
    breaks: false,
    async: false,
  }) as string;

  rendered = sanitizeRenderedHtml(rendered);
  rendered = replaceChartLinksWithIframes(rendered, chartPubIds, publicBase);

  return `<!doctype html>
<html lang="en" style="height: ${INITIAL_WIDGET_HEIGHT_PX}px;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-tako-widget" content="get_report/v1" />
<title>Tako report</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; background: #0f1115; color: #e6e6e6; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { padding: 20px; box-sizing: border-box; }
  h1, h2, h3, h4 { color: #fff; margin: 1.4em 0 0.5em 0; line-height: 1.25; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.1em; }
  p { margin: 0.7em 0; }
  ul, ol { margin: 0.7em 0; padding-left: 1.4em; }
  li { margin: 0.25em 0; }
  a { color: #4aa9ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #1a1d24; padding: 1px 5px; border-radius: 3px; font-size: 0.92em; }
  pre { background: #1a1d24; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #2a2e36; margin: 0.7em 0; padding: 0 0 0 12px; color: #a0a4ab; }
  table { border-collapse: collapse; width: 100%; margin: 0.7em 0; }
  th, td { border: 1px solid #2a2e36; padding: 6px 10px; text-align: left; }
  th { background: #1a1d24; }
  .tako-chart-embed { width: 100%; aspect-ratio: 1.91 / 1; border: 0; margin: 14px 0; display: block; background: transparent; }
</style>
</head>
<body>
${rendered}
<script>
(function(){
  "use strict";
  function notify() {
    try {
      var h = document.body.scrollHeight || ${INITIAL_WIDGET_HEIGHT_PX};
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight(h);
      }
      document.documentElement.style.height = h + "px";
    } catch(e) {}
  }
  notify();
  // Re-measure once iframes load and may grow.
  window.addEventListener("load", notify);
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/_report_widget.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_widget.ts workers/src/tools/_report_widget.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): _report_widget.ts — markdown + chart iframe widget bundle

New shared widget for get_report / wait_for_report:
- buildReportWidgetHtml() renders the markdown body via marked, sanitizes
  the output (strip <script>, on*, style, javascript:), then replaces
  the first N chart links with <iframe class="tako-chart-embed"> in
  document order.
- Dynamic resource URI ui://tako/embed/report/{report_id} (no static
  variant — the widget requires per-call data baked in).
- Fallback HTML for the markdown_body === null degraded path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire `get_report.ts` — input flag, enrichment, widget, fallback content blocks

**Files:**
- Modify: `workers/src/tools/get_report.ts`
- Create: `workers/src/tools/get_report.test.ts`

- [ ] **Step 1: Write failing tests for `get_report` end-to-end behavior**

Create `workers/src/tools/get_report.test.ts`:

```ts
/**
 * End-to-end tests for `get_report`'s full-content path. Three lanes:
 *   1. include_full_content=false → status-only, no extra fetches.
 *   2. status='running' → no extra fetches even when flag is true.
 *   3. status='completed' → fetch markdown, populate fields, emit
 *      content blocks (claude.ai path) or rely on widget (ChatGPT).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import get_report from "./get_report.js";
import {
  jsonResponse,
  mockFetchSequence,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = {
  DJANGO_BASE_URL: "https://trytako.com",
  PUBLIC_BASE_URL: "https://tako.com",
};
const CTX: ToolContext = { token: "sk-test", env: ENV };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("get_report — include_full_content branching", () => {
  it("does not fetch markdown when include_full_content is false", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        markdown_url: "https://exports.tako.com/r/rep_done.md",
      }),
    ]);

    const out = await get_report.handler(
      { report_id: "rep_done", include_full_content: false },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.markdown_body).toBeNull();
    expect(out.chart_pub_ids).toEqual([]);
    expect(out.charts_truncated).toBe(false);
  });

  it("does not fetch markdown on a non-completed status even with the flag", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_running",
        status: "running",
        markdown_url: "https://exports.tako.com/r/rep_running.md",
      }),
    ]);

    const out = await get_report.handler(
      { report_id: "rep_running", include_full_content: true },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.markdown_body).toBeNull();
    expect(out.chart_pub_ids).toEqual([]);
  });

  it("fetches markdown and populates fields on completed status", async () => {
    const md =
      "# Tesla Q1\n\nKey chart: [Revenue](https://tako.com/embed/aaa).\n\nMore: [Margins](https://tako.com/embed/bbb).";
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        markdown_url: "https://exports.tako.com/r/rep_done.md",
      }),
      new Response(md, { status: 200, headers: { "content-type": "text/markdown" } }),
    ]);

    const out = await get_report.handler(
      { report_id: "rep_done", include_full_content: true },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.markdown_body).toMatch(/^# Tesla Q1/);
    expect(out.chart_pub_ids).toEqual(["aaa", "bbb"]);
    expect(out.charts_truncated).toBe(false);
    // Sanity check the second fetch hit markdown_url.
    const secondReq = requestFrom(fetchMock.mock.calls[1]);
    expect(secondReq.url).toBe("https://exports.tako.com/r/rep_done.md");
  });

  it("defaults include_full_content to true when omitted", async () => {
    const parse = get_report.inputSchema.safeParse({ report_id: "rep_x" });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.include_full_content).toBe(true);
    }
  });

  it("succeeds when markdown_url fetch fails (graceful degrade)", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        markdown_url: "https://exports.tako.com/r/missing.md",
      }),
      new Response("nope", { status: 404 }),
    ]);

    const out = await get_report.handler(
      { report_id: "rep_done", include_full_content: true },
      CTX,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.status).toBe("completed");
    expect(out.markdown_body).toBeNull();
    expect(out.chart_pub_ids).toEqual([]);
  });
});

describe("get_report.appUiResource — dynamic URI for the report widget", () => {
  it("declares the dynamic-only widget bundle pointing at the report URI", () => {
    const ui = get_report.appUiResource?.(ENV);
    expect(ui).toBeDefined();
    expect(ui!.dynamic).toBeDefined();
    expect(ui!.dynamic!.uriPattern).toBe("ui://tako/embed/report/{report_id}");
    // No static URI — the widget requires per-call data baked in.
    expect(ui!.uri).toBe("ui://tako/embed/report/{report_id}");
    // resolveUriFromInput substitutes report_id.
    const resolved = ui!.dynamic!.resolveUriFromInput({ report_id: "rep_x" });
    expect(resolved).toBe("ui://tako/embed/report/rep_x");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/get_report.test.ts
```

Expected: FAIL — `include_full_content` not in input schema, `appUiResource` not defined on `get_report`.

- [ ] **Step 3: Update `get_report.ts` — add input flag, enrichment call, widget, fallback content blocks**

Replace `workers/src/tools/get_report.ts` with:

```ts
/**
 * `get_report` — fetch a Tako report's current status and (when ready) content.
 *
 * Wraps `GET /api/v1/internal/reports/{report_id}/`. Unified read: while the
 * report is generating, `status` is `pending` / `running` and content fields
 * are absent; once `status === "completed"`, the full `sections`,
 * `export_urls`, etc. are populated.
 *
 * On completed reports, when `include_full_content` is true (default), the
 * tool also fetches `markdown_url`, extracts up to 6 chart pub_ids, and
 * renders the report inline:
 *   - ChatGPT → MCP Apps widget (`ui://tako/embed/report/{report_id}`)
 *     with markdown body + N chart iframes baked in.
 *   - claude.ai → no widget (suppressed by `mcp.ts`); inline image content
 *     blocks for each chart's PNG plus the markdown body as text.
 *
 * Response shape and enrichment logic live in `_report_shape.ts` so this
 * tool and `wait_for_report` cannot drift on field names.
 */
import { z } from "zod";

import { djangoGet } from "../django.js";
import { resolvePublicApiBase, resolvePublicBase } from "../env.js";
import {
  buildReportWidgetHtml,
  REPORT_WIDGET_NAME,
  REPORT_WIDGET_URI_PATTERN,
} from "./_report_widget.js";
import {
  enrichReportOutputWithFullContent,
  type ReportDetailResponse,
  reportOutputSchema,
  shapeReportOutput,
} from "./_report_shape.js";
import type { AppUiResource, ToolContentBlock, ToolModule } from "./types.js";

const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
  include_full_content: z
    .boolean()
    .default(true)
    .describe(
      "When true (default) and status is 'completed', the response inlines the full report markdown body and renders chart widgets. Pass `false` for a status-only check (skips the markdown fetch and chart rendering — cheaper, smaller response).",
    ),
});

// Cap on the inlined PNG bytes for each chart on the claude.ai
// fallback path. Reuses the same value `open_chart_ui` uses.
const MAX_INLINE_PNG_BYTES = 4 * 1024 * 1024;
const PNG_FETCH_TIMEOUT_MS = 8_000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

/**
 * Fetch a single chart PNG and return a `data:image/...;base64,...`
 * content block. Returns `undefined` on any failure path so the
 * caller drops just that chart instead of failing the whole call.
 */
async function fetchChartImageBlock(
  pubId: string,
  apiBase: string,
): Promise<ToolContentBlock | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PNG_FETCH_TIMEOUT_MS);
  try {
    const url = `${apiBase}/api/v1/image/${encodeURIComponent(pubId)}/?dark_mode=true`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return undefined;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return undefined;
    if (buffer.byteLength > MAX_INLINE_PNG_BYTES) return undefined;
    return {
      type: "image",
      data: arrayBufferToBase64(buffer),
      mimeType: contentType.split(";")[0]!.trim(),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

const get_report = {
  name: "get_report",
  description:
    "Use this for a one-shot status check on a Tako report (from create_report). For waiting on a report to finish, prefer `wait_for_report` — it keeps the polling loop on the server. When still 'pending' / 'running', narrative / sections fields are null. When 'completed', they contain the full report payload plus export URLs (pdf, pptx). When 'failed', read `error_message` and surface it to the user instead of retrying indefinitely. ALWAYS include the response's `webpage_url` in your reply so the user has a clickable link to open the report in their browser — every response carries one whether the report is still cooking or done. When `status === 'completed'` and `include_full_content` is true (default), the response carries the full markdown body and up to 6 interactive chart widgets (charts beyond the cap are linked in the markdown). Surface the markdown_body to the user verbatim — do NOT summarize it.",
  inputSchema,
  outputSchema: reportOutputSchema,
  annotations: {
    title: "Tako: Get Report",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input, ctx) {
    const reportId = encodeURIComponent(input.report_id);
    const data = await djangoGet<ReportDetailResponse>(
      ctx.env,
      ctx.token,
      `/api/v1/internal/reports/${reportId}/`,
      { timeoutMs: 30_000 },
    );
    const shaped = shapeReportOutput(data, input.report_id, ctx.env);
    return enrichReportOutputWithFullContent(
      shaped,
      ctx.env,
      input.include_full_content,
    );
  },
  appUiResource(env): AppUiResource {
    const publicBase = resolvePublicBase(env);
    return {
      // Static URI — points at the same dynamic pattern. claude.ai is
      // already widget-suppressed for this tool by `mcp.ts`'s client
      // detection, and ChatGPT honors the dynamic per-call URI via
      // `_meta["openai/outputTemplate"]` (set in mcp.ts). No
      // standalone HTML is needed because every call resolves to the
      // dynamic variant; provide an empty fallback bundle for
      // registration parity with the rest of the codebase.
      uri: REPORT_WIDGET_URI_PATTERN,
      name: REPORT_WIDGET_NAME,
      html: buildReportWidgetHtml({
        markdownBody: null,
        chartPubIds: [],
        publicBase,
      }),
      // Allow the inner chart iframes to load.
      frameDomains: [publicBase],
      dynamic: {
        uriPattern: REPORT_WIDGET_URI_PATTERN,
        templateName: `${REPORT_WIDGET_NAME}_template`,
        async renderHtml(variables, ctx) {
          const reportIdRaw = variables.report_id;
          const reportId =
            typeof reportIdRaw === "string"
              ? reportIdRaw
              : Array.isArray(reportIdRaw)
                ? (reportIdRaw[0] ?? "")
                : "";
          if (reportId === "") {
            return buildReportWidgetHtml({
              markdownBody: null,
              chartPubIds: [],
              publicBase,
            });
          }
          // Re-fetch the report on resource read so the widget data
          // matches the current report state. The host resolves the
          // resource read using the same Bearer token / env as the
          // tool call, so authentication is handled by ctx.
          let shaped;
          try {
            const data = await djangoGet<ReportDetailResponse>(
              ctx.env,
              ctx.token,
              `/api/v1/internal/reports/${encodeURIComponent(reportId)}/`,
              { timeoutMs: 30_000 },
            );
            shaped = shapeReportOutput(data, reportId, ctx.env);
            shaped = await enrichReportOutputWithFullContent(
              shaped,
              ctx.env,
              true,
            );
          } catch {
            return buildReportWidgetHtml({
              markdownBody: null,
              chartPubIds: [],
              publicBase,
            });
          }
          return buildReportWidgetHtml({
            markdownBody: shaped.markdown_body,
            chartPubIds: shaped.chart_pub_ids,
            publicBase,
          });
        },
        resolveUriFromInput(input) {
          const reportId =
            typeof (input as { report_id?: unknown })?.report_id === "string"
              ? (input as { report_id: string }).report_id
              : "";
          return `ui://tako/embed/report/${encodeURIComponent(reportId)}`;
        },
      },
    };
  },
  async extraContentBlocks(output, ctx): Promise<ToolContentBlock[]> {
    // Fired only when the widget was suppressed (claude.ai client
    // detection in mcp.ts). For each chart pub_id we extracted, fetch
    // the PNG and inline it as an image content block. Failures drop
    // that chart silently; we never fail the call over a presentation
    // hiccup.
    if (output.chart_pub_ids.length === 0) return [];
    const apiBase = resolvePublicApiBase(ctx.env);
    const blocks = await Promise.all(
      output.chart_pub_ids.map((pubId) => fetchChartImageBlock(pubId, apiBase)),
    );
    return blocks.filter((b): b is ToolContentBlock => b !== undefined);
  },
} satisfies ToolModule<typeof inputSchema, z.infer<typeof reportOutputSchema>>;

export default get_report;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/get_report.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/get_report.ts workers/src/tools/get_report.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): get_report renders full markdown body + chart widgets

Add include_full_content (default true) input. When the report is
completed, the tool fetches markdown_url, extracts up to 6 chart
pub_ids, and:
- Registers a dynamic MCP Apps widget at ui://tako/embed/report/{id}
  that renders markdown + iframe embeds inline (ChatGPT path).
- On the claude.ai widget-suppressed path, falls back to inline
  base64 PNG content blocks (one per chart) plus the markdown body
  in the structuredContent.

Failures (markdown fetch, individual chart fetch, widget render)
degrade silently — the user always still gets webpage_url.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `wait_for_report.ts` — same enrichment + widget on terminal-completed

**Files:**
- Modify: `workers/src/tools/wait_for_report.ts`
- Modify: `workers/src/tools/wait_for_report.test.ts`

- [ ] **Step 1: Add a failing test for the terminal-completed full-content path**

Append to `workers/src/tools/wait_for_report.test.ts` (inside the existing `describe`):

```ts
  it("populates markdown_body and chart_pub_ids on terminal-completed when include_full_content is true", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        markdown_url: "https://exports.tako.com/r/rep_done.md",
      }),
      new Response(
        "# Done\n\n[Chart](https://trytako.com/embed/zzz).",
        { status: 200, headers: { "content-type": "text/markdown" } },
      ),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_done", max_wait_seconds: 50, include_full_content: true },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.timed_out).toBe(false);
    expect(out.markdown_body).toMatch(/^# Done/);
    expect(out.chart_pub_ids).toEqual(["zzz"]);
  });

  it("does not fetch markdown when include_full_content=false on terminal completed", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      jsonResponse(200, {
        id: "rep_done",
        status: "completed",
        markdown_url: "https://exports.tako.com/r/rep_done.md",
      }),
    ]);

    const promise = wait_for_report.handler(
      { report_id: "rep_done", max_wait_seconds: 50, include_full_content: false },
      CTX,
    );
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.markdown_body).toBeNull();
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/wait_for_report.test.ts
```

Expected: FAIL — `include_full_content` not in input schema, markdown not being fetched.

- [ ] **Step 3: Update `wait_for_report.ts` — add input flag, call enrichment after the terminal exit, declare widget**

Edit `workers/src/tools/wait_for_report.ts`:

Add imports near the top (alongside existing imports):

```ts
import { resolvePublicApiBase, resolvePublicBase } from "../env.js";
import {
  buildReportWidgetHtml,
  REPORT_WIDGET_NAME,
  REPORT_WIDGET_URI_PATTERN,
} from "./_report_widget.js";
import { enrichReportOutputWithFullContent } from "./_report_shape.js";
import type { AppUiResource, ToolContentBlock } from "./types.js";
```

Update `inputSchema` to add `include_full_content`:

```ts
const inputSchema = z.object({
  report_id: z
    .string()
    .min(1)
    .describe("Report ID returned from create_report or list_reports."),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_CEILING_S)
    .default(MAX_WAIT_CEILING_S)
    .describe(
      `How long this single call may block waiting for a terminal status. Capped at ${MAX_WAIT_CEILING_S}s so the call always returns before the MCP client's tool-call timeout fires. If the report isn't done yet, call this tool again with the same report_id — reports typically take 5–20 minutes, so expect to chain several calls in a row.`,
    ),
  include_full_content: z
    .boolean()
    .default(true)
    .describe(
      "When true (default) and the polling reaches a 'completed' status, the response inlines the full report markdown body and renders chart widgets. Pass `false` for a status-only check (skips the markdown fetch and chart rendering — cheaper, smaller response).",
    ),
});
```

Update the description string (replacing the existing description):

```ts
  description:
    "Use this after create_report (or whenever the user wants to wait for / check on a report). Server-side polling — returns when status is 'completed' / 'failed' / 'cancelled' OR after max_wait_seconds (default 50s) without a terminal status. **If `timed_out` is true, IMMEDIATELY call wait_for_report again with the same report_id and continue chaining until status is terminal — do NOT reply to the user mid-poll. CAP THE CHAIN AT 12 CALLS TOTAL (~10 minutes of waiting): once you've made 12 chained wait_for_report calls and the report is still not terminal, STOP chaining; tell the user the report is taking longer than usual, re-share the `webpage_url`, and remind them they'll receive an email when it's done.** Once terminal, ALWAYS include the response's `webpage_url` so the user has a clickable link to open the report in their browser, then summarize `result` / `export_urls` on completed or `error_message` on failed. When `status === 'completed'` and `include_full_content` is true (default), the response carries the full markdown body and up to 6 interactive chart widgets (charts beyond the cap are linked in the markdown). Surface the markdown_body to the user verbatim — do NOT summarize it.",
```

Update the handler's terminal-completed return path. Replace:

```ts
      const status = (last.status ?? "").toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        return {
          ...shapeReportOutput(last, input.report_id, ctx.env),
          timed_out: false,
        };
      }
```

with:

```ts
      const status = (last.status ?? "").toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        const shaped = shapeReportOutput(last, input.report_id, ctx.env);
        const enriched = await enrichReportOutputWithFullContent(
          shaped,
          ctx.env,
          input.include_full_content,
        );
        return {
          ...enriched,
          timed_out: false,
        };
      }
```

(The timed-out branch at the bottom of the handler stays unchanged — we don't enrich on timeouts since status is non-terminal.)

After the `wait_for_report = { ... }` literal, before `} satisfies`, add the same `appUiResource` + `extraContentBlocks` blocks as `get_report`. Add right before `} satisfies`:

```ts
,
  appUiResource(env): AppUiResource {
    const publicBase = resolvePublicBase(env);
    return {
      uri: REPORT_WIDGET_URI_PATTERN,
      name: REPORT_WIDGET_NAME,
      html: buildReportWidgetHtml({
        markdownBody: null,
        chartPubIds: [],
        publicBase,
      }),
      frameDomains: [publicBase],
      dynamic: {
        uriPattern: REPORT_WIDGET_URI_PATTERN,
        templateName: `${REPORT_WIDGET_NAME}_template`,
        async renderHtml(variables, ctx) {
          const reportIdRaw = variables.report_id;
          const reportId =
            typeof reportIdRaw === "string"
              ? reportIdRaw
              : Array.isArray(reportIdRaw)
                ? (reportIdRaw[0] ?? "")
                : "";
          if (reportId === "") {
            return buildReportWidgetHtml({
              markdownBody: null,
              chartPubIds: [],
              publicBase,
            });
          }
          let shaped;
          try {
            const data = await djangoGet<ReportDetailResponse>(
              ctx.env,
              ctx.token,
              `/api/v1/internal/reports/${encodeURIComponent(reportId)}/`,
              { timeoutMs: 30_000 },
            );
            shaped = shapeReportOutput(data, reportId, ctx.env);
            shaped = await enrichReportOutputWithFullContent(
              shaped,
              ctx.env,
              true,
            );
          } catch {
            return buildReportWidgetHtml({
              markdownBody: null,
              chartPubIds: [],
              publicBase,
            });
          }
          return buildReportWidgetHtml({
            markdownBody: shaped.markdown_body,
            chartPubIds: shaped.chart_pub_ids,
            publicBase,
          });
        },
        resolveUriFromInput(input) {
          const reportId =
            typeof (input as { report_id?: unknown })?.report_id === "string"
              ? (input as { report_id: string }).report_id
              : "";
          return `ui://tako/embed/report/${encodeURIComponent(reportId)}`;
        },
      },
    };
  },
  async extraContentBlocks(output, ctx): Promise<ToolContentBlock[]> {
    if (output.chart_pub_ids.length === 0) return [];
    const apiBase = resolvePublicApiBase(ctx.env);
    const MAX_INLINE_PNG_BYTES = 4 * 1024 * 1024;
    const PNG_FETCH_TIMEOUT_MS = 8_000;
    const blocks = await Promise.all(
      output.chart_pub_ids.map(async (pubId) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PNG_FETCH_TIMEOUT_MS);
        try {
          const url = `${apiBase}/api/v1/image/${encodeURIComponent(pubId)}/?dark_mode=true`;
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) return undefined;
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.startsWith("image/")) return undefined;
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength === 0 || buffer.byteLength > MAX_INLINE_PNG_BYTES) {
            return undefined;
          }
          return {
            type: "image" as const,
            data: Buffer.from(buffer).toString("base64"),
            mimeType: contentType.split(";")[0]!.trim(),
          };
        } catch {
          return undefined;
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    return blocks.filter((b): b is ToolContentBlock => b !== undefined);
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npx vitest run src/tools/wait_for_report.test.ts
```

Expected: PASS (including the existing tests).

- [ ] **Step 5: Run the full test suite + typecheck**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm test && npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/wait_for_report.ts workers/src/tools/wait_for_report.test.ts
git commit -m "$(cat <<'EOF'
feat(workers): wait_for_report renders full report content on terminal-completed

Mirror get_report's full-content behavior on the terminal-completed
exit branch — fetch markdown_url, extract chart pub_ids, attach the
same dynamic widget at ui://tako/embed/report/{id}, fall back to
inline image content blocks on the claude.ai widget-suppressed path.
Timed-out and failed/cancelled exits don't enrich (no markdown body
to fetch).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: DRY the duplicated chart-image fallback into `_report_shape.ts`

**Files:**
- Modify: `workers/src/tools/_report_shape.ts`
- Modify: `workers/src/tools/get_report.ts`
- Modify: `workers/src/tools/wait_for_report.ts`

The `extraContentBlocks` body for fetching chart PNGs is duplicated across `get_report.ts` and `wait_for_report.ts` after Task 8. Pull it into a shared helper before adding any more behavior — exactly the DRY moment the spec calls out.

- [ ] **Step 1: Add a shared `fetchChartImageBlocks` helper in `_report_shape.ts`**

Append to `workers/src/tools/_report_shape.ts`:

```ts
/**
 * Cap on a single inlined chart PNG (in bytes). Above this we drop
 * that chart from the inline content blocks. Mirrors the same value
 * `open_chart_ui` uses — kept in sync because both code paths fetch
 * from the same chart-image endpoint and are subject to the same
 * client tool-result size guards.
 */
export const REPORT_CHART_INLINE_PNG_CAP = 4 * 1024 * 1024;

/** Outer timeout on each chart PNG fetch — same as the markdown fetch. */
const CHART_PNG_FETCH_TIMEOUT_MS = 8_000;

interface InlineImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * Fetch up to N chart PNGs (one per pub_id) from the public chart
 * image endpoint and return them as MCP `image` content blocks.
 * Failures (timeout, !ok, wrong content type, oversize, empty) drop
 * just that chart from the result; the rest still ship.
 *
 * Used by `get_report` and `wait_for_report` on the claude.ai
 * widget-suppressed path. No-op when `chartPubIds` is empty.
 */
export async function fetchChartImageBlocks(
  chartPubIds: readonly string[],
  apiBase: string,
): Promise<InlineImageBlock[]> {
  if (chartPubIds.length === 0) return [];
  const fetchOne = async (pubId: string): Promise<InlineImageBlock | undefined> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHART_PNG_FETCH_TIMEOUT_MS);
    try {
      const url = `${apiBase}/api/v1/image/${encodeURIComponent(pubId)}/?dark_mode=true`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) return undefined;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) return undefined;
      if (buffer.byteLength > REPORT_CHART_INLINE_PNG_CAP) return undefined;
      return {
        type: "image",
        data: Buffer.from(buffer).toString("base64"),
        mimeType: contentType.split(";")[0]!.trim(),
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  };
  const blocks = await Promise.all(chartPubIds.map(fetchOne));
  return blocks.filter((b): b is InlineImageBlock => b !== undefined);
}
```

- [ ] **Step 2: Replace the inline body in `get_report.ts` with a call to the shared helper**

In `workers/src/tools/get_report.ts`:

- Delete the `MAX_INLINE_PNG_BYTES`, `PNG_FETCH_TIMEOUT_MS`, `arrayBufferToBase64`, and `fetchChartImageBlock` definitions.
- Update the import from `./_report_shape.js` to also import `fetchChartImageBlocks`.
- Replace the `extraContentBlocks` body with:

```ts
  async extraContentBlocks(output, ctx): Promise<ToolContentBlock[]> {
    return fetchChartImageBlocks(output.chart_pub_ids, resolvePublicApiBase(ctx.env));
  },
```

- [ ] **Step 3: Replace the inline body in `wait_for_report.ts` with the shared helper**

In `workers/src/tools/wait_for_report.ts`:

- Update the import from `./_report_shape.js` to also import `fetchChartImageBlocks`.
- Replace the `extraContentBlocks` body with the same one-line call as Task 9 step 2.

- [ ] **Step 4: Run the full test suite to make sure no regression**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm test && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/src/tools/_report_shape.ts workers/src/tools/get_report.ts workers/src/tools/wait_for_report.ts
git commit -m "$(cat <<'EOF'
refactor(workers): pull chart PNG fetch into _report_shape.fetchChartImageBlocks

DRY the claude.ai-fallback chart image fetcher that get_report and
wait_for_report both need. Behavior unchanged — same per-chart
timeout, same content-type check, same 4 MB cap, same drop-failed-
charts-silently semantics. One shared helper keeps the two tools
in lockstep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Regenerate `registry/server.json`

**Files:**
- Modify: `workers/registry/server.json`

- [ ] **Step 1: Regenerate**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run registry:gen
```

Expected: `registry/server.json` updated to include the new `include_full_content` input on `get_report` and `wait_for_report`, and the updated tool descriptions.

- [ ] **Step 2: Verify the registry check passes**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run registry:check
```

Expected: PASS — generated registry matches the on-disk one.

- [ ] **Step 3: Commit**

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp && git add workers/registry/server.json
git commit -m "$(cat <<'EOF'
chore(registry): regenerate server.json for get_report/wait_for_report full content

Picks up the new include_full_content input field and updated
descriptions on both tools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Manual smoke test against staging

**Files:** none (manual)

- [ ] **Step 1: Run the smoke harness**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run smoke
```

Expected: existing smoke tests still pass (no new ones for this feature — the smoke harness is mostly knowledge_search / chart paths). If smoke calls `get_report`, ensure the new fields don't break the assertion shape.

- [ ] **Step 2: Local dev server check**

Run:

```bash
cd /Users/juanchifassio/Desktop/work/tako-mcp/workers && npm run dev
```

Then in a second terminal, hit `/mcp` with a tools/list request and confirm `get_report.inputSchema` includes `include_full_content`. Stop the dev server with Ctrl+C.

- [ ] **Step 3: Done**

No commit — local validation only.

---

## Self-Review Checklist

After completing all tasks above, verify:

**Spec coverage:**
- [x] `include_full_content: boolean` on both tools, default true (Tasks 7, 8)
- [x] `markdown_body`, `chart_pub_ids`, `charts_truncated` on shared shape (Task 2)
- [x] Markdown fetch with 8s timeout, content-type check, 12 KB cap with UTF-8 boundary truncation (Task 4)
- [x] Pub_id regex over markdown body, dedupes, caps at 6 (Task 3)
- [x] `marked` for markdown → HTML; sanitizer strips `<script>`, `on*`, `style`, `javascript:` (Task 6)
- [x] Inline-replace strategy for chart links → iframes, document order (Task 6)
- [x] Dynamic-only resource URI `ui://tako/embed/report/{report_id}` (Task 6, 7, 8)
- [x] ChatGPT widget path + claude.ai inline-image fallback (Tasks 7, 8) — gated by existing `mcp.ts` UA detection (no `mcp.ts` changes needed)
- [x] Tool descriptions tell the LLM to surface `markdown_body` verbatim (Tasks 7, 8)
- [x] Failure paths degrade silently — markdown 404, chart fetch fail, marked throw (Tasks 4, 6, 9)
- [x] Tests for each helper + end-to-end happy/failure paths (Tasks 2-9)
- [x] Registry regeneration (Task 10)

**Placeholder scan:** none — every step has either runnable commands or full file content.

**Type consistency:** `ReportOutput` exported from `_report_shape.ts`, used by both `get_report.ts` and `wait_for_report.ts` and the shared helpers. `REPORT_WIDGET_URI_PATTERN` / `REPORT_WIDGET_NAME` exported from `_report_widget.ts`. `fetchChartImageBlocks` returns `InlineImageBlock[]` which structurally matches `ToolContentBlock` (`{ type: "image"; data: string; mimeType: string }` from `types.ts`).

**Risks:** `marked` v14 default behavior escapes raw HTML; the sanitizer is defense-in-depth only. The widget renders the markdown directly as innerHTML inside the iframe sandbox — XSS containment is via the host's CSP sandbox + our sanitizer. No user-provided JS reaches outside the iframe.
