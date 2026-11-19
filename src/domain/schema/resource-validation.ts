import { assertRecord, fail, type UnknownRecord } from "./validation-internals";

const BASE64_CHUNK_CHARACTERS = 65_536;

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
  const padding = base64Padding(value);
  const bytes = (value.length / 4) * 3 - padding;
  if (
    value.length > (limits.maximumCharacters ?? Infinity) ||
    bytes > (limits.maximumBytes ?? Infinity)
  )
    fail("invalid-range", path, limits.capacityMessage);
  for (let offset = 0; offset < value.length; offset += BASE64_CHUNK_CHARACTERS) {
    const chunk = value.slice(offset, offset + BASE64_CHUNK_CHARACTERS);
    const final = offset + chunk.length === value.length;
    if (!(final ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk))
      fail("invalid-range", path, limits.malformedMessage);
    yield;
  }
  if (limits.canonicalPadding) assertCanonicalPadding(value, padding, path);
  return bytes;
}

export function validatedResourceDataBytes(data: string): number {
  return (data.length / 4) * 3 - base64Padding(data);
}

/** Compare immutable Base64 values in bounded steps across a transport boundary. */
export function* matchesResourceDataSteps(
  data: unknown,
  previous: string,
): Generator<void, boolean> {
  if (typeof data !== "string" || data.length !== previous.length) return false;
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_CHARACTERS) {
    if (!data.startsWith(previous.slice(offset, offset + BASE64_CHUNK_CHARACTERS), offset))
      return false;
    yield;
  }
  return true;
}

function base64Padding(data: string): number {
  return data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
}

function assertCanonicalPadding(value: string, padding: number, path: string): void {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const finalValue = alphabet.indexOf(value[value.length - padding - 1]!);
  if ((padding === 2 && finalValue % 16 !== 0) || (padding === 1 && finalValue % 4 !== 0))
    fail("invalid-range", path, "Image Base64 padding bits must be zero.");
}
