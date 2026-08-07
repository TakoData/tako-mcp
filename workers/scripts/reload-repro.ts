/**
 * Local browser repro for the ChatGPT reload bug (PR #225).
 *
 * Emits three standalone HTML pages that run the REAL widget bundle in a real
 * browser, each with a different `window.openai` injected before the bundle's
 * script executes — the same three states ChatGPT puts the widget in.
 *
 * Why this exists alongside the jsdom tests: jsdom proves the selection logic,
 * but not that the chart actually paints. These pages load the live prod card,
 * so a broken restore is visible rather than merely asserted.
 *
 * What it CANNOT prove: that ChatGPT itself repopulates `window.openai
 * .widgetState` on reload. That is the host's half of the contract and only a
 * real ChatGPT reload can confirm it. These pages simulate the host.
 *
 * Usage: npx tsx scripts/reload-repro.ts && open /tmp/tako-reload-repro/1-first-render.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Env } from "../src/env.js";
import { buildChartAppUiResourceFromOutputPubId } from "../src/tools/_chart_widget.js";

const ENV: Env = { DJANGO_BASE_URL: "https://tako.com" };
const OUT_DIR = "/tmp/tako-reload-repro";

// A real, live prod card so the iframe/image actually resolve.
const PUB_ID = "RF6buyymVjo8M4YYsYQe";
const PAYLOAD = {
  cards: [],
  web_results: [],
  usage: {},
  request_id: "req_repro",
  pub_id: PUB_ID,
  embed_url: `https://tako.com/embed/${PUB_ID}/?dark_mode=auto`,
  image_url: `https://tako.com/api/v1/image/${PUB_ID}/?dark_mode=true`,
  dark_mode: true,
  width: 900,
  height: 720,
};

// Exactly what ChatGPT handed the widget after a reload.
const STRIPPED = { width: 900, height: 720 };

/**
 * Splice a bootstrap script into the bundle's <head> so `window.openai` exists
 * before the bundle's own script runs — the ordering ChatGPT provides on the
 * synchronous path, and the one `pickFromOpenAi` is written against.
 */
function page(title: string, note: string, openaiLiteral: string): string {
  const bundle = buildChartAppUiResourceFromOutputPubId(ENV).html;
  const boot = `<script>
    window.__takoLog = [];
    window.openai = ${openaiLiteral};
    window.openai.notifyIntrinsicHeight = function (h) {
      window.__takoLog.push("notifyIntrinsicHeight(" + h + ")");
      var el = window.parent && window.parent.document.getElementById("log");
      if (el) el.textContent += "notifyIntrinsicHeight(" + h + ")\\n";
    };
  </script>`;
  const injected = bundle.replace("<head>", `<head>${boot}`);
  if (!injected.includes("window.__takoLog")) {
    throw new Error("bootstrap injection failed — bundle <head> not found");
  }
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; background: #fff; color: #111; }
  .note { max-width: 60ch; padding: 12px 16px; border-left: 3px solid #888; background: #f6f6f6; }
  .expect { font-weight: 600; }
  iframe.host { width: 820px; height: 620px; border: 1px dashed #bbb; margin-top: 16px; }
  pre { background: #111; color: #eee; padding: 10px; max-width: 60ch; }
  nav a { margin-right: 12px; }
</style>
<nav>
  <a href="1-first-render.html">1. first render</a>
  <a href="2-reload-restored.html">2. reload (fixed)</a>
  <a href="3-reload-no-state.html">3. reload (no state)</a>
</nav>
<h2>${title}</h2>
<div class="note">${note}</div>
<pre id="log"></pre>
<iframe class="host" srcdoc="${injected.replace(/"/g, "&quot;")}"></iframe>
`;
}

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(
  join(OUT_DIR, "1-first-render.html"),
  page(
    "1. First render",
    `The normal path: a full <code>toolOutput</code>. <span class="expect">Expect: the chart renders,
     and the log shows the card mirrored into widget state.</span> The captured
     <code>setWidgetState</code> payload is printed above the frame.`,
    `{
      toolOutput: ${JSON.stringify(PAYLOAD)},
      setWidgetState: function (s) {
        var el = window.parent && window.parent.document.getElementById("log");
        if (el) el.textContent += "setWidgetState(" + JSON.stringify(s) + ")\\n";
      },
    }`,
  ),
);

writeFileSync(
  join(OUT_DIR, "2-reload-restored.html"),
  page(
    "2. Reload, with the fix",
    `ChatGPT's rehydration: <code>toolOutput</code> stripped to
     <code>{width:900,height:720}</code>, with widget state restored — what the
     host does on reload once page 1 has persisted.
     <span class="expect">Expect: the chart renders anyway, from the mirror.</span>
     Before this PR the stripped-but-truthy object won the selection and the
     widget collapsed.`,
    `{
      toolOutput: ${JSON.stringify(STRIPPED)},
      widgetState: ${JSON.stringify(PAYLOAD)},
      setWidgetState: function () {},
    }`,
  ),
);

writeFileSync(
  join(OUT_DIR, "3-reload-no-state.html"),
  page(
    "3. Reload, nothing to restore",
    `The same stripped <code>toolOutput</code>, but no widget state either — the
     worst case, and what every reload looked like before this PR.
     <span class="expect">Expect: the labelled empty state and a 0-height
     notification, NOT a spinner that never resolves.</span> This is the branch
     the fix must not break.`,
    `{
      toolOutput: ${JSON.stringify(STRIPPED)},
      setWidgetState: function () {},
    }`,
  ),
);

console.log(`wrote 3 pages to ${OUT_DIR}`);
console.log(`open ${join(OUT_DIR, "1-first-render.html")}`);
