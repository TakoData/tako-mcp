/**
 * Tests for the markdown renderers + structuredContent slimmers.
 *
 * The renderers are the model-facing text channel — every load-bearing fact
 * (ids, exportable flag, values_hint, chart url, rows, glossary text) must
 * survive into the markdown, because the slim structuredContent no longer
 * carries it. The slimmers are the token guard — they must emit ONLY the
 * machine essentials.
 */
import { describe, expect, it } from "vitest";

import {
  renderAgentRunMarkdown,
  renderAnswerMarkdown,
  renderAvailableDataMarkdown,
  renderContentsText,
  renderSearchMarkdown,
  slimAgentRunStructured,
  slimAnswerStructured,
  slimAvailableDataStructured,
  slimContentsStructured,
  slimSearchStructured,
  type AnswerFullOutput,
} from "./_render_markdown.js";
import type { SearchOutput, TakoCard } from "./_search_results.js";

const card = (over: Partial<TakoCard> = {}): TakoCard =>
  ({
    card_id: "c1",
    title: "Tesla Revenue",
    description: "Quarterly revenue for Tesla, Inc.",
    exportable: true,
    nodes: [
      { id: "ent_tsla", name: "Tesla, Inc.", type: "entity" },
      { id: "met_rev", name: "Revenue", type: "metric" },
    ],
    webpage_url: "https://trytako.com/card/c1",
    content: {
      content_format: "json_compact",
      total_rows: 40,
      truncated: true,
      dataset: {
        columns: [
          { name: "date", type: "datetime" },
          { name: "revenue", type: "number" },
        ],
        rows: [
          ["2026-03-31", 25.5],
          ["2026-06-30", 27.1],
        ],
      },
    },
    ...over,
  }) as TakoCard;

const searchOutput = (over: Partial<SearchOutput> = {}): SearchOutput => ({
  cards: [card()],
  web_results: [
    {
      title: "Tesla Q2 earnings",
      url: "https://example.com/tsla",
      snippet: "Revenue rose 6% to $27.1B in the quarter.",
      source_name: "Example News",
      publish_date: "2026-07-20",
    },
  ],
  usage: { total_cost_usd: 0.007 },
  request_id: "req-1",
  ...over,
});

describe("renderSearchMarkdown", () => {
  it("renders cards with every load-bearing fact: title, exportable, nodes, chart, rows", () => {
    const md = renderSearchMarkdown(searchOutput());
    expect(md).toContain("## Tako Data (1 card)");
    expect(md).toContain("### 1. Tesla Revenue");
    expect(md).toContain("Quarterly revenue for Tesla, Inc.");
    expect(md).toContain("exportable: yes");
    expect(md).toContain("`ent_tsla` (Tesla, Inc.)");
    expect(md).toContain("`met_rev` (Revenue)");
    expect(md).toContain("chart: https://trytako.com/card/c1");
    // Dataset renders as a markdown table with the true-total note.
    expect(md).toContain("| date | revenue |");
    expect(md).toContain("| 2026-06-30 | 27.1 |");
    expect(md).toContain("2 most recent of 40 rows");
  });

  it("renders web results Exa-style with title/url/meta/snippet", () => {
    const md = renderSearchMarkdown(searchOutput());
    expect(md).toContain("## Web Results (1)");
    expect(md).toContain("1. Title: Tesla Q2 earnings");
    expect(md).toContain("URL: https://example.com/tsla");
    expect(md).toContain("Example News · Published: 2026-07-20");
    expect(md).toContain("Revenue rose 6%");
  });

  it("surfaces values_hint on gated cards and marks them not exportable", () => {
    const gated = card({
      exportable: false,
      content: null,
      values_hint: "rows not exportable; for specific figures call tako_answer",
    });
    const md = renderSearchMarkdown(searchOutput({ cards: [gated] }));
    expect(md).toContain("exportable: no");
    expect(md).toContain("values_hint: rows not exportable");
  });

  it("renders the glossary as a trailing Source Notes section", () => {
    const md = renderSearchMarkdown(
      searchOutput({ sources_glossary: { "S Global": "A long source paragraph." } }),
    );
    const notesAt = md.indexOf("## Source Notes");
    expect(notesAt).toBeGreaterThan(-1);
    expect(md).toContain("**S Global**: A long source paragraph.");
    // Trailing: after the cards and web sections.
    expect(notesAt).toBeGreaterThan(md.indexOf("## Tako Data"));
    expect(notesAt).toBeGreaterThan(md.indexOf("## Web Results"));
  });

  it("leads with guidance on a zero-card response", () => {
    const md = renderSearchMarkdown(
      searchOutput({ cards: [], guidance: "This search returned web results but no data cards." }),
    );
    expect(md.startsWith("> This search returned web results")).toBe(true);
    expect(md).not.toContain("## Tako Data");
  });

  it("says so plainly when there are no cards and no guidance", () => {
    const md = renderSearchMarkdown(searchOutput({ cards: [], web_results: [] }));
    expect(md).toContain("No data cards matched.");
  });

  it("footers with request_id and cost", () => {
    const md = renderSearchMarkdown(searchOutput());
    expect(md).toContain("request_id: req-1");
    expect(md).toContain("cost: $0.007");
  });

  it("renders csv content as a fenced block and records as a table", () => {
    const csvCard = card({
      content: { content_format: "csv", data: "date,v\n2026-01-01,1", total_rows: 1 },
    });
    const mdCsv = renderSearchMarkdown(searchOutput({ cards: [csvCard] }));
    expect(mdCsv).toContain("```csv\ndate,v\n2026-01-01,1\n```");

    const recCard = card({
      content: {
        content_format: "json_records",
        records: [{ date: "2026-01-01", v: 1 }],
        total_rows: 1,
      } as TakoCard["content"],
    });
    const mdRec = renderSearchMarkdown(searchOutput({ cards: [recCard] }));
    expect(mdRec).toContain("| date | v |");
    expect(mdRec).toContain("| 2026-01-01 | 1 |");
  });

  it("escapes pipes in table cells so rows can't break the table", () => {
    const md = renderSearchMarkdown(
      searchOutput({
        cards: [
          card({
            content: {
              content_format: "json_records",
              records: [{ label: "a|b", v: 1 }],
            } as TakoCard["content"],
          }),
        ],
      }),
    );
    expect(md).toContain("a\\|b");
  });
});

