import { copyStrokeSamplesToRuntime } from "../../../domain/elements/public";
import {
  MAX_STROKE_POINTS,
  validatedElementDerivationBounds,
  type ElementValidationDerivation,
  type InkElementV1,
  type StrokeElementV1,
  type StrokeSamplesV1,
} from "../../../domain/schema/public";
import { adoptTransferredStrokeSamples } from "./runtime-elements";

type NonStrokeElement = Exclude<InkElementV1, StrokeElementV1>;
type PackedStroke = Omit<StrokeElementV1, "points"> & { readonly pointsBufferIndex: number };
type PackedElement = NonStrokeElement | PackedStroke;

export interface PackedElements {
  readonly pointBuffers: readonly Float64Array[];
  readonly records: readonly PackedElement[];
}

export interface RuntimeWireSliceOptions {
  readonly checkpoint: () => Promise<void> | undefined;
  readonly signal: AbortSignal;
  readonly reusePoints?: (element: InkElementV1) => boolean;
}

export function packElements(elements: readonly InkElementV1[]): PackedElements {
  return packElementsWithCopy(elements, copyStrokeSamplesToRuntime);
}

/** The hosted unlock producer has already completed semantic sample validation. */
export function packValidatedElements(
  elements: readonly InkElementV1[],
  derivations: readonly ElementValidationDerivation[],
): PackedElements {
  assertMatchingDerivations(elements, derivations);
  return packElementsWithCopy(elements, (points) => new Float64Array(points));
}

function packElementsWithCopy(
  elements: readonly InkElementV1[],
  copyPoints: (points: StrokeSamplesV1) => Readonly<Float64Array>,
): PackedElements {
  const pointBuffers: Float64Array[] = [];
  const records: PackedElement[] = [];
  for (const element of elements)
    appendPackedElement(element, records, pointBuffers, undefined, copyPoints);
  return { pointBuffers, records };
}

export async function packElementsChunked(
  elements: readonly InkElementV1[],
  options: RuntimeWireSliceOptions,
): Promise<PackedElements> {
  const pointBuffers: Float64Array[] = [];
  const records: PackedElement[] = [];
  let bytesSinceCheckpoint = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    appendPackedElement(element, records, pointBuffers, options.reusePoints);
    bytesSinceCheckpoint += estimatedElementBytes(element);
    if ((index + 1) % 64 !== 0 && bytesSinceCheckpoint < 256 * 1024) continue;
    const pending = options.checkpoint();
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
    bytesSinceCheckpoint = 0;
  }
  return { pointBuffers, records };
}

export function unpackElements(
  packed: PackedElements,
  resolvePoints?: (id: string) => StrokeSamplesV1,
): InkElementV1[] {
  return unpackElementBuffers(packed, adoptTransferredStrokeSamples, resolvePoints);
}

/** Only the identity-checked owned unlock channel may bypass repeated sample scans. */
export function unpackValidatedElements(
  packed: PackedElements,
  derivations: readonly ElementValidationDerivation[],
): InkElementV1[] {
  const elements = unpackElementBuffers(packed, (points) => {
    if (points.length < 3 || points.length % 3 !== 0 || points.length / 3 > MAX_STROKE_POINTS)
      throw new RangeError("Validated stroke point-buffer length is invalid.");
    return points as unknown as StrokeSamplesV1;
  });
  assertMatchingDerivations(elements, derivations);
  return elements;
}

function unpackElementBuffers(
  packed: PackedElements,
  adopt: (points: Float64Array) => StrokeSamplesV1,
  resolvePoints?: (id: string) => StrokeSamplesV1,
): InkElementV1[] {
  if (!hasPackedArrays(packed)) {
    throw new TypeError("Packed elements must contain record and point-buffer arrays.");
  }
  const used = new Set<number>();
  const elements = packed.records.map((record) => {
    if (record.kind !== "stroke") return record;
    const index = record.pointsBufferIndex;
    if (index === -1 && resolvePoints !== undefined) {
      const { pointsBufferIndex: _index, ...element } = record;
      return { ...element, points: resolvePoints(record.id) };
    }
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= packed.pointBuffers.length ||
      used.has(index)
    ) {
      throw new RangeError("Stroke point-buffer index is invalid or reused.");
    }
    const points = packed.pointBuffers[index];
    if (!(points instanceof Float64Array)) {
      throw new TypeError("Stroke points must use a Float64Array wire buffer.");
    }
    used.add(index);
    const { pointsBufferIndex: _index, ...element } = record;
    return { ...element, points: adopt(points) };
  });
  if (used.size !== packed.pointBuffers.length) {
    throw new RangeError("Every stroke point buffer must be referenced exactly once.");
  }
  return elements;
}

function appendPackedElement(
  element: InkElementV1,
  records: PackedElement[],
  pointBuffers: Float64Array[],
  reusePoints?: (element: InkElementV1) => boolean,
  copyPoints: (points: StrokeSamplesV1) => Readonly<Float64Array> = copyStrokeSamplesToRuntime,
): void {
  const reused = reusePoints?.(element) === true;
  if (element.kind !== "stroke") {
    records.push(element);
    return;
  }
  const pointsBufferIndex = reused ? -1 : pointBuffers.length;
  if (!reused) pointBuffers.push(copyPoints(element.points));
  const { points: _points, ...record } = element;
  records.push({ ...record, pointsBufferIndex });
}

function assertMatchingDerivations(
  elements: readonly InkElementV1[],
  derivations: readonly ElementValidationDerivation[],
): void {
  if (elements.length !== derivations.length)
    throw new TypeError("Validated element derivations are incomplete.");
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const derivation = derivations[index]!;
    validatedElementDerivationBounds(element, derivation);
    if (element.kind === "stroke" && derivation.strokeSampleExtrema === undefined)
      throw new TypeError("Validated stroke sample extrema are missing.");
  }
}

function estimatedElementBytes(element: InkElementV1): number {
  return element.kind === "stroke" ? element.points.length * Float64Array.BYTES_PER_ELEMENT : 4096;
}

function hasPackedArrays(packed: PackedElements): boolean {
  return Array.isArray(packed.records) && Array.isArray(packed.pointBuffers);
}
