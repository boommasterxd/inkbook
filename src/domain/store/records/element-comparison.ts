import type { InkElementV1 } from "../../schema/public";

import type { DeltaDomain, ImmutableInkElement } from "../types";

export function elementsEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  return drain(elementsEqualSteps(left, right));
}

interface ComparisonProgress {
  readonly samplesPerStep: number;
  samples: number;
}

export function* elementsEqualSteps(
  left: ImmutableInkElement,
  right: InkElementV1,
  samplesPerStep = 256,
): Generator<void, boolean> {
  return yield* valuesEqualSteps(left, right, comparisonProgress(samplesPerStep));
}

export function classifyReplacement(
  previous: ImmutableInkElement,
  next: InkElementV1,
): DeltaDomain[] {
  return drain(classifyReplacementSteps(previous, next));
}

export function* classifyReplacementSteps(
  previous: ImmutableInkElement,
  next: InkElementV1,
  samplesPerStep = 256,
): Generator<void, DeltaDomain[]> {
  const progress = comparisonProgress(samplesPerStep);
  const domains: DeltaDomain[] = [];
  if (!(yield* geometryEqualSteps(previous, next, progress))) domains.push("geometry");
  if (!paintEqual(previous, next)) domains.push("paint");
  if (!connectionsEqual(previous, next)) domains.push("connection");
  return domains;
}

export function hasConnections(element: ImmutableInkElement | InkElementV1): boolean {
  return (
    (element.kind === "line" || element.kind === "arrow") &&
    (element.startConnection !== null || element.endConnection !== null)
  );
}

function* geometryEqualSteps(
  left: ImmutableInkElement,
  right: InkElementV1,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  if (left.kind !== right.kind) return false;
  if (!valuesEqual(left.pivot, right.pivot) || left.rotation !== right.rotation) return false;
  if (!geometryStyleEqual(left, right)) return false;
  switch (left.kind) {
    case "stroke":
      return yield* strokeGeometryEqualSteps(left, right, progress);
    case "line":
    case "arrow":
      return connectedLinearGeometryEqual(left, right);
    case "straight-highlighter":
      return right.kind === "straight-highlighter" && linearGeometryEqual(left, right);
    case "coordinate-system":
      return yield* coordinateGeometryEqualSteps(left, right, progress);
    case "table":
      return yield* tableGeometryEqualSteps(left, right, progress);
    default:
      return boxGeometryEqual(left, right);
  }
}

function* strokeGeometryEqualSteps(
  left: Extract<ImmutableInkElement, { kind: "stroke" }>,
  right: InkElementV1,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  return (
    right.kind === "stroke" &&
    left.tool === right.tool &&
    (left.offset?.x ?? 0) === (right.offset?.x ?? 0) &&
    (left.offset?.y ?? 0) === (right.offset?.y ?? 0) &&
    (yield* valuesEqualSteps(left.points, right.points, progress))
  );
}

function connectedLinearGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "line" | "arrow" }>,
  right: InkElementV1,
): boolean {
  return (
    right.kind === left.kind &&
    linearGeometryEqual(left, right) &&
    left.startNode === right.startNode &&
    left.endNode === right.endNode
  );
}

function* coordinateGeometryEqualSteps(
  left: Extract<ImmutableInkElement, { kind: "coordinate-system" }>,
  right: InkElementV1,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  return (
    right.kind === "coordinate-system" &&
    left.dimension === right.dimension &&
    (yield* valuesEqualSteps(left.origin, right.origin, progress)) &&
    (yield* valuesEqualSteps(left.axes, right.axes, progress))
  );
}

function* tableGeometryEqualSteps(
  left: Extract<ImmutableInkElement, { kind: "table" }>,
  right: InkElementV1,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  return (
    right.kind === "table" &&
    left.x === right.x &&
    left.y === right.y &&
    left.columnWidth === right.columnWidth &&
    (yield* valuesEqualSteps(left.columnOffsets, right.columnOffsets, progress)) &&
    left.height === right.height &&
    left.columns === right.columns &&
    left.headerHeight === right.headerHeight
  );
}

