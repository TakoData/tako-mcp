#!/usr/bin/env tsx
/**
 * Drive the REAL `tako_available_data` handler against a live backend and print
 * exactly what an MCP client would receive.
 *
 * Distinct from `pair-confirm-eval.ts`, which REIMPLEMENTS the decision logic
 * to measure it in bulk. This one imports the tool module itself and calls
 * `handler` → `renderText` → `slimStructured`, so what you read is what the
 * model reads: the markdown text channel, the structuredContent, the node ids
 * and the runnable next_call. No wrangler, no deploy — the handler only needs a
 * token and a `DJANGO_BASE_URL`.
 *
 * Free: `tako_available_data` only touches the graph endpoints.
 *
 * Usage:
 *   TAKO_API_TOKEN=... npx tsx scripts/available-data-live.ts
 *   ... "Lockheed Martin" "backlog"        (one ad-hoc pair)
 *   ... --base https://staging.tako.com
 *   ... --json                             (structuredContent only)
 */
import type { Env } from "../src/env.js";
import type { ToolContext } from "../src/tools/types.js";
import takoAvailableData from "../src/tools/tako_available_data.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = flag("--base") ?? "https://tako.com";
const JSON_ONLY = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--") && a !== BASE);

const TOKEN = process.env["TAKO_API_TOKEN"];
if (TOKEN === undefined || TOKEN === "") {
  console.error("TAKO_API_TOKEN is required.");
  process.exit(1);
}

const ctx: ToolContext = {
  token: TOKEN,
  env: { DJANGO_BASE_URL: BASE } as Env,
  sendProgress: async () => {
    /* no-op: no MCP transport here */
  },
  surface: "generic",
};

// The cases that make the difference visible: one clean confirmation, the
// unlinked catches, and two false claims the probe does NOT catch.
const DEFAULT_CASES: Array<[string, string]> = [
  ["Apple", "gross margin"],
  ["Lockheed Martin", "backlog"],
  ["Pfizer", "R&D expense"],
  ["Boeing", "aircraft deliveries"],
  ["Netflix", "paid subscribers"],
];

const cases: Array<[string, string]> =
  positional.length >= 2
    ? [[positional[0] as string, positional[1] as string]]
    : DEFAULT_CASES;

async function main(): Promise<void> {
  for (const [q, metric] of cases) {
    const started = Date.now();
    let out: Awaited<ReturnType<typeof takoAvailableData.handler>>;
    try {
      out = await takoAvailableData.handler({ q, metric }, ctx);
    } catch (err) {
      console.error(`\n### ${q} / ${metric}\n  THREW: ${String(err)}`);
      continue;
    }
    const ms = Date.now() - started;
    const structured = takoAvailableData.slimStructured?.(out) ?? {};

    if (JSON_ONLY) {
      console.log(JSON.stringify({ q, metric, ms, structured }, null, 2));
      continue;
    }

    console.log(`\n${"=".repeat(72)}`);
    console.log(`tako_available_data  q=${JSON.stringify(q)}  metric=${JSON.stringify(metric)}   (${ms}ms)`);
    console.log("=".repeat(72));
    console.log(`\n--- verdict -------------------------------------------------`);
    console.log(`  found:    ${out.found}`);
    console.log(`  verified: ${out.verified ?? "(absent)"}`);
    console.log(`  entity:   ${out.entity?.name ?? "—"}  ${out.entity?.node_id ?? ""}`);
    console.log(`  metric:   ${out.metric?.name ?? "—"}  ${out.metric?.node_id ?? ""}`);
    console.log(`  next_call:${out.next_call === null ? " null" : ""}`);
    if (out.next_call !== null) console.log(`    ${JSON.stringify(out.next_call)}`);
    console.log(`\n--- text channel (what the model actually reads) -------------`);
    console.log(
      (takoAvailableData.renderText?.(out, ctx) ?? "(no renderText)")
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log(`\n--- structuredContent ---------------------------------------`);
    console.log(
      JSON.stringify(structured, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
}

await main();
