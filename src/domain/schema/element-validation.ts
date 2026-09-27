import { canonicalizeGeometryNumber } from "./canonical";
import { assertStrokeSamplesSteps } from "./stroke-sample-validation";
import { FILE_SCHEMA_LIMITS, type SchemaLimits } from "./constants";
import { assertOutlineStyle, assertShapeStyle, assertStrokeStyle } from "./style-validation";
import type { EndpointConnectionV1, InkElementV1, PointV1, ShapeAnchorV1 } from "./types";
import {
  assertExactKeys,
  assertGeometryNumber,
  assertIntegerRange,
  assertJsonTree,
  assertJsonTreeSteps,
  assertLiteral,
  assertOneOf,
  assertRecord,
  assertRotation,
  assertSafeInteger,
  assertUuid,
  createStatistics,
  fail,
  jsonContainerBudget,
  jsonNodeBudget,
  toValidationError,
  type UnknownRecord,
  type ValidationContext,
} from "./validation-internals";
import type { ValidationResult } from "./validation-types";

const BOX_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-right",
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "middle-left",
] as const;
const ARROW_NODES = ["none", "arrow", "triangle", "diamond", "circle"] as const;
const SHAPE_KINDS = [
  "rectangle",
  "ellipse",
  "triangle",
  "octagon",
  "parallelogram",
  "diamond",
] as const;
const BASE_KEYS = ["kind", "id", "createdAt", "rotation", "pivot"] as const;
const LINEAR_KEYS = ["start", "end", "bend", "startNode", "endNode", "style"] as const;

export interface ElementValidationOptions {
  limits?: Readonly<SchemaLimits>;
}

export function validateInkElementV1(
  value: unknown,
  options: ElementValidationOptions = {},
): ValidationResult<InkElementV1> {
  return validateElement(value, options, false);
}

export function validateRuntimeInkElementV1(
  value: unknown,
  options: ElementValidationOptions = {},
): ValidationResult<InkElementV1> {
  return validateElement(value, options, true);
}

export function* validateInkElementV1Steps(
  value: unknown,
  options: ElementValidationOptions,
  nodesPerStep: number,
  samplesPerStep: number,
): Generator<boolean | void, ValidationResult<InkElementV1>> {
  const statistics = createStatistics();
  try {
    const limits = options.limits ?? FILE_SCHEMA_LIMITS;
    const tree = assertJsonTreeSteps(
      value,
      jsonNodeBudget(limits),
      nodesPerStep,
      false,
      jsonContainerBudget(limits),
    );
    let step = tree.next();
    while (!step.done) {
      yield true;
      step = tree.next();
    }
    statistics.maximumDepth = step.value;
    const context = { allowRuntimeStrokeBuffers: false, limits, statistics };
    if (typeof value === "object" && value !== null && "kind" in value && value.kind === "stroke") {
      yield* assertStrokeElementSteps(value, "$", context, samplesPerStep);
    } else {
      assertInkElement(value, "$", context);
    }
    return { ok: true, value: value as InkElementV1, statistics };
  } catch (error: unknown) {
    return { ok: false, error: toValidationError(error) };
  }
}

function validateElement(
  value: unknown,
  options: ElementValidationOptions,
  allowRuntimeStrokeBuffers: boolean,
): ValidationResult<InkElementV1> {
  const statistics = createStatistics();
  try {
    const limits = options.limits ?? FILE_SCHEMA_LIMITS;
    statistics.maximumDepth = allowRuntimeStrokeBuffers
      ? consumeRuntimeJsonTree(value, jsonNodeBudget(limits), jsonContainerBudget(limits))
      : assertJsonTree(value, jsonNodeBudget(limits), jsonContainerBudget(limits));
    const context = { allowRuntimeStrokeBuffers, limits, statistics };
    assertInkElement(value, "$", context);
    return { ok: true, value, statistics };
  } catch (error: unknown) {
    return { ok: false, error: toValidationError(error) };
  }
}

