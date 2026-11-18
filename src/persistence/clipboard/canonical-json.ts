import { MAX_JSON_DEPTH } from "../../domain/schema/public";
import { CLIPBOARD_LIMITS, INKBOOK_CLIPBOARD_TEXT_PREFIX } from "./constants";
import type { ClipboardResult } from "./types";

export const CLIPBOARD_JSON_LIMITS = {
  maximumContainerEntries: CLIPBOARD_LIMITS.pointsPerStroke * 3,
  maximumDepth: MAX_JSON_DEPTH,
  maximumNodes: CLIPBOARD_LIMITS.strokePoints * 4 + CLIPBOARD_LIMITS.elements * 64,
  maximumOutputCharacters: CLIPBOARD_LIMITS.totalInputBytes,
};

const encoder = new TextEncoder();
const prefixBytes = encoder.encode(INKBOOK_CLIPBOARD_TEXT_PREFIX).byteLength;

interface JsonWorkProfile {
  readonly nodeLimit: number;
  readonly inputByteLimit: number;
}

type Frame =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "array"; readonly value: ArrayLike<unknown>; index: number }
  | {
      readonly kind: "object";
      readonly value: Record<string, unknown>;
      readonly keys: string[];
      index: number;
    };

interface WrittenJson {
  readonly byteLength: number;
  readonly text: string;
}

/** Charge UTF-8 chunks before retaining them and enforce the reader's structural limits in the same traversal. */
export function* writeClipboardJsonSteps(
  value: unknown,
  includePlainPrefix: boolean,
  profile: JsonWorkProfile = { nodeLimit: 256, inputByteLimit: 16_384 },
): Generator<void, ClipboardResult<WrittenJson>> {
  const maximum = CLIPBOARD_LIMITS.totalInputBytes - (includePlainPrefix ? prefixBytes : 0);
  const writer = new ClipboardJsonWriter(maximum, profile);
  return yield* writer.write(value);
}

const limitExceeded = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "limit-exceeded", message },
});

class ClipboardJsonWriter {
  readonly #chunks: string[] = [];
  #current = "";
  #bytes = 0;
  #nodes = 0;

  constructor(
    readonly maximum: number,
    readonly profile: JsonWorkProfile,
  ) {}

  *write(value: unknown): Generator<void, ClipboardResult<WrittenJson>> {
    const stack: Frame[] = [{ kind: "value", value }];
    while (stack.length > 0 && this.#bytes <= this.maximum) {
      const frame = stack.pop()!;
      if (frame.kind !== "value") {
        this.#continueContainer(frame, stack);
        continue;
      }
      if (++this.#nodes > CLIPBOARD_JSON_LIMITS.maximumNodes)
        return limitExceeded("Clipboard JSON value count exceeds the input limit.");
      if (this.#nodes % this.profile.nodeLimit === 0) yield;
      const next = frame.value;
      if (next !== null && typeof next === "object") {
        if (
          stack.length + 1 > CLIPBOARD_JSON_LIMITS.maximumDepth ||
          !this.#openContainer(next, stack)
        )
          return limitExceeded("Clipboard JSON container exceeds the input limits.");
      } else if (typeof next === "string" && next.length > this.profile.inputByteLimit) {
        yield* this.#writeString(next);
      } else {
        const serialized = JSON.stringify(next);
        if (serialized === undefined) throw new TypeError("Clipboard payload is not serializable.");
        this.#append(serialized);
      }
    }
    this.#flush();
    if (this.#bytes > this.maximum)
      return limitExceeded("Clipboard payload exceeds the 8 MiB input limit.");
    return { ok: true, value: { byteLength: this.#bytes, text: this.#chunks.join("") } };
  }

  #openContainer(value: object, stack: Frame[]): boolean {
    if (value instanceof Float64Array || Array.isArray(value)) {
      if (value.length > CLIPBOARD_JSON_LIMITS.maximumContainerEntries) return false;
      this.#append("[");
      stack.push({ index: 0, kind: "array", value });
    } else {
      const keys = Object.keys(value).sort();
      if (keys.length > CLIPBOARD_JSON_LIMITS.maximumContainerEntries) return false;
      this.#append("{");
      stack.push({ index: 0, keys, kind: "object", value: value as Record<string, unknown> });
    }
    return true;
  }

  *#writeString(value: string): Generator<void, void> {
    this.#append('"');
    for (let start = 0; start < value.length && this.#bytes <= this.maximum;) {
      let end = Math.min(value.length, start + Math.max(2, this.profile.inputByteLimit));
      const trailing = value.charCodeAt(end - 1);
      if (end < value.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
      this.#append(JSON.stringify(value.slice(start, end)).slice(1, -1));
      start = end;
      yield;
    }
    this.#append('"');
  }

  #continueContainer(frame: Exclude<Frame, { kind: "value" }>, stack: Frame[]): void {
    const length = frame.kind === "array" ? frame.value.length : frame.keys.length;
    if (frame.index === length) {
      this.#append(frame.kind === "array" ? "]" : "}");
      return;
    }
    if (frame.index > 0) this.#append(",");
    const index = frame.index++;
    if (frame.kind === "array") stack.push(frame, { kind: "value", value: frame.value[index] });
    else {
      const key = frame.keys[index]!;
      this.#append(`${JSON.stringify(key)}:`);
      stack.push(frame, { kind: "value", value: frame.value[key] });
    }
  }

  #append(value: string): void {
    this.#current += value;
    if (this.#current.length >= this.profile.inputByteLimit) this.#flush();
  }

  #flush(): void {
    if (this.#current.length === 0) return;
    this.#bytes += encoder.encode(this.#current).byteLength;
    if (this.#bytes <= this.maximum) this.#chunks.push(this.#current);
    this.#current = "";
  }
}