function boxGeometryEqual(
  left: Exclude<
    ImmutableInkElement,
    { kind: "stroke" | "line" | "arrow" | "straight-highlighter" | "coordinate-system" | "table" }
  >,
  right: InkElementV1,
): boolean {
  return (
    right.kind === left.kind &&
    "x" in right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function linearGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "line" | "arrow" | "straight-highlighter" }>,
  right: Extract<InkElementV1, { kind: "line" | "arrow" | "straight-highlighter" }>,
): boolean {
  return (
    valuesEqual(left.start, right.start) &&
    valuesEqual(left.end, right.end) &&
    valuesEqual(left.bend, right.bend)
  );
}

function geometryStyleEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind === "stroke" || left.kind === "straight-highlighter") {
    if (right.kind !== "stroke" && right.kind !== "straight-highlighter") return false;
    return (
      left.style.width === right.style.width &&
      left.style.pressureEnabled === right.style.pressureEnabled &&
      left.style.smoothing === right.style.smoothing
    );
  }
  if (right.kind === "stroke" || right.kind === "straight-highlighter") return false;
  return left.style.outlineWidth === right.style.outlineWidth;
}

function paintEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind === "stroke" || left.kind === "straight-highlighter") {
    if (right.kind !== "stroke" && right.kind !== "straight-highlighter") return false;
    return (
      valuesEqual(left.style.color, right.style.color) && left.style.opacity === right.style.opacity
    );
  }
  if (right.kind === "stroke" || right.kind === "straight-highlighter") return false;
  if (
    !valuesEqual(left.style.outlineColor, right.style.outlineColor) ||
    left.style.outlineOpacity !== right.style.outlineOpacity ||
    left.style.outlineStyle !== right.style.outlineStyle
  )
    return false;
  if (!("fillColor" in left.style) || !("fillColor" in right.style)) {
    return !("fillColor" in left.style) && !("fillColor" in right.style);
  }
  return (
    valuesEqual(left.style.fillColor, right.style.fillColor) &&
    left.style.fillOpacity === right.style.fillOpacity
  );
}

function connectionsEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind !== "line" && left.kind !== "arrow") {
    return right.kind !== "line" && right.kind !== "arrow";
  }
  if (right.kind !== left.kind) return false;
  return (
    valuesEqual(left.startConnection, right.startConnection) &&
    valuesEqual(left.endConnection, right.endConnection)
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return drain(valuesEqualSteps(left, right, comparisonProgress(256)));
}

function* valuesEqualSteps(
  left: unknown,
  right: unknown,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  if (Object.is(left, right)) return true;
  if (left instanceof Float64Array && right instanceof Float64Array) {
    return yield* typedSamplesEqualSteps(left, right, progress);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return yield* arrayValuesEqualSteps(left, right, progress);
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return yield* recordValuesEqualSteps(left, right, progress);
}

function* recordValuesEqualSteps(
  left: object,
  right: object,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let rightCount = 0;
  for (const key in rightRecord) {
    if (Object.prototype.hasOwnProperty.call(rightRecord, key)) rightCount += 1;
    if (++progress.samples % progress.samplesPerStep === 0) yield;
  }
  let leftCount = 0;
  for (const key in leftRecord) {
    if (Object.prototype.hasOwnProperty.call(leftRecord, key)) {
      leftCount += 1;
      if (!(yield* valuesEqualSteps(leftRecord[key], rightRecord[key], progress))) return false;
    }
    if (++progress.samples % progress.samplesPerStep === 0) yield;
  }
  return leftCount === rightCount;
}

function* typedSamplesEqualSteps(
  left: Float64Array,
  right: Float64Array,
  progress: ComparisonProgress,
): Generator<void, boolean> {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
    if (++progress.samples % progress.samplesPerStep === 0) yield;
  }
  return true;
}

function* arrayValuesEqualSteps(
  left: readonly unknown[],
  right: readonly unknown[],
  progress: ComparisonProgress,
): Generator<void, boolean> {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (index in left && !(yield* valuesEqualSteps(left[index], right[index], progress)))
      return false;
    if (++progress.samples % progress.samplesPerStep === 0) yield;
  }
  return true;
}

function comparisonProgress(samplesPerStep: number): ComparisonProgress {
  if (!Number.isSafeInteger(samplesPerStep) || samplesPerStep < 1) {
    throw new RangeError("Comparison sample count must be a positive safe integer.");
  }
  return { samplesPerStep, samples: 0 };
}

function drain<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}
