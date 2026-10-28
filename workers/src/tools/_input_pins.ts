import type { z } from "zod";

import type { Surface } from "../surface.js";
import { inputSchemaForSurface } from "./_surface.js";
import type { AnyToolModule } from "./types.js";

export const SOURCE_VALUES = ["data", "web"] as const;
export type Source = (typeof SOURCE_VALUES)[number];

/** Tool inputs a `/mcp` URL fixes for the whole connection, keyed by MCP input name. */
export interface InputPins {
  readonly sources?: readonly Source[];
}
export type PinName = keyof InputPins;
export type PinValue<K extends PinName> = NonNullable<InputPins[K]>;

export const NO_PINS: InputPins = {};

export type InputPinsResult =
  | { ok: true; pins: InputPins }
  | { ok: false; parameter: PinName; message: string };

/** How one tool applies one pinned input: its schema, its input, and its description. */
export interface InputPinApplier<V> {
  schema(schema: z.ZodObject<z.ZodRawShape>, value: V): z.ZodObject<z.ZodRawShape>;
  input(input: Record<string, unknown>, value: V): Record<string, unknown>;
  description(value: V): string;
  note: string;
}

export type InputPinAppliers = { readonly [K in PinName]?: InputPinApplier<PinValue<K>> };

interface PinDefinition<K extends PinName> {
  readonly accepted: string;
  parse(tokens: readonly string[]): PinValue<K> | undefined;
}

const isSource = (token: string): token is Source =>
  (SOURCE_VALUES as readonly string[]).includes(token);

const PIN_DEFINITIONS: { readonly [K in PinName]: PinDefinition<K> } = {
  sources: {
    accepted: "data, web, or data,web",
    parse: (tokens) =>
      tokens.every(isSource) ? SOURCE_VALUES.filter((source) => tokens.includes(source)) : undefined,
  },
};

const PIN_NAMES = Object.keys(PIN_DEFINITIONS) as PinName[];

const ECHOED_VALUE_LIMIT = 200;

/**
 * Read every pinnable parameter off a `/mcp` URL. Values parse like
 * `?tools=`: repeats join, commas split, and tokens trim and lowercase.
 * Unknown parameter names are ignored.
 */
export function readInputPins(url: URL): InputPinsResult {
  const pins: { -readonly [K in PinName]?: InputPins[K] } = {};
  for (const name of PIN_NAMES) {
    const values = url.searchParams.getAll(name);
    if (values.length === 0) continue;
    const raw = values.join(",");
    const tokens = raw
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "");
    const definition = PIN_DEFINITIONS[name];
    if (tokens.length === 0) {
      return {
        ok: false,
        parameter: name,
        message: `The "${name}" URL parameter is empty. Use ${definition.accepted}.`,
      };
    }
    const value = definition.parse(tokens);
    if (value === undefined) {
      return {
        ok: false,
        parameter: name,
        message: `The "${name}" URL parameter has an invalid value: "${raw.slice(0, ECHOED_VALUE_LIMIT)}". Use ${definition.accepted}.`,
      };
    }
    pins[name] = value;
  }
  return { ok: true, pins };
}

export function describePins(pins: InputPins): string {
  const described = PIN_NAMES.flatMap((name) => {
    const value = pins[name];
    return value === undefined ? [] : [`${name}=${value.join(",")}`];
  });
  return described.length === 0 ? "(none)" : described.join(" ");
}

/** The applier for a plain input: the pin removes the field from the schema and sets it on every call. */
export function pinnedField<K extends PinName>(
  name: K,
  description: (value: PinValue<K>) => string,
): InputPinApplier<PinValue<K>> {
  return {
    schema: (schema) => schema.omit({ [name]: true }),
    input: (input, value) => ({ ...input, [name]: value }),
    description,
    note: `Pins \`${name}\` for the whole connection: the input leaves this tool's schema, and every call sends the pinned value.`,
  };
}

type PinnableTool = Pick<AnyToolModule, "inputPins">;

type AppliedPin = {
  [K in PinName]: { applier: InputPinApplier<PinValue<K>>; value: PinValue<K> };
}[PinName];

function appliedPins(tool: PinnableTool, surface: Surface, pins: InputPins): AppliedPin[] {
  if (surface === "chatgpt") return [];
  return PIN_NAMES.flatMap((name) => {
    const applier = tool.inputPins?.[name];
    const value = pins[name];
    return applier === undefined || value === undefined ? [] : [{ applier, value }];
  });
}

export function inputSchemaForConnection(
  tool: Pick<AnyToolModule, "inputSchema" | "inputSchemaBySurface" | "inputPins">,
  surface: Surface,
  pins: InputPins,
): z.ZodObject<z.ZodRawShape> {
  return appliedPins(tool, surface, pins).reduce(
    (schema, pin) => pin.applier.schema(schema, pin.value),
    inputSchemaForSurface(tool, surface),
  );
}

export function descriptionForConnection(
  tool: Pick<AnyToolModule, "description" | "inputPins">,
  surface: Surface,
  pins: InputPins,
): string {
  const [first] = appliedPins(tool, surface, pins);
  return first === undefined ? tool.description : first.applier.description(first.value);
}

export function applyInputPins(
  tool: PinnableTool,
  surface: Surface,
  pins: InputPins,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return appliedPins(tool, surface, pins).reduce(
    (pinned, pin) => pin.applier.input(pinned, pin.value),
    input,
  );
}

/** The pins that at least one of `tools` declares; the rest have nothing to apply to. */
export function effectivePins(tools: Iterable<PinnableTool>, pins: InputPins): InputPins {
  const toolList = [...tools];
  const effective: { -readonly [K in PinName]?: InputPins[K] } = {};
  for (const name of PIN_NAMES) {
    const value = pins[name];
    if (value !== undefined && toolList.some((tool) => tool.inputPins?.[name] !== undefined)) {
      effective[name] = value;
    }
  }
  return effective;
}
