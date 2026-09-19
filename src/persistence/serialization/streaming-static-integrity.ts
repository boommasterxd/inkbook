import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";

import { serializeBackgroundPaths } from "./background";
import { integrityOutlinePaths } from "./legacy-outline-paths";

interface ExpectedToken {
  readonly allowLeadingWhitespace?: boolean;
  readonly text: string;
  readonly rounded?: string;
  readonly legacy?: string;
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
  readonly #valid = [true, true, true];

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number) {
    this.#tokens = staticTokens(snapshot, lockedHeight, (profile) => this.#valid[profile]!)[
      Symbol.iterator
    ]();
  }

  public get failure(): "invalid-svg" | "static-path-mismatch" {
    return this.#failure;
  }

  public get requiresCanonicalRewrite(): boolean {
    return !this.#valid[0] && (this.#valid[1]! || this.#valid[2]!);
  }

  public write(input: string): boolean {
    if (!this.#valid.some(Boolean)) return false;
    let cursor = 0;
    while (cursor < input.length) {
      this.#advancePastEmptyTokens();
      if (this.#finished) return /^[ \t\r\n]*$/u.test(input.slice(cursor));
      const current = this.#current!;
      if (
        this.#offset === 0 &&
        current.allowLeadingWhitespace === true &&
        isWhitespace(input[cursor]!)
      ) {
        cursor += 1;
        continue;
      }
      const length = Math.min(input.length - cursor, this.#remainingLength());
      const supplied = input.slice(cursor, cursor + length);
      for (let profile = 0; profile < this.#valid.length; profile += 1) {
        if (this.#valid[profile]) {
          const expected = this.#profileText(profile);
          this.#valid[profile] = supplied === expected.slice(this.#offset, this.#offset + length);
        }
      }
      if (!this.#valid.some(Boolean)) {
        this.#classifyMismatch(input, cursor, length);
        return false;
      }
      this.#offset += length;
      cursor += length;
    }
    return true;
  }

  public finish(): boolean {
    if (!this.#valid.some(Boolean)) return false;
    this.#advancePastEmptyTokens();
    return this.#finished;
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

  #profileText(profile: number): string {
    const token = this.#current!;
    if (profile === 1) return token.rounded ?? token.text;
    return profile === 2 ? (token.legacy ?? token.text) : token.text;
  }

  #remainingLength(): number {
    let remaining = Infinity;
    for (let profile = 0; profile < this.#valid.length; profile += 1) {
      if (this.#valid[profile]) {
        remaining = Math.min(remaining, this.#profileText(profile).length - this.#offset);
      }
    }
    return remaining;
  }

  #expectedLength(): number {
    return this.#profileText(this.#valid.findIndex(Boolean)).length;
  }

  #advancePastEmptyTokens(): void {
    while (this.#current === null || this.#offset === this.#expectedLength()) {
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

function* staticTokens(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  includeProfile: (profile: number) => boolean,
): Iterable<ExpectedToken> {
  const bands = deriveRenderBands(snapshot.elements);
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-background">' };
  for (const fragment of serializeBackgroundPaths(snapshot.page.background, lockedHeight)) {
    yield { text: fragment };
  }
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-highlights">' };
  yield* elementTokens(bands.highlight, includeProfile);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-content">' };
  yield* elementTokens(bands.content, includeProfile);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: "</svg>" };
}

function* elementTokens(
  elements: readonly InkElementV1[],
  includeProfile: (profile: number) => boolean,
): Iterable<ExpectedToken> {
  for (const element of elements) {
    const [text, rounded, legacy] = integrityOutlinePaths(element, includeProfile);
    yield { text, rounded, legacy };
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
