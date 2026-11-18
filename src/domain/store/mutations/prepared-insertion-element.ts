import {
  captureRuntimeElementHeader,
  captureRuntimeTextElementSteps,
  copyStrokeSamplesToImmutableJsonSteps,
  preparedInsertionHeader,
} from "../../elements/runtime-element-copy";
import { calculateElementBoundsSteps } from "../../geometry/bounds";
import type { Bounds } from "../../geometry/primitives";
import { validateInkElementV1Steps } from "../../schema/element-validation";
import type { InkElementV1, StrokeElementV1 } from "../../schema/public";
import { takeImmutableElementOwnershipSteps } from "../records/immutability";

const boundsByElement = new WeakMap<object, Readonly<Bounds>>();

export function preparedInsertionBounds(element: object): Readonly<Bounds> | undefined {
  return boundsByElement.get(element);
}

/** Synchronous canvas creation accepts JSON strokes. Worker decoding owns typed buffer input. */
export function prepareStrokeInsertion(stroke: StrokeElementV1): StrokeElementV1 {
  if (boundsByElement.has(stroke)) return stroke;
  const steps = prepareInsertionElementSteps(stroke, "json-stroke");
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value as StrokeElementV1;
}

/** Validation and bounds belong to the same privately staged, immutable JSON element. */
export function* prepareInsertionElementSteps(
  element: InkElementV1,
  input: "runtime" | "json-stroke" = "runtime",
): Generator<boolean | void, InkElementV1> {
  if (boundsByElement.has(element)) return element;
  const header =
    preparedInsertionHeader(element) ??
    (element.kind === "text"
      ? yield* captureRuntimeTextElementSteps(element)
      : captureRuntimeElementHeader(element));
  const points = Object.getOwnPropertyDescriptor(element, "points");
  if (input === "json-stroke" && (header.kind !== "stroke" || !Array.isArray(points?.value))) {
    throw new RangeError("Stroke creation requires JSON samples.");
  }
  if (
    header.kind === "stroke" &&
    (points === undefined || !("value" in points) || !points.enumerable)
  )
    throw new TypeError("Stroke samples must be an own data property.");
  const staged = (header.kind === "stroke"
    ? { ...header, points: yield* copyStrokeSamplesToImmutableJsonSteps(points!.value as number[]) }
    : header) as unknown as InkElementV1;
  const validation = yield* validateInkElementV1Steps(staged, {}, 2048, 256);
  if (!validation.ok) throw new RangeError(`Invalid insertion element: ${validation.error.code}`);
  const bounds = Object.freeze(yield* calculateElementBoundsSteps(staged));
  const immutable = (yield* takeImmutableElementOwnershipSteps(staged)) as InkElementV1;
  boundsByElement.set(immutable, bounds);
  return immutable;
}
