# Opt-in Tako agent via the `tools` parameter — Design

**Date:** 2026-07-18
**Branch:** `feat/opt-in-agent-via-tools-param`
**Status:** Approved design — ready for implementation plan

## Problem

The Tako MCP registers the Answer Agent (`tako_agent`, and its ChatGPT split
pair `tako_agent_start` / `tako_agent_wait`) by default on every connection.
The agent is a slow (~30–90 s), opinionated, multi-step research tool — the
right choice for some questions, but not a sensible *default* alongside the
fast one-shot tools (`tako_search`, `tako_answer`). We want the agent to be
**opt-in**: off unless a connection explicitly asks for it, enabled the
standard MCP way via a `tools` query parameter on the server URL — mirroring
how Exa exposes its optional tools (`?tools=agent_tools`).

## Goals

- Make the agent feature opt-in, off by default.
- Enable it per-connection with `.../mcp?tools=agent`.
- Keep the change additive and backward-compatible for the *mechanism*: a URL
  with no `tools` param still returns the full default tool set (now minus the
  agent).
- Preserve the existing per-client agent behavior: when enabled, Claude/unknown
  clients get single-call `tako_agent`; ChatGPT gets the `tako_agent_start` /
  `tako_agent_wait` split.

## Non-goals

- Making any other tool opt-in. Only the three agent tools move behind the
  flag. Everything else (`tako_search`, `tako_answer`, `tako_contents`,
  `tako_visualize`, `tako_graph_node`, `tako_graph_related`,
  `tako_graph_search`, `get_credit_balance`) stays default.
- A general per-tool enable/disable framework. We build exactly the alias the
  agent needs; the mapping is structured so more optional tools can be added
  later, but we do not design a broader system now.
- Accepting raw tool names in the param (e.g. `?tools=tako_agent`). Only the
  `agent` alias is recognized (see Decisions).
- Marking tools optional in `registry/server.json`. Discovery continues to list
  every tool; runtime filters per request (existing precedent).

## Decisions (resolved during brainstorming)

1. **Enable syntax — alias `agent`.** `?tools=agent` enables the feature; the
   server picks the client-appropriate variant. Chosen over enumerating the
   three tool names so the client-split implementation detail stays hidden from
   users. Raw tool names are intentionally *not* recognized.
2. **Param semantics — additive opt-in.** The `tools` param only *adds* opt-in
   tools on top of the default set. It is not an allowlist; it never removes a
   default tool. No param = current default set minus the agent.

## Behavior

| URL | Claude / unknown clients | ChatGPT |
|---|---|---|
| `.../mcp` | all defaults, **no agent** | all defaults, no agent |
| `.../mcp?tools=agent` | defaults **+ `tako_agent`** | defaults **+ `tako_agent_start` / `tako_agent_wait`** |

The `agent` alias expands to all three agent tool names; the existing
client-split filters in `mcp.ts` (`CHATGPT_ONLY_TOOL_NAMES`,
`CHATGPT_EXCLUDED_TOOL_NAMES`) then narrow to the correct variant per client.

## Architecture

### New module: `workers/src/tools/_optional.ts`

Single source of truth for optional-tool aliases and param parsing. The
underscore prefix keeps it out of the tool scan in `gen-registry.ts` and out of
the `_registry.ts` barrel (it is not a tool module). It mirrors the existing
pattern of centralizing tool-name sets in `mcp.ts`.

```ts
/** Alias → the tool names it enables. `agent` spans the single-call tool and
 *  the ChatGPT split pair; the client filters in mcp.ts narrow per request. */
export const OPTIONAL_TOOL_ALIASES = {
  agent: ["tako_agent", "tako_agent_start", "tako_agent_wait"],
} as const;

/** Flattened set of every tool name that is opt-in (excluded unless enabled). */
export const OPTIONAL_TOOL_NAMES: ReadonlySet<string> =
  new Set(Object.values(OPTIONAL_TOOL_ALIASES).flat());

/**
 * Parse the raw `tools` query-param value into the set of opt-in tool names to
 * register. Tokens are comma-separated, trimmed, lowercased, de-duplicated.
 * Only known aliases are recognized; unknown tokens are ignored (and logged),
 * never fatal — a typo must not break `initialize`.
 */
export function parseEnabledOptionalToolNames(param: string | null): Set<string>;
```

Parsing rules, precisely:
- `null` / empty / whitespace-only → empty set.
- Split on `,`; for each token: `trim().toLowerCase()`.
- Drop empty tokens.
- If the token is a key of `OPTIONAL_TOOL_ALIASES`, add all its tool names.
- Otherwise ignore it and `console.log` a single line noting the unknown token
  (observability via `wrangler tail`).
- Result is the union of tool names across all recognized aliases.

### Request flow (`mcp.ts` + `index.ts`)

