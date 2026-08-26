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

export const DOC_MIME_TYPE = "text/markdown";

export interface DocResource {
  /** `tako://` rather than `https://` — the content is served from the worker,
   * not proxied from a URL the client could fetch itself. */
  uri: string;
  name: string;
  title: string;
  description: string;
  text: string;
}

const TOOL_GUIDE = `# Tako MCP — which tool answers what

Tako searches a proprietary live-data graph AND the live web in the same call.
Reach for it instead of a separate web search, not alongside one.

## The default toolset

| What you need | Tool |
|---|---|
| A figure, a comparison, a chart, or web context — the workhorse | \`tako_search\` |
| "Does Tako have this, and what is the measure called?" | \`tako_available_data\` |
| One source read in full: a card's rows, or a web page's text by url | \`tako_contents\` |

There is no separate one-figure tool on the default surface. \`tako_search\`
answers a specific figure and a broad comparison alike, so a single call is
usually the whole job. Additional tools unlock through the \`?tools=\` query
parameter on the endpoint — see https://docs.tako.com.

## Don't chain what one call does

Reaching for \`tako_contents\` right after \`tako_search\` to get the numbers
is two calls for one answer. Set \`include_contents: true\` on the search
instead. Save \`tako_contents\` for a source you already have a handle on.

## Getting the metric name right

\`tako_available_data\` is free and returns the exact measure names for an
entity. A query that names the measure the way Tako stores it retrieves far more
reliably than a paraphrase, so spend the free call before guessing twice.

## What comes back

Every result is citation-backed and carries a source. Results that are chartable
include an embed URL you can render directly — the chart is part of the answer,
not a separate rendering step.

## Freshness

Company financials cover the latest reported quarter. Market prices are
same-day. Official statistical releases land as they publish. If a figure looks
stale, check the source date on the card before assuming the graph is behind.

## Anonymous connections

Without a Tako account the connection runs on a rate-limited free tier, and
\`tako_contents\` answers sign-in instructions rather than reading the source.
\`tako_search\` and \`tako_available_data\` run either way.
`;

const COVERAGE = `# Tako MCP — data coverage

Tako's graph is licensed, continuously updated data. It is strongest where the
open web is weakest: numbers that live behind a vendor, are revised on a
schedule, or are only published as a filing.

## Domains

- **Company financials** — revenue, earnings against estimates, margins,
  valuation, KPIs. Public and private companies.
- **Markets** — equity prices, indices, FX, commodities, crypto.
- **Macroeconomics** — inflation (CPI/PCE), unemployment, GDP, policy and
  interest rates, trade, for individual countries and side by side.
- **Demographics** — population, and the standard census and development
  indicators.
- **Web and app traffic** — monthly visits, active users, and top-site rankings
  for any domain.
- **Sports** — scores, schedules, standings, and player and team statistics.
- **Prediction markets and elections** — contract prices and polling.
- **Energy, real estate, and health** — production, prices, inventories,
  housing, and public-health indicators.
- **US government spending** — federal contracts and agency budgets.
- **The live web** — searched in the same call, for the context around a figure.

## When Tako is not the right tool

A query with no numeric or entity anchor — an opinion, a how-to, a news
narrative with no figure in it — is better served by a general web search. Tako
returns nothing rather than guessing, so a null result is a real signal.

## Confirming coverage before you query

\`tako_available_data\` answers what Tako holds for an entity or a metric,
including the measure's exact name, and costs nothing to call.

Full public documentation: https://docs.tako.com
`;

export const DOC_RESOURCES: readonly DocResource[] = [
  {
    uri: "tako://guide/tools",
    name: "tako-tool-guide",
    title: "Tako tool guide",
    description:
      "Which Tako tool answers which question shape, how to get metric names right, and what a result contains.",
    text: TOOL_GUIDE,
  },
  {
    uri: "tako://guide/coverage",
    name: "tako-data-coverage",
    title: "Tako data coverage",
    description:
      "The data domains Tako's licensed graph covers, and the query shapes it does not serve.",
    text: COVERAGE,
  },
];

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
): void {
  for (const doc of DOC_RESOURCES) {
    if (registeredResourceUris.has(doc.uri)) {
      continue;
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
