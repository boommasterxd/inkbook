import {
  createCounters,
  failureResult,
  hasInvalidLimits,
  IncrementalJsonParser,
  ParseFailure,
} from "./bounded-json-parser";
import { isHighSurrogate, isLowSurrogate } from "./json-unicode";

export const BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS = 16_384;
export { BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT } from "./bounded-json-parser";
const ASCII_MAX = 0x7f;
const TWO_BYTE_UTF8_MAX = 0x7ff;
const TWO_UTF8_BYTES = 2;
const THREE_UTF8_BYTES = 3;
const FOUR_UTF8_BYTES = 4;

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
  readonly maxObjectMembersPerObject: number;
  readonly maxArrays: number;
  readonly maxObjects: number;
}

export interface BoundedJsonCounters {
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

export interface BoundedJsonProcessor {
  readonly done: boolean;
  processNext(maxUtf16Units?: number): boolean;
  complete(): BoundedJsonParseResult | undefined;
}

export function createBoundedJsonProcessor(
  input: string,
  limits: BoundedJsonLimits,
): BoundedJsonProcessor {
  return new Processor(input, limits);
}

export function parseBoundedJson(
  input: string,
  limits: BoundedJsonLimits,
): BoundedJsonParseResult {
  const processor = createBoundedJsonProcessor(input, limits);
  while (!processor.processNext()) {
    // The synchronous API intentionally drives the same resumable parser.
  }
  const result = processor.complete();
  if (result === undefined)
    throw new Error("Bounded JSON parser did not finish.");
  return result;
}

class Processor implements BoundedJsonProcessor {
  private readonly counters = createCounters();
  private readonly limits: BoundedJsonLimits;
  private preflightOffset = 0;
  private utf8Bytes = 0;
  private pendingHighSurrogateOffset: number | undefined;
  private parser: IncrementalJsonParser | undefined;
  private result: BoundedJsonParseResult | undefined;

  public constructor(
    private readonly input: string,
    limits: BoundedJsonLimits,
  ) {
    this.limits = Object.freeze({ ...limits });
    if (hasInvalidLimits(this.limits)) {
      this.result = failureResult(
        new ParseFailure(
          "invalid-limits",
          0,
          "Bounded JSON limits are invalid.",
        ),
        this.counters,
      );
    }
  }

  public get done(): boolean {
    return this.result !== undefined;
  }

  public processNext(
    maxUtf16Units = BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS,
  ): boolean {
    if (this.done) return true;
    validateProcessLimit(maxUtf16Units);
    const boundedUnits = Math.min(
      maxUtf16Units,
      BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS,
    );
    try {
      if (this.parser === undefined) this.processPreflight(boundedUnits);
      else this.processParser(boundedUnits);
    } catch (error: unknown) {
      if (!(error instanceof ParseFailure)) throw error;
      this.result = failureResult(error, this.counters);
    }
    return this.done;
  }

  public complete(): BoundedJsonParseResult | undefined {
    return this.result;
  }

  private processPreflight(maxUtf16Units: number): void {
    const end = Math.min(
      this.input.length,
      this.preflightOffset + maxUtf16Units,
    );
    while (this.preflightOffset < end) this.countNextCodeUnit();
    if (this.preflightOffset !== this.input.length) return;
    if (this.pendingHighSurrogateOffset !== undefined) {
      throw new ParseFailure(
        "invalid-unicode",
        this.pendingHighSurrogateOffset,
        "JSON input contains an unpaired surrogate.",
      );
    }
    this.counters.utf8Bytes = this.utf8Bytes;
    if (this.utf8Bytes > this.limits.maxUtf8Bytes) {
      throw new ParseFailure(
        "utf8-byte-limit",
        this.input.length,
        "JSON input exceeds the UTF-8 byte limit.",
      );
    }
    this.parser = new IncrementalJsonParser(
      this.input,
      this.limits,
      this.counters,
    );
  }

  private countNextCodeUnit(): void {
    const offset = this.preflightOffset;
    const codeUnit = this.input.charCodeAt(offset);
    this.preflightOffset += 1;
    if (this.pendingHighSurrogateOffset !== undefined) {
      if (!isLowSurrogate(codeUnit)) {
        throw new ParseFailure(
          "invalid-unicode",
          this.pendingHighSurrogateOffset,
          "JSON input contains an unpaired surrogate.",
        );
      }
      this.pendingHighSurrogateOffset = undefined;
      this.utf8Bytes += FOUR_UTF8_BYTES;
    } else if (codeUnit <= ASCII_MAX) this.utf8Bytes += 1;
    else if (codeUnit <= TWO_BYTE_UTF8_MAX) this.utf8Bytes += TWO_UTF8_BYTES;
    else if (isHighSurrogate(codeUnit)) {
      this.pendingHighSurrogateOffset = offset;
    } else if (isLowSurrogate(codeUnit)) {
      throw new ParseFailure(
        "invalid-unicode",
        offset,
        "JSON input contains an unpaired surrogate.",
      );
    } else this.utf8Bytes += THREE_UTF8_BYTES;
  }

  private processParser(maxUtf16Units: number): void {
    const result = this.parser?.processNext(maxUtf16Units);
    if (result !== undefined) this.result = result;
  }
}

function validateProcessLimit(maxUtf16Units: number): void {
  if (!Number.isSafeInteger(maxUtf16Units) || maxUtf16Units <= 0) {
    throw new RangeError("Parser work must be a positive safe integer.");
  }
}
