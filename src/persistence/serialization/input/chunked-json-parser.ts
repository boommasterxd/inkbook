import { BoundedJsonStringBuilder } from "./bounded-json-string-builder";
import { ParsedJsonProof } from "../../../domain/schema/parsed-json-proof";
import type { ChunkedJsonLimits } from "./chunked-json-limits";
import { positiveSafeInteger, validateChunkedJsonLimits } from "./chunked-json-parser-limits";
import { JsonContainerScanError, scanJsonContainerWidths } from "./json-container-width";
import { ChunkedJsonCancelledError, ChunkedJsonParseError } from "./chunked-json-errors";
export { ChunkedJsonCancelledError, ChunkedJsonParseError } from "./chunked-json-errors";

const DEFAULT_BATCH_CHARACTERS = 64 * 1024;

export interface ChunkedJsonParseOptions {
  readonly batchCharacters?: number;
  readonly checkpoint?: () => Promise<void> | undefined;
  readonly limits: ChunkedJsonLimits;
  readonly signal?: AbortSignal;
}

type ArrayState = "comma-or-end" | "value" | "value-or-end";
type ObjectState = "colon" | "comma-or-end" | "key" | "key-or-end" | "value";

interface ArrayFrame {
  entries: number;
  readonly kind: "array";
  readonly value: unknown[];
  state: ArrayState;
}

interface ObjectFrame {
  entries: number;
  readonly keys: Set<string>;
  readonly kind: "object";
  readonly value: Record<string, unknown>;
  pendingKey: string | null;
  state: ObjectState;
}

type Frame = ArrayFrame | ObjectFrame;

interface ParsedValue {
  readonly frame?: Frame;
  readonly value: unknown;
}

/**
 * Parses standard JSON while yielding after bounded input batches. Duplicate object keys are
 * rejected so untrusted metadata cannot rely on JSON.parse's otherwise implicit last-write rule.
 */
export function parseChunkedJson(
  input: string,
  options: ChunkedJsonParseOptions,
): Promise<unknown> {
  return new ChunkedJsonParser(input, options).parse();
}

export async function parseChunkedJsonWithProof(
  input: string,
  options: ChunkedJsonParseOptions,
): Promise<{ readonly value: unknown; readonly proof: ParsedJsonProof }> {
  const parser = new ChunkedJsonParser(input, options);
  const value = await parser.parse();
  return { value, proof: parser.proof(value) };
}

class ChunkedJsonParser {
  readonly #batchCharacters: number;
  readonly #checkpoint: (() => Promise<void> | undefined) | undefined;
  readonly #input: string;
  readonly #limits: ChunkedJsonLimits;
  readonly #signal: AbortSignal | undefined;
  readonly #stack: Frame[] = [];
  readonly #stringBuilder: BoundedJsonStringBuilder;
  #nextCheckpoint: number;
  #nodes = 0;
  #maximumDepth = 1;
  #maximumContainerEntries = 0;
  #finiteNumbers = true;
  #outputCharacters = 0;
  #position = 0;
  #root: unknown;
  #rootAssigned = false;