describe("renderAnswerMarkdown", () => {
  const answerOutput = (over: Partial<AnswerFullOutput> = {}): AnswerFullOutput => ({
    answer: "Tesla's Q2 2026 revenue was $27.1B.",
    cards: [card()],
    web_results: [],
    usage: { total_cost_usd: 0.009 },
    request_id: "req-a",
    ...over,
  });

  it("leads with the synthesized answer, then cited cards", () => {
    const md = renderAnswerMarkdown(answerOutput());
    expect(md.startsWith("Tesla's Q2 2026 revenue was $27.1B.")).toBe(true);
    expect(md).toContain("## Cited Data (1 card)");
    expect(md).toContain("### 1. Tesla Revenue");
  });

  it("renders the data-gap guidance as a blockquote after the answer", () => {
    const md = renderAnswerMarkdown(
      answerOutput({ cards: [], guidance: "Data-coverage note: ZERO curated data cards." }),
    );
    expect(md).toContain("> Data-coverage note: ZERO curated data cards.");
  });
});

describe("structuredContent slimmers", () => {
  it("slimSearchStructured keeps ONLY machine essentials + widget fields", () => {
    const out = slimSearchStructured({
      ...searchOutput({ guidance: "note" }),
      pub_id: "c1",
      embed_url: "https://trytako.com/embed/c1/",
      image_url: "https://trytako.com/img/c1.png",
      dark_mode: false,
      width: 800,
      height: 500,
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        "dark_mode",
        "embed_url",
        "guidance",
        "height",
        "image_url",
        "pub_id",
        "request_id",
        "usage",
        "width",
      ].sort(),
    );
    // The heavy channels must NOT ride along.
    expect(out).not.toHaveProperty("cards");
    expect(out).not.toHaveProperty("web_results");
    expect(out).not.toHaveProperty("sources_glossary");
  });

  it("slimAnswerStructured is request_id + usage (+ guidance when present)", () => {
    const base = {
      answer: "a",
      cards: [],
      web_results: [],
      usage: null,
      request_id: "req-a",
    };
    expect(Object.keys(slimAnswerStructured(base)).sort()).toEqual(["request_id", "usage"]);
    expect(
      Object.keys(slimAnswerStructured({ ...base, guidance: "g" })).sort(),
    ).toEqual(["guidance", "request_id", "usage"]);
  });
});

