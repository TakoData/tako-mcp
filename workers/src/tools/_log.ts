/**
 * Server-side breadcrumbs for tool-level failures.
 *
 * Every wire-contract guard in this directory throws client-facing prose
 * ("unexpected shape — retry once…") while discarding the diagnostic that
 * would identify the drift: the zod issue paths and the upstream
 * `request_id`. That is exactly how a silent backend rename (`format` →
 * `content_format`, see `_search_results.ts`) became a total outage with
 * zero server-side signal. Workers observability is enabled with full
 * retention (`wrangler.jsonc`), so one `console.error` here is the
 * difference between "which field drifted, on which request" and
 * redeploy-and-guess.
 *
 * Client-facing error text stays generic by design (no internal URLs, no
 * zod dumps — see Safety Rules in AGENTS.md); the detail belongs here.
 *
 * Runbook grep: `wrangler tail <worker> --search "wire-guard"`.
 */

/** Structural slice of a zod error — avoids coupling to a zod version. */
interface ZodIssueLike {
  path: ReadonlyArray<string | number | symbol>;
  message: string;
}
interface ZodErrorLike {
  issues: ReadonlyArray<ZodIssueLike>;
}

const MAX_ISSUES = 5;
const MAX_ISSUES_CHARS = 600;

/**
 * Pull the upstream correlation id out of a raw wire payload, if present.
 *
 * Read by BOTH loggers below — the failure breadcrumb and
 * `logToolRequestId`. That second caller matters: the id no longer ships in
 * either response channel (see the `_render_markdown.ts` docstring — OpenAI
 * app review treats request/trace ids as not-to-be-returned), so these log
 * lines are the only remaining route to it.
 */
function requestIdOf(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "request_id" in raw) {
    const id = (raw as { request_id: unknown }).request_id;
    if (typeof id === "string" && id !== "") return id;
  }
  return "(none)";
}

function issueSummary(error: ZodErrorLike | undefined): string {
  if (error === undefined || error.issues.length === 0) return "(none)";
  const shown = error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const extra = error.issues.length - MAX_ISSUES;
  const suffix = extra > 0 ? ` (+${extra} more)` : "";
  // JSON.stringify neutralizes control characters (log-injection guard —
  // zod messages can echo upstream-controlled strings).
  return JSON.stringify(shown.slice(0, MAX_ISSUES_CHARS) + suffix);
}

/**
 * Log a failed wire-contract guard before throwing the client-facing error.
 *
 * @param tool  Tool name (e.g. "tako_search").
 * @param stage Which guard failed (e.g. "SearchResponse", "output-normalise").
 * @param error The failed safeParse's `.error`, when the guard was a zod
 *              parse; omit for structural checks (missing card_id, etc.).
 * @param raw   The raw wire payload, used only to extract `request_id` for
 *              backend-trace correlation. Never logged wholesale.
 */
export function logWireGuardFailure(
  tool: string,
  stage: string,
  error?: ZodErrorLike,
  raw?: unknown,
): void {
  console.error(
    `[tako] wire-guard failed tool=${tool} stage=${stage} request_id=${requestIdOf(raw)} issues=${issueSummary(error)}`,
  );
}

/**
 * Log a SUCCESSFUL call's upstream `request_id`.
 *
 * The counterpart to removing the id from tool responses. A caller who
 * reports a bad result can no longer quote a request_id, so this line is how
 * a report gets tied to a backend request — matched on tool + client +
 * timestamp instead. Silent (no line at all) when the output carries no id:
 * several tools' payloads have none, and `request_id=(none)` on every one of
 * them would be noise in the same log the runbook greps.
 *
 * Runbook grep: `wrangler tail <worker> --search "request_id="`.
 */
export function logToolRequestId(tool: string, client: string, output: unknown): void {
  const id = requestIdOf(output);
  if (id === "(none)") return;
  // JSON.stringify neutralizes control characters — the id is upstream-
  // controlled, and this is the same log a human reads by eye.
  console.log(`[tako] tool=${tool} client=${client} request_id=${JSON.stringify(id)}`);
}
