import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import {
  retainValidatedSampleExtrema,
  validatedSampleExtrema,
} from "../schema/stroke-sample-extrema";
import { assertSpatialBounds } from "../spatial/bounds";
import { calculateElementBoundsSteps } from "../geometry/bounds";
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
  immutableElementSteps,
  immutableReplacementSteps,
  takeImmutableElementOwnership,
} from "./immutability";
import type { ElementRecord } from "./types";
import { preparedInsertionBounds } from "./prepared-insertion-element";

export function createInitialRecord(element: InkElementV1): ElementRecord {
  return drainRecordSteps(createInitialRecordSteps(element));
}

export function* createInitialRecordSteps(
  element: InkElementV1,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  const immutable = yield* immutableElementSteps(element);
  return yield* initialRecordSteps(immutable, undefined, pointsPerStep);
}

export function* createOwnedInitialRecordSteps(
  element: InkElementV1,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  return yield* initialRecordSteps(
    takeImmutableElementOwnership(element),
    preparedInsertionBounds(element),
    pointsPerStep,
  );
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
  return drainRecordSteps(
    initialRecordSteps(takeImmutableElementOwnership(element), Object.freeze({ ...bounds })),
  );
}

function* initialRecordSteps(
  immutable: ElementRecord["element"],
  validatedBounds?: Readonly<SpatialBounds>,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  if (immutable.kind === "stroke") markStoredStroke(immutable);
  const bounds =
    validatedBounds ??
    Object.freeze(
      yield* calculateElementBoundsSteps(immutable as unknown as InkElementV1, pointsPerStep),
    );
  return Object.freeze({ bounds, element: immutable, geometryVersion: 0, paintVersion: 0 });
}

export function createReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  return drainRecordSteps(
    createReplacementRecordSteps(element, current, geometryVersion, paintVersion),
  );
}

export function* createReplacementRecordSteps(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  return yield* replacementRecordSteps(
    yield* immutableReplacementSteps(element, current.element),
    current,
    geometryVersion,
    paintVersion,
    undefined,
    pointsPerStep,
  );
}

export function* createOwnedReplacementRecordSteps(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  return yield* replacementRecordSteps(
    takeImmutableElementOwnership(element),
    current,
    geometryVersion,
    paintVersion,
    undefined,
    pointsPerStep,
  );
}

export function createOwnedReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  return drainRecordSteps(
    createOwnedReplacementRecordSteps(element, current, geometryVersion, paintVersion),
  );
}

export function createOwnedTranslatedReplacementRecord(
  element: InkElementV1,
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  translation: Readonly<{ x: number; y: number }>,
): ElementRecord {
  return drainRecordSteps(
    replacementRecordSteps(
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
    ),
  );
}

function* replacementRecordSteps(
  immutable: ElementRecord["element"],
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
  replacementBounds?: Readonly<SpatialBounds>,
  pointsPerStep = 256,
): Generator<void, ElementRecord> {
  if (immutable.kind === "stroke") markStoredStroke(immutable);
  const bounds =
    replacementBounds ??
    (geometryVersion === current.geometryVersion
      ? current.bounds
      : Object.freeze(
          yield* calculateElementBoundsSteps(immutable as unknown as InkElementV1, pointsPerStep),
        ));
  return Object.freeze({ bounds, element: immutable, geometryVersion, paintVersion });
}

function drainRecordSteps(steps: Generator<void, ElementRecord>): ElementRecord {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
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
