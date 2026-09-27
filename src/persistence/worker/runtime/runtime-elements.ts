import { copyValidatedSampleExtrema } from "../../../domain/schema/stroke-sample-extrema";
import { assertStrokeSamplesV1 } from "../../../domain/elements/public";
import type {
  InkElementV1,
  InkSnapshotV1,
  StrokeElementV1,
  StrokeSamplesV1,
} from "../../../domain/schema/public";

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
