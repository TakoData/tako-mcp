/**
 * Evaluation corpus for the web-snippet arm: Exa highlights vs page text.
 *
 * MEASUREMENT corpus, not a regression gate. `scripts/golden.ts` is the
 * pass/fail gate; this exists to quantify what flipping
 * `sources.web.highlights` actually does, so the default can be justified
 * rather than asserted.
 *
 * Two design rules, both learned the hard way on the available_data harness:
 *
 * 1. **Include cases the change is expected to LOSE.** A corpus of
 *    press-release lookups would show highlights winning everywhere, because
 *    a press release is the one page shape whose opening characters are pure
 *    preamble. The `expect` field below records the prior so a result that
 *    contradicts it is visible as a surprise rather than averaged away —
 *    `text-favoured` and `highlights-hostile` cases are load-bearing, not
 *    filler. A live probe already found one: a CNBC live-blog returned a
 *    highlight of shredded nav fragments ("- $80 billion buyback and u ...
 *    dividend - Guidance beats ...") where the text arm returned readable
 *    prose.
 *
 * 2. **The prior is not a scoring key.** Nothing scores a case against
 *    `expect`; it is there so the report can bucket by page shape and so a
 *    reader can tell whether a win came from the easy third of the corpus.
 *    Scoring is done by a blind judge in `judge.ts`, which never sees which
 *    arm produced a snippet.
 *
 * Every query is one a caller might plausibly send to tako_search or
 * tako_answer — no synthetic strings, because the thing being measured is
 * what Exa's selector does on real pages.
 */

/** What page shape the case is evidence about, and which way the prior runs. */
export type Expect =
  /** Answer-bearing figures buried under preamble — highlights should win. */
  | "highlights-favoured"
  /** The opening of the page IS the answer — highlights should roughly tie. */
  | "text-favoured"
  /** Nav-heavy / live-blog / listing pages — highlights may shred. */
  | "highlights-hostile"
  /** No strong prior; included for coverage of a real query shape. */
  | "neutral";

export interface WebSnippetCase {
  id: string;
  /** The query, exactly as a caller would send it. */
  query: string;
  /** Page shape this case probes, and the direction of the prior. */
  expect: Expect;
  /** Why this case is in the corpus — the thing it is evidence about. */
  probes: string;
}

