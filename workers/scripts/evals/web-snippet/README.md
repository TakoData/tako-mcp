# Web-snippet evaluation harness — Exa highlights vs page text

Measures what `sources.web.highlights` (TakoData/tako#28462) actually does to
the web snippet, so making it the default in `tako_search` and `tako_answer`
can be justified rather than asserted. **Measurement, not a gate** —
`scripts/golden.ts` is the pass/fail regression gate; nothing here should be
wired into CI.

```bash
# 1. collect (priced: ~$0.032/case — 2 search + 2 answer calls)
#    EVAL_STAMP names the output file; without it you get raw-latest.jsonl.
EVAL_API_BASE=https://staging.tako.com TAKO_EVAL_API_KEY=$TAKO_STAGING_API_KEY \
  EVAL_STAMP=2026-08-01-prod npm run eval:web-snippet
#    --search-only  halves the spend    --limit N  first N cases

# 2. score (Anthropic tokens, no Tako spend)
ANTHROPIC_API_KEY=... npm run eval:web-snippet:judge -- \
  scripts/evals/web-snippet/results/raw-2026-08-01-prod.jsonl
#    --top N   results/arm to judge (default 5)   --conc N  concurrency (default 6)

# 3. render → RESULTS.md
npm run eval:web-snippet:report -- \
  scripts/evals/web-snippet/results/raw-2026-08-01-prod.jsonl
```

**Name the raw file in steps 2 and 3.** Both scripts take it as an argument and
refuse to guess when `results/` holds more than one sweep, listing the
candidates with their case counts instead. There is no ordering that reliably
means "the one you meant": a lexical sort puts `raw-<stamp>.jsonl` *after*
`raw-<stamp>-full.jsonl` (`-` sorts before `.`), and mtime is checkout order on
a fresh clone. Guessing wrong here regenerates the committed `RESULTS.md` from a
smoke run, which reads exactly like a full sweep at a fraction of the
denominator.

| file | role |
|---|---|
| `cases.ts` | the corpus, with a per-case prior on which arm should win and why |
| `run.ts` | two-arm collector → one JSONL row per case. No scoring. |
| `judge.ts` | blind LLM scoring → `judged-*.jsonl` |
| `report.ts` | JSONL → `RESULTS.md` |
| `RESULTS.md` | the generated sheet (committed, so runs stay comparable) |

## Why it measures the backend, not the MCP

The lever is a backend field and the MCP hardcodes it, so an MCP-level A/B
would need a knob on the tool surface existing only for the harness — a worse
tool contract in exchange for a worse measurement. The MCP adds nothing to the
snippet path: it does not truncate, re-rank, or reformat, and the snippet rides
verbatim into `structuredContent`. What the MCP *does* fix is
`snippet_max_chars`, so `run.ts` pins the same 2000 the tools send. If that
constant changes in `buildSearchBody`, change it here too or the measurement
stops describing the shipped configuration.

## Four things this harness is built to avoid

**A corpus that can only produce a win.** Highlights beat page text on exactly
one page shape — the press release, whose opening is masthead and boilerplate.
A corpus of earnings lookups would show a large, real, and badly misleading
gain. So `cases.ts` carries `text-favoured` cases (the definition *is* the
first sentence) and `highlights-hostile` ones (live blogs and listing pages,
where a live probe already caught Exa returning shredded nav fragments), and
`report.ts` breaks the score out by page shape. A headline mean that only moves
on the favourable third is a narrower result than it looks.

**Position bias in pairwise judging.** Every answer comparison runs twice with
the sides swapped, and a winner counts only when both orders agree. Order
disagreement is reported as `no-consensus` rather than settled by picking one
run — a single-order pairwise judge reports a winner that is partly an artifact
of which answer went first.

**Latency measured as position.** Both arms hit the same upstream cache and the
same rate limiter, so a fixed arm order hands one arm every cold cache. Arm
order is rotated per case. This is not hypothetical: in the first 4-case smoke
run, the arm issued *first* was slower in 3 of 4 cases regardless of which arm
it was.

**A gap scored as a zero.** With highlights on, Tako requests no page text, so
a page with no relevant passage returns `snippet: null` and keeps its slot.
That is a coverage gap, not a useless excerpt, and the two want different
responses — so `judge.ts` records `unscored` as a first-class outcome and
`report.ts` reports it in its own column, never folded into the 0 bucket.

## What it does not establish

- **No p95.** One repetition per case, timed from a laptop against staging.
  That is an honest median and max; it is not a p95, and the thing that
  actually gates the answer default is the tail against a hard 1.5s grounding
  budget. That needs a measurement from inside the VPC.
- **No production traffic mix.** 26 hand-written queries chosen to span page
  shapes, not sampled from real MCP calls.
- **`--top 5` is a real cap.** Only the head of each result set is judged. The
  cap is printed in `RESULTS.md`; raise it with `--top 10` for full coverage at
  double the judge spend.
