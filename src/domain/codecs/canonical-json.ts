const MAX_JSON_NESTING = 64;
const LINE_FEED = 0x0a;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const SORT_BEFORE = -1;
const LAST_ITEM = -1;
const QUOTE = '"';
const SURROGATE_PAIR_UNITS = 2;
const BACKSPACE_CODE_UNIT = 0x08;
const TAB_CODE_UNIT = 0x09;
const LINE_FEED_CODE_UNIT = 0x0a;
const FORM_FEED_CODE_UNIT = 0x0c;
const CARRIAGE_RETURN_CODE_UNIT = 0x0d;
const QUOTE_CODE_UNIT = 0x22;
const BACKSLASH_CODE_UNIT = 0x5c;
const CONTROL_CODE_UNIT_LIMIT = 0x20;
const HEX_RADIX = 16;
const HEX_ESCAPE_DIGITS = 4;

export const CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS = 16_384;

export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonProcessor {
  readonly done: boolean;
  readonly chunkCount: number;
  processNext(maxUtf16Units?: number): boolean;
  chunkAt(index: number): string | undefined;
  complete(): readonly string[] | undefined;
}

interface ValueFrame {
  readonly kind: "value";
  readonly value: unknown;
  readonly nesting: number;
}

interface TextFrame {
  readonly kind: "text";
  readonly value: string;
  offset: number;
}

interface StringFrame {
  readonly kind: "string";
  readonly value: string;
  offset: number;
  state: "open" | "content" | "close";
}

interface ArrayFrame {
  readonly kind: "array";
  readonly value: readonly unknown[];
  readonly nesting: number;
  index: number;
  opened: boolean;
}

interface ObjectFrame {
  readonly kind: "object";
  readonly value: Record<string, unknown>;
  readonly keys: readonly string[];
  readonly nesting: number;
  index: number;
  opened: boolean;
}

type Frame = ValueFrame | TextFrame | StringFrame | ArrayFrame | ObjectFrame;

export function createCanonicalJsonProcessor(
  value: unknown,
): CanonicalJsonProcessor {
  return new Processor(value);
}

export function canonicalizeJson(value: unknown): string {
  const processor = createCanonicalJsonProcessor(value);
  while (!processor.processNext()) {
    // The synchronous API drives the same resumable encoder to completion.
  }
  const chunks = processor.complete();
  if (chunks === undefined)
    throw new Error("Canonical JSON encode is incomplete.");
  return chunks.join("");
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

export function encodeCanonicalSidecarJson(value: unknown): Uint8Array {
  const canonicalBytes = encodeCanonicalJson(value);
  const sidecarBytes = new Uint8Array(canonicalBytes.byteLength + 1);
  sidecarBytes.set(canonicalBytes);
  sidecarBytes[sidecarBytes.length - 1] = LINE_FEED;
  return sidecarBytes;
}

class Processor implements CanonicalJsonProcessor {
  readonly #ancestors = new Set<object>();
  readonly #frames: Frame[];
  readonly #chunks: string[] = [];

  constructor(value: unknown) {
    this.#frames = [{ kind: "value", value, nesting: 0 }];
  }

  get done(): boolean {
    return this.#frames.length === 0;
  }

  get chunkCount(): number {
    return this.#chunks.length;
  }

  processNext(maxUtf16Units = CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS): boolean {
    validateProcessLimit(maxUtf16Units);
    if (this.done) return true;
    let remaining = Math.min(
      maxUtf16Units,
      CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS,
    );
    const emitted: string[] = [];
    while (remaining > 0 && this.#frames.length > 0) {
      remaining -= this.processFrame(remaining, emitted);
    }
    if (emitted.length > 0) this.#chunks.push(emitted.join(""));
    return this.done;
  }

  complete(): readonly string[] | undefined {
    return this.done ? this.#chunks : undefined;
  }

  chunkAt(index: number): string | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    return this.#chunks[index];
  }

  private processFrame(remaining: number, emitted: string[]): number {
    const frame = this.#frames.at(LAST_ITEM);
    if (frame === undefined) return 0;
    switch (frame.kind) {
      case "value":
        this.expandValue(frame);
        return 0;
      case "text":
        return this.processText(frame, remaining, emitted);
      case "string":
        this.expandString(frame);
        return 0;
      case "array":
        this.expandArray(frame);
        return 0;
      case "object":
        this.expandObject(frame);
        return 0;
    }
  }

  private expandValue(frame: ValueFrame): void {
    this.#frames.pop();
    const { value } = frame;
    if (value === null || typeof value === "boolean") {
      this.pushText(String(value));
    } else if (typeof value === "string") {
      this.#frames.push({ kind: "string", value, offset: 0, state: "open" });
    } else if (typeof value === "number") {
      this.pushNumber(value);
    } else if (typeof value === "object") {
      this.pushCollection(value, frame.nesting);
    } else {
      throw new TypeError("The value is not representable as canonical JSON.");
    }
  }

  private pushNumber(value: number): void {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite.");
    }
    this.pushText(JSON.stringify(value));
  }

  private pushCollection(value: object, nesting: number): void {
    if (nesting >= MAX_JSON_NESTING) {
      throw new RangeError("Canonical JSON nesting exceeds the limit of 64.");
    }
    if (this.#ancestors.has(value)) {
      throw new TypeError("Canonical JSON cannot contain cyclic values.");
    }
    this.#ancestors.add(value);
    if (Array.isArray(value)) this.pushArray(value, nesting + 1);
    else this.pushObject(value, nesting + 1);
  }

  private pushArray(value: readonly unknown[], nesting: number): void {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Canonical JSON arrays must be plain data arrays.");
    }
    const keys = ownDataKeys(value);
    if (
      keys.length !== value.length ||
      keys.some((key) => !isArrayIndex(key, value.length))
    ) {
      throw new TypeError(
        "Canonical JSON arrays must be dense and contain no extra properties.",
      );
    }
    this.#frames.push({
      kind: "array",
      value,
      nesting,
      index: 0,
      opened: false,
    });
  }

  private pushObject(value: object, nesting: number): void {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain data objects.");
    }
    const keys = ownDataKeys(value).sort(compareUtf16CodeUnits);
    this.#frames.push({
      kind: "object",
      value: value as Record<string, unknown>,
      keys,
      nesting,
      index: 0,
      opened: false,
    });
  }

  private processText(
    frame: TextFrame,
    remaining: number,
    emitted: string[],
  ): number {
    const length = Math.min(remaining, frame.value.length - frame.offset);
    emitted.push(frame.value.slice(frame.offset, frame.offset + length));
    frame.offset += length;
    if (frame.offset === frame.value.length) this.#frames.pop();
    return length;
  }

  private expandString(frame: StringFrame): void {
    if (frame.state === "open") {
      frame.state = "content";
      this.pushText(QUOTE);
      return;
    }
    if (frame.state === "close") {
      this.#frames.pop();
      this.pushText(QUOTE);
      return;
    }
    if (frame.offset === frame.value.length) {
      frame.state = "close";
      return;
    }
    const escaped = escapeCodePoint(frame.value, frame.offset);
    frame.offset += escaped.inputUnits;
    this.pushText(escaped.value);
  }

  private expandArray(frame: ArrayFrame): void {
    if (!frame.opened) {
      frame.opened = true;
      this.pushText("[");
      return;
    }
    if (frame.index >= frame.value.length) {
      this.#frames.pop();
      this.#ancestors.delete(frame.value);
      this.pushText("]");
      return;
    }
    const index = frame.index;
    frame.index += 1;
    this.#frames.push({
      kind: "value",
      value: readDataProperty(frame.value, String(index)),
      nesting: frame.nesting,
    });
    if (index > 0) this.pushText(",");
  }

  private expandObject(frame: ObjectFrame): void {
    if (!frame.opened) {
      frame.opened = true;
      this.pushText("{");
      return;
    }
    if (frame.index >= frame.keys.length) {
      this.#frames.pop();
      this.#ancestors.delete(frame.value);
      this.pushText("}");
      return;
    }
    const index = frame.index;
    const key = frame.keys[index];
    if (key === undefined) {
      throw new TypeError("Canonical JSON object changed during encoding.");
    }
    frame.index += 1;
    this.#frames.push({
      kind: "value",
      value: readDataProperty(frame.value, key),
      nesting: frame.nesting,
    });
    this.pushText(":");
    this.#frames.push({ kind: "string", value: key, offset: 0, state: "open" });
    if (index > 0) this.pushText(",");
  }

  private pushText(value: string): void {
    this.#frames.push({ kind: "text", value, offset: 0 });
  }
}

