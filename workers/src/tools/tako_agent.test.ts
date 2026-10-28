import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../django.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../django.js")>();
  return { ...actual, djangoPost: vi.fn(), djangoGet: vi.fn() };
});
import { djangoPost, djangoGet } from "../django.js";
import type { Env } from "../env.js";
import { createMcpServer } from "../mcp.js";
import tool, { buildAgentBody, describeAnswerAgent } from "./tako_agent.js";
import { applyInputPins, inputSchemaForConnection } from "./_input_pins.js";
import { refusalGuidance } from "./_agent_run.js";
import { AnswerAgentRunRequest } from "../generated/schemas.js";
import { AGENT_CALL_WINDOW_MS } from "./_agent_wait.js";
import { AGENT_CARD_LINK_SENTENCE } from "./_agent_call.js";
import { inputPropertyDescription } from "./__test_helpers.js";
import type { ToolContext } from "./types.js";

const encoder = new TextEncoder();
const RUN = "run_1";

const ctx: ToolContext = {
  token: "t",
  env: { DJANGO_BASE_URL: "https://trytako.com" } as Env,
  surface: "generic",
  caller: undefined,
  sendProgress: vi.fn(async () => {}),
};

function frame(block: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ seq: 1, run_id: RUN, thread_id: "t1", category: "x", block })}\n\n`;
}

function stubStream(frames: string[], keepOpen = false): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const text of frames) controller.enqueue(encoder.encode(text));
            if (!keepOpen) controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function completedFrames(result: Record<string, unknown>): string[] {
  return [
    frame({ kind: "agent_result", id: "a1", data: result }),
    frame({ kind: "run_summary", status: "completed", created_at: "2026-10-22T00:00:00Z", error: null, usage: null }),
  ];
}

async function runToCompletion(
  result: Record<string, unknown>,
  input: { query: string; sources: Array<"data" | "web"> } = { query: "q", sources: ["data"] },
) {
  vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
  stubStream(completedFrames(result));
  return tool.handler(input, ctx);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("tako_agent", () => {
  it("the description tells the model to link each card's url", () => {
    expect(tool.description).toContain(AGENT_CARD_LINK_SENTENCE);
  });

  it("the description starts a run only on an explicit ask and sends other questions to tako_search", () => {
    expect(tool.description).toContain("Start a run only when the user asks for one: they name Tako's agent or ask for deep or multi-step research with Tako.");
    expect(tool.description).toContain("Otherwise, use `tako_search`.");
    expect(tool.description).toContain("not a list of companies or people");
    expect(tool.description).not.toContain("fallback");
  });

  it("starts a run and returns the finished answer with a prefixed run_id", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    stubStream(
      completedFrames({
        answer: "42",
        cards: [
          {
            card_id: "agentcard",
            title: "Agent card",
            embed_url: "https://trytako.com/embed/agentcard/",
          },
        ],
        citations: [{ index: 1, title: "Source", url: "https://example.com" }],
      }),
    );

    const out = await tool.handler({ query: "analyze X", sources: ["data", "web"] }, ctx);

    expect(tool.name).toBe("tako_agent");
    expect(vi.mocked(djangoPost).mock.calls[0]![2]).toBe("/api/v1/agent/answer/runs");
    expect(vi.mocked(djangoPost).mock.calls[0]![3]).toEqual({
      query: "analyze X",
      source_indexes: ["data", "web"],
    });
    expect(out.status).toBe("completed");
    expect(out.run_id).toBe("answer_run_run_1");
    expect(out.answer).toBe("42");
    expect(out.cards[0]?.embed_url).toBe("https://trytako.com/embed/agentcard/?showShare=true");
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.index).toBe(1);
  });

  it("returns running with the resume message when the run outlives the window", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    vi.mocked(djangoGet).mockResolvedValue({ run_id: RUN, status: "running" });
    stubStream([frame({ kind: "status", message: "Searching the web" })], true);

    const pending = tool.handler({ query: "slow", sources: ["data"] }, ctx);
    await vi.advanceTimersByTimeAsync(AGENT_CALL_WINDOW_MS + 1_000);
    const out = await pending;

    expect(out.status).toBe("running");
    expect(out.run_id).toBe("answer_run_run_1");
    expect(out.thread_id).toBeUndefined();
    expect(out.message).toContain("answer_run_run_1");
    expect(out.answer).toBeUndefined();
  });

  it("resumes a run by run_id without starting a new one", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "x",
      status: "completed",
      result: { answer: "done", cards: [], citations: [] },
    });

    const out = await tool.handler({ run_id: "answer_run_x", sources: ["data", "web"] }, ctx);

    expect(djangoPost).not.toHaveBeenCalled();
    expect(vi.mocked(djangoGet).mock.calls[0]![2]).toBe("/api/v1/agent/answer/runs/x");
    expect(out.status).toBe("completed");
    expect(out.run_id).toBe("answer_run_x");
    expect(out.answer).toBe("done");
  });

  it("carries a chart for each card with a card_id, in run order", async () => {
    const out = await runToCompletion({
      answer: "a",
      cards: [{ card_id: "c1", title: "One" }, { title: "No id" }, { card_id: "c2", title: "Two" }],
      citations: [],
    });

    expect(out.charts?.map((c) => c.pub_id)).toEqual(["c1", "c2"]);
    expect(out.charts?.[0]?.embed_url).toBe("https://trytako.com/embed/c1/?dark_mode=auto&showShare=true");
  });

  it("carries charts when a resume finds the run already finished", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "x",
      status: "completed",
      result: { answer: "done", cards: [{ card_id: "c9" }], citations: [] },
    });

    const out = await tool.handler({ run_id: "answer_run_x", sources: ["data"] }, ctx);

    expect(out.charts?.map((c) => c.pub_id)).toEqual(["c9"]);
  });

  it("rejects a company run_id at input validation and names tako_company_agent", () => {
    const parsed = tool.inputSchema.safeParse({ run_id: "company_run_x" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join(" ")).toContain("tako_company_agent");
  });

  it("surfaces the Answer Agent metadata (definitions/assumptions/methodology) instead of dropping it", async () => {
    const out = await runToCompletion({
      answer: "a",
      cards: [],
      citations: [],
      metadata: {
        definitions: [{ term: "GDP", definition: "gross domestic product" }],
        assumptions: [{ title: "nominal", description: "not inflation-adjusted" }],
        methodology: [{ title: "sources", description: "world bank" }],
      },
    });

    expect(out.definitions).toEqual({ GDP: "gross domestic product" });
    expect(out.assumptions).toEqual({ nominal: "not inflation-adjusted" });
    expect(out.methodology).toEqual({ sources: "world bank" });
  });

  it("carries refusal_code through the wire parse into the one guidance branch", async () => {
    const out = await runToCompletion({
      answer: null,
      cards: [],
      citations: [],
      refusal_code: "rejected_input_classifier",
    });

    expect(out.guidance).toBe(refusalGuidance("rejected_input_classifier"));
    expect(out.answer).toBeUndefined();
  });

  it("surfaces a failed run with its error", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    stubStream([
      frame({
        kind: "run_summary",
        status: "failed",
        created_at: "2026-10-22T00:00:00Z",
        error: { code: "x", message: "boom" },
        usage: null,
      }),
    ]);

    const out = await tool.handler({ query: "q", sources: ["data"] }, ctx);

    expect(out.status).toBe("failed");
    expect(out.error).toEqual({ code: "x", message: "boom" });
    expect(out.answer).toBeUndefined();
  });

  it("keeps a completed run when the usage payload is malformed", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    stubStream([
      frame({ kind: "agent_result", id: "a1", data: { answer: "kept", cards: [], citations: [] } }),
      frame({ kind: "run_summary", status: "completed", created_at: "2026-10-22T00:00:00Z", error: null, usage: { total_cost_usd: "nope" } }),
    ]);

    const out = await tool.handler({ query: "q", sources: ["data"] }, ctx);

    expect(out.answer).toBe("kept");
    expect(out.status).toBe("completed");
  });
});

describe("tako_agent over MCP", () => {
  async function callAgent(args: Record<string, unknown>, surface: "generic" | "chatgpt" = "generic") {
    const server = createMcpServer(
      { ...ctx, surface },
      surface === "chatgpt"
        ? { surface, clientRendersUi: true }
        : { surface, clientRendersUi: false, requestedToolNames: new Set(["tako_agent"]) },
    );
    const client = new Client(
      { name: "agent-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.callTool({ name: "tako_agent", arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    ["both query and run_id", { query: "q", run_id: "answer_run_x" }],
    ["neither query nor run_id", {}],
  ])("returns a tool error that says to send exactly one when a call has %s", async (_label, args) => {
    const result = await callAgent(args);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Send exactly one of `query` (start a run) or `run_id` (keep waiting for a run).",
    );
    expect(djangoPost).not.toHaveBeenCalled();
    expect(djangoGet).not.toHaveBeenCalled();
  });

  function realPngResponse(): Response {
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
  }

  function finishedRun(cards: Record<string, unknown>[]): void {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "x",
      status: "completed",
      result: { answer: "done", cards, citations: [] },
    });
  }

  it("chatgpt: ships every card as _meta.charts and keeps charts out of structuredContent", async () => {
    finishedRun([{ card_id: "c1" }, { card_id: "c2" }]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => realPngResponse()));

    const result = await callAgent({ run_id: "answer_run_x" }, "chatgpt");

    expect(result.structuredContent?.charts).toBeUndefined();
    const charts = result._meta?.charts as { pub_id: string; image_natural_width?: number }[];
    expect(charts.map((c) => c.pub_id)).toEqual(["c1", "c2"]);
    expect(charts[0]?.image_natural_width).toBe(1);
    expect(charts[1]?.image_natural_width).toBeUndefined();
  });

  it("chatgpt: sends an empty chart list when no card has a card_id", async () => {
    finishedRun([{ title: "No id" }]);

    const result = await callAgent({ run_id: "answer_run_x" }, "chatgpt");

    expect(result._meta?.charts).toEqual([]);
  });

  it("chatgpt: keeps the chart list when the PNG read fails", async () => {
    finishedRun([{ card_id: "c1" }, { card_id: "c2" }]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Promise.reject(new Error("offline"))));

    const result = await callAgent({ run_id: "answer_run_x" }, "chatgpt");

    expect((result._meta?.charts as { pub_id: string }[]).map((c) => c.pub_id)).toEqual(["c1", "c2"]);
  });
});

describe("tako_agent extraMeta on generic", () => {
  const liveCtx = {
    ...ctx,
    env: { DJANGO_BASE_URL: "https://trytako.com", PUBLIC_CDN_URL: "https://cdn.trytako.com" } as Env,
    origin: "https://mcp.tako.com",
  } as ToolContext;
  const finished = (cards: Record<string, unknown>[]) => ({
    ...cardsOutput(cards),
  });
  function cardsOutput(cards: Record<string, unknown>[]) {
    return {
      status: "completed",
      charts: cards.map((c) => ({
        pub_id: c.card_id,
        embed_url: `e/${String(c.card_id)}`,
        image_url: `i/${String(c.card_id)}`,
      })),
    };
  }

  it("returns two live-card charts and fetches nothing", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const meta = await tool.extraMeta!(finished([{ card_id: "c1" }, { card_id: "c2" }]) as never, liveCtx);
    expect(Object.keys(meta ?? {})).toEqual(["charts"]);
    const entries = (meta as { charts: Record<string, unknown>[] }).charts;
    expect(entries.map((c) => c.pub_id)).toEqual(["c1", "c2"]);
    for (const entry of entries) {
      expect(entry.native_card_url).toEqual(expect.stringContaining(String(entry.pub_id)));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for a running run", async () => {
    const meta = await tool.extraMeta!({ status: "running", run_id: "answer_run_x" } as never, liveCtx);
    expect(meta).toBeUndefined();
  });
});

describe("tako_agent input schema", () => {
  it("leaves sources unset when the caller omits them", () => {
    const parsed = tool.inputSchema.parse({ query: "hello" });
    expect(parsed.sources).toBeUndefined();
  });

  it("accepts web and data", () => {
    expect(tool.inputSchema.parse({ query: "q", sources: ["web"] }).sources).toEqual(["web"]);
    expect(tool.inputSchema.parse({ query: "q", sources: ["data", "web"] }).sources).toEqual([
      "data",
      "web",
    ]);
  });

  it("the sources description keeps both corpora unless the user asks for one", () => {
    const sources = inputPropertyDescription(tool.inputSchema, "sources");
    expect(sources).toContain("`data` is Tako's data graph, curated from authoritative data sources; `web` is the open web.");
    expect(sources).toContain("Keep both unless the user asks for one.");
  });

  it('rejects the retired "tako" source alias', () => {
    expect(tool.inputSchema.safeParse({ query: "q", sources: ["tako"] }).success).toBe(false);
  });

  it("rejects an empty sources array", () => {
    expect(() => tool.inputSchema.parse({ query: "q", sources: [] })).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => tool.inputSchema.parse({ query: "q", sources: ["bing"] })).toThrow();
  });
});

describe("tako_agent contract guards", () => {
  it("omits source_indexes and effort on a follow-up, so it keeps the thread's pins", () => {
    const body = buildAgentBody(
      tool.inputSchema.parse({ query: "and in 2024?", thread_id: "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }),
    );
    expect(body).not.toHaveProperty("source_indexes");
    expect(body).not.toHaveProperty("effort");
    expect(body.thread_id).toBe("6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f");
  });

  it("passes the sources array straight through to source_indexes", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x", sources: ["data"] }));
    expect(body.source_indexes).toEqual(["data"]);
  });

  it("reshapes into a contract-valid answer-agent request", () => {
    const body = buildAgentBody(tool.inputSchema.parse({ query: "x" }));
    expect(() => AnswerAgentRunRequest.parse(body)).not.toThrow();
  });
});


describe("tako_agent on a connection that pins sources", () => {
  it("describes the pinned sources", () => {
    expect(describeAnswerAgent(["data"])).toContain("queries the data graph over several steps");
    expect(describeAnswerAgent(["web"])).toContain("queries the web over several steps");
    expect(describeAnswerAgent(["data", "web"])).toBe(tool.description);
  });

  it("sends the pinned sources on a thread follow-up", () => {
    const pins = { sources: ["data"] as const };
    const parsed = inputSchemaForConnection(tool, "generic", pins).parse({
      query: "and in 2024?",
      thread_id: "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    });
    const input = applyInputPins(tool, pins, parsed) as Parameters<typeof buildAgentBody>[0];
    expect(buildAgentBody(input).source_indexes).toEqual(["data"]);
  });
});
