# Skill evals

Run these before changing a bundled skill, and again after. A skill edit with no
eval is a guess: the three research skills shipped for six weeks with a rule that
became false on 1.0.0 (a comparison card's date equals the query date) because
nothing exercised them.

Two sets, per the guidance in Anthropic's skill-authoring docs and
agentskills.io: a **trigger set** (does the right skill load, and does nothing
load on a near-miss?) and an **output set** (does the answer improve with the
skill present, measured against the same prompt with no skill?).

## Run

```bash
export TAKO_SKILLS_EVAL_MCP_CONFIG=/path/to/mcp.json   # {"mcpServers":{"tako":{"type":"http","url":"https://mcp.staging.tako.com/mcp","headers":{"Authorization":"Bearer ..."}}}}
python3 launch.py            # every row of runs.tsv, 7 in parallel
python3 launch.py trig-      # one set
python3 extract.py           # one block per run: skill loaded, tools called, final answer
```

Each row of `runs.tsv` is `id  arm  model  prompt`. The `skill` arm loads this
repo as a plugin so the working-tree skills are under test; `noskill` is the
baseline. Transcripts land in `out/` (gitignored: they hold card data and cost
nothing to regenerate).

## What to assert

Trigger rows (`trig-*`, `haiku-*`): `skills=` names the intended skill, or is
empty for a `neg` row. `trig-fin-nearmiss-traffic` ("Netflix subscribers") must
load financial, not traffic; `trig-traffic-brand` ("traffic does Netflix get")
must load traffic and query `netflix.com`.

Output rows (`out-*`), skill arm vs noskill arm on the same prompt:

| id | trap | assert on the skill arm |
| --- | --- | --- |
| F1-margin | segment card outranks company-wide | quotes the company-wide gross margin, or says only a segment card exists; names the source |
| F2-toyota | analyst-estimate card ranks #0 with a future `coverage_end` | reports an actual reported-year figure, not the estimate |
| M1-pce | "core PCE" query returns a core CPI card | quotes a PCE (% Change) card, or says the card returned was CPI |
| M2-fedfunds | a discontinued historical series ranks above the live one | cites the current effective rate, with a recent `coverage_end` |
| T1-netflix | brand query returns subscriber cards | searched `netflix.com`, quotes monthly visits, not subscribers |
| T2-compare | comparison card reports % change, not visits | gives absolute visits from the single-domain cards |

Drop an assertion that both arms pass; it measures nothing. Add one when a run
shows a failure the skill should have prevented.

Two assertions did differentiate on the first run (Sonnet, 2026-09-01) and are
the ones to watch: the skill arm followed the output template on every row
(source name, `coverage_end`, `[Open in Tako]` on the card `url`) where the
baseline never did, and it used the skill's query shapes (the exact
"Core PCE Price Index (% Change)" name; single-domain searches before a
comparison). The six correctness assertions passed in both arms that day: the
baseline model avoided every trap unaided. Keep them; they are the regression
net for a weaker model or a ranking change, not proof the skill is needed.

## Recording results

Put the pass/fail table and the date in the PR that changes the skill. The
transcripts aren't kept.