function consumeRuntimeJsonTree(
  value: unknown,
  maximumNodes: number,
  maximumContainerEntries: number,
): number {
  const steps = assertJsonTreeSteps(value, maximumNodes, 2048, true, maximumContainerEntries);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function assertInkElement(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is InkElementV1 {
  assertRecord(value, path);
  context.statistics.elements += 1;
  if (context.statistics.elements > context.limits.elements) {
    fail("element-limit-exceeded", path, "Element count exceeds the configured limit.");
  }
  switch (value.kind) {
    case "stroke":
      assertStroke(value, path, context);
      return;
    case "line":
      assertLine(value, path, context);
      return;
    case "arrow":
      assertArrow(value, path, context);
      return;
    case "straight-highlighter":
      assertStraightHighlighter(value, path, context);
      return;
    case "rectangle":
    case "ellipse":
    case "triangle":
    case "octagon":
    case "parallelogram":
    case "diamond":
      assertBoxShape(value, path, context);
      return;
    case "coordinate-system":
      assertCoordinateSystem(value, path, context);
      return;
    case "table":
      assertTable(value, path, context);
      return;
    default:
      fail("invalid-literal", `${path}.kind`, "Unsupported element kind.");
  }
}

function assertBase(value: UnknownRecord, path: string, context: ValidationContext): void {
  assertUuid(value.id, `${path}.id`);
  assertSafeInteger(value.createdAt, 0, `${path}.createdAt`);
  assertRotation(value.rotation, `${path}.rotation`);
  assertPoint(value.pivot, `${path}.pivot`, context);
}

function assertPoint(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is PointV1 {
  assertRecord(value, path);
  assertExactKeys(value, ["x", "y"], path);
  assertGeometryNumber(value.x, `${path}.x`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.y, `${path}.y`, context.limits.absoluteCoordinate);
}

function assertStroke(value: UnknownRecord, path: string, context: ValidationContext): void {
  const steps = assertStrokeSteps(value, path, context, Number.POSITIVE_INFINITY);
  while (!steps.next().done) {
    // Synchronous callers retain the same complete validation boundary.
  }
}

function* assertStrokeElementSteps(
  value: unknown,
  path: string,
  context: ValidationContext,
  samplesPerStep: number,
): Generator<boolean, void> {
  assertRecord(value, path);
  context.statistics.elements += 1;
  if (context.statistics.elements > context.limits.elements) {
    fail("element-limit-exceeded", path, "Element count exceeds the configured limit.");
  }
  yield* assertStrokeSteps(value, path, context, samplesPerStep);
}

function* assertStrokeSteps(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
  samplesPerStep: number,
): Generator<boolean, void> {
  assertExactKeys(
    value,
    [...BASE_KEYS, "tool", "points", "style", ...(value.offset === undefined ? [] : ["offset"])],
    path,
  );
  if (value.offset !== undefined) assertPoint(value.offset, `${path}.offset`, context);
  assertLiteral(value.kind, "stroke", `${path}.kind`);
  assertBase(value, path, context);
  assertOneOf(value.tool, ["pen", "highlighter"] as const, `${path}.tool`);
  yield* assertStrokeSamplesSteps(
    value.points,
    `${path}.points`,
    context,
    value.offset,
    samplesPerStep,
  );
  assertStrokeStyle(value.style, `${path}.style`);
  if (value.tool === "highlighter" && value.style.pressureEnabled) {
    fail(
      "invalid-literal",
      `${path}.style.pressureEnabled`,
      "Highlighter pressure must be disabled.",
    );
  }
  context.statistics.strokes += 1;
  if (context.statistics.strokes > context.limits.strokes) {
    fail("stroke-limit-exceeded", path, "Freehand stroke count exceeds the configured limit.");
  }
}

function assertLine(value: UnknownRecord, path: string, context: ValidationContext): void {
  assertExactKeys(value, [...BASE_KEYS, ...LINEAR_KEYS, "startConnection", "endConnection"], path);
  assertLiteral(value.kind, "line", `${path}.kind`);
  assertBase(value, path, context);
  assertLinearGeometry(value, path, context);
  assertLiteral(value.startNode, "none", `${path}.startNode`);
  assertLiteral(value.endNode, "none", `${path}.endNode`);
  assertOutlineStyle(value.style, `${path}.style`);
  assertConnection(value.startConnection, `${path}.startConnection`, context);
  assertConnection(value.endConnection, `${path}.endConnection`, context);
}

function assertArrow(value: UnknownRecord, path: string, context: ValidationContext): void {
  assertExactKeys(value, [...BASE_KEYS, ...LINEAR_KEYS, "startConnection", "endConnection"], path);
  assertLiteral(value.kind, "arrow", `${path}.kind`);
  assertBase(value, path, context);
  assertLinearGeometry(value, path, context);
  assertOneOf(value.startNode, ARROW_NODES, `${path}.startNode`);
  assertOneOf(value.endNode, ARROW_NODES, `${path}.endNode`);
  assertOutlineStyle(value.style, `${path}.style`);
  assertConnection(value.startConnection, `${path}.startConnection`, context);
  assertConnection(value.endConnection, `${path}.endConnection`, context);
}

function assertStraightHighlighter(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): void {
  assertExactKeys(value, [...BASE_KEYS, ...LINEAR_KEYS], path);
  assertLiteral(value.kind, "straight-highlighter", `${path}.kind`);
  assertBase(value, path, context);
  assertLinearGeometry(value, path, context);
  assertLiteral(value.startNode, "none", `${path}.startNode`);
  assertLiteral(value.endNode, "none", `${path}.endNode`);
  assertStrokeStyle(value.style, `${path}.style`);
  if (value.style.pressureEnabled) {
    fail(
      "invalid-literal",
      `${path}.style.pressureEnabled`,
      "Highlighter pressure must be disabled.",
    );
  }
}

function assertLinearGeometry(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): void {
  assertPoint(value.start, `${path}.start`, context);
  assertPoint(value.end, `${path}.end`, context);
  if (value.bend !== null) assertPoint(value.bend, `${path}.bend`, context);
}

function assertConnection(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is EndpointConnectionV1 | null {
  if (value === null) return;
  assertRecord(value, path);
  assertExactKeys(value, ["targetId", "anchor"], path);
  assertUuid(value.targetId, `${path}.targetId`);
  assertShapeAnchor(value.anchor, `${path}.anchor`);
  context.statistics.connectedEndpoints += 1;
  if (context.statistics.connectedEndpoints > context.limits.connectedEndpoints) {
    fail("connection-limit-exceeded", path, "Connected endpoint count exceeds the limit.");
  }
}

function assertShapeAnchor(value: unknown, path: string): asserts value is ShapeAnchorV1 {
  assertRecord(value, path);
  switch (value.kind) {
    case "box":
      assertExactKeys(value, ["kind", "position"], path);
      assertOneOf(value.position, BOX_ANCHORS, `${path}.position`);
      return;
    case "ellipse-cardinal":
      assertExactKeys(value, ["kind", "angle"], path);
      assertOneOf(value.angle, [0, 90, 180, 270] as const, `${path}.angle`);
      return;
    case "polygon-vertex":
    case "polygon-edge-midpoint":
    case "coordinate-axis-end":
      assertExactKeys(value, ["kind", "index"], path);
      assertIntegerRange(value.index, 0, Number.MAX_SAFE_INTEGER, `${path}.index`);
      return;
    case "coordinate-origin":
      assertExactKeys(value, ["kind"], path);
      return;
    case "linear-endpoint":
      assertExactKeys(value, ["kind", "endpoint"], path);
      assertOneOf(value.endpoint, ["start", "end"] as const, `${path}.endpoint`);
      return;
    default:
      fail("invalid-anchor", `${path}.kind`, "Unsupported semantic anchor.");
  }
}

function assertBoxShape(value: UnknownRecord, path: string, context: ValidationContext): void {
  assertExactKeys(value, [...BASE_KEYS, "x", "y", "width", "height", "style"], path);
  assertOneOf(value.kind, SHAPE_KINDS, `${path}.kind`);
  assertBase(value, path, context);
  assertGeometryNumber(value.x, `${path}.x`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.y, `${path}.y`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.width, `${path}.width`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.height, `${path}.height`, context.limits.absoluteCoordinate);
  if (value.width < 0 || value.height < 0) {
    fail("invalid-range", path, "Closed shape width and height must be nonnegative.");
  }
  assertShapeStyle(value.style, `${path}.style`);
  assertCenteredPivot(value, value.width, `${path}.pivot`);
}

function assertCoordinateSystem(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): void {
  assertExactKeys(value, [...BASE_KEYS, "origin", "dimension", "axes", "style"], path);
  assertLiteral(value.kind, "coordinate-system", `${path}.kind`);
  assertBase(value, path, context);
  assertPoint(value.origin, `${path}.origin`, context);
  assertOneOf(value.dimension, ["2d", "3d"] as const, `${path}.dimension`);
  const axisCount = value.dimension === "2d" ? 2 : 3;
  if (!Array.isArray(value.axes) || value.axes.length !== axisCount) {
    fail("invalid-range", `${path}.axes`, `Expected exactly ${axisCount} axis endpoints.`);
  }
  for (let index = 0; index < value.axes.length; index += 1) {
    assertPoint(value.axes[index], `${path}.axes[${index}]`, context);
  }
  assertOutlineStyle(value.style, `${path}.style`);
  const pivot = value.pivot as PointV1;
  if (pivot.x !== value.origin.x || pivot.y !== value.origin.y) {
    fail("invalid-range", `${path}.pivot`, "Coordinate-system pivot must equal its origin.");
  }
}

function assertTable(value: UnknownRecord, path: string, context: ValidationContext): void {
  assertExactKeys(
    value,
    [
      ...BASE_KEYS,
      "x",
      "y",
      "columnWidth",
      ...(value.columnOffsets === undefined ? [] : ["columnOffsets"]),
      "height",
      "columns",
      "headerHeight",
      "style",
    ],
    path,
  );
  assertLiteral(value.kind, "table", `${path}.kind`);
  assertBase(value, path, context);
  assertGeometryNumber(value.x, `${path}.x`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.y, `${path}.y`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.columnWidth, `${path}.columnWidth`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.height, `${path}.height`, context.limits.absoluteCoordinate);
  assertIntegerRange(value.columns, 1, 12, `${path}.columns`);
  assertGeometryNumber(
    value.headerHeight,
    `${path}.headerHeight`,
    context.limits.absoluteCoordinate,
  );
  if (value.columnWidth < 0 || value.height < 0) {
    fail("invalid-range", path, "Table dimensions must be nonnegative.");
  }
  if (value.headerHeight < 0 || value.headerHeight > value.height) {
    fail(
      "invalid-range",
      `${path}.headerHeight`,
      "Header height must stay within the outer table bounds.",
    );
  }
  if (value.columns * value.columnWidth > context.limits.absoluteCoordinate) {
    fail("invalid-range", `${path}.columnWidth`, "Derived table width exceeds the numeric limit.");
  }
  assertTableColumnOffsets(value, path, context);
  assertOutlineStyle(value.style, `${path}.style`);
  assertCenteredPivot(value, value.columns * value.columnWidth, `${path}.pivot`);
}

function assertTableColumnOffsets(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): void {
  const columns = value.columns;
  const columnWidth = value.columnWidth;
  assertIntegerRange(columns, 1, 12, `${path}.columns`);
  assertGeometryNumber(columnWidth, `${path}.columnWidth`, context.limits.absoluteCoordinate);
  const offsets = value.columnOffsets;
  if (offsets === undefined) return;
  if (!isUnknownArray(offsets) || offsets.length !== columns - 1) {
    fail(
      "invalid-range",
      `${path}.columnOffsets`,
      "Table column offsets must contain one entry per inner separator.",
    );
  }
  const width = columns * columnWidth;
  let previous = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index];
    assertGeometryNumber(
      offset,
      `${path}.columnOffsets[${index}]`,
      context.limits.absoluteCoordinate,
    );
    if (offset < previous || offset > width) {
      fail(
        "invalid-range",
        `${path}.columnOffsets[${index}]`,
        "Table column offsets must be non-decreasing and stay within the outer bounds.",
      );
    }
    previous = offset;
  }
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertCenteredPivot(value: UnknownRecord, width: number, path: string): void {
  const pivot = value.pivot as PointV1;
  const x = canonicalizeGeometryNumber((value.x as number) + width / 2);
  const y = canonicalizeGeometryNumber((value.y as number) + (value.height as number) / 2);
  if (pivot.x !== x || pivot.y !== y) {
    fail("invalid-range", path, "Pivot must equal the canonical unrotated bounds center.");
  }
}
