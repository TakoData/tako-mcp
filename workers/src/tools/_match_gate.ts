/**
 * Name plausibility for graph candidates — the relevance gate.
 *
 * `/api/v1/graph/search` is a fuzzy matcher and its nodes carry NO score
 * field, so there is nothing backend-side to threshold on. Without a gate the
 * top hits for a query are frequently about something else entirely, and
 * `tako_available_data` reports coverage for whatever it drilled: measured on
 * staging (2026-07-29) `q="Carnival Corporation"` returned `found: true`
 * describing **Cuscal Limited**, and `q="UnitedHealth Group"` spent half its
 * two-slot drill budget on **Blackstone Inc.**
 *
 * The rule is bidirectional token containment against the candidate's name OR
 * any of its aliases: one side's token set must contain the other's. Symmetry
 * is what makes it work in both directions the tool is used —
 *
 *   query ⊆ candidate   `Carnival` → `Carnival Corporation Ltd.`
 *   candidate ⊆ query   `Carnival passenger cruise days` → `Passenger Cruise Days`
 *
 * Aliases are mandatory, not a refinement: `q="SpaceX"` resolves
 * `Space Exploration Technologies Corp.`, which shares ZERO name tokens with
 * the query and matches only through its alias list. A name-only gate would
 * reject the correct answer and report an honest gap where data exists. Same
 * mechanism carries `Nestle` → `Nestlé S.A.` (via diacritic folding) and
 * `UNH` → `UnitedHealth Group Incorporated`.
 *
 * Deliberately NOT a ranker. Among candidates that pass, the backend's own
 * order is kept: `q="Delta"` passes both `Delta Air Lines, Inc.` (rank 0,
 * correct) and `Delta Corp Limited`, which tie on coverage AND both carry an
 * exact alias "Delta" — no rank-independent signal separates them, so backend
 * rank is the only thing that resolves that class.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */

/**
 * Corporate suffixes and articles carry no discriminating signal — every
 * company has them, so leaving them in makes unrelated firms look similar
 * ("Zzzqq Industries" vs "Daikin Industries"). `group` is deliberately NOT
 * here: it distinguishes (UnitedHealth Group, SoftBank Group) rather than
 * blurring.
 */
const NOISE_TOKENS = new Set([
  "inc", "corp", "corporation", "plc", "ltd", "limited", "co", "sa", "ag",
  "nv", "llc", "lp", "holdings", "holding", "company", "the", "and", "of",
]);

/**
 * Normalise a name to a comparable token set: strip diacritics (so `Nestlé`
 * matches `Nestle`), lowercase, split on anything non-alphanumeric, and drop
 * the noise tokens above.
 */
export function matchTokens(value: string): Set<string> {
  // NFKD splits "é" into "e" + U+0301; stripping the combining-marks block
  // (U+0300–U+036F) leaves the ASCII base letter. Written as escapes so the
  // range survives any editor/encoding round-trip.
  const ascii = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const raw = ascii.split(/[^a-z0-9]+/).filter((t) => t !== "");

  // Re-join runs of single characters, so dotted initialisms survive splitting
  // as one token: "S.A." \u2192 ["s","a"] \u2192 "sa" (a noise suffix), "U.S." \u2192 "us".
  // Done by run-length rather than by stripping dots globally, because
  // stripping dots would fuse "netflix.com" into "netflixcom" and stop it
  // matching "Netflix, Inc." \u2014 domains are a real query shape here.
  const merged: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 1) merged.push(run.join(""));
    else if (run.length === 1) merged.push(run[0] as string);
    run = [];
  };
  for (const token of raw) {
    if (token.length === 1) run.push(token);
    else {
      flush();
      merged.push(token);
    }
  }
  flush();

  const out = new Set<string>();
  for (const token of merged) {
    if (!NOISE_TOKENS.has(token)) out.add(token);
  }
  return out;
}

const contains = (outer: Set<string>, inner: Set<string>): boolean => {
  for (const token of inner) if (!outer.has(token)) return false;
  return true;
};

/** One candidate's comparable surfaces: its own name plus every alias. */
export interface MatchCandidate {
  name: string;
  aliases?: readonly string[] | null | undefined;
}

/**
 * Is `candidate` a plausible match for `query`?
 *
 * True when the query's token set and the candidate's (name or any alias)
 * either contains the other. Empty token sets never match — a query of pure
 * punctuation must not pass everything.
 */
