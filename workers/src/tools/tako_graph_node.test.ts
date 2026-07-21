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

  it("maps a 404 into a message that echoes the id and explains where ids come from", async () => {
    mockFetchSequence([jsonResponse(404, { detail: "not found" })]);
    await expect(
      takoGraphNode.handler({ id: "not-a-real-id" }, CTX),
    ).rejects.toThrow(/no graph node with id "not-a-real-id" \(404\)/);
  });
});
