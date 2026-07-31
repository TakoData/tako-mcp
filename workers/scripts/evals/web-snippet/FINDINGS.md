# What the web-snippet A/B found

Run: 26 cases × 2 arms × 2 endpoints against `staging.tako.com`, 2026-07-31.
104 priced Tako calls ($0.83), 0 failures, 0 rate-limited arms.
Numbers in `RESULTS.md`; this file is the interpretation, which the generated
sheet deliberately does not contain.

## Verdict

**Flipping `highlights` on for `tako_search` is well supported.** Flipping it
for `tako_answer` is supported but on a thin denominator, and one latency
outlier is unexplained — details and the reason it still ships below.

## `tako_search`: better excerpts, and 18% fewer bytes

| | text | highlights |
|---|---:|---:|
| Blind snippet utility (0-2 mean, n=130/arm) | 1.75 | **1.89** |
| Share carrying a fact that answers the query | 78% | **89%** |
| Share scoring 0 (nav text, boilerplate, fragments) | 3% | **0%** |
| Mean snippet chars | 1896 | **1556** |
| Snippets pinned at the 2000-char cap | 167/260 | 40/260 |

The size result was not the expected one and matters more than the quality
result for a tool whose snippets ride verbatim in `structuredContent`:
highlights are **~18% shorter** while scoring higher. The text arm hits the cap
on 64% of results — it is truncating mid-page-text to fill 2000 characters,
whereas highlights stop when the relevant passage ends. Better content and
fewer tokens is not the tradeoff the upstream PR framed ("4x the bytes for 2x
the answer-bearing content" was measured on the *text* path at cap 4000); at a
2000 cap on the highlights path it inverts.

**The `highlights-hostile` prior was wrong, and that is the most useful thing
in the run.** The corpus was built expecting live blogs and listing pages to
shred, on the strength of one probe where CNBC returned nav fragments. Across 4
such cases highlights scored **+0.20**, not negative. The live-blog case is the
clearest reversal — text returned the headline twice and a markdown artifact,
highlights returned a causal sentence:

```
text        "Nvidia Stock Rebounds Toward $200 as Cathie Wood Buys the Dip, but
             OpenAI Risk Looms - Forex News by FX Leaders Nvidia Stock Rebounds
             Toward $... # Nvidia Stock Rebounds Toward $200 as …"
highlights  "…NVDA rose on Friday after Amazon reaffirmed its commitment to the
             chipmaker's artificial intelligence processors and increased its
             capital spending plans, reinforcing investor …"
```

One probe was not a page shape. Highlights improved on every bucket except
`neutral` (−0.03, inside noise), so the gain is not confined to press releases.

## Coverage: the null-snippet risk did not materialise

**0 null snippets in 260 highlight results.** Upstream measured 0 across ~40
and declined to add a text fallback on that basis; this holds at 6.5× the
sample, including two deliberately near-contentless queries (`market outlook`,
`AI spending`). The `webResultSchema.snippet` description still documents
`null`, because absence is in the contract even if it is rare — but no fallback
is warranted on this evidence.

Only 1 of 260 highlight snippets contained the `" … "` multi-passage join,
matching the upstream finding that Exa returns one passage per URL in every
configuration. The join is a guard against a vendor-default change, not a
description of current behaviour.

## `tako_answer`: positive, thin, and one unexplained tail

Pairwise, both orders required to agree: **7 highlights, 2 text, 14 tie, 3
no-consensus.** So 9 decided cases, 7-2 in favour. That is a direction, not a
result — 9 is too few to size the effect, and 14 ties say the arbiter mostly
synthesises the same answer either way.

**The degradation mode the upstream PR warned about did not fire.** A breach of
the 1.5s `GROUNDING_WEB_RETRIEVAL_TIMEOUT_S` returns an answer with no web
grounding rather than a slow one, so the metric that matters is empty
`web_results` on a web-only request: **0/26 on both arms.** Median paired answer
latency delta is **+1ms**, and highlights were slower on 13 of 26 — a coin
flip, not a cost.

**The unresolved item: one highlights answer took 8585ms against 2474ms for the
same query on the text arm** (`ipo-calendar`). That is +6.1s, an order of
magnitude past the +488ms worst case upstream measured on `/search`. It still
returned 3 web results, so it did not degrade — but a single 26-case run cannot
tell whether that is Exa selector variance on a listing page, staging noise, or
a real tail. It is one observation and it did not cost grounding, so it does not
block the flip; it is the first thing to look at if answer p95 moves after
deploy.

## What this run does not establish

- **No p95, on either endpoint.** One repetition per case, timed from a laptop
  against staging. Honest median and max; not a p95. The 8.6s outlier above is
  exactly the shape of thing a laptop-timed n=1 sweep cannot resolve.
- **Snippet utility is judged on the top 5 of 10 results per arm** (`--top 5`,
  stated in `RESULTS.md`). The tail of each result set is unjudged.
- **Not a production traffic mix.** 26 hand-written queries chosen to span page
  shapes.
- **Nothing here measured `snippet_max_chars`.** It stayed at the 2000 the MCP
  sends, deliberately — one variable at a time. The cap-binding asymmetry above
  (64% of text results at cap vs 15% of highlight results) is the argument for
  revisiting it as a *separate* change: the text arm was being truncated by a
  cap the highlights arm rarely reaches, so raising it now would be raising it
  for a path that mostly does not want it.