1. `handleMcpRequest` already has the `Request`. Read the param:
   `const enabledOptionalToolNames = parseEnabledOptionalToolNames(new URL(request.url).searchParams.get("tools"));`
2. Pass it into `createMcpServer(ctx, { iconsBaseUrl, client, enabledOptionalToolNames })`.
   Add `enabledOptionalToolNames?: Set<string>` to the options type (default:
   empty set when omitted, so tests and non-HTTP callers behave as "nothing
   opted in").
3. In the registration loop in `createMcpServer` (currently `mcp.ts:217`), add
   one gate **before** the existing ChatGPT filters:

   ```ts
   for (const tool of TOOL_REGISTRY) {
     // Opt-in gate: optional tools are excluded unless enabled via ?tools=.
     if (OPTIONAL_TOOL_NAMES.has(tool.name) && !enabledOptionalToolNames.has(tool.name)) {
       continue;
     }
     if (CHATGPT_ONLY_TOOL_NAMES.has(tool.name) && client !== "chatgpt") continue;
     if (CHATGPT_EXCLUDED_TOOL_NAMES.has(tool.name) && client === "chatgpt") continue;
     registerTool(/* ... */);
   }
   ```

   Ordering matters only for clarity, not correctness — the gates are
   independent skips. Placing the opt-in gate first documents intent: "is this
   tool even allowed on this connection?" before "which client variant?".

No change to `registerTool`, the tool modules themselves, the SDK wiring, or
the OAuth path. The connector URL a user configures simply carries
`?tools=agent`; OAuth resource identification is unaffected (the query string is
not part of the protected-resource URL).

## Discovery / registry

`registry/server.json` continues to list all eleven tools. This matches the
existing precedent documented in `mcp.ts` for the ChatGPT-split tools: the
registry lists everything for discovery, and the runtime filters per request.
No `gen-registry.ts` or `MCP_TOOL_ALLOWLIST` change is required — the agent
tool files still exist and are still scanned.

## Documentation

Update user-facing docs to describe enabling the agent (scope: this PR):
- `README.md` — an "Enabling the Tako agent" note showing `.../mcp?tools=agent`.
- `llms.txt` / `llms-full.txt` — same, in the agent-tool section.
- `AGENTS.md` — note that the agent is opt-in and how to turn it on.

## Backward-compatibility / rollout ⚠️

This is a **behavior change**, not merely additive from the caller's view:
connectors that currently receive `tako_agent` by default will stop seeing it
until they append `?tools=agent` to their MCP URL. This is the intended product
change (the agent should not be a default). It must be called out in the PR
description and release notes so existing installs know how to re-enable the
agent.

## Testing

### Unit — `workers/src/tools/_optional.test.ts` (new)
`parseEnabledOptionalToolNames`:
- `null` → empty set.
- `""` / `"   "` → empty set.
- `"agent"` → `{tako_agent, tako_agent_start, tako_agent_wait}`.
- `" Agent "` (whitespace + case) → same three.
- `"agent,agent"` (dupes) → same three, no duplicates.
- `"nope"` (unknown) → empty set.
- `"agent,nope"` → the three agent names (unknown dropped).
- `OPTIONAL_TOOL_NAMES` equals the flattened alias values.

### Integration — `workers/src/index.test.ts` (extend)
The end-to-end `tools/list` assertions live here (not `mcp.test.ts`, which only
covers `djangoErrorToToolResult`) — this is where the existing default-set and
ChatGPT-split tests already drive `POST /mcp` via `SELF.fetch`. Extend / update
those to reflect opt-in behavior:
- No `?tools=` (default), non-ChatGPT UA: none of the three agent tools appear;
  the 8 non-agent defaults do. (Updates the existing default-set test.)
- No `?tools=`, ChatGPT UA: no agent tools at all (8 defaults only).
- `?tools=agent`, non-ChatGPT UA → `tako_agent` present; split pair absent (9).
- `?tools=agent`, ChatGPT UA → `tako_agent_start` + `tako_agent_wait` present;
  `tako_agent` absent — existing exclusion still applies (10).
- Non-agent defaults present in every case above.

## Files touched

- `workers/src/tools/_optional.ts` — **new**: aliases, `OPTIONAL_TOOL_NAMES`,
  `parseEnabledOptionalToolNames`.
- `workers/src/tools/_optional.test.ts` — **new**: parser unit tests.
- `workers/src/mcp.ts` — import from `_optional`, add `enabledOptionalToolNames`
  to `createMcpServer` options + the opt-in gate; parse the param in
  `handleMcpRequest`.
- `workers/src/index.test.ts` — end-to-end `tools/list` assertions (updated the
  default-set + ChatGPT-split tests; added no-param and `?tools=agent` cases).
- `README.md`, `llms.txt`, `llms-full.txt`, `AGENTS.md` — enabling docs.

## Open questions

None. Scope and both config decisions are resolved.