  public constructor(input: string, options: ChunkedJsonParseOptions) {
    this.#input = input;
    this.#batchCharacters = positiveSafeInteger(
      options.batchCharacters ?? DEFAULT_BATCH_CHARACTERS,
      "batchCharacters",
    );
    this.#nextCheckpoint = this.#batchCharacters;
    this.#checkpoint = options.checkpoint;
    this.#limits = validateChunkedJsonLimits(options.limits);
    this.#signal = options.signal;
    this.#stringBuilder = new BoundedJsonStringBuilder(this.#limits.maximumStringScratchCharacters);
  }

  public async parse(): Promise<unknown> {
    this.#throwIfCancelled();
    const steps = this.#parseSteps();
    let step = steps.next();
    while (!step.done) {
      const pending = this.#checkpoint?.();
      if (pending !== undefined) await pending;
      this.#throwIfCancelled();
      step = steps.next();
    }
    return step.value;
  }

  public proof(value: unknown): ParsedJsonProof {
    return ParsedJsonProof.fromParser(value, {
      finiteNumbers: this.#finiteNumbers,
      maximumContainerEntries: this.#maximumContainerEntries,
      maximumDepth: this.#maximumDepth,
      nodes: this.#nodes,
    });
  }

  *#parseSteps(): Generator<void, unknown> {
    yield* this.#preflightContainerWidths();
    while (true) {
      yield* this.#skipWhitespace();
      if (this.#stack.length === 0) {
        if (this.#rootAssigned) return this.#finish();
        yield* this.#readRoot();
        continue;
      }
      const frame = this.#stack[this.#stack.length - 1]!;
      if (frame.kind === "array") yield* this.#advanceArray(frame);
      else yield* this.#advanceObject(frame);
    }
  }

  *#advanceArray(frame: ArrayFrame): Generator<void> {
    if (frame.state === "value-or-end" && this.#peek() === "]") {
      yield* this.#closeContainer("]");
      return;
    }
    if (frame.state === "value" || frame.state === "value-or-end") {
      this.#reserveContainerEntry(frame);
      const parsed = yield* this.#readValue();
      frame.value.push(parsed.value);
      frame.state = "comma-or-end";
      if (parsed.frame !== undefined) this.#stack.push(parsed.frame);
      return;
    }
    if (this.#peek() === "]") {
      yield* this.#closeContainer("]");
      return;
    }
    this.#expect(",");
    frame.state = "value";
    yield* this.#checkpointsAfterAdvance();
  }

  *#advanceObject(frame: ObjectFrame): Generator<void> {
    if (frame.state === "key-or-end" && this.#peek() === "}") {
      yield* this.#closeContainer("}");
      return;
    }
    if (frame.state === "key" || frame.state === "key-or-end") {
      this.#reserveContainerEntry(frame);
      yield* this.#readObjectKey(frame);
      return;
    }
    if (frame.state === "colon") {
      this.#expect(":");
      frame.state = "value";
      yield* this.#checkpointsAfterAdvance();
      return;
    }
    if (frame.state === "value") {
      yield* this.#readObjectValue(frame);
      return;
    }
    if (this.#peek() === "}") {
      yield* this.#closeContainer("}");
      return;
    }
    this.#expect(",");
    frame.state = "key";
    yield* this.#checkpointsAfterAdvance();
  }

  *#readRoot(): Generator<void> {
    const parsed = yield* this.#readValue();
    this.#root = parsed.value;
    this.#rootAssigned = true;
    if (parsed.frame !== undefined) this.#stack.push(parsed.frame);
  }

  *#readObjectKey(frame: ObjectFrame): Generator<void> {
    if (this.#peek() !== '"') this.#invalid("Expected an object property name");
    const key = yield* this.#readString();
    if (frame.keys.has(key)) {
      throw new ChunkedJsonParseError("duplicate-key", this.#position, "Duplicate object key");
    }
    frame.keys.add(key);
    frame.pendingKey = key;
    frame.state = "colon";
  }

  *#readObjectValue(frame: ObjectFrame): Generator<void> {
    const parsed = yield* this.#readValue();
    const key = frame.pendingKey!;
    Object.defineProperty(frame.value, key, {
      configurable: true,
      enumerable: true,
      value: parsed.value,
      writable: true,
    });
    frame.pendingKey = null;
    frame.state = "comma-or-end";
    if (parsed.frame !== undefined) this.#stack.push(parsed.frame);
  }

  *#readValue(): Generator<void, ParsedValue> {
    this.#countNode();
    const character = this.#peek();
    if (character === '"') return { value: yield* this.#readString() };
    if (character === "{") return yield* this.#openObject();
    if (character === "[") return yield* this.#openArray();
    if (character === "t") return yield* this.#readLiteral("true", true);
    if (character === "f") return yield* this.#readLiteral("false", false);
    if (character === "n") return yield* this.#readLiteral("null", null);
    if (character === "-" || isDigit(character)) return yield* this.#readNumber();
    this.#invalid("Expected a JSON value");
  }

  *#openArray(): Generator<void, ParsedValue> {
    this.#checkDepth();
    this.#position += 1;
    const value: unknown[] = [];
    yield* this.#checkpointsAfterAdvance();
    return { frame: { entries: 0, kind: "array", state: "value-or-end", value }, value };
  }

  *#openObject(): Generator<void, ParsedValue> {
    this.#checkDepth();
    this.#position += 1;
    const value: Record<string, unknown> = {};
    yield* this.#checkpointsAfterAdvance();
    return {
      frame: {
        entries: 0,
        keys: new Set(),
        kind: "object",
        pendingKey: null,
        state: "key-or-end",
        value,
      },
      value,
    };
  }

  *#closeContainer(expected: "]" | "}"): Generator<void> {
    this.#expect(expected);
    this.#stack.pop();
    yield* this.#checkpointsAfterAdvance();
  }

  *#readLiteral(token: string, value: boolean | null): Generator<void, ParsedValue> {
    if (!this.#input.startsWith(token, this.#position)) this.#invalid(`Invalid ${token} literal`);
    this.#position += token.length;
    this.#addOutputCharacters(token.length);
    yield* this.#checkpointsAfterAdvance();
    return { value };
  }

  *#readNumber(): Generator<void, ParsedValue> {
    const start = this.#position;
    if (this.#peek() === "-") this.#position += 1;
    if (this.#peek() === "0") this.#position += 1;
    else {
      if (!isNonZeroDigit(this.#peek())) this.#invalid("Invalid number");
      yield* this.#consumeDigits();
    }
    if (this.#peek() === ".") {
      this.#position += 1;
      if (!isDigit(this.#peek())) this.#invalid("Invalid number fraction");
      yield* this.#consumeDigits();
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      this.#position += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#position += 1;
      if (!isDigit(this.#peek())) this.#invalid("Invalid number exponent");
      yield* this.#consumeDigits();
    }
    const token = this.#input.slice(start, this.#position);
    this.#addOutputCharacters(token.length);
    yield* this.#checkpointsAfterAdvance();
    const value = Number(token);
    this.#finiteNumbers &&= Number.isFinite(value);
    return { value };
  }

  *#readString(): Generator<void, string> {
    this.#position += 1;
    this.#stringBuilder.reset();
    while (this.#position < this.#input.length) {
      const character = this.#peek();
      if (character === '"') {
        this.#position += 1;
        yield* this.#checkpointsAfterAdvance();
        return this.#stringBuilder.finish().value;
      }
      if (character === "\\") this.#stringBuilder.appendCodeUnit(yield* this.#readEscape());
      else {
        if (character.charCodeAt(0) <= 0x1f) this.#invalid("Unescaped control character in string");
        const start = this.#position;
        const end = this.#findStringRunEnd();
        this.#addOutputCharacters(end - start);
        this.#stringBuilder.appendInput(this.#input, start, end);
        this.#position = end;
        yield* this.#checkpointsAfterAdvance();
      }
    }
    this.#invalid("Unterminated string");
  }

  *#readEscape(): Generator<void, number> {
    this.#position += 1;
    const escape = this.#peek();
    const simple = ESCAPES[escape];
    if (simple !== undefined) {
      this.#position += 1;
      this.#addOutputCharacters(1);
      yield* this.#checkpointsAfterAdvance();
      return simple.charCodeAt(0);
    }
    if (escape !== "u") this.#invalid("Invalid string escape");
    const digits = this.#input.slice(this.#position + 1, this.#position + 5);
    if (digits.length !== 4 || !HEX_ESCAPE.test(digits)) this.#invalid("Invalid Unicode escape");
    this.#position += 5;
    this.#addOutputCharacters(1);
    yield* this.#checkpointsAfterAdvance();
    return Number.parseInt(digits, 16);
  }

  *#preflightContainerWidths(): Generator<void> {
    try {
      yield* scanJsonContainerWidths(this.#input, {
        batchCharacters: this.#batchCharacters,
        maximumContainerEntries: this.#limits.maximumContainerEntries,
        maximumDepth: this.#limits.maximumDepth,
      });
    } catch (error) {
      if (error instanceof JsonContainerScanError) {
        throw new ChunkedJsonParseError(error.code, error.offset, "JSON container limit exceeded");
      }
      throw error;
    }
  }

  *#skipWhitespace(): Generator<void> {
    while (isWhitespace(this.#peek())) {
      const end = Math.min(this.#input.length, this.#nextCheckpoint);
      while (this.#position < end && isWhitespace(this.#peek())) this.#position += 1;
      yield* this.#checkpointsAfterAdvance();
    }
  }

  *#consumeDigits(): Generator<void> {
    while (isDigit(this.#peek())) {
      const end = Math.min(this.#input.length, this.#nextCheckpoint);
      while (this.#position < end && isDigit(this.#peek())) this.#position += 1;
      yield* this.#checkpointsAfterAdvance();
    }
  }

  #findStringRunEnd(): number {
    const end = Math.min(this.#input.length, this.#nextCheckpoint);
    let position = this.#position;
    while (position < end) {
      const character = this.#input[position]!;
      if (character === '"' || character === "\\" || character.charCodeAt(0) <= 0x1f) break;
      position += 1;
    }
    return position;
  }

  *#checkpointsAfterAdvance(): Generator<void> {
    if (this.#position < this.#nextCheckpoint) return;
    const checkpointCount =
      Math.floor((this.#position - this.#nextCheckpoint) / this.#batchCharacters) + 1;
    this.#nextCheckpoint += checkpointCount * this.#batchCharacters;
    this.#throwIfCancelled();
    for (let index = 0; index < checkpointCount; index += 1) yield;
  }

  #finish(): unknown {
    if (this.#position !== this.#input.length) this.#invalid("Unexpected trailing input");
    this.#throwIfCancelled();
    return this.#root;
  }

  #expect(character: string): void {
    if (this.#peek() !== character) this.#invalid(`Expected '${character}'`);
    this.#position += 1;
  }

  #peek(): string {
    return this.#input[this.#position] ?? "";
  }

  #checkDepth(): void {
    this.#maximumDepth = Math.max(this.#maximumDepth, this.#stack.length + 1);
    if (this.#stack.length + 1 > this.#limits.maximumDepth) {
      throw new ChunkedJsonParseError(
        "depth-limit-exceeded",
        this.#position,
        "JSON nesting depth limit exceeded",
      );
    }
  }

  #countNode(): void {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maximumNodes) {
      throw new ChunkedJsonParseError(
        "node-limit-exceeded",
        this.#position,
        "JSON node limit exceeded",
      );
    }
  }

  #reserveContainerEntry(frame: Frame): void {
    if (frame.entries >= this.#limits.maximumContainerEntries) {
      throw new ChunkedJsonParseError(
        "container-limit-exceeded",
        this.#position,
        "JSON container entry limit exceeded",
      );
    }
    frame.entries += 1;
    this.#maximumContainerEntries = Math.max(this.#maximumContainerEntries, frame.entries);
  }

  #addOutputCharacters(count: number): void {
    this.#outputCharacters += count;
    if (this.#outputCharacters > this.#limits.maximumOutputCharacters) {
      throw new ChunkedJsonParseError(
        "output-limit-exceeded",
        this.#position,
        "JSON output character limit exceeded",
      );
    }
  }

  #invalid(message: string): never {
    throw new ChunkedJsonParseError("invalid-json", this.#position, message);
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted === true) throw new ChunkedJsonCancelledError();
  }
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "/": "/",
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

const HEX_ESCAPE = /^[0-9A-Fa-f]{4}$/u;

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isNonZeroDigit(character: string): boolean {
  return character >= "1" && character <= "9";
}
