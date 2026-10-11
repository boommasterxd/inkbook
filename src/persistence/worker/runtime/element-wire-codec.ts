import {
  captureRuntimeElementHeader,
  copyStrokeSamplesToRuntimeSteps,
} from "../../../domain/elements/runtime-element-copy";
import {
  MAX_STROKE_POINTS,
  validatedElementDerivationBounds,
  type ElementValidationDerivation,
  type InkElementV1,
  type StrokeElementV1,
  type StrokeSamplesV1,
} from "../../../domain/schema/public";
import { validateRuntimeSamplesSteps } from "./runtime-elements";
import {
  completeSerializationSteps,
  consumeSerializationSteps,
} from "../../serialization/serialization-model-preparation";

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
  readonly reusePoints?: (element: InkElementV1) => boolean | "retired";
}

export function packElements(elements: readonly InkElementV1[]): PackedElements {
  return completeSerializationSteps(packElementsSteps(elements));
}

export function packElementsChunked(
  elements: readonly InkElementV1[],
  options: RuntimeWireSliceOptions,
): Promise<PackedElements> {
  return consumeSerializationSteps(packElementsSteps(elements, options.reusePoints), options);
}

/** The hosted unlock producer has already completed semantic sample validation. */
export function packValidatedElementsChunked(
  elements: readonly InkElementV1[],
  derivations: readonly ElementValidationDerivation[],
  options: RuntimeWireSliceOptions,
): Promise<PackedElements> {
  return consumeSerializationSteps(packElementsSteps(elements, undefined, derivations), options);
}

function* packElementsSteps(
  elements: readonly InkElementV1[],
  reusePoints?: (element: InkElementV1) => boolean | "retired",
  derivations?: readonly ElementValidationDerivation[],
): Generator<void, PackedElements> {
  if (derivations !== undefined && elements.length !== derivations.length)
    throw new TypeError("Validated element derivations are incomplete.");
  const pointBuffers: Float64Array[] = [];
  const records: PackedElement[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const source = elements[index]!;
    const header = captureRuntimeElementHeader(source);
    if (derivations !== undefined) assertMatchingDerivation(source, derivations[index]!);
    if (source.kind !== "stroke") records.push(header as unknown as NonStrokeElement);
    else {
      const reuse = reusePoints?.(source);
      const pointsBufferIndex =
        reuse === "retired" ? -2 : reuse === true ? -1 : pointBuffers.length;
      if (reuse !== true && reuse !== "retired") {
        const points = yield* copyStrokeSamplesToRuntimeSteps(source.points);
        if (derivations === undefined) yield* validateRuntimeSamplesSteps(points);
        pointBuffers.push(points);
      }
      records.push({ ...header, pointsBufferIndex } as unknown as PackedStroke);
    }
    if ((index + 1) % 64 === 0) yield;
  }
  return { pointBuffers, records };
}

export function unpackElements(
  packed: PackedElements,
  resolvePoints?: (id: string, retired?: boolean) => StrokeSamplesV1,
): InkElementV1[] {
  return completeSerializationSteps(unpackElementsSteps(packed, resolvePoints));
}

/** Only the identity-checked owned unlock channel may bypass repeated sample scans. */
export function unpackValidatedElements(
  packed: PackedElements,
  derivations: readonly ElementValidationDerivation[],
): InkElementV1[] {
  const elements = completeSerializationSteps(unpackElementBuffersSteps(packed, undefined, true));
  if (elements.length !== derivations.length)
    throw new TypeError("Validated element derivations are incomplete.");
  for (let index = 0; index < elements.length; index += 1)
    assertMatchingDerivation(elements[index]!, derivations[index]!);
  return elements;
}

export function unpackElementsSteps(
  packed: PackedElements,
  resolvePoints?: (id: string, retired?: boolean) => StrokeSamplesV1,
): Generator<void, InkElementV1[]> {
  return unpackElementBuffersSteps(packed, resolvePoints, false);
}

function* unpackElementBuffersSteps(
  packed: PackedElements,
  resolvePoints: ((id: string, retired?: boolean) => StrokeSamplesV1) | undefined,
  validated = false,
): Generator<void, InkElementV1[]> {
  if (!hasPackedArrays(packed))
    throw new TypeError("Packed elements must contain record and point-buffer arrays.");
  const used = new Set<number>();
  const elements: InkElementV1[] = [];
  for (let recordIndex = 0; recordIndex < packed.records.length; recordIndex += 1) {
    const record = packed.records[recordIndex]!;
    const { pointsBufferIndex: _bufferIndex, ...header } = captureRuntimeElementHeader(record);
    if (record.kind !== "stroke") elements.push(header as unknown as NonStrokeElement);
    else
      elements.push({
        ...header,
        points: yield* unpackStrokePointsSteps(record, packed, used, resolvePoints, validated),
      } as unknown as StrokeElementV1);
    if ((recordIndex + 1) % 64 === 0) yield;
  }
  if (used.size !== packed.pointBuffers.length)
    throw new RangeError("Every stroke point buffer must be referenced exactly once.");
  return elements;
}

function* unpackStrokePointsSteps(
  record: PackedStroke,
  packed: PackedElements,
  used: Set<number>,
  resolvePoints: ((id: string, retired?: boolean) => StrokeSamplesV1) | undefined,
  validated: boolean,
): Generator<void, StrokeSamplesV1> {
  const index = record.pointsBufferIndex;
  if ((index === -1 || index === -2) && resolvePoints !== undefined)
    return resolvePoints(record.id, index === -2);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= packed.pointBuffers.length ||
    used.has(index)
  )
    throw new RangeError("Stroke point-buffer index is invalid or reused.");
  const points = packed.pointBuffers[index];
  if (!(points instanceof Float64Array))
    throw new TypeError("Stroke points must use a Float64Array wire buffer.");
  used.add(index);
  if (!validated) return yield* validateRuntimeSamplesSteps(points);
  if (points.length < 3 || points.length % 3 !== 0 || points.length / 3 > MAX_STROKE_POINTS)
    throw new RangeError("Validated stroke point-buffer length is invalid.");
  return points as unknown as StrokeSamplesV1;
}

function hasPackedArrays(packed: PackedElements): boolean {
  return Array.isArray(packed.records) && Array.isArray(packed.pointBuffers);
}

function assertMatchingDerivation(
  element: InkElementV1,
  derivation: ElementValidationDerivation,
): void {
  validatedElementDerivationBounds(element, derivation);
  if (element.kind === "stroke" && derivation.strokeSampleExtrema === undefined)
    throw new TypeError("Validated stroke sample extrema are missing.");
}