export const WEB_SNIPPET_CASES: WebSnippetCase[] = [
  // ── Earnings and company KPIs ────────────────────────────────────────────
  // Press releases and IR pages: masthead, date, "Download this Press
  // Release" before any figure. The shape the flag was designed for.
  {
    id: "nvda-datacenter-rev",
    query: "nvidia data center revenue latest quarter",
    expect: "highlights-favoured",
    probes: "IR press release — the upstream PR's own worked example",
  },
  {
    id: "tsla-deliveries",
    query: "Tesla vehicle deliveries most recent quarter",
    expect: "highlights-favoured",
    probes: "A single figure inside a quarterly-results release",
  },
  {
    id: "msft-azure-growth",
    query: "Microsoft Azure revenue growth rate last quarter",
    expect: "highlights-favoured",
    probes: "A growth rate quoted on an earnings call, not in the headline",
  },
  {
    id: "costco-comparable-sales",
    query: "Costco comparable sales growth latest month",
    expect: "highlights-favoured",
    probes: "Monthly sales release — figure sits below a boilerplate header",
  },
  {
    id: "amzn-aws-operating-income",
    query: "AWS operating income most recent quarter",
    expect: "highlights-favoured",
    probes: "A segment line item, reachable only deep in the release",
  },

  // ── Macro indicators ─────────────────────────────────────────────────────
  // Statistical-agency pages open with agency boilerplate; the print is in a
  // table or a mid-page sentence.
  {
    id: "us-cpi-latest",
    query: "US CPI inflation rate latest reading",
    expect: "highlights-favoured",
    probes: "BLS-style release — the print is mid-page, not in the opening",
  },
  {
    id: "fed-funds-rate",
    query: "current federal funds target rate",
    expect: "neutral",
    probes: "A single well-known number many pages state up front",
  },
  {
    id: "uk-unemployment",
    query: "UK unemployment rate most recent release",
    expect: "highlights-favoured",
    probes: "ONS-style release with a statistical-bulletin preamble",
  },
  {
    id: "eurozone-gdp-growth",
    query: "eurozone GDP growth latest quarter",
    expect: "highlights-favoured",
    probes: "Eurostat-style release; figure follows methodology text",
  },

  // ── Definitional / explainer ─────────────────────────────────────────────
  // The page opening IS the answer. Highlights should not help, and this is
  // where a regression would show up first.
  {
    id: "what-is-sharpe-ratio",
    query: "what is the Sharpe ratio",
    expect: "text-favoured",
    probes: "Explainer page — the definition is the first sentence",
  },
  {
    id: "define-basis-point",
    query: "what is a basis point in finance",
    expect: "text-favoured",
    probes: "Glossary page; text arm should already be optimal",
  },
  {
    id: "how-etf-works",
    query: "how does an ETF work",
    expect: "text-favoured",
    probes: "Long explainer — highlights may pick a mid-page aside instead",
  },

  // ── Live blogs, listings, nav-heavy pages ────────────────────────────────
  // The observed failure shape: Exa's selector returns link-text fragments.
  {
    id: "earnings-live-updates",
    query: "Nvidia earnings live updates reaction",
    expect: "highlights-hostile",
    probes: "Live blog — the CNBC shape that returned shredded nav fragments",
  },
  {
    id: "biggest-movers-today",
    query: "biggest stock movers today",
    expect: "highlights-hostile",
    probes: "Ticker-list page; almost all link text, little prose",
  },
  {
    id: "ipo-calendar",
    query: "upcoming IPO calendar this month",
    expect: "highlights-hostile",
    probes: "Table/listing page with no answer-bearing sentence to select",
  },
  {
    id: "crypto-prices-now",
    query: "bitcoin price right now",
    expect: "highlights-hostile",
    probes: "Live-quote page — the number is rendered, not in the text",
  },

  // ── News / what-happened ─────────────────────────────────────────────────
  {
    id: "opec-decision",
    query: "latest OPEC production decision",
    expect: "neutral",
    probes: "News article — inverted pyramid puts the answer up front anyway",
  },
  {
    id: "fed-meeting-outcome",
    query: "what did the Fed decide at its most recent meeting",
    expect: "neutral",
    probes: "Statement plus commentary; both arms have material to work with",
  },
  {
    id: "chip-export-controls",
    query: "latest US semiconductor export controls on China",
    expect: "neutral",
    probes: "Policy coverage spread across a long article",
  },

  // ── Vague and broad ──────────────────────────────────────────────────────
  // Exa selects highlights against the query; a query with little signal
  // gives the selector little to bite on. The upstream PR measured 0 null
  // snippets across ~40 results, including a deliberately vague query — this
  // is the arm that would falsify that.
  {
    id: "vague-market-outlook",
    query: "market outlook",
    expect: "neutral",
    probes: "Near-contentless query — the null-snippet risk case",
  },
  {
    id: "vague-ai-spending",
    query: "AI spending",
    expect: "neutral",
    probes: "Two-word topic with no question in it",
  },

  // ── Operational KPIs the data graph does not cover ────────────────────────
  // Memory: mainstream financial metrics have cards, operational KPIs do not,
  // so these lean hardest on the web arm — where the snippet is all there is.
  {
    id: "cruise-occupancy",
    query: "Carnival cruise occupancy rate latest quarter",
    expect: "highlights-favoured",
    probes: "Operational KPI with no data card; the web snippet is the answer",
  },
  {
    id: "boeing-backlog",
    query: "Boeing commercial aircraft order backlog current",
    expect: "highlights-favoured",
    probes: "Backlog figure — buried in an orders-and-deliveries page",
  },
  {
    id: "shopify-gmv",
    query: "Shopify GMV latest quarter",
    expect: "highlights-favoured",
    probes: "GMV is a non-GAAP line; sits deep in the release",
  },

  // ── Non-English entity, and a homograph ──────────────────────────────────
  {
    id: "sap-cloud-backlog",
    query: "SAP current cloud backlog latest quarter",
    expect: "highlights-favoured",
    probes: "Non-US filer; page may open in another language",
  },
  {
    id: "homograph-apple-revenue",
    query: "Apple services revenue latest quarter",
    expect: "neutral",
    probes: "High-competition query where retrieval, not snippet, may dominate",
  },
];
