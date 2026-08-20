import {
  countValidUtf8Bytes,
  isHighSurrogate,
  isLowSurrogate,
  jsonHexValue,
} from "./json-unicode";

const MAX_JSON_NESTING = 64;
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

export interface BoundedJsonLimits {
  readonly maxUtf8Bytes: number;
  readonly maxNesting: number;
  readonly maxStringUtf16Units: number;
  readonly maxArrayItems: number;
  readonly maxObjectMembers: number;
  readonly maxArrays: number;
  readonly maxObjects: number;
}

interface BoundedJsonCounters {
  readonly utf8Bytes: number;
  readonly maximumNesting: number;
  readonly maximumStringUtf16Units: number;
  readonly stringUtf16Units: number;
  readonly strings: number;
  readonly arrayItems: number;
  readonly objectMembers: number;
  readonly arrays: number;
  readonly objects: number;
}

export type BoundedJsonErrorCode =
  | "invalid-limits"
  | "utf8-byte-limit"
  | "nesting-limit"
  | "string-limit"
  | "array-item-limit"
  | "object-member-limit"
  | "array-limit"
  | "object-limit"
  | "invalid-unicode"
  | "invalid-syntax"
  | "duplicate-key"
  | "non-finite-number"
  | "trailing-data";

interface BoundedJsonError {
  readonly code: BoundedJsonErrorCode;
  readonly offset: number;
  readonly message: string;
}

export type BoundedJsonParseResult =
  | {
      readonly ok: true;
      readonly value: BoundedJsonValue;
      readonly counters: BoundedJsonCounters;
    }
  | {
      readonly ok: false;
      readonly error: BoundedJsonError;
      readonly counters: BoundedJsonCounters;
    };

type MutableCounters = {
  -readonly [Key in keyof BoundedJsonCounters]: BoundedJsonCounters[Key];
};

