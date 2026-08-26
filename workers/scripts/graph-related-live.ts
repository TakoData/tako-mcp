#!/usr/bin/env tsx
/**
 * Measure what the model receives from `tako_graph_related`, live, before and
 * after slimming: raw API chars vs the rendered text and structuredContent.
 *
 * Free: graph endpoints only. Needs a token and a base URL.
 *
 * Usage:
 *   TAKO_API_TOKEN=... npx tsx scripts/graph-related-live.ts
 *   ... "Anthropic" "NVIDIA"                (entity names; resolved via tako_available_data)
 *   ... --base https://staging.tako.com     (default https://tako.com)
 */
import type { Env } from "../src/env.js";
import type { ToolContext } from "../src/tools/types.js";
import takoAvailableData from "../src/tools/tako_available_data.js";
import takoGraphRelated from "../src/tools/tako_graph_related.js";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? (args[baseIdx + 1] ?? "https://tako.com") : "https://tako.com";
const names = args.filter((a, i) => !a.startsWith("--") && i !== baseIdx + 1);
const TOKEN = process.env["TAKO_API_TOKEN"];
if (TOKEN === undefined || TOKEN === "") {
  console.error("TAKO_API_TOKEN is required.");
  process.exit(1);
}
const ctx: ToolContext = {
  token: TOKEN,
  env: { DJANGO_BASE_URL: BASE } as Env,
  sendProgress: async () => {
    /* no transport */
  },
  surface: "generic",
};
const CASES = names.length > 0 ? names : ["Anthropic", "NVIDIA", "Duolingo", "Crocs", "Nigeria", "Bhutan"];

async function rawChars(query: Record<string, string>): Promise<number> {
  const url = new URL("/api/v1/graph/related", BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "X-API-Key": TOKEN as string } });
  return (await r.text()).length;
}

for (const name of CASES) {
  const resolved = await takoAvailableData.handler({ q: name, types: "entity" }, ctx);
  const nodeId = resolved.matches[0]?.node_id;
  if (nodeId === undefined) {
    console.log(`${name}: no entity resolved`);
    continue;
  }
  for (const input of [{ node_id: nodeId }, { node_id: nodeId, relation: "metrics" }]) {
    const raw = await rawChars(input);
    const out = await takoGraphRelated.handler(input, ctx);
    const text = takoGraphRelated.renderText(out, ctx);
    const structured = JSON.stringify(out);
    const mode = "relation" in input ? "drill:metrics" : "overview";
    console.log(
      `${name} [${mode}] raw=${raw} text=${text.length} structured=${structured.length} groups=${out.relations?.length ?? "-"} items=${out.relation?.items.length ?? "-"}`,
    );
  }
}
