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
 * That host cannot fix it upstream, which is why the coercion belongs here:
 * its documented MCP integration renders our JSON Schema into PROSE in the
 * system prompt (reading only `type` and `description` per param, dropping
 * `items` entirely) and exposes a single untyped
 * `execute_agent_tool(server_id, tool_name, parameters)` whose `parameters` is
 * `{"type":"object","additionalProperties":true}`. No schema reaches the model
 * natively, so no grammar constraint and no client-side validation can apply
 * anywhere in that chain. This server is the first component that knows
 * `sources` is an array of enums.
 *
 * ALWAYS accepted (any wrapped field):
 *   '["data","web"]'  JSON-encoded array → ["data","web"]   (the observed case)
 *   'data'            single bare value  → ["data"]
 *
 * OPT-IN, because each one is unsafe on the wrong item domain — see
 * `LooseArrayOptions`:
 *   'data,web'        comma-separated list → ["data","web"]  (commaSeparated)
 *   '{"id":"a"}'      JSON-encoded object  → [{"id":"a"}]    (jsonObjectAsItem)
 *
 * Coercion NEVER widens what is valid: it only reshapes, then hands off to the
 * wrapped array schema, which still enforces the item type, `min`/`max` and
 * everything else. A string that cannot be reshaped (`''`, `'[not json'`, or a
 * JSON object where `jsonObjectAsItem` is off) is passed through UNCHANGED, so
 * the caller gets the honest "expected array, received string" naming the
 * mistake they actually made.
 *
 * SCOPE: top-level array inputs only. Arrays nested inside an object item
 * (`components[].config.datasets` and friends in `tako_visualize`) are not
 * wrapped, and do not need to be for the observed failure: a host that
 * stringifies the whole `components` array yields correctly typed nested
 * values once this parses it. A host that stringifies ONLY a nested field is
 * not a shape we have seen. `_loose_array.test.ts` states that boundary as an
 * assertion rather than leaving it implied.
 */
export type LooseArrayOptions = {
  /**
   * `"<tool>.<field>"`, e.g. `"tako_answer.sources"` — identifies the coercion
   * in the Workers Logs line (see `warnCoerced`). Required, not derived: a zod
   * preprocess has no access to the tool it was registered under, and the
   * whole point of the log is knowing WHICH shape reaches which tool.
   * `_loose_array.test.ts` asserts the suffix matches the real property key,
   * so a renamed field cannot silently keep a stale label.
   */
  field: string;
  /**
   * Split a bare string on commas. **Closed-enum item domains ONLY.**
   *
   * Not the default, because it silently corrupts any item type that can
   * legitimately contain a comma. `tako_contents.urls` is the proof: its item
   * schema is `ContentsRequest.shape.url`, a bare `z.string()` with NO url
   * format check, so `'https://en.wikipedia.org/wiki/Washington,_D.C.'` split
   * into `['https://en.wikipedia.org/wiki/Washington', '_D.C.']` — both halves
   * pass `.min(1)`, and the handler fans them out as two independently BILLED
   * subrequests, handing the model a different city's page as the payload. No
   * validation error can catch that, because nothing in that path validates
   * URL syntax.
   *
   * A closed enum has no such hazard: no member of `["data","web","tako"]`
   * contains a comma, so every part either matches a member or fails loudly.
   */
  commaSeparated?: boolean;
  /**
   * Accept a single JSON-encoded object as a one-item array. **Object item
   * domains ONLY** (`tako_visualize.components`).
   *
   * Not the default, because on a primitive item domain it can never validate,
   * and it degrades the very error the model is meant to self-correct from.
   * `sources: '{"data":{},"web":{}}'` is a plausible guess — our own
   * descriptions discuss the nested per-source wire shape — and wrapping it
   * turns `sources: expected array, received string` (which names the real
   * mistake) into an invalid enum value at `sources[0]`, inviting the model to
   * fix element 0 of an array it never sent.
   */
  jsonObjectAsItem?: boolean;
};

/**
 * Which reshaping rule fired. Logged INSTEAD of the value: a coerced field can
 * hold a user's URLs or query terms, and the form plus item count is what
 * actually sizes the problem (which shapes arrive, on which tools, and whether
 * the sibling scalar gap is worth closing).
 */
