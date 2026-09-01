#!/bin/bash
# usage: run.sh <id> <skill|noskill> <model> <prompt>
#
# One headless Claude Code session, recorded as stream-json. The `skill` arm
# loads this repo as a plugin (`--plugin-dir`) so the bundled skills are the
# ones under test; `noskill` is the same session with no plugin, the baseline
# every source on skill authoring says to measure against.
#
# `--setting-sources project` keeps the user's installed plugins out of the
# run: the published tako plugin ships an OLDER copy of these skills, and a run
# that loaded both would coach the model from the version you are not testing.
#
# Requires: TAKO_SKILLS_EVAL_MCP_CONFIG — path to a Claude Code MCP config
# whose only server is `tako` (a staging endpoint plus a bearer header). Never
# commit that file; it holds a token.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="${TAKO_SKILLS_EVAL_OUT:-$HERE/out}"
mkdir -p "$OUT"
ID="$1"; ARM="$2"; MODEL="$3"; PROMPT="$4"
: "${TAKO_SKILLS_EVAL_MCP_CONFIG:?set TAKO_SKILLS_EVAL_MCP_CONFIG to an MCP config file}"
PLUGIN=()
if [ "$ARM" = "skill" ]; then PLUGIN=(--plugin-dir "$REPO_ROOT"); fi
cd "$OUT"
claude -p "$PROMPT" \
  --mcp-config "$TAKO_SKILLS_EVAL_MCP_CONFIG" \
  --strict-mcp-config \
  --setting-sources project \
  --allowedTools "mcp__tako,Skill" \
  --model "$MODEL" \
  --max-turns 10 \
  --output-format stream-json --verbose \
  "${PLUGIN[@]+"${PLUGIN[@]}"}" \
  > "$OUT/$ID-$ARM-$MODEL.jsonl" 2> "$OUT/$ID-$ARM-$MODEL.err"
echo "done $ID $ARM $MODEL exit=$?"
