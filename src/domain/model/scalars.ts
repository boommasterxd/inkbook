const CROCKFORD_BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const RANDOM_ID_BYTE_LENGTH = 16;
const RANDOM_ID_CHARACTER_LENGTH = 26;
// Bit widths and masks are fixed by the Crockford Base32 encoding contract.
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const BYTE_RADIX = BigInt(8);
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const BASE32_MASK = BigInt(31);
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const BASE32_SHIFT = BigInt(5);
const ELEMENT_ID_PATTERN = /^el_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const GROUP_ID_PATTERN = /^grp_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

export type ElementId = string & { readonly __brand: "ElementId" };
export type GroupId = string & { readonly __brand: "GroupId" };
export type SceneRevision = number & { readonly __brand: "SceneRevision" };
export type GeometryRevision = number & {
  readonly __brand: "GeometryRevision";
};
export type StyleRevision = number & { readonly __brand: "StyleRevision" };
export type BindingRevision = number & {
  readonly __brand: "BindingRevision";
};

export interface NotePointV1 {
  readonly x: number;
  readonly y: number;
}

export interface NoteVectorV1 {
  readonly x: number;
  readonly y: number;
}

export type RandomByteSourceV1 = (byteLength: number) => Uint8Array;

function encodeRandomId(prefix: "el_" | "grp_", bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_ID_BYTE_LENGTH) {
    throw new RangeError("An Inkbook ID requires exactly 16 random bytes.");
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << BYTE_RADIX) | BigInt(byte);
  }

  const characters = Array<string>(RANDOM_ID_CHARACTER_LENGTH);
  for (let index = RANDOM_ID_CHARACTER_LENGTH - 1; index >= 0; index -= 1) {
    const character = CROCKFORD_BASE32[Number(value & BASE32_MASK)];
    if (character === undefined) {
      throw new RangeError("A Base32 digit was outside the encoding alphabet.");
    }
    characters[index] = character;
    value >>= BASE32_SHIFT;
  }
  return `${prefix}${characters.join("")}`;
}

export function parseElementId(value: string): ElementId {
  if (!ELEMENT_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid element ID syntax.");
  }
  return value as ElementId;
}

export function parseGroupId(value: string): GroupId {
  if (!GROUP_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid group ID syntax.");
  }
  return value as GroupId;
}

export function generateElementId(randomBytes: RandomByteSourceV1): ElementId {
  return parseElementId(
    encodeRandomId("el_", randomBytes(RANDOM_ID_BYTE_LENGTH)),
  );
}

export function generateGroupId(randomBytes: RandomByteSourceV1): GroupId {
  return parseGroupId(
    encodeRandomId("grp_", randomBytes(RANDOM_ID_BYTE_LENGTH)),
  );
}

function createRevision<T extends number>(value: number): T {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("A revision must be a non-negative safe integer.");
  }
  return value as T;
}

export function createSceneRevision(value: number): SceneRevision {
  return createRevision<SceneRevision>(value);
}

export function createGeometryRevision(value: number): GeometryRevision {
  return createRevision<GeometryRevision>(value);
}

export function createStyleRevision(value: number): StyleRevision {
  return createRevision<StyleRevision>(value);
}

export function createBindingRevision(value: number): BindingRevision {
  return createRevision<BindingRevision>(value);
}

export function createNotePointV1(x: number, y: number): NotePointV1 {
  return Object.freeze({ x, y });
}

export function createNoteVectorV1(x: number, y: number): NoteVectorV1 {
  return Object.freeze({ x, y });
}
