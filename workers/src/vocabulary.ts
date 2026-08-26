/**
 * The product vocabulary every prose surface renders: what Tako covers, and how
 * fresh it is.
 *
 * Three surfaces stated this independently and had already contradicted each
 * other. `SHARED_INSTRUCTION_PARAGRAPHS` listed `weather`; the coverage resource
 * did not, and added `US government spending` that neither of the others had. An
 * agent reads the instructions and the resource in the same session, so one of
 * them was telling it Tako has weather data and the other that it does not.
 *
 * The decomposition matches the rule the sibling repo enforces for agent prompts:
 * reuse a block wholesale, or split it so the neutral part is shared and only the
 * rendering differs. `DOMAINS` is that neutral part -- `name` is the noun an
 * agent matches on, `detail` is the expansion only the long-form resource shows.
 * Nothing here interpolates into the middle of a sentence.
 */

export interface Domain {
  /** The short noun. Rendered inline by the server instructions. */
  name: string;
  /** What the graph actually holds. Rendered only by the coverage resource. */
  detail: string;
}

/**
 * Names are the ORIGINAL instruction vocabulary, verbatim and in order. They are
 * what a model matches a question against, so renaming one is a discoverability
 * change and not an editorial one -- an early draft of this list collapsed
 * "finance" and "company KPIs" into "company financials" and dropped two nouns
 * the instructions had carried. `US government spending` is the one addition:
 * the coverage resource already claimed it while the instructions did not.
 */
export const DOMAINS: readonly Domain[] = [
  {
    name: "finance",
    detail:
      "company revenue, earnings against estimates, margins and valuation, for public and private companies",
  },
  {
    name: "markets",
    detail: "equity prices, indices, FX, commodities, crypto",
  },
  {
    name: "company KPIs",
    detail: "the operating metrics a company reports alongside its financials",
  },
  {
    name: "economics",
    detail:
      "inflation (CPI/PCE), unemployment, GDP, policy and interest rates, and trade, per country and side by side",
  },
  {
    name: "website/app traffic",
    detail:
      "monthly visits, active users, and top-site rankings for any domain",
  },
  {
    name: "sports",
    detail: "scores, schedules, standings, and player and team statistics",
  },
  {
    name: "weather",
    detail: "forecasts, air quality, and historical averages",
  },
  { name: "elections", detail: "results and polling" },
  {
    name: "prediction markets",
    detail: "contract prices across the major venues",
  },
  {
    name: "demographics",
    detail: "population, and the standard census and development indicators",
  },
  { name: "energy", detail: "production, prices, and inventories" },
  { name: "real estate", detail: "housing prices, inventory, and rates" },
  { name: "health", detail: "public-health indicators and outcomes" },
  {
    name: "US government spending",
    detail: "federal contracts and agency budgets",
  },
];

/** Comma-joined names, for a surface that has one sentence to spend. */
export const DOMAIN_NAMES_INLINE = DOMAINS.map((domain) => domain.name).join(
  ", ",
);

/**
 * How current the data is. Stated by `serverInfo.description` and by the tool
 * guide; one sentence, one definition, because a claim about freshness that
 * drifts is worse than no claim.
 */
export const FRESHNESS =
  "Covers the latest reported quarter, same-day market prices, and official releases as they publish.";
