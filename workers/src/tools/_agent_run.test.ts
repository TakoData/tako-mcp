/**
 * The projection's conformance guard (spec, "Pilot PR boundary" §1): the
 * projected object must be exactly what the advertised `outputSchema`
 * declares — no undeclared key, because `registerTool` publishes the shape
 * strict (`additionalProperties: false`) and a spec-compliant client rejects
 * the WHOLE result, text block included, on a call already billed.
 *
 * The drop assertions are the other half. A `looseObject` accepts the keys the
 * projection forgets to drop, and `pickDeclared` only strips at the ROOT — a
 * `methodologies` blob left on a card would ride all the way to the model.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentRunOutputShape,
  noteMap,
  projectAgentCard,
  projectAgentRun,
  projectCitation,
  refusalGuidance,
} from "./_agent_run.js";
import { pickDeclared } from "./_pick_declared.js";

/** A run shaped like the wire, carrying every field the projection drops. */
const wireRun = {
  run_id: "8f1c0b2a-6d4e-4f7a-9c31-5b8e2a7d4f60",
  object: "agent.run",
  thread_id: "cde6ed80-ab7d-464b-baa9-793fcb418a62",
  status: "completed",
  created_at: "2026-08-30T22:48:10.751475+00:00",
  completed_at: "2026-08-30T22:50:31.204118+00:00",
  timed_out: false,
  usage: { total_cost_usd: 0.09314, compute: { cost_usd: 0.09314 } },
  error: null,
  result: {
    answer: "Surf Air Mobility grew fastest, at 73.9% CAGR. [1]",
    cards: [
      {
        card_id: "CpQeOBcKjz8VM8-wNlEV",
        title: "Fastest US Airline Revenue Growth",
        description: "Three-year revenue CAGR, top 10 of 21 screened.",
        semantic_description: null,
        webpage_url: "https://tako.com/card/CpQeOBcKjz8VM8-wNlEV/",
        image_url: "https://tako.com/api/v1/image/CpQeOBcKjz8VM8-wNlEV/",
        embed_url: "https://tako.com/embed/CpQeOBcKjz8VM8-wNlEV/",
        card_type: "bar",
        exportable: true,
        relevance: null,
        relevance_score: null,
        nodes: null,
        source_indexes: ["data"],
        sources: [
          {
            source_name: "S&P Global",
            source_index: "data",
            source_description: "A financial data and analytics company.",
          },
        ],
        methodologies: [
          { methodology_name: "Data Transformation", methodology_description: "out = df.copy()" },
        ],
        metric_definitions: [
          { name: "Revenues (Normalized)", definition: "Excel Formula: IQ_REV Revenues [112] …" },
        ],
        content: {
          content_format: null,
          cost: 0.001,
          data: null,
          total_rows: 10,
          truncated: false,
          export_pricing: { baseline_usd: 0.001, row_cpm_usd: 0.01 },
        },
        data_freshness: { coverage_end: "2025-12", data_as_of: "2026-03-31", last_updated: "2026-08-26" },
      },
    ],
    citations: [
      {
        index: 1,
        title: "S&P Global",
        url: "https://www.spglobal.com/",
        source_name: null,
        source_index: "data",
        excerpt: null,
        publish_date: null,
        content: null,
      },
    ],
    metadata: {
      definitions: [{ term: "Revenue CAGR", definition: "The constant annual rate.", source_ref: 1 }],
      assumptions: [{ title: "Window", description: "2022 to 2025.", category: "temporal" }],
      methodology: [{ title: "Ranking method", description: "By CAGR, not dollar growth." }],
    },
    refusal_code: null,
    request_id: "req_fixture",
  },
};