type CoercionForm = "json-array" | "json-object" | "comma-list" | "bare-value";

function warnCoerced(field: string, form: CoercionForm, items: number): void {
  // Mirrors the `[mcp] invalid params (-32602)` tap in mcp.ts, which exists so
  // argument problems surface in Workers Logs instead of only as user
  // complaints. Coercing silently would remove that signal for exactly the
  // class this module targets: after deploy there would be no way to tell
  // whether real traffic recovered, or which hosts send which shape.
  console.warn(`[mcp] input coerced field=${field} from=${form} items=${items}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reshape a stringified array into an array. Exported for unit tests;
 * `looseArray` is what tool files use.
 */
export function coerceStringToArray(
  value: unknown,
  options: LooseArrayOptions,
): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;

  // JSON-shaped input is parsed or given up on — never comma-split. Splitting
  // `{"data":{},"web":{}}` on commas yields fragments that each fail as an
  // item, burying the actual mistake under two bogus per-item errors.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return value; // looks like JSON, isn't. Let the schema report it.
    }
    if (Array.isArray(parsed)) {
      warnCoerced(options.field, "json-array", parsed.length);
      return parsed;
    }
    if (options.jsonObjectAsItem === true && isPlainObject(parsed)) {
      warnCoerced(options.field, "json-object", 1);
      return [parsed];
    }
    return value;
  }

  if (options.commaSeparated === true && trimmed.includes(",")) {
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length === 0) return value;
    warnCoerced(options.field, "comma-list", parts.length);
    return parts;
  }

  warnCoerced(options.field, "bare-value", 1);
  return [trimmed];
}

/**
 * The wrapped → inner schema map, so the suite can assert the published JSON
 * Schema of every SHIPPED wrapped field against the same field unwrapped.
 *
 * That equality is this module's load-bearing claim (leniency must never reach
 * the advertised contract) and it holds for a reason narrow enough to break on
 * a dependency bump: on zod 4.4.2 `$ZodPreprocess` re-derives BOTH `optin` and
 * `optout` from `def.out`, overriding the `$ZodPipe` inheritance that would
 * otherwise move `required` for the `.optional()` fields (`node_ids`, `urls`).
 * A WeakMap keyed on the wrapper is how the guard reaches the inner schema
 * without poking zod internals itself.
 */
const INNER_SCHEMAS = new WeakMap<z.ZodType, z.ZodType>();
const FIELD_LABELS = new WeakMap<z.ZodType, string>();

/** The schema a `looseArray` wraps, or undefined if it is not a wrapper. */
export function unwrapLooseArray(schema: unknown): z.ZodType | undefined {
  return INNER_SCHEMAS.get(schema as z.ZodType);
}

/** The `field` label a `looseArray` was declared with. For the guard. */
export function looseArrayField(schema: unknown): string | undefined {
  return FIELD_LABELS.get(schema as z.ZodType);
}

/**
 * Wrap an array input schema so a stringified array is accepted.
 *
 * `z.preprocess` (not `z.union([array, string])`) on purpose: the SDK
 * publishes tool input schemas with `z.toJSONSchema(…, { io: "input" })`,
 * where a preprocess pipe serializes to the wrapped schema VERBATIM — same
 * `type: "array"`, same item enum, same `minItems`, `default`, `description`
 * and `required`. A union would publish `anyOf: [array, string]`, which both
 * advertises the sloppy form as legal (teaching every other client to send it)
 * and trips the hosts that reject `anyOf` in tool parameters. Leniency belongs
 * on the accepting side only, never in the contract.
 */
export function looseArray<Schema extends z.ZodType>(
  schema: Schema,
  options: LooseArrayOptions,
) {
  const wrapped = z.preprocess(
    (value) => coerceStringToArray(value, options),
    schema,
  );
  INNER_SCHEMAS.set(wrapped as unknown as z.ZodType, schema);
  FIELD_LABELS.set(wrapped as unknown as z.ZodType, options.field);
  return wrapped;
}
