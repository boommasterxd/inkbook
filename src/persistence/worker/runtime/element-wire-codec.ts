import { copyStrokeSamplesToRuntime } from "../../../domain/elements/public";
import type { InkElementV1, StrokeElementV1, StrokeSamplesV1 } from "../../../domain/schema/public";
import { adoptTransferredStrokeSamples } from "./runtime-elements";

type NonStrokeElement = Exclude<InkElementV1, StrokeElementV1>;
type PackedStroke = Omit<StrokeElementV1, "points"> & { readonly pointsBufferIndex: number };
type PackedElement = NonStrokeElement | PackedStroke;

export interface PackedElements {
  readonly pointBuffers: readonly Float64Array[];
  readonly records: readonly PackedElement[];
}

export interface RuntimeWireSliceOptions {
  readonly checkpoint: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly reusePoints?: (element: InkElementV1) => boolean;
}

export function packElements(elements: readonly InkElementV1[]): PackedElements {
  const pointBuffers: Float64Array[] = [];
  const records: PackedElement[] = [];
  for (const element of elements) appendPackedElement(element, records, pointBuffers);
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
    await options.checkpoint();
    options.signal.throwIfAborted();
    bytesSinceCheckpoint = 0;
  }
  return { pointBuffers, records };
}

export function unpackElements(
  packed: PackedElements,
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
    return { ...element, points: adoptTransferredStrokeSamples(points) };
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
): void {
  const reused = reusePoints?.(element) === true;
  if (element.kind !== "stroke") {
    records.push(element);
    return;
  }
  const pointsBufferIndex = reused ? -1 : pointBuffers.length;
  if (!reused) pointBuffers.push(copyStrokeSamplesToRuntime(element.points));
  const { points: _points, ...record } = element;
  records.push({ ...record, pointsBufferIndex });
}

function estimatedElementBytes(element: InkElementV1): number {
  return element.kind === "stroke" ? element.points.length * Float64Array.BYTES_PER_ELEMENT : 4096;
}

function hasPackedArrays(packed: PackedElements): boolean {
  return Array.isArray(packed.records) && Array.isArray(packed.pointBuffers);
}
