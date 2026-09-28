import {
  copyValidatedSampleExtrema,
  validatedSampleExtrema,
} from "../../../domain/schema/stroke-sample-extrema";
import { assertStrokeSamplesV1 } from "../../../domain/elements/public";
import { MAX_STROKE_POINTS } from "../../../domain/schema/public";
import type {
  InkElementV1,
  InkSnapshotV1,
  SnapshotValidationDerivations,
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
  derivations?: SnapshotValidationDerivations,
): RuntimeInkSnapshot {
  return {
    ...snapshot,
    elements: copyElementsToRuntimeInternal(snapshot.elements, pointCopies, derivations),
  };
}

export async function copyParsed(
  snapshot: InkSnapshotV1,
  derivations: SnapshotValidationDerivations,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  context?: RuntimeSliceContext,
): Promise<RuntimeInkSnapshot> {
  return context === undefined
    ? copySnapshotToRuntime(snapshot, pointCopies, derivations)
    : copySnapshotToRuntimeSliced(snapshot, context, pointCopies, derivations);
}

export async function copySnapshotToRuntimeSliced(
  snapshot: InkSnapshotV1,
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
): Promise<RuntimeInkSnapshot> {
  return {
    ...snapshot,
    elements: await copyElementsToRuntimeSlicedInternal(
      snapshot.elements,
      context,
      pointCopies,
      derivations,
    ),
  };
}

async function copyElementsToRuntimeSlicedInternal(
  elements: readonly InkElementV1[],
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
): Promise<RuntimeInkElement[]> {
  const profile = context.workProfile ?? runtimeSliceWorkProfile(context.sliceMilliseconds?.());
  const sampleSlice = Math.max(3, Math.floor(profile.inputByteLimit / 24) * 3);
  const copied: RuntimeInkElement[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    if (element.kind === "stroke" && derivations !== undefined) {
      assertValidatedStrokeSource(element, derivations, index);
    }
    if (element.kind !== "stroke") copied.push(element);
    else if (element.points instanceof Float64Array) copied.push(element as RuntimeStrokeElement);
    else {
      copied.push(
        await copyStrokeToRuntimeSliced(
          element,
          sampleSlice,
          context,
          pointCopies,
          derivations !== undefined,
        ),
      );
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
  validated = false,
): Promise<RuntimeStrokeElement> {
  const source = element.points;
  const reusable = Object.isFrozen(source);
  const retained = reusable ? pointCopies?.get(source) : undefined;
  if (retained !== undefined) return { ...element, points: retained };
  if (
    !validated &&
    (source.length < 3 || source.length % 3 !== 0 || source.length / 3 > MAX_STROKE_POINTS)
  ) {
    assertStrokeSamplesV1(source);
  }
  const points = new Float64Array(source.length);
  for (let start = 0; start < source.length; start += sampleSlice) {
    const end = Math.min(source.length, start + sampleSlice);
    for (let index = start; index < end; index += 1) points[index] = source[index]!;
    if (!validated) assertStrokeSamplesV1(points.subarray(start, end));
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
  return copyElementsToRuntimeInternal(elements, pointCopies);
}

function copyElementsToRuntimeInternal(
  elements: readonly InkElementV1[],
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
): RuntimeInkElement[] {
  return elements.map((element, index) => {
    if (element.kind !== "stroke") return element;
    if (derivations !== undefined) assertValidatedStrokeSource(element, derivations, index);
    if (element.points instanceof Float64Array) return element as RuntimeStrokeElement;
    const reusable = Object.isFrozen(element.points);
    let points = reusable ? pointCopies?.get(element.points) : undefined;
    if (points === undefined) {
      const copied = new Float64Array(element.points);
      points =
        derivations === undefined
          ? adoptTransferredStrokeSamples(copied)
          : (copied as RuntimeStrokeSamples);
      copyValidatedSampleExtrema(element.points, points);
      if (reusable) pointCopies?.set(element.points, points);
    }
    return { ...element, points };
  });
}

function assertValidatedStrokeSource(
  element: StrokeElementV1,
  derivations: SnapshotValidationDerivations,
  index: number,
): void {
  const derivation = derivations.elements[index];
  if (
    derivation?.elementId !== element.id ||
    derivation.strokeSampleExtrema === undefined ||
    derivation.strokeSampleExtrema !== validatedSampleExtrema(element.points)
  ) {
    throw new RangeError("Stroke samples lack matching validation derivations.");
  }
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
