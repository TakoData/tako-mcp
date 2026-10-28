import type { z } from "zod";

import type { Surface } from "../surface.js";
import { inputSchemaForSurface } from "./_surface.js";
import { listParamTokens, readListParam } from "./_tools_param.js";
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

/** Whether a connection that applies `pins` returns results from `source`. */
export function reachesSource(pins: InputPins | undefined, source: Source): boolean {
  return pins?.sources === undefined || pins.sources.includes(source);
}

/** The one source a `sources` value names, or `undefined` when it names both. */
export function soleSource(sources: readonly Source[]): Source | undefined {
  return sources.length === 1 ? sources[0] : undefined;
}

export type InputPinsResult =
  | { ok: true; pins: InputPins }
  | { ok: false; parameter: PinName; message: string };

/** How one tool applies one pinned input: its schema and its input. */
export interface InputPinApplier<V> {
  schema(schema: z.ZodObject<z.ZodRawShape>, value: V): z.ZodObject<z.ZodRawShape>;
  input(input: Record<string, unknown>, value: V): Record<string, unknown>;
  note: string;
}

export type InputPinAppliers = { readonly [K in PinName]?: InputPinApplier<PinValue<K>> };

interface PinDefinition<K extends PinName> {
  readonly accepted: string;
  readonly values: readonly PinValue<K>[];
  parse(tokens: readonly string[]): PinValue<K> | undefined;
}

const isSource = (token: string): token is Source =>
  (SOURCE_VALUES as readonly string[]).includes(token);

const PIN_DEFINITIONS: { readonly [K in PinName]: PinDefinition<K> } = {
  sources: {
    accepted: "data, web, or data,web",
    values: [["data"], ["web"], ["data", "web"]],
    parse: (tokens) =>
      tokens.every(isSource) ? SOURCE_VALUES.filter((source) => tokens.includes(source)) : undefined,
  },
};

const PIN_NAMES = Object.keys(PIN_DEFINITIONS) as PinName[];

/** Each accepted value of each pinnable input, as one-pin `InputPins`. */
export function everySinglePin(): InputPins[] {
  return PIN_NAMES.flatMap((name) => PIN_DEFINITIONS[name].values.map((value) => ({ [name]: value })));
}

const ECHOED_VALUE_LIMIT = 200;

/**
 * Read every pinnable parameter off a `/mcp` URL. Values parse like
 * `?tools=`: repeats join, commas split, and tokens trim and lowercase.
 * Unknown parameter names are ignored.
 */
export function readInputPins(url: URL): InputPinsResult {
  const pins: { -readonly [K in PinName]?: InputPins[K] } = {};
  for (const name of PIN_NAMES) {
    if (!url.searchParams.has(name)) continue;
    const raw = readListParam(url, name) ?? "";
    const tokens = listParamTokens(raw);
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
export function pinnedField<K extends PinName>(name: K): InputPinApplier<PinValue<K>> {
  return {
    schema: (schema) => schema.omit({ [name]: true }),
    input: (input, value) => ({ ...input, [name]: value }),
    note: `Pins \`${name}\` for the whole connection: the input leaves this tool's schema, and every call sends the pinned value.`,
  };
}

type PinnableTool = Pick<AnyToolModule, "inputPins">;

type AppliedPin = {
  [K in PinName]: { applier: InputPinApplier<PinValue<K>>; value: PinValue<K> };
}[PinName];

function appliedPins(tool: PinnableTool, pins: InputPins): AppliedPin[] {
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
  return appliedPins(tool, pins).reduce(
    (schema, pin) => pin.applier.schema(schema, pin.value),
    inputSchemaForSurface(tool, surface),
  );
}

export function descriptionForConnection(
  tool: Pick<AnyToolModule, "description" | "describeForPins">,
  pins: InputPins,
): string {
  return tool.describeForPins?.(pins) ?? tool.description;
}

export function applyInputPins(
  tool: PinnableTool,
  pins: InputPins,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return appliedPins(tool, pins).reduce(
    (pinned, pin) => pin.applier.input(pinned, pin.value),
    input,
  );
}

/**
 * The pins a connection applies: those that at least one of `tools` declares.
 * `/mcp/chatgpt` applies none.
 */
export function effectivePins(
  tools: Iterable<PinnableTool>,
  surface: Surface,
  pins: InputPins,
): InputPins {
  if (surface === "chatgpt") return NO_PINS;
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
