import { sampleOffsetWithinRange } from "../schema/stroke-sample-extrema";
import { canonicalizeGeometryNumber } from "../schema/canonical";
import { MAX_ABSOLUTE_COORDINATE } from "../schema/constants";
import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import type { StrokeElementV1 } from "../schema/public";

export interface CanonicalStrokeReplacementProof {
  readonly source: object;
  readonly translation: Readonly<{ x: number; y: number }>;
}

const canonicalReplacementProofs = new WeakMap<object, CanonicalStrokeReplacementProof>();
const storedStrokeProofs = new WeakSet<object>();

export function markStoredStroke<T extends { readonly points: ArrayLike<number> }>(stroke: T): T {
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
    if (
      !Object.isFrozen(replacement) ||
      !Object.isFrozen(replacement.pivot) ||
      (replacement.offset !== undefined && !Object.isFrozen(replacement.offset))
    ) {
      throw new TypeError("Canonical stroke replacements must be immutable.");
    }
    assertCanonicalTranslation(source as StrokeElementV1, replacement, translation);
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

/** Bounds belong to the exclusively owned sample buffer, independent of document position. */
export function storedStrokeOffsetWithinRange(stroke: StrokeElementV1): boolean {
  return sampleOffsetWithinRange(stroke.points, stroke.offset, MAX_ABSOLUTE_COORDINATE);
}

function assertCanonicalTranslation(
  source: StrokeElementV1,
  replacement: StrokeElementV1,
  translation: Readonly<{ x: number; y: number }>,
): void {
  const fields = validateRuntimeInkElementV1({ ...replacement, points: [0, 0, 0.5] });
  if (
    !fields.ok ||
    source.points !== replacement.points ||
    source.style !== replacement.style ||
    source.rotation !== replacement.rotation ||
    source.tool !== replacement.tool ||
    source.id !== replacement.id ||
    source.createdAt !== replacement.createdAt ||
    !translatedPoint(source.pivot, replacement.pivot, translation) ||
    !translatedPoint(source.offset, replacement.offset, translation) ||
    !storedStrokeOffsetWithinRange(replacement)
  ) {
    throw new RangeError("Invalid canonical stroke translation.");
  }
}

function translatedCoordinate(source: number, replacement: number, delta: number): boolean {
  return Number.isFinite(delta) && replacement === canonicalizeGeometryNumber(source + delta);
}

/** History retains owned immutable records; recover their translation without inspecting samples. */
export function inferStoredStrokeTranslation(
  source: object,
  replacement: StrokeElementV1,
): CanonicalStrokeReplacementProof | undefined {
  const existing = getCanonicalStrokeReplacementProof(replacement);
  if (existing?.source === source) return existing;
  if (!isStoredStroke(source) || !isStoredStroke(replacement)) return undefined;
  const current = source as StrokeElementV1;
  if (
    current.points !== replacement.points ||
    current.style !== replacement.style ||
    current.rotation !== replacement.rotation ||
    current.tool !== replacement.tool
  )
    return undefined;
  const translation = {
    x: canonicalizeGeometryNumber((replacement.offset?.x ?? 0) - (current.offset?.x ?? 0)),
    y: canonicalizeGeometryNumber((replacement.offset?.y ?? 0) - (current.offset?.y ?? 0)),
  };
  if (
    !translatedCoordinate(current.pivot.x, replacement.pivot.x, translation.x) ||
    !translatedCoordinate(current.pivot.y, replacement.pivot.y, translation.y)
  )
    return undefined;
  markCanonicalStrokeReplacement(source, replacement, translation);
  return getCanonicalStrokeReplacementProof(replacement);
}

function translatedPoint(
  source: Readonly<{ x: number; y: number }> | undefined,
  replacement: Readonly<{ x: number; y: number }> | undefined,
  delta: Readonly<{ x: number; y: number }>,
): boolean {
  return (
    translatedCoordinate(source?.x ?? 0, replacement?.x ?? 0, delta.x) &&
    translatedCoordinate(source?.y ?? 0, replacement?.y ?? 0, delta.y)
  );
}
