import { assertRecord, fail, type UnknownRecord } from "./validation-internals";

interface ResourceDataLimits {
  readonly maximumCharacters?: number;
  readonly maximumBytes?: number;
  readonly canonicalPadding?: boolean;
  readonly malformedMessage: string;
  readonly capacityMessage: string;
}

export function* resourceEntries(
  resources: readonly unknown[],
  path: string,
): Generator<{ readonly resource: UnknownRecord; readonly location: string }> {
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    const location = `${path}[${index}]`;
    assertRecord(resource, location);
    yield { resource, location };
  }
}

/** Bounded alphabet inspection shared by binary resource schemas; decoders own byte integrity. */
export function* assertResourceDataSteps(
  value: unknown,
  path: string,
  limits: ResourceDataLimits,
): Generator<void, number> {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0)
    fail("invalid-range", path, limits.malformedMessage);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  if (
    value.length > (limits.maximumCharacters ?? Infinity) ||
    bytes > (limits.maximumBytes ?? Infinity)
  )
    fail("invalid-range", path, limits.capacityMessage);
  for (let offset = 0; offset < value.length; offset += 65_536) {
    const chunk = value.slice(offset, offset + 65_536);
    const final = offset + chunk.length === value.length;
    if (!(final ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk))
      fail("invalid-range", path, limits.malformedMessage);
    yield;
  }
  if (limits.canonicalPadding) assertCanonicalPadding(value, padding, path);
  return bytes;
}

function assertCanonicalPadding(value: string, padding: number, path: string): void {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const finalValue = alphabet.indexOf(value[value.length - padding - 1]!);
  if ((padding === 2 && finalValue % 16 !== 0) || (padding === 1 && finalValue % 4 !== 0))
    fail("invalid-range", path, "Image Base64 padding bits must be zero.");
}