export function plausibleMatch(query: string, candidate: MatchCandidate): boolean {
  const q = matchTokens(query);
  if (q.size === 0) return false;
  const surfaces = [candidate.name, ...(candidate.aliases ?? [])];
  for (const surface of surfaces) {
    if (typeof surface !== "string" || surface === "") continue;
    const c = matchTokens(surface);
    if (c.size === 0) continue;
    if (contains(c, q) || contains(q, c)) return true;
  }
  return false;
}

/**
 * Does the query mention the WHOLE of one of the candidate's surfaces?
 *
 * One direction of `plausibleMatch` — candidate ⊆ query — on its own. The gate
 * needs both directions (`Carnival` must reach `Carnival Corporation Ltd.`),
 * but deciding that a query names BOTH an entity and a metric needs the
 * stricter one: `q="Disney"` passes the gate for the metric
 * `Disney Core Paid Subscribers` (query ⊆ name), and treating that as a tie
 * would turn every bare company name into a two-candidate answer. `Core` and
 * the alias `Core PCE` are both inside `US core PCE`; the KPI is not inside
 * `Disney`.
 */
export function mentionedWhole(query: string, candidate: MatchCandidate): boolean {
  const q = matchTokens(query);
  if (q.size === 0) return false;
  for (const surface of [candidate.name, ...(candidate.aliases ?? [])]) {
    if (typeof surface !== "string" || surface === "") continue;
    const c = matchTokens(surface);
    if (c.size > 0 && contains(q, c)) return true;
  }
  return false;
}

/**
 * Keep only plausible candidates, in the backend's order (see the "not a
 * ranker" note above). Returns the ORIGINAL list when nothing passes — the
 * fail-open contract: a gate that is too strict must degrade to today's
 * behaviour, never to an empty answer, because a false "Tako has no data on X"
 * is worse than the noise the gate exists to remove.
 */
export function gateCandidates<T extends MatchCandidate>(
  query: string,
  candidates: readonly T[],
): { kept: T[]; gated: boolean } {
  // Name matches rank above alias-only matches, order preserved within each
  // group. This is NOT general re-ranking (see the note above) — it is the one
  // defence against poisoned alias data, which is real and observed: on
  // staging `Cuscal Limited` (an Australian credit-union services company)
  // carries "Carnival Corp", "Carnival Corporation", "Carnival Cruise" and four
  // more Carnival aliases, and it comes back at RANK 0 for
  // `q="Carnival Corporation"`. A gate treating names and aliases alike keeps
  // it there; preferring the node whose OWN NAME matches drops it below the
  // real Carnival nodes. Tracked for a data fix in KE-804.
  //
  // What this partition does NOT do is decide relevance, and it must not be
  // read as doing so. Two things it gets wrong on live data, both handled
  // downstream by coverage rather than here:
  //
  //   - `q="SpaceX"` returns a node literally NAMED `SpaceX` alongside
  //     `Space Exploration Technologies Corp.`, so a name match DOES survive to
  //     outrank the alias match and this function returns the impostor at rank
  //     0. The right answer still gets rendered, but only because the impostor
  //     carries zero coverage and the promotion in `tako_available_data` fires.
  //   - A bare name match is not evidence of relevance at all:
  //     `US Savings Inflation Securities` name-matches `q="US inflation"` and
  //     holds one metric. See SHELL_COVERAGE_MAX.
  //
  // Ties (both name matches, e.g. Delta Air Lines vs Delta Corp) keep the
  // backend's order.
  const byName: T[] = [];
  const byAlias: T[] = [];
  for (const c of candidates) {
    if (plausibleMatch(query, { name: c.name })) byName.push(c);
    else if (plausibleMatch(query, c)) byAlias.push(c);
  }
  const kept = [...byName, ...byAlias];
  return kept.length > 0 ? { kept, gated: true } : { kept: [...candidates], gated: false };
}

/**
 * Do two names normalise to the SAME token set?
 *
 * Much stronger evidence than containment: it fires only when the caller typed
 * a name that, after folding and suffix-stripping, is exactly a candidate's.
 * Used to promote a verbatim metric name that the backend ranked low —
 * `metric="CPI Inflation Rate (Seasonally Adjusted)"` returns that exact node
 * at rank 3, below `Inflation Rate`, so it fell outside the three candidates
 * the response shows.
 *
 * Deliberately NOT used on the entity half: `q="Delta"` token-equals
 * `Delta Corp Limited` ({delta} after suffix stripping) but the correct answer
 * is `Delta Air Lines, Inc.`, which does not — promotion there would actively
 * pick the wrong company.
 */