class ParseFailure extends Error {
  public constructor(
    public readonly code: BoundedJsonErrorCode,
    public readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseBoundedJson(
  input: string,
  limits: BoundedJsonLimits,
): BoundedJsonParseResult {
  const counters = createCounters();
  const boundedLimits = Object.freeze({ ...limits });
  if (hasInvalidLimits(boundedLimits)) {
    return failureResult(
      new ParseFailure("invalid-limits", 0, "Bounded JSON limits are invalid."),
      counters,
    );
  }

  try {
    const byteCount = countValidUtf8Bytes(input);
    if (!byteCount.ok) {
      throw new ParseFailure(
        "invalid-unicode",
        byteCount.invalidOffset,
        "JSON input contains an unpaired surrogate.",
      );
    }
    counters.utf8Bytes = byteCount.bytes;
    if (counters.utf8Bytes > boundedLimits.maxUtf8Bytes) {
      throw new ParseFailure(
        "utf8-byte-limit",
        input.length,
        "JSON input exceeds the UTF-8 byte limit.",
      );
    }
    return new Parser(input, boundedLimits, counters).parse();
  } catch (error: unknown) {
    if (!(error instanceof ParseFailure)) throw error;
    return failureResult(error, counters);
  }
}

class Parser {
  private offset = 0;

  public constructor(
    private readonly input: string,
    private readonly limits: BoundedJsonLimits,
    private readonly counters: MutableCounters,
  ) {}

  public parse(): BoundedJsonParseResult {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.offset !== this.input.length) {
      this.fail("trailing-data", "JSON input contains trailing data.");
    }
    return Object.freeze({
      ok: true,
      value,
      counters: snapshot(this.counters),
    });
  }

  private parseValue(nesting: number): BoundedJsonValue {
    const character = this.input[this.offset];
    let value: BoundedJsonValue;
    if (character === '"') value = this.parseString();
    else if (character === "[") value = this.parseArray(nesting + 1);
    else if (character === "{") value = this.parseObject(nesting + 1);
    else if (character === "t") value = this.parseLiteral("true", true);
    else if (character === "f") value = this.parseLiteral("false", false);
    else if (character === "n") value = this.parseLiteral("null", null);
    else if (character === "-" || isDigit(character))
      value = this.parseNumber();
    else this.fail("invalid-syntax", "Expected a JSON value.");
    return value;
  }

  private parseArray(nesting: number): readonly BoundedJsonValue[] {
    this.admitContainer(
      nesting,
      "arrays",
      this.limits.maxArrays,
      "array-limit",
    );
    this.offset += 1;
    const values: BoundedJsonValue[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return Object.freeze(values);

    for (;;) {
      this.increment(
        "arrayItems",
        this.limits.maxArrayItems,
        "array-item-limit",
      );
      values.push(this.parseValue(nesting));
      this.skipWhitespace();
      if (this.consume("]")) return Object.freeze(values);
      this.expect(",", "Expected a comma or closing bracket.");
      this.skipWhitespace();
    }
  }

  private parseObject(
    nesting: number,
  ): Readonly<Record<string, BoundedJsonValue>> {
    this.admitContainer(
      nesting,
      "objects",
      this.limits.maxObjects,
      "object-limit",
    );
    this.offset += 1;
    const value: Record<string, BoundedJsonValue> = Object.create(
      null,
    ) as Record<string, BoundedJsonValue>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return Object.freeze(value);

    for (;;) {
      if (this.input[this.offset] !== '"') {
        this.fail("invalid-syntax", "Expected a quoted object member name.");
      }
      const keyOffset = this.offset;
      const key = this.parseString();
      this.increment(
        "objectMembers",
        this.limits.maxObjectMembers,
        "object-member-limit",
      );
      if (keys.has(key)) {
        throw new ParseFailure(
          "duplicate-key",
          keyOffset,
          "JSON objects must not contain duplicate member names.",
        );
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(":", "Expected a colon after the object member name.");
      this.skipWhitespace();
      value[key] = this.parseValue(nesting);
      this.skipWhitespace();
      if (this.consume("}")) return Object.freeze(value);
      this.expect(",", "Expected a comma or closing brace.");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.offset += 1;
    const parts: string[] = [];
    let segmentStart = this.offset;
    let decodedUnits = 0;

    while (this.offset < this.input.length) {
      const codeUnit = this.input.charCodeAt(this.offset);
      if (this.input[this.offset] === '"') {
        parts.push(this.input.slice(segmentStart, this.offset));
        this.offset += 1;
        return this.finishString(parts, decodedUnits);
      }
      if (this.input[this.offset] === "\\") {
        decodedUnits += this.offset - segmentStart;
        this.checkStringLimit(decodedUnits);
        parts.push(this.input.slice(segmentStart, this.offset));
        this.offset += 1;
        const escaped = this.parseEscape();
        parts.push(escaped);
        decodedUnits += escaped.length;
        this.checkStringLimit(decodedUnits);
        segmentStart = this.offset;
        continue;
      }
      if (codeUnit < CONTROL_CHARACTER_LIMIT) {
        this.fail(
          "invalid-syntax",
          "JSON strings cannot contain control characters.",
        );
      }
      this.offset += 1;
      this.checkStringLimit(decodedUnits + this.offset - segmentStart);
    }
    this.fail("invalid-syntax", "JSON string is not terminated.");
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

  private parseEscape(): string {
    const escape = this.input[this.offset];
    this.offset += 1;
    if (escape === '"' || escape === "\\" || escape === "/") return escape;
    if (escape === "b") return "\b";
    if (escape === "f") return "\f";
    if (escape === "n") return "\n";
    if (escape === "r") return "\r";
    if (escape === "t") return "\t";
    if (escape !== "u") {
      this.fail("invalid-syntax", "JSON string contains an invalid escape.");
    }

    const first = this.parseHexCodeUnit();
    if (isLowSurrogate(first)) {
      this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    if (!isHighSurrogate(first)) return String.fromCharCode(first);
    if (!this.input.startsWith("\\u", this.offset)) {
      this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    this.offset += "\\u".length;
    const second = this.parseHexCodeUnit();
    if (!isLowSurrogate(second)) {
      this.fail(
        "invalid-unicode",
        "JSON string contains an unpaired surrogate.",
      );
    }
    return String.fromCharCode(first, second);
  }

  private parseHexCodeUnit(): number {
    if (this.offset + FOUR_HEX_DIGITS > this.input.length) {
      this.fail(
        "invalid-syntax",
        "Unicode escape must contain four hex digits.",
      );
    }
    let value = 0;
    for (let count = 0; count < FOUR_HEX_DIGITS; count += 1) {
      const digit = jsonHexValue(this.input.charCodeAt(this.offset));
      if (digit === undefined) {
        this.fail(
          "invalid-syntax",
          "Unicode escape must contain four hex digits.",
        );
      }
      value = value * HEX_RADIX + digit;
      this.offset += 1;
    }
    return value;
  }

  private parseNumber(): number {
    const start = this.offset;
    if (this.consume("-"))
      this.requireDigit("Expected a digit after the minus sign.");
    if (this.consume("0")) {
      if (isDigit(this.input[this.offset])) {
        this.fail(
          "invalid-syntax",
          "JSON numbers cannot contain leading zeroes.",
        );
      }
    } else {
      this.requireDigit("Expected an integer part.");
      while (isDigit(this.input[this.offset])) this.offset += 1;
    }
    if (this.consume(".")) {
      this.requireDigit("Expected a digit after the decimal point.");
      while (isDigit(this.input[this.offset])) this.offset += 1;
    }
    if (this.input[this.offset] === "e" || this.input[this.offset] === "E") {
      this.offset += 1;
      if (this.input[this.offset] === "+" || this.input[this.offset] === "-") {
        this.offset += 1;
      }
      this.requireDigit("Expected a digit in the exponent.");
      while (isDigit(this.input[this.offset])) this.offset += 1;
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

  private parseLiteral<T extends boolean | null>(text: string, value: T): T {
    if (!this.input.startsWith(text, this.offset)) {
      this.fail("invalid-syntax", `Expected ${text}.`);
    }
    this.offset += text.length;
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

  private expect(character: string, message: string): void {
    if (!this.consume(character)) this.fail("invalid-syntax", message);
  }

  private consume(character: string): boolean {
    if (this.input[this.offset] !== character) return false;
    this.offset += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.input[this.offset])) this.offset += 1;
  }

  private fail(code: BoundedJsonErrorCode, message: string): never {
    throw new ParseFailure(code, this.offset, message);
  }
}

function hasInvalidLimits(limits: BoundedJsonLimits): boolean {
  const values = [
    limits.maxUtf8Bytes,
    limits.maxNesting,
    limits.maxStringUtf16Units,
    limits.maxArrayItems,
    limits.maxObjectMembers,
    limits.maxArrays,
    limits.maxObjects,
  ];
  return (
    limits.maxNesting > MAX_JSON_NESTING ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  );
}

function createCounters(): MutableCounters {
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

function failureResult(
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
