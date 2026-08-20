import type {
  BoundedJsonCounters,
  BoundedJsonErrorCode,
  BoundedJsonLimits,
  BoundedJsonParseResult,
} from "./bounded-json";
import { isHighSurrogate, isLowSurrogate, jsonHexValue } from "./json-unicode";

const MAX_JSON_NESTING = 64;
export const BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT = 64;
const CONTROL_CHARACTER_LIMIT = 0x20;
const FOUR_HEX_DIGITS = 4;
const HEX_RADIX = 16;
const LAST_INDEX = -1;

type BoundedJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly BoundedJsonValue[]
  | { readonly [key: string]: BoundedJsonValue };

export type MutableCounters = {
  -readonly [Key in keyof BoundedJsonCounters]: BoundedJsonCounters[Key];
};

export class ParseFailure extends Error {
  public constructor(
    public readonly code: BoundedJsonErrorCode,
    public readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

export class IncrementalJsonParser {
  private offset = 0;
  private remainingUnits = 0;
  private readonly iterator: Generator<void, BoundedJsonParseResult>;

  public constructor(
    private readonly input: string,
    private readonly limits: BoundedJsonLimits,
    private readonly counters: MutableCounters,
  ) {
    this.iterator = this.parse();
  }

  public processNext(
    maxUtf16Units: number,
  ): BoundedJsonParseResult | undefined {
    this.remainingUnits = maxUtf16Units;
    const step = this.iterator.next();
    return step.done ? step.value : undefined;
  }

  private *parse(): Generator<void, BoundedJsonParseResult> {
    yield* this.skipWhitespace();
    const value = yield* this.parseValue(0);
    yield* this.skipWhitespace();
    if (this.offset !== this.input.length) {
      this.fail("trailing-data", "JSON input contains trailing data.");
    }
    return Object.freeze({
      ok: true,
      value,
      counters: snapshot(this.counters),
    });
  }

  private *parseValue(nesting: number): Generator<void, BoundedJsonValue> {
    const character = this.input[this.offset];
    if (character === '"') return yield* this.parseString();
    if (character === "[") return yield* this.parseArray(nesting + 1);
    if (character === "{") return yield* this.parseObject(nesting + 1);
    if (character === "t") return yield* this.parseLiteral("true", true);
    if (character === "f") return yield* this.parseLiteral("false", false);
    if (character === "n") return yield* this.parseLiteral("null", null);
    if (character === "-" || isDigit(character)) {
      return yield* this.parseNumber();
    }
    return this.fail("invalid-syntax", "Expected a JSON value.");
  }

  private *parseArray(
    nesting: number,
  ): Generator<void, readonly BoundedJsonValue[]> {
    this.admitContainer(
      nesting,
      "arrays",
      this.limits.maxArrays,
      "array-limit",
    );
    yield* this.advance();
    const values: BoundedJsonValue[] = [];
    yield* this.skipWhitespace();
    if (yield* this.consume("]")) return Object.freeze(values);

    for (;;) {
      this.increment(
        "arrayItems",
        this.limits.maxArrayItems,
        "array-item-limit",
      );
      values.push(yield* this.parseValue(nesting));
      yield* this.skipWhitespace();
      if (yield* this.consume("]")) return Object.freeze(values);
      yield* this.expect(",", "Expected a comma or closing bracket.");
      yield* this.skipWhitespace();
    }
  }

  private *parseObject(
    nesting: number,
  ): Generator<void, Readonly<Record<string, BoundedJsonValue>>> {
    this.admitContainer(
      nesting,
      "objects",
      this.limits.maxObjects,
      "object-limit",
    );
    yield* this.advance();
    const value: Record<string, BoundedJsonValue> = Object.create(
      null,
    ) as Record<string, BoundedJsonValue>;
    const keys = new Set<string>();
    let memberCount = 0;
    yield* this.skipWhitespace();
    if (yield* this.consume("}")) return Object.freeze(value);

    for (;;) {
      if (this.input[this.offset] !== '"') {
        this.fail("invalid-syntax", "Expected a quoted object member name.");
      }
      const keyOffset = this.offset;
      const key = yield* this.parseString();
      this.increment(
        "objectMembers",
        this.limits.maxObjectMembers,
        "object-member-limit",
      );
      memberCount += 1;
      if (memberCount > this.limits.maxObjectMembersPerObject) {
        this.fail(
          "object-member-limit",
          "JSON object exceeds the configured member limit.",
        );
      }
      if (keys.has(key)) {
        throw new ParseFailure(
          "duplicate-key",
          keyOffset,
          "JSON objects must not contain duplicate member names.",
        );
      }
      keys.add(key);
      yield* this.skipWhitespace();
      yield* this.expect(":", "Expected a colon after the object member name.");
      yield* this.skipWhitespace();
      value[key] = yield* this.parseValue(nesting);
      yield* this.skipWhitespace();
      if (yield* this.consume("}")) return Object.freeze(value);
      yield* this.expect(",", "Expected a comma or closing brace.");
      yield* this.skipWhitespace();
    }
  }

  private *parseString(): Generator<void, string> {
    yield* this.advance();
    const parts: string[] = [];
    let segmentStart = this.offset;
    let decodedUnits = 0;

    while (this.offset < this.input.length) {
      const codeUnit = this.input.charCodeAt(this.offset);
      if (this.input[this.offset] === '"') {
        parts.push(this.input.slice(segmentStart, this.offset));
        yield* this.advance();
        return this.finishString(parts, decodedUnits);
      }
      if (this.input[this.offset] === "\\") {
        decodedUnits += this.offset - segmentStart;
        this.checkStringLimit(decodedUnits);
        parts.push(this.input.slice(segmentStart, this.offset));
        yield* this.advance();
        const escaped = yield* this.parseEscape();
        parts.push(escaped);
        decodedUnits += escaped.length;
        this.checkStringLimit(decodedUnits);
        segmentStart = this.offset;
      } else {
        if (codeUnit < CONTROL_CHARACTER_LIMIT) {
          this.fail(
            "invalid-syntax",
            "JSON strings cannot contain control characters.",
          );
        }
        yield* this.advance();
        this.checkStringLimit(decodedUnits + this.offset - segmentStart);
      }
    }
    return this.fail("invalid-syntax", "JSON string is not terminated.");
  }

  private finishString(parts: string[], decodedUnits: number): string {
    decodedUnits += parts.at(LAST_INDEX)?.length ?? 0;
    this.checkStringLimit(decodedUnits);
    this.counters.strings += 1;
    this.counters.stringUtf16Units += decodedUnits;
    this.counters.maximumStringUtf16Units = Math.max(
      this.counters.maximumStringUtf16Units,
      decodedUnits,
    );
    return parts.length === 1 ? (parts[0] ?? "") : parts.join("");
  }

  private *parseEscape(): Generator<void, string> {
    const escape = this.input[this.offset];
    yield* this.advance();
    if (escape === '"' || escape === "\\" || escape === "/") return escape;
    if (escape === "b") return "\b";
    if (escape === "f") return "\f";
    if (escape === "n") return "\n";
    if (escape === "r") return "\r";
    if (escape === "t") return "\t";
    if (escape !== "u") {
      return this.fail(
        "invalid-syntax",
        "JSON string contains an invalid escape.",
      );
    }

    const first = yield* this.parseHexCodeUnit();
    if (isLowSurrogate(first)) {
      return this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    if (!isHighSurrogate(first)) return String.fromCharCode(first);
    if (!this.input.startsWith("\\u", this.offset)) {
      return this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    yield* this.advance("\\u".length);
    const second = yield* this.parseHexCodeUnit();
    if (!isLowSurrogate(second)) {
      return this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    return String.fromCharCode(first, second);
  }

  private *parseHexCodeUnit(): Generator<void, number> {
    if (this.offset + FOUR_HEX_DIGITS > this.input.length) {
      return this.fail(
        "invalid-syntax",
        "Unicode escape must contain four hex digits.",
      );
    }
    let value = 0;
    for (let count = 0; count < FOUR_HEX_DIGITS; count += 1) {
      const digit = jsonHexValue(this.input.charCodeAt(this.offset));
      if (digit === undefined) {
        return this.fail(
          "invalid-syntax",
          "Unicode escape must contain four hex digits.",
        );
      }
      value = value * HEX_RADIX + digit;
      yield* this.advance();
    }
    return value;
  }

  private *parseNumber(): Generator<void, number> {
    const start = this.offset;
    if (yield* this.consume("-")) {
      this.requireDigit("Expected a digit after the minus sign.");
    }
    if (yield* this.consume("0")) {
      if (isDigit(this.input[this.offset])) {
        return this.fail(
          "invalid-syntax",
          "JSON numbers cannot contain leading zeroes.",
        );
      }
    } else {
      this.requireDigit("Expected an integer part.");
      while (isDigit(this.input[this.offset])) yield* this.advance();
    }
    if (yield* this.consume(".")) {
      this.requireDigit("Expected a digit after the decimal point.");
      while (isDigit(this.input[this.offset])) yield* this.advance();
    }
    if (this.input[this.offset] === "e" || this.input[this.offset] === "E") {
      yield* this.advance();
      if (this.input[this.offset] === "+" || this.input[this.offset] === "-") {
        yield* this.advance();
      }
      this.requireDigit("Expected a digit in the exponent.");
      while (isDigit(this.input[this.offset])) yield* this.advance();
    }
    const value = Number(this.input.slice(start, this.offset));
    if (!Number.isFinite(value)) {
      throw new ParseFailure(
        "non-finite-number",
        start,
        "JSON number does not have a finite JavaScript representation.",
      );
    }
    return value;
  }

  private *parseLiteral<T extends boolean | null>(
    text: string,
    value: T,
  ): Generator<void, T> {
    if (!this.input.startsWith(text, this.offset)) {
      return this.fail("invalid-syntax", `Expected ${text}.`);
    }
    yield* this.advance(text.length);
    return value;
  }

  private admitContainer(
    nesting: number,
    counter: "arrays" | "objects",
    limit: number,
    code: "array-limit" | "object-limit",
  ): void {
    if (nesting > this.limits.maxNesting || nesting > MAX_JSON_NESTING) {
      this.fail("nesting-limit", "JSON nesting exceeds the configured limit.");
    }
    this.counters.maximumNesting = Math.max(
      this.counters.maximumNesting,
      nesting,
    );
    this.increment(counter, limit, code);
  }

  private increment(
    counter: "arrayItems" | "objectMembers" | "arrays" | "objects",
    limit: number,
    code:
      | "array-item-limit"
      | "object-member-limit"
      | "array-limit"
      | "object-limit",
  ): void {
    this.counters[counter] += 1;
    if (this.counters[counter] > limit) {
      this.fail(code, "JSON input exceeds a configured structural limit.");
    }
  }

  private checkStringLimit(decodedUnits: number): void {
    if (decodedUnits > this.limits.maxStringUtf16Units) {
      this.fail("string-limit", "JSON string exceeds the UTF-16 unit limit.");
    }
  }

  private requireDigit(message: string): void {
    if (!isDigit(this.input[this.offset])) this.fail("invalid-syntax", message);
  }

  private *expect(character: string, message: string): Generator<void, void> {
    if (!(yield* this.consume(character))) this.fail("invalid-syntax", message);
  }

  private *consume(character: string): Generator<void, boolean> {
    if (this.input[this.offset] !== character) return false;
    yield* this.advance();
    return true;
  }

  private *skipWhitespace(): Generator<void, void> {
    while (isJsonWhitespace(this.input[this.offset])) yield* this.advance();
  }

  private *advance(units = 1): Generator<void, void> {
    for (let count = 0; count < units; count += 1) {
      this.offset += 1;
      this.remainingUnits -= 1;
      if (this.remainingUnits === 0) yield;
    }
  }

  private fail(code: BoundedJsonErrorCode, message: string): never {
    throw new ParseFailure(code, this.offset, message);
  }
}

export function hasInvalidLimits(limits: BoundedJsonLimits): boolean {
  const values = [
    limits.maxUtf8Bytes,
    limits.maxNesting,
    limits.maxStringUtf16Units,
    limits.maxArrayItems,
    limits.maxObjectMembers,
    limits.maxObjectMembersPerObject,
    limits.maxArrays,
    limits.maxObjects,
  ];
  return (
    limits.maxNesting > MAX_JSON_NESTING ||
    limits.maxObjectMembersPerObject >
      BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  );
}

export function createCounters(): MutableCounters {
  return {
    utf8Bytes: 0,
    maximumNesting: 0,
    maximumStringUtf16Units: 0,
    stringUtf16Units: 0,
    strings: 0,
    arrayItems: 0,
    objectMembers: 0,
    arrays: 0,
    objects: 0,
  };
}

function snapshot(counters: MutableCounters): BoundedJsonCounters {
  return Object.freeze({ ...counters });
}

export function failureResult(
  error: ParseFailure,
  counters: MutableCounters,
): BoundedJsonParseResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: error.code,
      offset: error.offset,
      message: error.message,
    }),
    counters: snapshot(counters),
  });
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isJsonWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}
