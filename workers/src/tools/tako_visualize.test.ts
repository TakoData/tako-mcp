/**
 * Tests for the `tako_visualize` tool.
 *
 * The handler is a single POST + re-parse: it maps the tool input onto the
 * backend's `/api/v1/thin_viz/create/` body, then lifts the returned
 * `card_id` into the shared chart-widget fields (pub_id/embed_url/image_url)
 * so the created card renders inline like a search result.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import type { ToolContext } from "./types.js";
import takoVisualize from "./tako_visualize.js";
import {
  bodyOf,
  jsonResponse,
  mockFetchSequence,
  noopSendProgress,
  requestFrom,
} from "./__test_helpers.js";

const ENV: Env = { DJANGO_BASE_URL: "https://staging.trytako.com" };
const CTX: ToolContext = {
  token: "sk-test",
  env: ENV,
  sendProgress: noopSendProgress,
  client: "claude",
};

const CARD_RESPONSE = {
  card_id: "card_abc123",
  title: "Monthly Revenue",
  description: "Revenue by month",
  webpage_url: "https://staging.trytako.com/charts/card_abc123",
  embed_url: "https://staging.trytako.com/embed/card_abc123/",
  image_url: "https://staging.trytako.com/api/v1/image/card_abc123/",
  embed_mode: "post",
};

const VALID_INPUT = {
  title: "Monthly Revenue",
  components: [
    { component_type: "header" as const, config: { title: "Monthly Revenue" } },
    {
      component_type: "categorical_bar" as const,
      config: {
        datasets: [
          { label: "Sales", units: "USD", data: [{ x: "NA", y: 500 }, { x: "EU", y: 300 }] },
        ],
      },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tako_visualize handler", () => {
  it("tool name is tako_visualize", () => {
    expect(takoVisualize.name).toBe("tako_visualize");
  });

  it("is a write tool that creates a public card (annotations)", () => {
    expect(takoVisualize.annotations.readOnlyHint).toBe(false);
    expect(takoVisualize.annotations.openWorldHint).toBe(false);
  });

  it("POSTs components + title to /api/v1/thin_viz/create/ and lifts card_id into widget fields", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, CARD_RESPONSE)]);

    const out = await takoVisualize.handler(VALID_INPUT, CTX);

    const req = requestFrom(fetchMock.mock.calls[0]);
    expect(req.url).toBe("https://staging.trytako.com/api/v1/thin_viz/create/");
    const body = await bodyOf(req);
    expect(body.title).toBe("Monthly Revenue");
    expect(Array.isArray(body.components)).toBe(true);
    expect((body.components as unknown[]).length).toBe(2);

    // card fields surfaced
    expect(out.card_id).toBe("card_abc123");
    expect(out.webpage_url).toBe("https://staging.trytako.com/charts/card_abc123");
    // widget fields lifted for inline render
    expect(out.pub_id).toBe("card_abc123");
    expect(out.embed_url).toMatch(/^https?:\/\//);
    expect(out.image_url).toMatch(/^https?:\/\//);
    expect(out.dark_mode).toBe(true);
  });

  it("omits undefined optional top-level fields from the POST body", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, CARD_RESPONSE)]);

    await takoVisualize.handler(
      { components: [{ component_type: "header" as const, config: { title: "X" } }] },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect("title" in body).toBe(false);
    expect("description" in body).toBe(false);
    expect("source" in body).toBe(false);
    expect("height" in body).toBe(false);
    expect("normalize_currencies" in body).toBe(false);
    // excluded-by-design fields never appear
    expect("postmessage_embed" in body).toBe(false);
    expect("image_ttl_minutes" in body).toBe(false);
  });

  it("forwards source, height, and normalize_currencies when provided", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(200, CARD_RESPONSE)]);

    await takoVisualize.handler(
      {
        components: [{ component_type: "header" as const, config: { title: "X" } }],
        source: "Internal Analytics",
        height: 600,
        normalize_currencies: "USD",
      },
      CTX,
    );

    const body = await bodyOf(requestFrom(fetchMock.mock.calls[0]));
    expect(body.source).toBe("Internal Analytics");
    expect(body.height).toBe(600);
    expect(body.normalize_currencies).toBe("USD");
  });

  it("throws an actionable error when the backend returns no card_id", async () => {
    mockFetchSequence([jsonResponse(200, { title: "X" })]);

    await expect(takoVisualize.handler(VALID_INPUT, CTX)).rejects.toThrow(/card_id/);
  });

  it("reflects requested height in output (widget render size)", async () => {
    // height: 600 → out.height === 600
    mockFetchSequence([jsonResponse(200, CARD_RESPONSE)]);
    const outWithHeight = await takoVisualize.handler({ ...VALID_INPUT, height: 600 }, CTX);
    expect(outWithHeight.height).toBe(600);

    // height omitted → out.height === DEFAULT_HEIGHT (720)
    mockFetchSequence([jsonResponse(200, CARD_RESPONSE)]);
    const outNoHeight = await takoVisualize.handler(VALID_INPUT, CTX);
    expect(outNoHeight.height).toBe(720);
  });
});

describe("tako_visualize input schema", () => {
  it("requires at least one component", () => {
    expect(() => takoVisualize.inputSchema.parse({ components: [] })).toThrow();
  });

  it("rejects an unknown component_type", () => {
    expect(() =>
      takoVisualize.inputSchema.parse({
        components: [{ component_type: "pie_chart", config: {} }],
      }),
    ).toThrow();
  });

  it("accepts a valid component with a freeform config object", () => {
    const parsed = takoVisualize.inputSchema.parse({
      components: [{ component_type: "scatter", config: { anything: [1, 2, 3], nested: { a: 1 } } }],
    });
    expect(parsed.components[0]?.component_type).toBe("scatter");
  });
});
