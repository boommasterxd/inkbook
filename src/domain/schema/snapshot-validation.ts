import {
  calculateElementBounds,
  derivePageExtent,
  isAnchorTarget,
  resolveShapeAnchor,
} from "../geometry/public";
import { measureSpatialCapacity } from "../spatial/index";
import {
  FILE_SCHEMA_LIMITS,
  INKBOOK_FORMAT,
  INKBOOK_VERSION,
  PAGE_INNER_WIDTH,
  PAGE_MARGIN,
  type SchemaLimits,
} from "./constants";
import { assertInkElement } from "./element-validation";
import type {
  BackgroundV1,
  EndpointConnectionV1,
  InkElementV1,
  InkSnapshotV1,
  PageV1,
  PointV1,
} from "./types";
import {
  assertExactKeys,
  assertIntegerRange,
  assertJsonTreeSteps,
  assertLiteral,
  assertOneOf,
  assertRecord,
  assertSafeInteger,
  createStatistics,
  fail,
  jsonContainerBudget,
  jsonNodeBudget,
  toValidationError,
  type ValidationContext,
} from "./validation-internals";
import type { SnapshotValidationResult, ValidationByteLengths } from "./validation-types";

const CONNECTION_TOLERANCE = 0.001;
const FLOAT_COMPARISON_EPSILON = 1e-9;

export interface SnapshotValidationOptions extends ValidationByteLengths {
  limits?: Readonly<SchemaLimits>;
}

export function validateInkSnapshotV1(
  value: unknown,
  options: SnapshotValidationOptions = {},
): SnapshotValidationResult {
  return completeValidation(validateInkSnapshotV1Steps(value, options));
}

export function validateRuntimeInkSnapshotV1(
  value: unknown,
  options: SnapshotValidationOptions = {},
): SnapshotValidationResult {
  return completeValidation(validateSnapshotSteps(value, options, true));
}

/** Yields after bounded JSON-tree batches and after every validated document element. */
export function* validateInkSnapshotV1Steps(
  value: unknown,
  options: SnapshotValidationOptions = {},
): Generator<void, SnapshotValidationResult> {
  return yield* validateSnapshotSteps(value, options, false);
}

function* validateSnapshotSteps(
  value: unknown,
  options: SnapshotValidationOptions,
  allowRuntimeStrokeBuffers: boolean,
): Generator<void, SnapshotValidationResult> {
  const statistics = createStatistics();
  try {
    const limits = options.limits ?? FILE_SCHEMA_LIMITS;
    assertByteLengths(options, limits);
    statistics.maximumDepth = yield* assertJsonTreeSteps(
      value,
      jsonNodeBudget(limits),
      2048,
      allowRuntimeStrokeBuffers,
      jsonContainerBudget(limits),
    );
    assertRecord(value, "$");
    assertExactKeys(value, ["format", "version", "revision", "page", "elements"], "$");
    assertLiteral(value.format, INKBOOK_FORMAT, "$.format");
    assertLiteral(value.version, INKBOOK_VERSION, "$.version");
    assertSafeInteger(value.revision, 0, "$.revision");
    assertPage(value.page, "$.page");
    if (!Array.isArray(value.elements)) fail("invalid-type", "$.elements", "Expected an array.");

    const context = { allowRuntimeStrokeBuffers, limits, statistics };
    yield* validateElements(value.elements, context);
    yield* validateDocumentRelations(value.elements as InkElementV1[], value.page, context);
    return { ok: true, value: value as unknown as InkSnapshotV1, statistics };
  } catch (error: unknown) {
    return { ok: false, error: toValidationError(error) };
  }
}

function assertByteLengths(options: ValidationByteLengths, limits: Readonly<SchemaLimits>): void {
  if (options.totalInputBytes !== undefined) {
    assertSafeInteger(options.totalInputBytes, 0, "$.totalInputBytes");
    if (options.totalInputBytes > limits.totalInputBytes) {
      fail("input-byte-limit-exceeded", "$", "Total input bytes exceed the configured limit.");
    }
  }
  if (options.metadataBytes !== undefined) {
    assertSafeInteger(options.metadataBytes, 0, "$.metadataBytes");
    if (options.metadataBytes > limits.metadataBytes) {
      fail("metadata-byte-limit-exceeded", "$", "Snapshot metadata bytes exceed the limit.");
    }
  }
}

function assertPage(value: unknown, path: string): asserts value is PageV1 {
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "innerWidth",
      "margin",
      "background",
      "writingLineHeight",
      "activeBufferLines",
      "lockedBufferLines",
    ],
    path,
  );
  assertLiteral(value.innerWidth, PAGE_INNER_WIDTH, `${path}.innerWidth`);
  assertLiteral(value.margin, PAGE_MARGIN, `${path}.margin`);
  assertBackground(value.background, `${path}.background`);
  assertIntegerRange(value.writingLineHeight, 50, 200, `${path}.writingLineHeight`);
  assertIntegerRange(value.activeBufferLines, 1, 8, `${path}.activeBufferLines`);
  assertIntegerRange(value.lockedBufferLines, 0, 8, `${path}.lockedBufferLines`);
}