describe("renderAvailableDataMarkdown + slim", () => {
  const output = {
    found: true,
    query: "Tesla",
    summary: "Tako's proprietary data has live coverage of 1 match for \"Tesla\":",
    matches: [
      {
        node_id: "ent_tsla",
        name: "Tesla, Inc.",
        type: "entity",
        coverage: {
          kind: "metrics",
          names: ["Revenue", "Gross Margin"],
          total: 187,
          truncated: true,
          capped: false,
        },
      },
    ],
    other_matches: [],
    next_call: { tool: "tako_search" as const, query: "Tesla, Inc. Revenue", node_ids: ["ent_tsla"] },
  };

  it("renders summary, coverage names with node id, truncation note, and next_call fence", () => {
    const md = renderAvailableDataMarkdown(output);
    expect(md.startsWith("Tako's proprietary data")).toBe(true);
    expect(md).toContain("**Tesla, Inc.** (`ent_tsla`) — metrics (187 total):");
    expect(md).toContain("Revenue, Gross Margin");
    expect(md).toContain("…and 185 more server-side");
    expect(md).toContain('```json\n{"tool":"tako_search"');
  });

  it("slims structuredContent to found/query/next_call", () => {
    expect(Object.keys(slimAvailableDataStructured(output)).sort()).toEqual([
      "found",
      "next_call",
      "query",
    ]);
  });
});

describe("renderAgentRunMarkdown + slim", () => {
  const completed = {
    run_id: "run-1",
    thread_id: "th-1",
    status: "completed",
    timed_out: false,
    result: {
      answer: "The cohort is A, B, and C. [1]",
      cards: [{ title: "Cohort chart", embed_url: "https://trytako.com/embed/x/" }],
      citations: [
        { index: 1, title: "Source doc", url: "https://example.com/doc", source_name: "Example", publish_date: "2026-07-01" },
      ],
      metadata: {
        definitions: [{ term: "cohort", definition: "companies matching the criteria" }],
        assumptions: null,
        methodology: null,
      },
    },
  };

  it("renders answer, indexed citations, charts, definitions, and the run footer", () => {
    const md = renderAgentRunMarkdown(completed);
    expect(md.startsWith("The cohort is A, B, and C. [1]")).toBe(true);
    expect(md).toContain("[1] Source doc — https://example.com/doc (Example · 2026-07-01)");
    expect(md).toContain("- Cohort chart: https://trytako.com/embed/x/");
    expect(md).toContain("- cohort: companies matching the criteria");
    expect(md).toContain("run_id: run-1");
    expect(md).toContain("thread_id: th-1");
  });

  it("renders a poll-again line for a timed-out non-terminal run", () => {
    const md = renderAgentRunMarkdown({ run_id: "run-2", status: "running", timed_out: true });
    expect(md).toContain("still running");
    expect(md).toContain("Poll again");
  });

  it("renders the error for a failed run", () => {
    const md = renderAgentRunMarkdown({
      run_id: "run-3",
      status: "failed",
      timed_out: false,
      error: { code: "internal", message: "boom" },
    });
    expect(md).toContain("Agent run failed (internal): boom");
  });

  it("slims structuredContent to the lifecycle fields", () => {
    expect(Object.keys(slimAgentRunStructured(completed)).sort()).toEqual([
      "run_id",
      "status",
      "thread_id",
      "timed_out",
    ]);
  });
});

describe("renderContentsText + slim", () => {
  it("web text: note leads, page text rides RAW (no JSON escaping), metadata footers", () => {
    const md = renderContentsText({
      note: "2 match(es) for the phrase \"RevPAR\"",
      data: "line one\nline two",
      truncated: true,
      cost: 0.001,
    });
    expect(md.startsWith("> 2 match(es)")).toBe(true);
    expect(md).toContain("line one\nline two");
    expect(md).toContain("cost: $0.001");
    expect(md).toContain("truncated");
  });

  it("card csv rides in a fence with total_rows in the footer", () => {
    const md = renderContentsText({
      format: "csv",
      data: "date,v\n2026-01-01,1",
      total_rows: 1500,
      cost: 0.001,
    });
    expect(md).toContain("```csv\ndate,v\n2026-01-01,1\n```");
    expect(md).toContain("total_rows: 1500");
  });

  it("url mode renders the download link + expiry", () => {
    const md = renderContentsText({
      download_url: "https://signed/csv",
      expires_at: "2026-07-29T00:00:00Z",
      cost: 0,
    });
    expect(md).toContain("Download: https://signed/csv (expires 2026-07-29T00:00:00Z)");
  });

  it("slims structuredContent to metadata only (payload channels dropped)", () => {
    const slim = slimContentsStructured({
      note: "n",
      data: "big page text",
      format: "csv",
      total_rows: 3,
      cost: 0.5,
    });
    expect(slim).toEqual({ format: "csv", total_rows: 3, cost: 0.5 });
  });
});
