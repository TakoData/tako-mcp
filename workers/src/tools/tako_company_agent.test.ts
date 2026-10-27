import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../django.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../django.js")>();
  return { ...actual, djangoPost: vi.fn(), djangoGet: vi.fn() };
});
import { djangoPost, djangoGet } from "../django.js";
import type { Env } from "../env.js";
import { createMcpServer } from "../mcp.js";
import { parseToolsParam } from "./_tools_param.js";
import { CHATGPT_TOOL_NAMES, GENERIC_DEFAULT_TOOL_NAMES, resolveToolSet } from "./_surface.js";
import { TOOL_REGISTRY } from "./_registry.js";
import tool, { buildCompanyAgentBody } from "./tako_company_agent.js";
import type { ToolContext } from "./types.js";
import { AGENT_CARD_LINK_SENTENCE } from "./_agent_call.js";

const encoder = new TextEncoder();
const RUN = "run_1";

const ctx: ToolContext = {
  token: "t",
  env: { DJANGO_BASE_URL: "https://trytako.com" } as Env,
  surface: "generic",
  caller: undefined,
  sendProgress: vi.fn(async () => {}),
};

function completedStream(
  result: Record<string, unknown> = { answer: "Acme Corp matches [1].", cards: [], citations: [] },
): void {
  const frames = [
    { kind: "agent_result", id: "a1", data: result },
    { kind: "run_summary", status: "completed", created_at: "2026-10-22T00:00:00Z", error: null, usage: null },
  ].map(
    (block) =>
      `data: ${JSON.stringify({ seq: 1, run_id: RUN, thread_id: "t1", category: "x", block })}\n\n`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const text of frames) controller.enqueue(encoder.encode(text));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("tako_company_agent", () => {
  it("the description tells the model to link each card's url", () => {
    expect(tool.description).toContain(AGENT_CARD_LINK_SENTENCE);
  });

  it("the description starts a run only on an explicit ask and sends other questions to tako_search", () => {
    expect(tool.description).toContain("Start a run only when the user asks for one: they name Tako's agent or ask for deep or multi-step research with Tako.");
    expect(tool.description).toContain("Otherwise, use `tako_search`, even for a list that search can't fully filter.");
    expect(tool.description).toContain("an ask for Tako's agent to build a list of companies or of their professionals");
  });

  it("the sources description keeps both corpora unless the user asks for one", () => {
    const sources = (z.toJSONSchema(tool.inputSchema, { io: "input" }) as { properties: Record<string, { description?: string }> }).properties.sources?.description;
    expect(sources).toContain("`data` is Tako's data graph, curated from authoritative data sources; `web` is the open web.");
    expect(sources).toContain("Keep both unless the user asks for one.");
  });

  it("posts to the company runs path with cards true and no effort when omitted", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    completedStream();

    await tool.handler({ query: "UK companies dissolved in 2024" }, ctx);

    expect(tool.name).toBe("tako_company_agent");
    expect(vi.mocked(djangoPost).mock.calls[0]![2]).toBe("/api/v1/agent/company/runs");
    const body = vi.mocked(djangoPost).mock.calls[0]![3] as Record<string, unknown>;
    expect(body).toEqual({ query: "UK companies dissolved in 2024", cards: true });
  });

  it("carries a chart for each card with a card_id, in run order", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    completedStream({
      answer: "a",
      cards: [{ card_id: "c1", title: "One" }, { title: "No id" }, { card_id: "c2", title: "Two" }],
      citations: [],
    });

    const out = await tool.handler({ query: "q" }, ctx);

    expect(out.charts?.map((c) => c.pub_id)).toEqual(["c1", "c2"]);
    expect(out.charts?.[0]?.embed_url).toBe("https://trytako.com/embed/c1/?dark_mode=auto&showShare=true");
  });

  it("sends effort and source_indexes only when the caller set them", () => {
    const threadId = "cde6ed80-ab7d-464b-baa9-793fcb418a62";
    const body = buildCompanyAgentBody(
      tool.inputSchema.parse({
        query: "q",
        thread_id: threadId,
        effort: "high",
        sources: ["web"],
      }),
    );

    expect(body).toEqual({
      query: "q",
      cards: true,
      thread_id: threadId,
      effort: "high",
      source_indexes: ["web"],
    });
    expect(Object.keys(buildCompanyAgentBody(tool.inputSchema.parse({ query: "q" })))).toEqual([
      "query",
      "cards",
    ]);
  });

  it("returns a company_run_ run_id", async () => {
    vi.mocked(djangoPost).mockResolvedValue({ run_id: RUN, thread_id: "t1" });
    completedStream();

    const out = await tool.handler({ query: "q" }, ctx);

    expect(out.status).toBe("completed");
    expect(out.run_id).toBe("company_run_run_1");
    expect(out.answer).toBe("Acme Corp matches [1].");
  });

  it("resumes a company run by run_id on the company path", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "x",
      status: "completed",
      result: { answer: "done", cards: [], citations: [] },
    });

    const out = await tool.handler({ run_id: "company_run_x" }, ctx);

    expect(djangoPost).not.toHaveBeenCalled();
    expect(vi.mocked(djangoGet).mock.calls[0]![2]).toBe("/api/v1/agent/company/runs/x");
    expect(out.run_id).toBe("company_run_x");
  });

  it("rejects an answer_run_ run_id and names tako_agent", () => {
    const parsed = tool.inputSchema.safeParse({ run_id: "answer_run_x" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join(" ")).toContain("tako_agent");
  });

  it("is opt-in on generic, where ?tools= must name company_agent, and always listed on chatgpt", () => {
    const known = new Set(TOOL_REGISTRY.map((t) => t.name));
    const requested = parseToolsParam("company_agent", known);

    expect(requested).toEqual(new Set(["tako_company_agent"]));
    expect(resolveToolSet("generic", requested).has("tako_company_agent")).toBe(true);
    expect(resolveToolSet("generic", null).has("tako_company_agent")).toBe(false);
    expect(GENERIC_DEFAULT_TOOL_NAMES.has("tako_company_agent")).toBe(false);
    expect(resolveToolSet("chatgpt", requested)).toBe(CHATGPT_TOOL_NAMES);
    expect(CHATGPT_TOOL_NAMES.has("tako_company_agent")).toBe(true);
  });
});

describe("tako_company_agent over MCP", () => {
  it("chatgpt: ships every card as _meta.charts and keeps charts out of structuredContent", async () => {
    vi.mocked(djangoGet).mockResolvedValue({
      run_id: "x",
      status: "completed",
      result: { answer: "done", cards: [{ card_id: "c1" }, { card_id: "c2" }], citations: [] },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Promise.reject(new Error("offline"))));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createMcpServer({ ...ctx, surface: "chatgpt" }, { surface: "chatgpt", clientRendersUi: true });
    const client = new Client(
      { name: "company-agent-test", version: "0.0.0" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "tako_company_agent", arguments: { run_id: "company_run_x" } });

      expect(result.structuredContent).not.toHaveProperty("charts");
      expect(result._meta).toMatchObject({ charts: [{ pub_id: "c1" }, { pub_id: "c2" }] });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