function assertBackground(value: unknown, path: string): asserts value is BackgroundV1 {
  assertRecord(value, path);
  if (value.type === "none") {
    assertExactKeys(value, ["type"], path);
    return;
  }
  assertExactKeys(value, ["type", "spacing"], path);
  if (value.type === "lines") {
    assertOneOf(value.spacing, [50, 100, 150, 200] as const, `${path}.spacing`);
    return;
  }
  if (value.type === "dots" || value.type === "squares") {
    assertOneOf(value.spacing, [20, 40, 60, 80] as const, `${path}.spacing`);
    return;
  }
  fail("invalid-literal", `${path}.type`, "Unsupported background type.");
}

function* validateElements(elements: unknown[], context: ValidationContext): Generator<void, void> {
  let contentStarted = false;
  for (let index = 0; index < elements.length; index += 1) {
    const path = `$.elements[${index}]`;
    const element = elements[index];
    assertInkElement(element, path, context);
    const highlight = isHighlight(element);
    if (highlight && contentStarted) {
      fail("invalid-render-band-order", path, "Highlight elements must precede content elements.");
    }
    contentStarted ||= !highlight;
    yield;
  }
}

function* validateDocumentRelations(
  elements: InkElementV1[],
  page: PageV1,
  context: ValidationContext,
): Generator<void, void> {
  const byId = new Map<string, InkElementV1>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as InkElementV1;
    if (byId.has(element.id))
      fail("duplicate-id", `$.elements[${index}].id`, "Duplicate element ID.");
    byId.set(element.id, element);
    if ((index + 1) % 128 === 0) yield;
  }
  yield* validateConnections(elements, byId, context);
  yield* validateBoundsAndExtent(elements, page, context);
}

function* validateConnections(
  elements: InkElementV1[],
  byId: ReadonlyMap<string, InkElementV1>,
  context: ValidationContext,
): Generator<void, void> {
  const perTarget = new Map<string, number>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as InkElementV1;
    if (element.kind === "line" || element.kind === "arrow") {
      validateConnection(
        element.startConnection,
        element.start,
        `${index}].startConnection`,
        byId,
        perTarget,
        context,
      );
      validateConnection(
        element.endConnection,
        element.end,
        `${index}].endConnection`,
        byId,
        perTarget,
        context,
      );
    }
    if ((index + 1) % 128 === 0) yield;
  }
}

function validateConnection(
  connection: EndpointConnectionV1 | null,
  endpoint: PointV1,
  pathSuffix: string,
  byId: ReadonlyMap<string, InkElementV1>,
  perTarget: Map<string, number>,
  context: ValidationContext,
): void {
  if (connection === null) return;
  const path = `$.elements[${pathSuffix}`;
  const target = byId.get(connection.targetId);
  if (target === undefined || !isAnchorTarget(target)) {
    fail(
      "invalid-connection-target",
      `${path}.targetId`,
      "Connection target is missing or not connectable.",
    );
  }
  const count = (perTarget.get(target.id) ?? 0) + 1;
  if (count > context.limits.connectedEndpointsPerTarget) {
    fail("connection-limit-exceeded", path, "Connected endpoints per target exceed the limit.");
  }
  perTarget.set(target.id, count);
  const resolved = resolveShapeAnchor(target, connection.anchor);
  if (resolved === null)
    fail("invalid-anchor", `${path}.anchor`, "Anchor is incompatible with its target.");
  if (
    Math.hypot(endpoint.x - resolved.x, endpoint.y - resolved.y) >
    CONNECTION_TOLERANCE + FLOAT_COMPARISON_EPSILON
  ) {
    fail(
      "connection-position-mismatch",
      path,
      "Connected endpoint does not match its resolved anchor.",
    );
  }
}

function* validateBoundsAndExtent(
  elements: InkElementV1[],
  page: PageV1,
  context: ValidationContext,
): Generator<void, void> {
  let maximumBottom: number | null = null;
  const allBounds = [];
  for (let index = 0; index < elements.length; index += 1) {
    const bounds = calculateElementBounds(elements[index] as InkElementV1);
    allBounds.push(bounds);
    maximumBottom = Math.max(maximumBottom ?? 0, bounds.maxY);
    if ((index + 1) % 128 === 0) yield;
  }
  const spatial = measureSpatialCapacity(allBounds);
  context.statistics.spatialIndexCellMemberships = spatial.cellMemberships;
  context.statistics.spatialIndexOverflowElements = spatial.overflowElements;
  if (
    spatial.cellMemberships > context.limits.spatialIndexCellMemberships ||
    spatial.overflowElements > context.limits.spatialIndexOverflowElements
  ) {
    fail(
      "spatial-index-limit-exceeded",
      "$.elements",
      "Spatial-index aggregate capacity exceeds the configured limit.",
    );
  }
  if (context.limits.maximumDerivedHeight === null) return;
  const extent = derivePageExtent(page, maximumBottom);
  if (
    (maximumBottom ?? 0) > context.limits.maximumDerivedHeight ||
    extent.activeHeight > context.limits.maximumDerivedHeight ||
    extent.lockedHeight > context.limits.maximumDerivedHeight
  ) {
    fail("invalid-range", "$.elements", "Maximum derived page height exceeds the limit.");
  }
}

function completeValidation(
  steps: Generator<void, SnapshotValidationResult>,
): SnapshotValidationResult {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function isHighlight(element: InkElementV1): boolean {
  return (
    element.kind === "straight-highlighter" ||
    (element.kind === "stroke" && element.tool === "highlighter")
  );
}
