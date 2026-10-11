import {
  copyValidatedSampleExtrema,
  validatedSampleExtrema,
} from "../../../domain/schema/stroke-sample-extrema";
import { assertStrokeSamplesV1 } from "../../../domain/elements/public";
import {
  captureRuntimeElementHeader,
  copyStrokeSamplesToRuntimeSteps,
} from "../../../domain/elements/runtime-element-copy";
import { isStoredStroke } from "../../../domain/elements/stroke-replacement-proof";
import {
  assertSampleCopyInput,
  isImmutableStrokeSampleSource,
} from "../../../domain/elements/runtime-sample-copy";
import type {
  InkElementV1,
  InkSnapshotV1,
  SnapshotValidationDerivations,
  StrokeElementV1,
  StrokeSamplesV1,
} from "../../../domain/schema/public";
import { runtimeSliceWorkProfile } from "./slice-scheduler";
import { assertStagedSampleCapacity } from "../../serialization/serialization-input-preparation";
import type { RuntimeSliceContext } from "./types";

export type RuntimeStrokeSamples = StrokeSamplesV1 & Readonly<Float64Array>;
type RuntimeStrokeElement = Omit<StrokeElementV1, "points"> & {
  readonly points: RuntimeStrokeSamples;
};
export type RuntimeInkElement = Exclude<InkElementV1, StrokeElementV1> | RuntimeStrokeElement;
export type RuntimeInkSnapshot = Omit<InkSnapshotV1, "elements"> & {
  readonly elements: RuntimeInkElement[];
};

export function* validateRuntimeSamplesSteps(
  points: Float64Array,
  samplesPerStep = 256,
): Generator<void, RuntimeStrokeSamples> {
  const length = assertSampleCopyInput(points, samplesPerStep);
  for (let start = 0; start < length; start += samplesPerStep * 3) {
    assertStrokeSamplesV1(points.subarray(start, Math.min(length, start + samplesPerStep * 3)));
    yield;
  }
  return points as RuntimeStrokeSamples;
}

export function adoptTransferredStrokeSamples(points: Float64Array): RuntimeStrokeSamples {
  return drainSteps(validateRuntimeSamplesSteps(points));
}

export function copySnapshotToRuntime(
  snapshot: InkSnapshotV1,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
  ownsSamples = false,
): RuntimeInkSnapshot {
  return {
    ...snapshot,
    page: { ...snapshot.page, background: { ...snapshot.page.background } },
    elements: drainSteps(
      copyElementsSteps(snapshot.elements, pointCopies, derivations, ownsSamples),
    ),
  };
}

export async function copyParsed(
  snapshot: InkSnapshotV1,
  derivations: SnapshotValidationDerivations,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  context?: RuntimeSliceContext,
): Promise<RuntimeInkSnapshot> {
  return context === undefined
    ? copySnapshotToRuntime(snapshot, pointCopies, derivations, true)
    : copySnapshotToRuntimeSliced(snapshot, context, pointCopies, derivations, true);
}

export async function copySnapshotToRuntimeSliced(
  snapshot: InkSnapshotV1,
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
  ownsSamples = false,
): Promise<RuntimeInkSnapshot> {
  const header = {
    ...snapshot,
    page: { ...snapshot.page, background: { ...snapshot.page.background } },
  };
  return {
    ...header,
    elements: await runSteps(
      copyElementsSteps(
        snapshot.elements,
        pointCopies,
        derivations,
        ownsSamples,
        sampleStep(context),
      ),
      context,
    ),
  };
}

export function copyElementsToRuntime(
  elements: readonly InkElementV1[],
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  ownsSamples = false,
): RuntimeInkElement[] {
  return drainSteps(copyElementsSteps(elements, pointCopies, undefined, ownsSamples));
}

export function copyElementsToRuntimeSliced(
  elements: readonly InkElementV1[],
  context: RuntimeSliceContext,
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  ownsSamples = false,
): Promise<RuntimeInkElement[]> {
  return runSteps(
    copyElementsSteps(elements, pointCopies, undefined, ownsSamples, sampleStep(context)),
    context,
  );
}

function* copyElementsSteps(
  elements: readonly InkElementV1[],
  pointCopies?: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>,
  derivations?: SnapshotValidationDerivations,
  ownsSamples = false,
  samplesPerStep = 256,
): Generator<void, RuntimeInkElement[]> {
  const copied: RuntimeInkElement[] = [];
  const sampleCounts = { strokes: 0, strokePoints: 0 };
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const header = captureRuntimeElementHeader(element);
    if (element.kind !== "stroke") copied.push(header as unknown as RuntimeInkElement);
    else {
      assertStagedSampleCapacity(sampleCounts, element.points.length, `$.elements[${index}]`);
      if (derivations !== undefined) assertValidatedStrokeSource(element, derivations, index);
      const points = yield* copyStrokeSteps(
        element,
        pointCopies,
        derivations !== undefined,
        ownsSamples,
        samplesPerStep,
      );
      copied.push({ ...header, points } as unknown as RuntimeStrokeElement);
    }
    yield;
  }
  return copied;
}

function* copyStrokeSteps(
  element: StrokeElementV1,
  pointCopies: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples> | undefined,
  validated: boolean,
  ownsSamples: boolean,
  samplesPerStep: number,
): Generator<void, RuntimeStrokeSamples> {
  const source = element.points;
  const immutable = isImmutableStrokeSampleSource(source) || isStoredStroke(element);
  const retained = immutable ? pointCopies?.get(source) : undefined;
  if (retained !== undefined) return retained;
  if (source instanceof Float64Array && (ownsSamples || isStoredStroke(element))) return source;
  const candidate = yield* copyStrokeSamplesToRuntimeSteps(source, samplesPerStep);
  const copiedImmutable = immutable || isImmutableStrokeSampleSource(source);
  const points =
    validated && (copiedImmutable || ownsSamples)
      ? (candidate as RuntimeStrokeSamples)
      : yield* validateRuntimeSamplesSteps(candidate, samplesPerStep);
  if (copiedImmutable || ownsSamples) copyValidatedSampleExtrema(source, points);
  if (copiedImmutable) pointCopies?.set(source, points);
  return points;
}

function sampleStep(context: RuntimeSliceContext): number {
  const profile = context.workProfile ?? runtimeSliceWorkProfile(context.sliceMilliseconds?.());
  return Math.max(1, Math.floor(profile.inputByteLimit / 24));
}

function drainSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function runSteps<T>(steps: Generator<void, T>, context: RuntimeSliceContext): Promise<T> {
  context.signal.throwIfAborted();
  let step = steps.next();
  while (!step.done) {
    const pending = context.checkpoint();
    if (pending !== undefined) await pending;
    context.signal.throwIfAborted();
    step = steps.next();
  }
  return step.value;
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
