import { deriveRenderBands } from "../../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";

import { serializeBackgroundPaths } from "../output/background";
import { serializeElementPaths } from "../output/path-markup";
import { serializeTextMarkupFragments } from "../output/text-markup";

interface ExpectedToken {
  readonly allowLeadingWhitespace?: boolean;
  readonly text: string;
  readonly legacyOptional?: true;
  readonly legacyText?: string;
  readonly legacyTexts?: readonly [string, string, string];
}

/**
 * Compares the static SVG suffix with canonical fragments while retaining no supplied path text.
 * Only inter-group whitespace accepted by the safe envelope is ignored.
 */
export class StreamingStaticIntegrityMatcher {
  readonly #tokens: Iterator<ExpectedToken>;
  #current: ExpectedToken | null = null;
  #failure: "invalid-svg" | "static-path-mismatch" = "static-path-mismatch";
  #finished = false;
  #offset = 0;
  #valid = true;
  #legacyTextLengths = 0;
  #alternatives: readonly string[] = [];
  #possibleAlternatives = 0;
  #alternativeComplete = false;

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number) {
    this.#tokens = staticTokens(snapshot, lockedHeight)[Symbol.iterator]();
  }

  public get failure(): "invalid-svg" | "static-path-mismatch" {
    return this.#failure;
  }

  public get requiresCanonicalRewrite(): boolean {
    return this.#legacyTextLengths > 0;
  }

  public write(input: string): boolean {
    if (!this.#valid) return false;
    let cursor = 0;
    while (cursor < input.length) {
      this.#advancePastEmptyTokens();
      if (this.#finished) return /^[ \t\r\n]*$/u.test(input.slice(cursor));
      const current = this.#current!;
      if (this.#alternatives.length > 0) {
        const consumed = this.#matchAlternative(input, cursor);
        if (!this.#valid) return false;
        cursor += consumed;
        continue;
      }
      if (this.#offset === 0 && current.legacyOptional === true && input[cursor] === ">") {
        this.#offset = current.text.length;
        this.#legacyTextLengths++;
        continue;
      }
      if (
        this.#offset === 0 &&
        current.allowLeadingWhitespace === true &&
        isWhitespace(input[cursor]!)
      ) {
        cursor += 1;
        continue;
      }
      const length = Math.min(input.length - cursor, current.text.length - this.#offset);
      const supplied = input.slice(cursor, cursor + length);
      this.#valid = supplied === current.text.slice(this.#offset, this.#offset + length);
      if (!this.#valid) {
        this.#classifyMismatch(input, cursor, length);
        return false;
      }
      this.#offset += length;
      cursor += length;
    }
    return true;
  }

  public finish(): boolean {
    if (!this.#valid) return false;
    this.#advancePastEmptyTokens();
    return this.#finished;
  }

  #matchAlternative(input: string, cursor: number): number {
    let length = input.length - cursor;
    for (const [index, alternative] of this.#alternatives.entries())
      if (this.#possibleAlternatives & (1 << index))
        length = Math.min(length, alternative.length - this.#offset);
    const supplied = input.slice(cursor, cursor + length);
    for (const [index, alternative] of this.#alternatives.entries()) {
      if (supplied !== alternative.slice(this.#offset, this.#offset + length))
        this.#possibleAlternatives &= ~(1 << index);
    }
    this.#valid = this.#possibleAlternatives !== 0;
    this.#offset += length;
    this.#alternativeComplete = this.#alternatives.some(
      (alternative, index) =>
        (this.#possibleAlternatives & (1 << index)) !== 0 && this.#offset === alternative.length,
    );
    if (this.#alternativeComplete && !(this.#possibleAlternatives & 1)) this.#legacyTextLengths++;
    return length;
  }

  #classifyMismatch(input: string, cursor: number, length: number): void {
    const text = this.#current!.text;
    if (!text.startsWith("</") || this.#offset > 1) return;
    const prefixLength = Math.min(length, 2 - this.#offset);
    if (
      input.slice(cursor, cursor + prefixLength) !==
      text.slice(this.#offset, this.#offset + prefixLength)
    ) {
      this.#failure = "invalid-svg";
    }
  }

  #advancePastEmptyTokens(): void {
    while (
      this.#current === null ||
      (this.#alternatives.length === 0
        ? this.#offset === this.#current.text.length
        : this.#alternativeComplete)
    ) {
      const next = this.#tokens.next();
      this.#offset = 0;
      this.#alternatives = [];
      this.#possibleAlternatives = 0;
      this.#alternativeComplete = false;
      if (next.done) {
        this.#current = null;
        this.#finished = true;
        return;
      }
      this.#current = next.value;
      if (next.value.legacyTexts !== undefined || next.value.legacyText !== undefined) {
        this.#alternatives = [
          next.value.text,
          ...(next.value.legacyTexts ?? [next.value.legacyText!]),
        ];
        this.#possibleAlternatives = (1 << this.#alternatives.length) - 1;
      }
      if (next.value.text.length > 0) return;
    }
  }
}

function* staticTokens(snapshot: InkSnapshotV1, lockedHeight: number): Iterable<ExpectedToken> {
  const bands = deriveRenderBands(snapshot.elements);
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-background">' };
  for (const fragment of serializeBackgroundPaths(snapshot.page.background, lockedHeight)) {
    yield { text: fragment };
  }
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-highlights">' };
  yield* elementTokens(bands.highlight);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-content">' };
  yield* elementTokens(bands.content);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: "</svg>" };
}

function* elementTokens(elements: readonly InkElementV1[]): Iterable<ExpectedToken> {
  for (const element of elements) {
    if (element.kind === "text") yield* serializeTextMarkupFragments(element, true);
    else yield { text: serializeElementPaths(element).join("") };
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
