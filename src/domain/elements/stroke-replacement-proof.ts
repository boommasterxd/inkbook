import type { StrokeElementV1 } from "../schema/public";

export interface CanonicalStrokeReplacementProof {
  readonly source: object;
  readonly translation: Readonly<{ x: number; y: number }>;
}

const canonicalReplacementProofs = new WeakMap<object, CanonicalStrokeReplacementProof>();
const storedStrokeProofs = new WeakSet<object>();

export function markStoredStroke<T extends object>(stroke: T): T {
  canonicalReplacementProofs.delete(stroke);
  storedStrokeProofs.add(stroke);
  return stroke;
}

export function markCanonicalStrokeReplacement(
  source: object,
  replacement: StrokeElementV1,
  translation: Readonly<{ x: number; y: number }>,
): StrokeElementV1 {
  if (storedStrokeProofs.has(source)) {
    // Typed arrays cannot be frozen; proof callers transfer a fresh full-span buffer exclusively.
    const ownsImmutablePoints =
      replacement.points instanceof Float64Array || Object.isFrozen(replacement.points);
    if (
      !Object.isFrozen(replacement) ||
      !Object.isFrozen(replacement.pivot) ||
      !ownsImmutablePoints
    ) {
      throw new TypeError("Canonical stroke replacements must be immutable.");
    }
    const immutableTranslation = Object.isFrozen(translation)
      ? translation
      : Object.freeze({ ...translation });
    canonicalReplacementProofs.set(
      replacement,
      Object.freeze({ source, translation: immutableTranslation }),
    );
  }
  return replacement;
}

export function getCanonicalStrokeReplacementProof(
  stroke: object,
): CanonicalStrokeReplacementProof | undefined {
  return canonicalReplacementProofs.get(stroke);
}

export function isStoredStroke(stroke: object): boolean {
  return storedStrokeProofs.has(stroke);
}