function escapeCodePoint(
  value: string,
  offset: number,
): { readonly value: string; readonly inputUnits: number } {
  if (offset < 0 || offset >= value.length) {
    throw new RangeError("Canonical JSON string offset is out of bounds.");
  }
  const codeUnit = value.charCodeAt(offset);
  if (codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX) {
    const following = value.charCodeAt(offset + 1);
    if (!(following >= LOW_SURROGATE_MIN && following <= LOW_SURROGATE_MAX)) {
      throw new TypeError("Canonical JSON strings must contain valid Unicode.");
    }
    return {
      value: value.slice(offset, offset + SURROGATE_PAIR_UNITS),
      inputUnits: SURROGATE_PAIR_UNITS,
    };
  }
  if (codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX) {
    throw new TypeError("Canonical JSON strings must contain valid Unicode.");
  }
  const escaped = escapeCodeUnit(codeUnit);
  return { value: escaped ?? value.slice(offset, offset + 1), inputUnits: 1 };
}

function escapeCodeUnit(codeUnit: number): string | undefined {
  switch (codeUnit) {
    case BACKSPACE_CODE_UNIT:
      return "\\b";
    case TAB_CODE_UNIT:
      return "\\t";
    case LINE_FEED_CODE_UNIT:
      return "\\n";
    case FORM_FEED_CODE_UNIT:
      return "\\f";
    case CARRIAGE_RETURN_CODE_UNIT:
      return "\\r";
    case QUOTE_CODE_UNIT:
      return '\\"';
    case BACKSLASH_CODE_UNIT:
      return "\\\\";
    default:
      return codeUnit < CONTROL_CODE_UNIT_LIMIT
        ? `\\u${codeUnit.toString(HEX_RADIX).padStart(HEX_ESCAPE_DIGITS, "0")}`
        : undefined;
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return SORT_BEFORE;
  if (left > right) return 1;
  return 0;
}

function ownDataKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  const dataKeys: string[] = [];
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError("Canonical JSON cannot contain symbol properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        "Canonical JSON objects may contain only enumerable data properties.",
      );
    }
    dataKeys.push(key);
  }
  return dataKeys;
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("Canonical JSON object changed during encoding.");
  }
  return descriptor.value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function validateProcessLimit(maxUtf16Units: number): void {
  if (!Number.isSafeInteger(maxUtf16Units) || maxUtf16Units <= 0) {
    throw new RangeError("Canonical JSON process limit must be positive.");
  }
}
