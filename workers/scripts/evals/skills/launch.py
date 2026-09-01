"""Run every row of runs.tsv through run.sh, seven at a time.

usage: python3 launch.py [id-prefix]

A prefix runs only the rows whose id starts with it: `trig-` for the trigger
set, `out-` for the with/without-skill output set, `haiku-` for the small-model
trigger subset.
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

here = os.path.dirname(os.path.abspath(__file__))
rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(here, "runs.tsv")) if l.strip() and not l.startswith("#")]
only = sys.argv[1] if len(sys.argv) > 1 else None
rows = [r for r in rows if only is None or r[0].startswith(only)]


def run(row):
    rid, arm, model, prompt = row
    r = subprocess.run([os.path.join(here, "run.sh"), rid, arm, model, prompt], capture_output=True, text=True)
    return r.stdout.strip() or r.stderr.strip()[-200:]


with ThreadPoolExecutor(max_workers=7) as ex:
    for line in ex.map(run, rows):
        print(line, flush=True)
print("ALL-RUNS-DONE")
