import { validatedSampleExtrema } from "../../schema/stroke-sample-extrema";
import { validateRuntimeInkElementV1Steps } from "../../schema/element-validation";
import type { InkElementV1 } from "../../schema/public";
import { copyRuntimeElementSteps } from "../../elements/runtime-element-copy";

import type { DeepReadonly, ImmutableInkElement } from "../types";

export function* immutableElementSteps(
  element: InkElementV1,
): Generator<void, ImmutableInkElement> {
  const validated =
    element.kind === "stroke" && validatedSampleExtrema(element.points) !== undefined;
  const clone = yield* copyRuntimeElementSteps(element);
  if (validated && clone.kind === "stroke") {
    const steps = validateRuntimeInkElementV1Steps(clone, {}, 2048, 256);
    let step = steps.next();
    while (!step.done) {
      yield;
      step = steps.next();
    }
    const validation = step.value;
    if (!validation.ok) throw new RangeError(`Invalid immutable element: ${validation.error.code}`);
  }
  return yield* takeImmutableElementOwnershipSteps(clone);
}

/** Preserve an unchanged owned sample buffer while copying all replaceable fields. */
export function* immutableReplacementSteps(
  element: InkElementV1,
  source: ImmutableInkElement,
): Generator<void, ImmutableInkElement> {
  if (element.kind === "text" && source.kind === "text") {
    return yield* takeImmutableElementOwnershipSteps(
      yield* copyRuntimeElementSteps(element, undefined, source),
    );
  }
  if (element.kind !== "stroke" || source.kind !== "stroke" || element.points !== source.points) {
    return yield* immutableElementSteps(element);
  }
  const fields = yield* immutableElementSteps({ ...element, points: [0, 0, 0.5] });
  return Object.freeze({ ...fields, points: source.points });
}

/** The caller must relinquish every mutable alias after transferring ownership. */
export function takeImmutableElementOwnership(element: InkElementV1): ImmutableInkElement {
  if (Object.isFrozen(element)) return element;
  if (element.kind === "stroke" && Array.isArray(element.points)) Object.freeze(element.points);
  return freezeValue(element);
}

export function* takeImmutableElementOwnershipSteps(
  element: InkElementV1,
): Generator<void, ImmutableInkElement> {
  if (element.kind !== "text") return takeImmutableElementOwnership(element);
  yield* freezeTextValueSteps(element, { nodes: 0 });
  return element;
}

function* freezeTextValueSteps(value: unknown, progress: { nodes: number }): Generator<void, void> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) yield* freezeTextValueSteps(child, progress);
  } else {
    for (const child of Object.values(value)) yield* freezeTextValueSteps(child, progress);
  }
  Object.freeze(value);
  if (++progress.nodes % 256 === 0) yield;
}

export function mutableElement(element: ImmutableInkElement): InkElementV1 {
  return drainSteps(mutableElementSteps(element));
}

export function* mutableElementSteps(element: ImmutableInkElement): Generator<void, InkElementV1> {
  return (yield* copyRuntimeElementSteps(element)) as InkElementV1;
}

function drainSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function freezeValue<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  // Typed-array elements cannot be frozen in ECMAScript. Their immutability is
  // provided by exclusive ownership and readonly domain types instead.
  if (value instanceof Float64Array) return value as DeepReadonly<T>;
  if (Object.isFrozen(value)) return value as DeepReadonly<T>;
  if (Array.isArray(value)) {
    const arrayValue: unknown[] = value;
    for (const child of arrayValue) {
      if (child !== null && typeof child === "object") freezeValue(child);
    }
    Object.freeze(value);
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeValue(child);
  }
  Object.freeze(value);
  return value as DeepReadonly<T>;
}
