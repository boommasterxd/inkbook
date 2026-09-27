import { copyValidatedSampleExtrema } from "../../../domain/schema/stroke-sample-extrema";
import { assertStrokeSamplesV1 } from "../../../domain/elements/public";
import { MAX_STROKE_POINTS } from "../../../domain/schema/public";
import type {
  InkElementV1,
  InkSnapshotV1,
  StrokeElementV1,
  StrokeSamplesV1,
} from "../../../domain/schema/public";
import { runtimeSliceWorkProfile } from "./slice-scheduler";
import type { RuntimeSliceContext } from "./types";

export type RuntimeStrokeSamples = StrokeSamplesV1 & Readonly<Float64Array>;
type RuntimeStrokeElement = Omit<StrokeElementV1, "points"> & {
  readonly points: RuntimeStrokeSamples;
};
export type RuntimeInkElement = Exclude<InkElementV1, StrokeElementV1> | RuntimeStrokeElement;
export type RuntimeInkSnapshot = Omit<InkSnapshotV1, "elements"> & {
  readonly elements: RuntimeInkElement[];
};

export function adoptTransferredStrokeSamples(points: Float64Array): RuntimeStrokeSamples {
  assertStrokeSamplesV1(points);
  return points as RuntimeStrokeSamples;
}

export function copySnapshotToRuntime(
  snapshot: InkSnapshotV1,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
): RuntimeInkSnapshot {
  return {
    ...snapshot,
    elements: copyElementsToRuntime(snapshot.elements, pointCopies),
  };
}

export async function copySnapshotToRuntimeSliced(
  snapshot: InkSnapshotV1,
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
): Promise<RuntimeInkSnapshot> {
  return {
    ...snapshot,
    elements: await copyElementsToRuntimeSliced(snapshot.elements, context, pointCopies),
  };
}

export async function copyElementsToRuntimeSliced(
  elements: readonly InkElementV1[],
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
): Promise<RuntimeInkElement[]> {
  const profile = context.workProfile ?? runtimeSliceWorkProfile(context.sliceMilliseconds?.());
  const sampleSlice = Math.max(3, Math.floor(profile.inputByteLimit / 24) * 3);
  const copied: RuntimeInkElement[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    if (element.kind !== "stroke") copied.push(element);
    else if (element.points instanceof Float64Array) copied.push(element as RuntimeStrokeElement);
    else {
      copied.push(await copyStrokeToRuntimeSliced(element, sampleSlice, context, pointCopies));
    }
    if ((index + 1) % profile.nodeLimit === 0) await context.checkpoint();
  }
  context.signal.throwIfAborted();
  return copied;
}

async function copyStrokeToRuntimeSliced(
  element: StrokeElementV1,
  sampleSlice: number,
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
): Promise<RuntimeStrokeElement> {
  const source = element.points;
  const reusable = Object.isFrozen(source);
  const retained = reusable ? pointCopies?.get(source) : undefined;
  if (retained !== undefined) return { ...element, points: retained };
  if (source.length < 3 || source.length % 3 !== 0 || source.length / 3 > MAX_STROKE_POINTS) {
    assertStrokeSamplesV1(source);
  }
  const points = new Float64Array(source.length);
  for (let start = 0; start < source.length; start += sampleSlice) {
    const end = Math.min(source.length, start + sampleSlice);
    for (let index = start; index < end; index += 1) points[index] = source[index]!;
    assertStrokeSamplesV1(points.subarray(start, end));
    await context.checkpoint();
  }
  copyValidatedSampleExtrema(source, points);
  if (reusable) pointCopies?.set(source, points as RuntimeStrokeSamples);
  return { ...element, points: points as RuntimeStrokeSamples };
}

export function copyElementsToRuntime(
  elements: readonly InkElementV1[],
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
): RuntimeInkElement[] {
  return elements.map((element) => {
    if (element.kind !== "stroke") return element;
    if (element.points instanceof Float64Array) return element as RuntimeStrokeElement;
    const reusable = Object.isFrozen(element.points);
    let points = reusable ? pointCopies?.get(element.points) : undefined;
    if (points === undefined) {
      points = adoptTransferredStrokeSamples(new Float64Array(element.points));
      copyValidatedSampleExtrema(element.points, points);
      if (reusable) pointCopies?.set(element.points, points);
    }
    return { ...element, points };
  });
}

export function copyElementsFromRuntime(elements: readonly InkElementV1[]): InkElementV1[] {
  return elements.map((element) =>
    element.kind === "stroke" ? { ...element, points: Array.from(element.points) } : element,
  );
}

export function hasRuntimeStrokeSamples(snapshot: InkSnapshotV1): boolean {
  return snapshot.elements.some(
    (element) => element.kind === "stroke" && element.points instanceof Float64Array,
  );
}
