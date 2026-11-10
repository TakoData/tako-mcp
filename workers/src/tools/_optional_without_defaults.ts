/**
 * `optionalWithoutDefaults`: derive a tool's input fields from a generated
 * request schema without the defaults that schema carries.
 *
 * `tako_search_advanced` and the enrichment tools build their inputs from the
 * generated schemas so the set can't drift from the API. `.partial()` alone
 * isn't enough for that: zod keeps the inner `ZodDefault`, so an omitted field
 * parses back with a value the caller never chose and the handler sends it.
 *
 * `_`-prefixed so `gen-registry.ts` skips it: this isn't a tool module.
 */
import { z } from "zod";

import { looseArray, type LooseArrayOptions } from "./_loose_array.js";

/** How one array input accepts a host's stringified array: see `_loose_array.ts`. */
export type ArrayInputOptions = Omit<LooseArrayOptions, "field">;

/** A tool's top-level array inputs, which `_loose_array.test.ts` requires to be wrapped. */
export interface ArrayInputs<Key extends string> {
  /** The tool's name, for the `<tool>.<field>` label a coercion logs. */
  tool: string;
  fields: Partial<Record<Key, ArrayInputOptions>>;
}

/**
 * Make every field of a generated schema optional AND drop the default it
 * carries, so an omitted field never reaches the wire.
 *
 * `.partial()` on its own leaves `ZodOptional<ZodDefault<T>>`, and the default
 * still fires when the key is absent from a block the caller DID name. That is
 * how `data: {}` came back carrying four values on `tako_search_advanced`.
 *
 * `describes` replaces a field's generated description. `arrays` wraps the
 * named fields in `looseArray`; leave it out for a shape with no top-level
 * array input.
 *
 * ONE LEVEL ONLY. A field whose VALUE is an object keeps that object's own
 * generated defaults, and the generated schemas wrap every such field as
 * `z.union([z.lazy(() => T), z.null()])`, so no amount of unwrapping here
 * reaches `T`. `output_settings` on `tako_search_advanced` is the one field
 * that hits this and that tool rebuilds it by hand; `noDefaultsLeak` in
 * `tako_search_advanced.test.ts` fails when the backend adds a second one, and
 * `_optional_without_defaults.test.ts` pins the limit itself.
 */
export function optionalWithoutDefaults<T extends z.ZodRawShape>(
  shape: T,
  describes: Partial<Record<keyof T & string, string>> = {},
  arrays?: ArrayInputs<keyof T & string>,
): {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]>;
} {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    const bare = field instanceof z.ZodDefault ? field.unwrap() : field;
    const override = describes[key as keyof T & string];
    const optional =
      override === undefined ? (bare as z.ZodType).optional() : (bare as z.ZodType).describe(override).optional();
    const array = arrays?.fields[key as keyof T & string];
    out[key] =
      array === undefined || arrays === undefined
        ? optional
        : looseArray(optional, { ...array, field: `${arrays.tool}.${key}` });
  }
  return out as never;
}