describe("projectAgentRun conformance", () => {
  const output = projectAgentRun(wireRun);

  it("conforms to the advertised outputSchema", () => {
    const parsed = agentRunOutputShape.safeParse(output);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("declares every key it emits, so a strict client keeps the whole result", () => {
    const narrowed = pickDeclared(agentRunOutputShape, output as unknown as Record<string, unknown>);
    expect(Object.keys(narrowed).sort()).toEqual(Object.keys(output).sort());
  });

  it("publishes the schema strict, so an undeclared root key would void the result", () => {
    // Mirrors what `registerTool` publishes: the SDK rebuilds our looseObject
    // as a strict z.object, which is why the projection — not the schema's
    // looseness — is the gate.
    const strict = z.object(agentRunOutputShape.shape).strict();
    expect(strict.safeParse({ ...output, run_id: "leaked" }).success).toBe(false);
  });

  it("drops the correlation ids, the lifecycle fields and the request_id", () => {
    for (const key of ["run_id", "object", "status", "timed_out", "created_at", "completed_at", "request_id"]) {
      expect(output, `${key} reached the model`).not.toHaveProperty(key);
    }
  });
});

describe("projectAgentCard", () => {
  const card = projectAgentCard(wireRun.result.cards[0]);

  it("keeps the nine fields with a reader and nothing else", () => {
    expect(Object.keys(card ?? {}).sort()).toEqual([
      "description",
      "embed_url",
      "exportable",
      "image_url",
      "last_updated",
      "source",
      "title",
      "total_rows",
      "url",
    ]);
  });

  it("drops the build record and the upstream reference dumps", () => {
    // Measured on staging: 3,232 and 2,070 chars on one card, 81% of that
    // run's card payload. `metadata.methodology` / `.definitions` cover the
    // same ground in prose the agent wrote for a reader.
    for (const key of ["methodologies", "metric_definitions", "content", "card_id", "card_type", "semantic_description", "source_indexes", "nodes", "relevance"]) {
      expect(card, `${key} reached the model`).not.toHaveProperty(key);
    }
  });

  it("lifts total_rows out of content and trims last_updated to a date", () => {
    expect(card?.total_rows).toBe(10);
    expect(card?.last_updated).toBe("2026-08-26");
  });

  it("reports no row count for a locked card rather than a fabricated zero", () => {
    const locked = projectAgentCard({ title: "Locked", exportable: false, content: null });
    expect(locked?.exportable).toBe(false);
    expect(locked).not.toHaveProperty("total_rows");
  });

  it("drops the count on a locked card that still carries one", () => {
    // The channel-equivalence case the `content: null` test above cannot see:
    // the text channel prints a count only in the exportable arm, so an
    // ungated count would reach structuredContent and nowhere else. The
    // backend's export gate makes this unreachable today; the guard is what
    // keeps it that way.
    const locked = projectAgentCard({
      title: "Locked",
      exportable: false,
      content: { total_rows: 42 },
    });
    expect(locked?.exportable).toBe(false);
    expect(locked).not.toHaveProperty("total_rows");
  });

  it("reads exportable off content when the backend omits the flag", () => {
    expect(projectAgentCard({ content: { total_rows: 3 } })?.exportable).toBe(true);
    expect(projectAgentCard({ content: null })?.exportable).toBe(false);
  });
});

describe("projectCitation", () => {
  it("keeps the join key, title, url and corpus, and drops the always-null fields", () => {
    // The generated contract: the Answer Agent "populates source_index and
    // leaves the rest null".
    expect(projectCitation(wireRun.result.citations[0])).toEqual({
      index: 1,
      title: "S&P Global",
      url: "https://www.spglobal.com/",
      source_index: "data",
    });
  });

  it("preserves sparse indices, because the answer's [n] markers join to them", () => {
    const out = projectAgentRun({
      result: { citations: [{ index: 1, title: "a" }, { index: 12, title: "b" }] },
    });
    expect(out.citations.map((c) => c.index)).toEqual([1, 12]);
  });

  it("drops an entry with no index or no title — the marker could not join", () => {
    expect(projectCitation({ title: "no index" })).toBeUndefined();
    expect(projectCitation({ index: 2 })).toBeUndefined();
  });

  it("ignores a source_index outside the two known corpora", () => {
    expect(projectCitation({ index: 1, title: "a", source_index: "tako" })).not.toHaveProperty(
      "source_index",
    );
  });
});

describe("noteMap", () => {
  it("flattens a metadata list to {name: text}, dropping category and source_ref", () => {
    expect(noteMap(wireRun.result.metadata.definitions, "term", "definition")).toEqual({
      "Revenue CAGR": "The constant annual rate.",
    });
  });

  it("keeps both texts when one name carries two, rather than dropping prose", () => {
    expect(
      noteMap(
        [
          { term: "Revenue", definition: "first" },
          { term: "Revenue", definition: "second" },
        ],
        "term",
        "definition",
      ),
    ).toEqual({ Revenue: "first", "Revenue (2)": "second" });
  });

  it("omits an empty or absent list so the key never ships as {}", () => {
    expect(noteMap([], "term", "definition")).toBeUndefined();
    expect(noteMap(undefined, "term", "definition")).toBeUndefined();
    expect(noteMap([{ term: "x" }], "term", "definition")).toBeUndefined();
  });
});

describe("refusal", () => {
  it("turns refusal_code into the one guidance branch, with no answer", () => {
    const out = projectAgentRun({
      result: { answer: null, cards: [], citations: [], refusal_code: "rejected_input_classifier" },
    });
    expect(out.guidance).toBe(refusalGuidance("rejected_input_classifier"));
    expect(out.answer).toBeUndefined();
  });

  it("keeps guidance to two sentences: the verdict and one action", () => {
    const sentences = refusalGuidance("x").split(". ").filter((s) => s.trim() !== "");
    expect(sentences).toHaveLength(2);
  });

  it("emits no guidance on a normal run", () => {
    expect(projectAgentRun(wireRun).guidance).toBeUndefined();
  });
});

describe("failed run without an error", () => {
  it("synthesizes an error rather than reading as an empty answer", () => {
    // `status` is not projected, but it is the only field separating a failed
    // run from a legitimately prose-free one. Without this the renderer emits
    // "The agent returned no answer." for a run that actually failed.
    const out = projectAgentRun({ status: "failed", error: null, result: null });
    expect(out.error).toEqual({
      code: "agent_run_failed",
      message: "The agent run failed without a reason.",
    });
    expect(out.answer).toBeUndefined();
  });

  it("leaves the backend's own error untouched when it sends one", () => {
    const out = projectAgentRun({
      status: "failed",
      error: { code: "x", message: "boom" },
      result: null,
    });
    expect(out.error).toEqual({ code: "x", message: "boom" });
  });

  it("adds no error to a terminal run that simply carried no prose", () => {
    expect(projectAgentRun({ result: null }).error).toBeUndefined();
  });
});

describe("non-terminal run", () => {
  it("states the run did not finish, not that it returned nothing", () => {
    // `pollAgentRun`'s `onTimeout: "return"` arm returns `status: "running"`.
    // Without the guard this projects to no answer and no error, and the
    // renderer says "The agent returned no answer." about a live run.
    const out = projectAgentRun({ status: "running", result: null, error: null });
    expect(out.error).toEqual({
      code: "agent_run_incomplete",
      message: "The agent run ended while still running.",
    });
  });

  it("covers `queued`, which a `timed_out` check would miss", () => {
    expect(projectAgentRun({ status: "queued", result: null }).error?.code).toBe("agent_run_incomplete");
  });

  it("leaves a completed run that simply carried no prose alone", () => {
    expect(projectAgentRun({ status: "completed", result: null }).error).toBeUndefined();
  });
});

describe("usage", () => {
  it("carries the headline cost, which the tool used to drop entirely", () => {
    expect(projectAgentRun(wireRun).usage?.total_cost_usd).toBe(0.09314);
  });

  it("is null, not absent, on an unmetered run", () => {
    expect(projectAgentRun({ result: { answer: "a" } }).usage).toBeNull();
  });
});
