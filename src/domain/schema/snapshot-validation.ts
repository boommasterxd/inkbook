import { validatedSampleExtrema } from "./stroke-sample-extrema";
import {
  calculateElementBounds,
  derivePageExtent,
  isAnchorTarget,
  resolveShapeAnchor,
} from "../geometry/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../spatial/index";
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
  assertJsonTree,
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
import type {
  ElementValidationDerivation,
  SnapshotValidationDerivations,
  SnapshotValidationResult,
  ValidationByteLengths,
  ValidationResult,
} from "./validation-types";

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

export function validateInkPageV1(value: unknown): ValidationResult<PageV1> {
  const statistics = createStatistics();
  try {
    statistics.maximumDepth = assertJsonTree(
      value,
      jsonNodeBudget(FILE_SCHEMA_LIMITS),
      jsonContainerBudget(FILE_SCHEMA_LIMITS),
    );
    assertPage(value, "$.page");
    return { ok: true, statistics, value };
  } catch (error: unknown) {
    return { error: toValidationError(error), ok: false };
  }
}

export function validateInkConnectionRelationsV1(
  elements: readonly InkElementV1[],
): ValidationResult<void> {
  const statistics = createStatistics();
  try {
    const byId = new Map(elements.map((element) => [element.id, element]));
    const steps = validateConnections(elements, byId, {
      limits: FILE_SCHEMA_LIMITS,
      statistics,
    });
    let step = steps.next();
    while (!step.done) step = steps.next();
    return { ok: true, statistics, value: undefined };
  } catch (error: unknown) {
    return { error: toValidationError(error), ok: false };
  }
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
    const derivations = yield* validateDocumentRelations(
      value.elements as InkElementV1[],
      value.page,
      context,
    );
    return { derivations, ok: true, value: value as unknown as InkSnapshotV1, statistics };
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
    ["innerWidth", "margin", "background", "activeBufferLines", "lockedBufferLines"],
    path,
  );
  assertLiteral(value.innerWidth, PAGE_INNER_WIDTH, `${path}.innerWidth`);
  assertLiteral(value.margin, PAGE_MARGIN, `${path}.margin`);
  assertBackground(value.background, `${path}.background`);
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
  if (value.type === "lines" || value.type === "dots" || value.type === "squares") {
    assertOneOf(value.spacing, [25, 33.333333333333336, 50, 100] as const, `${path}.spacing`);
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
): Generator<void, SnapshotValidationDerivations> {
  const byId = new Map<string, InkElementV1>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as InkElementV1;
    if (byId.has(element.id))
      fail("duplicate-id", `$.elements[${index}].id`, "Duplicate element ID.");
    byId.set(element.id, element);
    if ((index + 1) % 128 === 0) yield;
  }
  yield* validateConnections(elements, byId, context);
  return yield* validateBoundsAndExtent(elements, page, context);
}

function* validateConnections(
  elements: readonly InkElementV1[],
  byId: ReadonlyMap<string, InkElementV1>,
  context: ValidationContext,
): Generator<void, void> {
  const perTarget = new Map<string, number>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as InkElementV1;
    if (element.kind === "line" || element.kind === "arrow") {
      validateConnection({
        byId,
        connection: element.startConnection,
        perTarget,
        endpoint: element.start,
        pathSuffix: `${index}].startConnection`,
        sourceId: element.id,
        context,
      });
      validateConnection({
        byId,
        connection: element.endConnection,
        perTarget,
        endpoint: element.end,
        pathSuffix: `${index}].endConnection`,
        sourceId: element.id,
        context,
      });
    }
    if ((index + 1) % 128 === 0) yield;
  }
  validateConnectionCycles(elements, byId);
}

interface ConnectionValidationInput {
  readonly byId: ReadonlyMap<string, InkElementV1>;
  readonly connection: EndpointConnectionV1 | null;
  readonly context: ValidationContext;
  readonly endpoint: PointV1;
  readonly pathSuffix: string;
  readonly perTarget: Map<string, number>;
  readonly sourceId: string;
}

function validateConnection(input: ConnectionValidationInput): void {
  const { byId, connection, context, endpoint, pathSuffix, perTarget, sourceId } = input;
  if (connection === null) return;
  const path = `$.elements[${pathSuffix}`;
  const target = byId.get(connection.targetId);
  if (connection.targetId === sourceId) {
    fail("invalid-connection-target", `${path}.targetId`, "An element cannot connect to itself.");
  }
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

function validateConnectionCycles(
  elements: readonly InkElementV1[],
  byId: ReadonlyMap<string, InkElementV1>,
): void {
  const dependencies = new Map<string, readonly string[]>();
  const indegree = new Map<string, number>();
  for (const element of elements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    indegree.set(element.id, 0);
    const targets = [element.startConnection?.targetId, element.endConnection?.targetId].filter(
      (id): id is string => {
        const target = id === undefined ? undefined : byId.get(id);
        return target?.kind === "line" || target?.kind === "arrow";
      },
    );
    dependencies.set(element.id, targets);
  }
  for (const targets of dependencies.values()) {
    for (const targetId of targets) indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let processed = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    processed += 1;
    for (const targetId of dependencies.get(id) ?? []) {
      const remaining = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) queue.push(targetId);
    }
  }
  if (processed !== indegree.size) {
    fail(
      "invalid-connection-target",
      "$.elements",
      "Linear endpoint connections must not form a cycle.",
    );
  }
}

function* validateBoundsAndExtent(
  elements: InkElementV1[],
  page: PageV1,
  context: ValidationContext,
): Generator<void, SnapshotValidationDerivations> {
  let maximumBottom: number | null = null;
  let cellMemberships = 0;
  let overflowElements = 0;
  const derivations: ElementValidationDerivation[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as InkElementV1;
    const bounds = Object.freeze(calculateElementBounds(element));
    const memberships = spatialCellMembershipCount(bounds);
    const spatialOverflow = memberships > MAX_ELEMENT_CELLS;
    if (spatialOverflow) overflowElements += 1;
    else cellMemberships += memberships;
    derivations.push(
      Object.freeze({
        bounds,
        elementId: element.id,
        spatialMemberships: spatialOverflow ? 0 : memberships,
        spatialOverflow,
        ...(element.kind === "stroke"
          ? { strokeSampleExtrema: validatedSampleExtrema(element.points)! }
          : {}),
      }),
    );
    maximumBottom = Math.max(maximumBottom ?? 0, bounds.maxY);
    if ((index + 1) % 128 === 0) yield;
  }
  context.statistics.spatialIndexCellMemberships = cellMemberships;
  context.statistics.spatialIndexOverflowElements = overflowElements;
  if (
    cellMemberships > context.limits.spatialIndexCellMemberships ||
    overflowElements > context.limits.spatialIndexOverflowElements
  ) {
    fail(
      "spatial-index-limit-exceeded",
      "$.elements",
      "Spatial-index aggregate capacity exceeds the configured limit.",
    );
  }
  if (context.limits.maximumDerivedHeight !== null) {
    const extent = derivePageExtent(page, maximumBottom);
    if (
      (maximumBottom ?? 0) > context.limits.maximumDerivedHeight ||
      extent.activeHeight > context.limits.maximumDerivedHeight ||
      extent.lockedHeight > context.limits.maximumDerivedHeight
    ) {
      fail("invalid-range", "$.elements", "Maximum derived page height exceeds the limit.");
    }
  }
  return Object.freeze({ elements: Object.freeze(derivations), maximumBottom });
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
