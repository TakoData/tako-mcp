import { z } from "zod";

/**
 * String → array coercion for array-typed tool inputs.
 *
 * WHY: some MCP hosts hand us the array their model meant to send as a
 * STRING. Observed live from OpenBB Copilot on `tako_answer` — the host's own
 * argument panel displayed `sources` as the two-element array `["data","web"]`
 * while the wire carried the JSON *text* of that array, so the SDK's input
 * validation rejected the call before our handler ever ran:
 *
 *   MCP error -32602: Input validation error: Invalid arguments for tool
 *   tako_answer: [{"expected":"array","code":"invalid_type",
 *   "path":["sources"],"message":"Invalid input: expected array, received string"}]
 *
 * The model's next move after that error is to re-ask with a different
 * (still wrong) shape, or to abandon Tako and answer from a generic web
 * search — both charge the user a round trip for a request whose intent was
 * unambiguous. Accepting the string is strictly better than failing it.
 *
 * The forms accepted (a string only — anything else passes through untouched):
 *   '["data","web"]'  JSON-encoded array   → ["data","web"]   (the observed case)
 *   '{"id":"a"}'      JSON-encoded object  → [{"id":"a"}]     (a single item)
 *   'data,web'        comma-separated list → ["data","web"]
 *   'data'            single bare value    → ["data"]
 *
 * Coercion NEVER widens what is valid: it only reshapes, then hands off to the
 * wrapped array schema, which still enforces the item type, `min`/`max` and
 * everything else. A string that cannot be reshaped into an array (`''`,
 * `'[not json'`) is passed through unchanged so the caller gets the honest
 * "expected array, received string" for what they actually sent.
 *
 * Comma-splitting is deliberately unconditional, including for URL arrays: a
 * comma is legal-but-rare in a URL, and a specific "not a valid URL" beats a
 * blanket type error on the whole field.
 */
export function coerceStringToArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Looks like JSON but isn't. Don't guess — let the schema report it.
      return value;
    }
  }
  if (trimmed.includes(",")) {
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return parts.length > 0 ? parts : value;
  }
  return [trimmed];
}

/**
 * Wrap an array input schema so a stringified array is accepted.
 *
 * `z.preprocess` (not `z.union([array, string])`) on purpose: the SDK
 * publishes tool input schemas with `z.toJSONSchema(…, { io: "input" })`,
 * where a preprocess pipe serializes to the wrapped schema VERBATIM — same
 * `type: "array"`, same item enum, same `minItems`, `default` and
 * `description`. A union would publish `anyOf: [array, string]`, which both
 * advertises the sloppy form as legal (teaching every other client to send
 * it) and trips the hosts that reject `anyOf` in tool parameters. Leniency
 * belongs on the accepting side only, never in the contract. `_loose_array.test.ts`
 * asserts that published-schema equality.
 */
export function looseArray<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(coerceStringToArray, schema);
}
