import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";

import { serializeBackgroundPaths } from "./background";
import { serializeElementPaths } from "./path-markup";

interface ExpectedToken {
  readonly allowLeadingWhitespace?: boolean;
  readonly legacyCapOffsets?: readonly number[];
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
  #legacyCap: boolean | null = null;
  #requiresCanonicalRewrite = false;

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number, allowLegacyCaps = true) {
    this.#tokens = staticTokens(snapshot, lockedHeight, allowLegacyCaps)[Symbol.iterator]();
  }

  public get requiresCanonicalRewrite(): boolean {
    return this.#requiresCanonicalRewrite;
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
    const matches = current.legacyCapOffsets?.includes(this.#offset)
      ? this.#matchesCap(character)
      : current.text[this.#offset] === character;
    if (!matches) {
      if (current.text.startsWith("</") && this.#offset <= 1) this.#failure = "invalid-svg";
      return false;
    }
    this.#offset += 1;
    return true;
  }

  #matchesCap(character: string): boolean {
    if (character !== "0" && character !== "1") return false;
    const legacy = character === "1";
    if (this.#legacyCap !== null && this.#legacyCap !== legacy) return false;
    this.#legacyCap = legacy;
    this.#requiresCanonicalRewrite ||= legacy;
    return true;
  }

  #advancePastEmptyTokens(): void {
    while (this.#current === null || this.#offset === this.#current.text.length) {
      const next = this.#tokens.next();
      this.#offset = 0;
      this.#legacyCap = null;
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
  allowLegacyCaps: boolean,
): Iterable<ExpectedToken> {
  const bands = deriveRenderBands(snapshot.elements);
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-background">' };
  for (const fragment of serializeBackgroundPaths(snapshot.page.background, lockedHeight)) {
    yield { text: fragment };
  }
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-highlights">' };
  yield* elementTokens(bands.highlight, allowLegacyCaps);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-content">' };
  yield* elementTokens(bands.content, allowLegacyCaps);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: "</svg>" };
}

function* elementTokens(
  elements: readonly InkElementV1[],
  allowLegacyCaps: boolean,
): Iterable<ExpectedToken> {
  for (const element of elements) {
    const legacyCaps =
      allowLegacyCaps &&
      element.kind === "stroke" &&
      element.tool === "pen" &&
      element.style.pressureEnabled &&
      element.points.length > 3;
    for (const fragment of serializeElementPaths(element)) {
      yield legacyCaps
        ? { text: fragment, legacyCapOffsets: capSweepOffsets(fragment) }
        : { text: fragment };
    }
  }
}

function capSweepOffsets(fragment: string): number[] {
  return Array.from(
    fragment.matchAll(/A[\d.]+ [\d.]+ 0 0 0/gu),
    (match) => match.index + match[0].length - 1,
  );
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
