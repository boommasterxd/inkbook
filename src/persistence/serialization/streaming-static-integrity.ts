import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";

import {
  serializeBackgroundPaths,
  serializeLegacyCenteredBackgroundPaths,
  serializePreviousInsetBackgroundPaths,
  serializePreviousTopAnchoredBackgroundPaths,
} from "./background";
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
  #candidates: StaticTokenCandidate[];
  #failure: "invalid-svg" | "static-path-mismatch" = "static-path-mismatch";

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number) {
    this.#candidates = [
      new StaticTokenCandidate(staticTokens(snapshot, lockedHeight, "canonical"), false),
    ];
    if (snapshot.page.background.type !== "none") {
      this.#candidates.push(
        new StaticTokenCandidate(staticTokens(snapshot, lockedHeight, "previous-inset"), true),
        new StaticTokenCandidate(
          staticTokens(snapshot, lockedHeight, "previous-top-anchored"),
          true,
        ),
        new StaticTokenCandidate(staticTokens(snapshot, lockedHeight, "centered"), true),
      );
    }
  }

  public get failure(): "invalid-svg" | "static-path-mismatch" {
    return this.#failure;
  }

  public get requiresCanonicalRewrite(): boolean {
    return (
      this.#candidates.length > 0 &&
      this.#candidates.every((candidate) => candidate.legacyBackground)
    );
  }

  public write(input: string): boolean {
    for (const character of input) {
      const rejected: StaticTokenCandidate[] = [];
      this.#candidates = this.#candidates.filter((candidate) => {
        const accepted = candidate.consume(character);
        if (!accepted) rejected.push(candidate);
        return accepted;
      });
      if (this.#candidates.length === 0) {
        if (rejected.some((candidate) => candidate.failure === "invalid-svg")) {
          this.#failure = "invalid-svg";
        }
        return false;
      }
    }
    return true;
  }

  public finish(): boolean {
    this.#candidates = this.#candidates.filter((candidate) => candidate.finish());
    return this.#candidates.length > 0;
  }
}

class StaticTokenCandidate {
  readonly legacyBackground: boolean;
  readonly #tokens: Iterator<ExpectedToken>;
  #current: ExpectedToken | null = null;
  #failure: "invalid-svg" | "static-path-mismatch" = "static-path-mismatch";
  #finished = false;
  #offset = 0;

  public constructor(tokens: Iterable<ExpectedToken>, legacyBackground: boolean) {
    this.#tokens = tokens[Symbol.iterator]();
    this.legacyBackground = legacyBackground;
  }

  public get failure(): "invalid-svg" | "static-path-mismatch" {
    return this.#failure;
  }

  public consume(character: string): boolean {
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

  public finish(): boolean {
    this.#advancePastEmptyTokens();
    return this.#finished;
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

function* staticTokens(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  backgroundAlignment: "canonical" | "centered" | "previous-inset" | "previous-top-anchored",
): Iterable<ExpectedToken> {
  const bands = deriveRenderBands(snapshot.elements);
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-background">' };
  const backgroundPaths =
    backgroundAlignment === "canonical"
      ? serializeBackgroundPaths(snapshot.page.background, lockedHeight)
      : backgroundAlignment === "previous-inset"
        ? serializePreviousInsetBackgroundPaths(snapshot.page.background, lockedHeight)
        : backgroundAlignment === "previous-top-anchored"
          ? serializePreviousTopAnchoredBackgroundPaths(snapshot.page.background, lockedHeight)
          : serializeLegacyCenteredBackgroundPaths(snapshot.page.background, lockedHeight);
  for (const fragment of backgroundPaths) {
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