export function sameTokens(a: string, b: string): boolean {
  const x = matchTokens(a);
  const y = matchTokens(b);
  if (x.size === 0 || x.size !== y.size) return false;
  for (const t of x) if (!y.has(t)) return false;
  return true;
}

/**
 * A stricter match used for the CONFIDENCE verdict, not for the gate.
 *
 * The gate accepts a match on any surface in either direction, which is right
 * for deciding "is this candidate worth showing". It is too loose for deciding
 * "does anything here actually answer the question", because a candidate can
 * vouch for itself through an alias BROADER than the query:
 * `metric="index level"` reported found:true via `Employment Index`, whose
 * alias `employment level index` is a strict superset of {index, level}.
 *
 * So an alias vouches only when it accounts for the WHOLE query — its token set
 * must EQUAL the query's, not merely be contained in it. That is exactly the
 * shape of a legitimate abbreviation: measured, `ROA`→`Return on Assets`,
 * `FCF`→`Free Cash Flow` and `capex`→`Capital Expenditure` are all alias-only
 * with no name match at all, and in every one the alias IS the query.
 *
 * The weaker `alias ⊆ query` rule was here first and let a broad node vouch on a
 * PARTIAL match — covering the generic half of a two-token query and ignoring the
 * distinctive half. Measured on staging 2026-07-31, that shipped wrong pins:
 *
 *   metric="AWS revenue"    → `Revenues` vouched via alias `Revenue`
 *                             ({revenue} ⊆ {aws, revenue}), ignoring `aws`
 *   metric="total assets"   → `Total Odds` — a SPORTS-BETTING metric — vouched
 *                             via an alias covering just `total`, and pinning it
 *                             returned a card 2 of 5 times. A wrong card with a
 *                             citation is worse than none.
 *
 * Equality rejects both while keeping every abbreviation above (verified against
 * the real staging alias lists). It also drops `P/E ratio`→`Price to Earnings
 * (P/E)`, whose alias `P/E` covers only half the query — no loss, since on
 * staging that query resolves `Last Close Price / Earnings` at rank 0 and pinning
 * THAT returned 0 cards in 5 of 5 runs, so the handle this pair used to emit was
 * dead anyway; the caller now picks from the alternates instead of being handed a
 * dead handle.
 *
 * The NAME path is held to the same standard, and used to not be. It accepted
 * BOTH directions, but only one of them was ever justified: a name CONTAINING
 * the query is a specialisation of what was asked (`Gross Margin (%)` for
 * "gross margin"), which is real evidence. The reverse — name ⊆ query — is the
 * identical "covers part of the query" defect this change bans on the alias
 * path, and it made the two flagship rejections turn on a SPELLING rather than
 * on the rule:
 *
 *   ("AWS revenue",  name `Revenues`)   rejected     <- plural, so not a subset
 *   ("AWS revenue",  name `Revenue`)    ACCEPTED     <- singular, so a subset
 *   ("total assets", name `Total Odds`) rejected
 *   ("total assets", name `Assets`)      ACCEPTED
 *
 * A node named `Revenue` vouching for "AWS revenue" is the same wrong pin as the
 * alias case, reached one line higher up. Both call sites pass a single HALF of
 * the query (`metricQuery`, or `input.q` in the swap probe), so a candidate whose
 * name is narrower than that half is not answering it. Dropped, and no existing
 * test depended on it — 86 passed with the direction removed before the tests
 * below were added to pin the new behaviour.
 */
export function confidentMatch(query: string, candidate: MatchCandidate): boolean {
  const q = matchTokens(query);
  if (q.size === 0) return false;
  const name = matchTokens(candidate.name);
  if (name.size > 0 && contains(name, q)) return true;
  for (const alias of candidate.aliases ?? []) {
    if (typeof alias !== "string" || alias === "") continue;
    // Exactly `sameTokens(query, alias)`. Re-tokenising a query of at most a few
    // tokens per alias is not worth an inline copy of the rule.
    if (sameTokens(query, alias)) return true;
  }
  return false;
}
