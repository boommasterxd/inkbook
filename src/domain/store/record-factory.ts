import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import {
  retainValidatedSampleExtrema,
  validatedSampleExtrema,
} from "../schema/stroke-sample-extrema";
import { assertSpatialBounds } from "../spatial/bounds";
import { calculateElementBounds } from "../geometry/bounds";
import { markStoredStroke } from "../elements/stroke-replacement-proof";
import {
  validatedElementDerivationBounds,
  type ElementValidationDerivation,
  type InkElementV1,
} from "../schema/public";
import {
  MAX_ELEMENT_CELLS,
  MAX_OVERFLOW_ELEMENTS,
  SPATIAL_CELL_SIZE,
  type SpatialBounds,
} from "../spatial/index";

import {
  immutableElement,
  immutableReplacement,
  takeImmutableElementOwnership,
} from "./immutability";
import type { ElementRecord } from "./types";

export function createInitialRecord(element: InkElementV1): ElementRecord {
  const immutable = immutableElement(element);
  return initialRecord(immutable);
}

export function createOwnedInitialRecord(element: InkElementV1): ElementRecord {
  return initialRecord(takeImmutableElementOwnership(element));
}

export function createOwnedValidatedInitialRecord(
  element: InkElementV1,
  derivation: ElementValidationDerivation,
): ElementRecord {
  const bounds = validatedElementDerivationBounds(element, derivation);
  if (element.kind === "stroke") {
    if (derivation.strokeSampleExtrema !== undefined) {
      assertSpatialBounds(derivation.strokeSampleExtrema);
      retainValidatedSampleExtrema(element.points, { ...derivation.strokeSampleExtrema });
    } else if (validatedSampleExtrema(element.points) === undefined) {
      const validation = validateRuntimeInkElementV1(element);
      if (!validation.ok) throw new TypeError("Invalid stroke samples in runtime derivation.");
    }
  }
  return initialRecord(takeImmutableElementOwnership(element), Object.freeze({ ...bounds }));
}

function initialRecord(
  immutable: ElementRecord["element"],
  validatedBounds?: Readonly<SpatialBounds>,
): ElementRecord {
  if (immutable.kind === "stroke") markStoredStroke(immutable);
  const bounds =
    validatedBounds ?? Object.freeze(calculateElementBounds(immutable as unknown as InkElementV1));
  return Object.freeze({ bounds, element: immutable, geometryVersion: 0, paintVersion: 0 });
}

export function createReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  return replacementRecord(
    immutableReplacement(element, current.element),
    current,
    geometryVersion,
    paintVersion,
  );
}

export function createOwnedReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  return replacementRecord(
    takeImmutableElementOwnership(element),
    current,
    geometryVersion,
    paintVersion,
  );
}

export function createOwnedTranslatedReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  translation: Readonly<{ x: number; y: number }>,
): ElementRecord {
  return replacementRecord(
    takeImmutableElementOwnership(element),
    current,
    geometryVersion,
    paintVersion,
    Object.freeze({
      maxX: current.bounds.maxX + translation.x,
      maxY: current.bounds.maxY + translation.y,
      minX: current.bounds.minX + translation.x,
      minY: current.bounds.minY + translation.y,
    }),
  );
}

function replacementRecord(
  immutable: ElementRecord["element"],
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  replacementBounds?: Readonly<SpatialBounds>,
): ElementRecord {
  if (immutable.kind === "stroke") markStoredStroke(immutable);
  const bounds =
    replacementBounds ??
    (geometryVersion === current.geometryVersion
      ? current.bounds
      : Object.freeze(calculateElementBounds(immutable as unknown as InkElementV1)));
  return Object.freeze({ bounds, element: immutable, geometryVersion, paintVersion });
}

export function assignRecordVersions(
  record: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  return Object.freeze({ ...record, geometryVersion, paintVersion });
}

export function assertOverflowCapacity(
  currentCount: number,
  previous: readonly ElementRecord[],
  next: readonly ElementRecord[],
  removed: readonly ElementRecord[] = [],
): void {
  let count = currentCount;
  const replaced = removed.length === 0 || previous.length === 0 ? undefined : new Set(previous);
  for (const record of previous) count -= Number(isOverflowBounds(record.bounds));
  for (const record of removed) {
    if (!(replaced?.has(record) ?? false)) count -= Number(isOverflowBounds(record.bounds));
  }
  for (const record of next) count += Number(isOverflowBounds(record.bounds));
  if (count > MAX_OVERFLOW_ELEMENTS) {
    throw new RangeError("The spatial-index overflow element limit was exceeded.");
  }
}

export function isOverflowBounds(bounds: SpatialBounds): boolean {
  const width =
    Math.floor(bounds.maxX / SPATIAL_CELL_SIZE) - Math.floor(bounds.minX / SPATIAL_CELL_SIZE) + 1;
  const height =
    Math.floor(bounds.maxY / SPATIAL_CELL_SIZE) - Math.floor(bounds.minY / SPATIAL_CELL_SIZE) + 1;
  return width > MAX_ELEMENT_CELLS || height > Math.floor(MAX_ELEMENT_CELLS / width);
}

export function nextRecordVersion(value: number, name: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} reached Number.MAX_SAFE_INTEGER.`);
  }
  return value + 1;
}
