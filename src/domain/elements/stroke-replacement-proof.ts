import { sampleOffsetWithinRange } from "../schema/stroke-sample-extrema";
import { canonicalizeGeometryNumber } from "../schema/canonical";
import { MAX_ABSOLUTE_COORDINATE } from "../schema/constants";
import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import { translatedStroke } from "../geometry/stroke-position";
import type { PointV1, StrokeElementV1 } from "../schema/public";

export interface CanonicalStrokeReplacementProof {
  readonly source: object;
  readonly translation: Readonly<{ x: number; y: number }>;
}

const canonicalReplacementProofs = new WeakMap<object, CanonicalStrokeReplacementProof>();
const validatedStyleReplacements = new WeakMap<object, WeakRef<object>>();
const storedStrokeProofs = new WeakSet<object>();

export function markStoredStroke<T extends { readonly points: ArrayLike<number> }>(stroke: T): T {
  canonicalReplacementProofs.delete(stroke);
  validatedStyleReplacements.delete(stroke);
  storedStrokeProofs.add(stroke);
  return stroke;
}

export function markValidatedInternalStyleReplacement(source: object, replacement: object): void {
  validatedStyleReplacements.set(replacement, new WeakRef(source));
}

export function isValidatedInternalStyleReplacement(source: object, replacement: object): boolean {
  return validatedStyleReplacements.get(replacement)?.deref() === source;
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
    retainTranslation(source, replacement, translation);
  }
  return replacement;
}

/** Only the producer can reuse all unchanged fields of the exact immutable Store record. */
export function translateStrokeForReplacement(
  source: StrokeElementV1,
  delta: PointV1,
): StrokeElementV1 {
  const replacement = translatedStroke(source, delta);
  for (const point of [replacement.pivot, replacement.offset!]) {
    if (Math.abs(point.x) > MAX_ABSOLUTE_COORDINATE || Math.abs(point.y) > MAX_ABSOLUTE_COORDINATE)
      throw new RangeError("Transformed stroke coordinates exceed the supported range.");
    Object.freeze(point);
  }
  Object.freeze(replacement);
  if (!isStoredStroke(source)) return replacement;
  if (!Object.isFrozen(source)) return markCanonicalStrokeReplacement(source, replacement, delta);
  if (!storedStrokeOffsetWithinRange(replacement))
    throw new RangeError("Invalid canonical stroke translation.");
  retainTranslation(source, replacement, delta);
  return replacement;
}

function retainTranslation(
  source: object,
  replacement: StrokeElementV1,
  translation: PointV1,
): void {
  const immutableTranslation = Object.isFrozen(translation)
    ? translation
    : Object.freeze({ ...translation });
  canonicalReplacementProofs.set(
    replacement,
    Object.freeze({ source, translation: immutableTranslation }),
  );
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
    source.locked !== replacement.locked ||
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
    current.tool !== replacement.tool ||
    current.locked !== replacement.locked
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
