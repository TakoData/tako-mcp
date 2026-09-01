"""Summarize recorded runs: which skill loaded, which tools ran, the final answer.

usage: python3 extract.py [glob]   e.g. extract.py "out-F1-*"

Reads the stream-json transcripts run.sh writes. A `Skill` tool_use is the
trigger signal; every other tool_use is the workflow the skill (or the model
alone) chose. Grade the FINAL line against the assertion in runs.tsv's README.
"""

import glob
import json
import os
import sys

d = os.environ.get("TAKO_SKILLS_EVAL_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
pattern = sys.argv[1] if len(sys.argv) > 1 else "*"
for path in sorted(glob.glob(f"{d}/{pattern}.jsonl")):
    sid = os.path.basename(path)[:-6]
    skills, tools, errors = [], [], []
    final, turns, dur = "", 0, 0
    pending = {}
    for line in open(path):
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if t == "assistant":
            for b in ev["message"].get("content", []):
                if b.get("type") == "tool_use":
                    pending[b.get("id")] = b["name"]
                    if b["name"] == "Skill":
                        skills.append(b["input"].get("skill") or b["input"].get("name") or json.dumps(b["input"]))
                    else:
                        tools.append((b["name"].replace("mcp__tako__", ""), json.dumps(b["input"])[:110]))
        elif t == "user":
            content = ev.get("message", {}).get("content", [])
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                        errors.append(pending.get(b.get("tool_use_id"), "?"))
        elif t == "result":
            final = ev.get("result") or ""
            turns = ev.get("num_turns", 0)
            dur = ev.get("duration_ms", 0)
    print(f"\n#### {sid}  turns={turns} {dur/1000:.0f}s  skills={skills or '-'}  errors={errors or '-'}")
    for name, inp in tools:
        print(f"   {name} {inp}")
    print("   FINAL:", final[:420].replace("\n", " "))
