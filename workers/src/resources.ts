/**
 * Static documentation resources exposed over `resources/list`.
 *
 * The server has always advertised the `resources` capability, and until these
 * existed `resources/list` answered `[]` on every connection that did not
 * register the chart widget — an anonymous client asked what the server offers
 * and was told "nothing". Capability-probing clients (Smithery's scan, MCP
 * directory audits) score that as a broken capability, and it is: advertising a
 * capability you never fulfil is worse than omitting it.
 *
 * These are documentation, not data. Live data belongs in a tool call, where
 * the model states what it wants; a resource is fetched blind, so anything
 * whose value depends on the question does not belong here. What does belong is
 * the guidance a client needs BEFORE its first call: which tool answers which
 * question, and what the graph actually covers.
 *
 * Every string is inlined rather than fetched from tako.com. A `resources/read`
 * that depends on a second network hop turns a documentation lookup into a
 * failure mode, and Workers bill for the subrequest.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Tier } from "./freetier.js";
import type { Surface } from "./surface.js";
import { DOMAINS, FRESHNESS } from "./vocabulary.js";

export const DOC_MIME_TYPE = "text/markdown; charset=utf-8";

export interface DocResource {
  /** `tako://` rather than `https://` — the content is served from the worker,
   * not proxied from a URL the client could fetch itself. */
  uri: string;
  name: string;
  title: string;
  description: string;
  text: string;
}

/**
 * The tool guide, rendered for the connection that asked.
 *
 * A module constant would serve identical text to every surface while the tool
 * surface itself differs -- `tako_visualize` registers on chatgpt and nothing
 * else, and `tako_contents` answers sign-in instructions rather than reading a
 * source on the free tier. The repo already varies prose by tier for exactly
 * that reason (`FREE_TIER_SERVER_INSTRUCTIONS`); a static document silently
 * describes somebody else's connection.
 */
function toolGuide(surface: Surface, tier: Tier): string {
  const rows = [
    "| What you need | Tool |",
    "|---|---|",
    "| A figure, a comparison, a chart, or web context — the workhorse | `tako_search` |",
    '| "Does Tako have this, and what is the measure called?" | `tako_available_data` |',
    "| One source read in full: a card's rows, or a web page's text by url | `tako_contents` |",
  ];
  if (surface === "chatgpt") {
    rows.push(
      "| Render a chart of a figure you already have | `tako_visualize` |",
    );
  }

  const sections = [
    "# Tako MCP — which tool answers what",
    "",
    "Tako searches a proprietary live-data graph AND the live web in the same call.",
    "Reach for it instead of a separate web search, not alongside one.",
    "",
    "## The tools on this connection",
    "",
    rows.join("\n"),
    "",
    "There is no separate one-figure tool here. `tako_search` answers a specific",
    "figure and a broad comparison alike, so a single call is usually the whole job.",
    "Further tools unlock through the `?tools=` query parameter on the endpoint —",
    "see https://docs.tako.com.",
    "",
    "## Don't chain what one call does",
    "",
    "Reaching for `tako_contents` right after `tako_search` to get the numbers is",
    "two calls for one answer. Set `include_contents: true` on the search instead.",
    "Save `tako_contents` for a source you already have a handle on.",
    "",
    "## Getting the metric name right",
    "",
    "`tako_available_data` is free and returns the exact measure names for an",
    "entity. A query that names the measure the way Tako stores it retrieves far",
    "more reliably than a paraphrase, so spend the free call before guessing twice.",
    "",
    "## What comes back",
    "",
    "Every result is citation-backed and carries a source. Results that are",
    "chartable include an embed URL you can render directly — the chart is part of",
    "the answer, not a separate rendering step.",
    "",
    "## Freshness",
    "",
    `${FRESHNESS} If a figure looks stale, check the source date on the card`,
    "before assuming the graph is behind.",
  ];

  if (tier === "free") {
    sections.push(
      "",
      "## This connection is anonymous",
      "",
      "It runs on a rate-limited free tier, and `tako_contents` answers sign-in",
      "instructions rather than reading the source. `tako_search` and",
      "`tako_available_data` run either way.",
    );
  }

  return sections.join("\n") + "\n";
}

/**
 * The coverage document. Domains come from `DOMAINS`, so this and the server
 * instructions cannot disagree about what Tako holds.
 */
function coverage(): string {
  return (
    [
      "# Tako MCP — data coverage",
      "",
      "Tako's graph is licensed, continuously updated data. It is strongest where",
      "the open web is weakest: numbers that live behind a vendor, are revised on a",
      "schedule, or are only published as a filing.",
      "",
      "## Domains",
      "",
      ...DOMAINS.map((domain) => `- **${domain.name}** — ${domain.detail}.`),
      "- **the live web** — searched in the same call, for the context around a figure.",
      "",
      "## When Tako is not the right tool",
      "",
      "A query with no numeric or entity anchor — an opinion, a how-to, a news",
      "narrative with no figure in it — is better served by a general web search.",
      "Tako returns nothing rather than guessing, so a null result is a real signal.",
      "",
      "## Confirming coverage before you query",
      "",
      "`tako_available_data` answers what Tako holds for an entity or a metric,",
      "including the measure's exact name, and costs nothing to call.",
      "",
      "Full public documentation: https://docs.tako.com",
    ].join("\n") + "\n"
  );
}

/** URIs are stable across surfaces; only the text varies. */
export const DOC_RESOURCE_URIS = [
  "tako://guide/tools",
  "tako://guide/coverage",
] as const;

export function docResources(
  surface: Surface,
  tier: Tier,
): readonly DocResource[] {
  return [
    {
      uri: DOC_RESOURCE_URIS[0],
      name: "tako-tool-guide",
      title: "Tako tool guide",
      description:
        "Which Tako tool answers which question shape, how to get metric names right, and what a result contains.",
      text: toolGuide(surface, tier),
    },
    {
      uri: DOC_RESOURCE_URIS[1],
      name: "tako-data-coverage",
      title: "Tako data coverage",
      description:
        "The data domains Tako's licensed graph covers, and the query shapes it does not serve.",
      text: coverage(),
    },
  ];
}

/**
 * Register every documentation resource on `server`.
 *
 * `registeredResourceUris` is the same dedupe set the widget registration uses:
 * the SDK throws `Resource <uri> is already registered` on a duplicate URI, and
 * sharing the set keeps a future widget that reuses one of these URIs from
 * crashing server construction.
 *
 * Registering at least one resource here is what wires the SDK's
 * `resources/list`, `resources/templates/list` and `resources/read` handlers on
 * EVERY server instance — including the anonymous, widget-less one. That is why
 * this runs before the tool loop rather than after it.
 */
export function registerDocResources(
  server: McpServer,
  registeredResourceUris: Set<string>,
  surface: Surface,
  tier: Tier,
): void {
  for (const doc of docResources(surface, tier)) {
    if (registeredResourceUris.has(doc.uri)) {
      // Not skipped silently. The set is shared with the widget registration so
      // a tool re-declaring the SAME widget URI dedupes cleanly, but these run
      // first against a fixed, unique list -- a collision here means something
      // else claimed a `tako://guide/*` URI, and dropping the document quietly
      // would leave resources/list short with no signal.
      throw new Error(
        `Documentation resource ${doc.uri} was already registered by something else`,
      );
    }
    registeredResourceUris.add(doc.uri);
    server.registerResource(
      doc.name,
      doc.uri,
      {
        title: doc.title,
        description: doc.description,
        mimeType: DOC_MIME_TYPE,
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: DOC_MIME_TYPE,
            text: doc.text,
          },
        ],
      }),
    );
  }
}
