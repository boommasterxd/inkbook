import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";

import { serializeBackgroundPaths } from "./background";
import { serializeElementPaths, serializeLegacyPressurePath } from "./path-markup";

interface ExpectedToken {
  readonly allowLeadingWhitespace?: boolean;
  readonly legacyTexts?: () => readonly string[];
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
  #legacyTexts: string[] | null = null;
  #requiresCanonicalRewrite = false;

  public constructor(snapshot: InkSnapshotV1, lockedHeight: number, allowLegacyPressure = true) {
    this.#tokens = staticTokens(snapshot, lockedHeight, allowLegacyPressure)[Symbol.iterator]();
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
    const matches = this.#matchesCharacter(current, character);
    if (!matches) {
      if (current.text.startsWith("</") && this.#offset <= 1) this.#failure = "invalid-svg";
      return false;
    }
    this.#offset += 1;
    return true;
  }

  #matchesCharacter(current: ExpectedToken, character: string): boolean {
    if (this.#legacyTexts === null && current.text[this.#offset] === character) return true;
    const candidates =
      this.#legacyTexts ??
      current
        .legacyTexts?.()
        .filter((text) => text.startsWith(current.text.slice(0, this.#offset))) ??
      [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (candidates[index]![this.#offset] !== character) candidates.splice(index, 1);
    }
    this.#legacyTexts = candidates;
    return candidates.length > 0;
  }

  #advancePastEmptyTokens(): void {
    while (this.#current === null || this.#offset === this.#currentTextLength()) {
      this.#requiresCanonicalRewrite ||= this.#legacyTexts !== null;
      const next = this.#tokens.next();
      this.#offset = 0;
      this.#legacyTexts = null;
      if (next.done) {
        this.#current = null;
        this.#finished = true;
        return;
      }
      this.#current = next.value;
      if (next.value.text.length > 0) return;
    }
  }

  #currentTextLength(): number {
    return this.#legacyTexts?.[0]?.length ?? this.#current!.text.length;
  }
}

function* staticTokens(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  allowLegacyPressure: boolean,
): Iterable<ExpectedToken> {
  const bands = deriveRenderBands(snapshot.elements);
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-background">' };
  for (const fragment of serializeBackgroundPaths(snapshot.page.background, lockedHeight)) {
    yield { text: fragment };
  }
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-highlights">' };
  yield* elementTokens(bands.highlight, allowLegacyPressure);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: '<g id="inkbook-content">' };
  yield* elementTokens(bands.content, allowLegacyPressure);
  yield { text: "</g>" };
  yield { allowLeadingWhitespace: true, text: "</svg>" };
}

function* elementTokens(
  elements: readonly InkElementV1[],
  allowLegacyPressure: boolean,
): Iterable<ExpectedToken> {
  for (const element of elements) {
    const legacyPressure =
      allowLegacyPressure &&
      element.kind === "stroke" &&
      element.tool === "pen" &&
      element.style.pressureEnabled;
    for (const fragment of serializeElementPaths(element)) {
      yield legacyPressure
        ? { text: fragment, legacyTexts: () => legacyPressurePaths(element) }
        : { text: fragment };
    }
  }
}

function legacyPressurePaths(element: Extract<InkElementV1, { kind: "stroke" }>): string[] {
  const oldOutline = serializeLegacyPressurePath(element);
  return [oldOutline, oldOutline.replaceAll(/(A[\d.]+ [\d.]+ 0 0 )0/gu, "$11")];
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
