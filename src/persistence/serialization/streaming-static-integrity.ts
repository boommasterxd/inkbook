import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";

import { serializeBackgroundPaths } from "./background";
import { serializeElementPaths } from "./path-markup";

interface ExpectedToken {
  readonly allowLeadingWhitespace?: boolean;
  readonly text: string;
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

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number) {
    this.#tokens = staticTokens(snapshot, lockedHeight)[Symbol.iterator]();
  }

  public get failure(): "invalid-svg" | "static-path-mismatch" {
    return this.#failure;
  }

  public write(input: string): boolean {
    for (const character of input) {
      if (!this.#consume(character)) return false;
    }
    return true;
  }

  public finish(): boolean {
    this.#advancePastEmptyTokens();
    return this.#finished;
  }

  #consume(character: string): boolean {
    this.#advancePastEmptyTokens();
    if (this.#finished) return isWhitespace(character);
    const current = this.#current!;
    if (this.#offset === 0 && current.allowLeadingWhitespace === true && isWhitespace(character)) {
      return true;
    }
    if (current.text[this.#offset] !== character) {
      if (current.text.startsWith("</") && this.#offset <= 1) this.#failure = "invalid-svg";
      return false;
    }
    this.#offset += 1;
    return true;
  }

  #advancePastEmptyTokens(): void {
    while (this.#current === null || this.#offset === this.#current.text.length) {
      const next = this.#tokens.next();
      this.#offset = 0;
      if (next.done) {
        this.#current = null;
        this.#finished = true;
        return;
      }
      this.#current = next.value;
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
    for (const fragment of serializeElementPaths(element)) yield { text: fragment };
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
