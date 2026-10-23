import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import { calculateElementBoundsSteps } from "../../../domain/geometry/bounds";
import type { StrokeElementV1 } from "../../../domain/schema/public";
import { assertSpatialBounds } from "../../../domain/spatial/bounds";
import {
  calculateElementBounds,
  derivePageExtent,
  isAnchorTarget,
} from "../../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  MAX_DERIVED_HEIGHT,
  validatedElementDerivationBounds,
  type ElementValidationDerivation,
  type InkElementV1,
  type PageV1,
  type ValidationError,
} from "../../../domain/schema/public";
import {
  MAX_ELEMENT_CELLS,
  spatialCellMembershipCount,
  type SpatialBounds,
} from "../../../domain/spatial/index";

export interface ElementFacts {
  readonly strokeGeometry?: {
    readonly local: StrokeElementV1;
    readonly bounds: Readonly<SpatialBounds>;
  };
  readonly bottom: number;
  readonly connectedEndpoints: number;
  readonly spatialMemberships: number;
  readonly spatialOverflow: number;
  readonly strokePoints: number;
  readonly strokes: number;
}

export interface AggregateFacts {
  readonly connectedEndpoints: number;
  readonly elements: number;
  readonly maximumBottom: number | null;
  readonly maximumBottomCount: number;
  readonly spatialMemberships: number;
  readonly spatialOverflow: number;
  readonly strokePoints: number;
  readonly strokes: number;
}

export interface ValidatedDeltaFacts {
  readonly aggregate: AggregateFacts;
  readonly changed: ReadonlyMap<string, ElementFacts>;
}

export function* elementFactsSteps(
  element: InkElementV1,
  derivation?: ElementValidationDerivation,
  samplesPerStep = 256,
): Generator<void, ElementFacts> {
  if (element.kind === "stroke") {
    if (derivation !== undefined)
      return yield* validatedStrokeFacts(element, derivation, samplesPerStep);
    return yield* strokeFacts(element, undefined, samplesPerStep);
  }
  const bounds =
    derivation === undefined
      ? yield* boundsSteps(element, samplesPerStep)
      : validatedElementDerivationBounds(element, derivation);
  return factsFromBounds(element, bounds);
}

function* validatedStrokeFacts(
  stroke: StrokeElementV1,
  derivation: ElementValidationDerivation,
  samplesPerStep: number,
): Generator<void, ElementFacts> {
  const worldBounds = validatedElementDerivationBounds(stroke, derivation);
  const local = strokeLocalGeometry(stroke);
  const bounds =
    derivation.strokeLocalBounds ??
    (stroke.offset === undefined ? worldBounds : yield* boundsSteps(local, samplesPerStep));
  assertSpatialBounds(bounds);
  const x = stroke.offset?.x ?? 0;
  const y = stroke.offset?.y ?? 0;
  if (
    bounds.minX + x !== worldBounds.minX ||
    bounds.minY + y !== worldBounds.minY ||
    bounds.maxX + x !== worldBounds.maxX ||
    bounds.maxY + y !== worldBounds.maxY
  )
    throw new TypeError("Stroke local bounds do not match their validated placement.");
  return { ...factsFromBounds(stroke, worldBounds), strokeGeometry: { local, bounds } };
}

export function* validatedDeltaElementFactsSteps(
  element: InkElementV1,
  derivation?: ElementValidationDerivation,
  previous?: ElementFacts,
  samplesPerStep = 256,
): Generator<void, ElementFacts> {
  if (element.kind === "stroke") {
    if (derivation !== undefined) validatedElementDerivationBounds(element, derivation);
    return yield* strokeFacts(element, previous, samplesPerStep);
  }
  if (derivation === undefined) return yield* elementFactsSteps(element, undefined, samplesPerStep);
  validatedElementDerivationBounds(element, derivation);
  const calculatedBounds = yield* boundsSteps(element, samplesPerStep);
  // Translating retained bounds and recomputing translated geometry can round differently.
  // A mismatched hint never supplies capacity facts; use the canonical recomputation.
  return factsFromBounds(element, calculatedBounds);
}

function* strokeFacts(
  stroke: StrokeElementV1,
  previous: ElementFacts | undefined,
  samplesPerStep: number,
): Generator<void, ElementFacts> {
  const local = strokeLocalGeometry(stroke);
  const cached = previous?.strokeGeometry;
  const old = cached?.local;
  const reusable =
    old !== undefined &&
    old.points === local.points &&
    old.rotation === local.rotation &&
    old.style.width === local.style.width &&
    old.tool === local.tool &&
    (local.rotation === 0 || (old.pivot.x === local.pivot.x && old.pivot.y === local.pivot.y));
  const bounds = reusable ? cached!.bounds : yield* boundsSteps(local, samplesPerStep);
  const x = stroke.offset?.x ?? 0;
  const y = stroke.offset?.y ?? 0;
  const translated = {
    minX: bounds.minX + x,
    minY: bounds.minY + y,
    maxX: bounds.maxX + x,
    maxY: bounds.maxY + y,
  };
  return { ...factsFromBounds(stroke, translated), strokeGeometry: { local, bounds } };
}

function factsFromBounds(element: InkElementV1, bounds: Readonly<SpatialBounds>): ElementFacts {
  const memberships = spatialCellMembershipCount(bounds);
  const spatialOverflow = Number(memberships > MAX_ELEMENT_CELLS);
  return {
    bottom: bounds.maxY,
    connectedEndpoints: connectionCount(element),
    spatialMemberships: spatialOverflow === 0 ? memberships : 0,
    spatialOverflow,
    strokePoints: element.kind === "stroke" ? element.points.length / 3 : 0,
    strokes: Number(element.kind === "stroke"),
  };
}

export function* aggregateElementFactsSteps(
  facts: Iterable<ElementFacts>,
  nodesPerStep = 256,
): Generator<void, AggregateFacts> {
  const aggregate = mutableAggregate();
  let visited = 0;
  for (const fact of facts) {
    addFact(aggregate, fact, 1);
    if (++visited % nodesPerStep === 0) yield;
  }
  return aggregate;
}

export function emptyAggregateFacts(): AggregateFacts {
  return mutableAggregate();
}

export function* updateAggregateFactsSteps(
  current: AggregateFacts,
  existing: ReadonlyMap<string, ElementFacts>,
  changed: ReadonlyMap<string, ElementFacts>,
  removed: ReadonlySet<string>,
  nodesPerStep = 256,
): Generator<void, AggregateFacts> {
  const aggregate = { ...current };
  let visited = 0;
  for (const id of removed) {
    if (++visited % nodesPerStep === 0) yield;
    const fact = existing.get(id);
    if (fact === undefined) continue;
    addFact(aggregate, fact, -1);
  }
  for (const [id, fact] of changed) {
    const previous = existing.get(id);
    if (previous !== undefined) {
      addFact(aggregate, previous, -1);
    }
    addFact(aggregate, fact, 1);
    if (++visited % nodesPerStep === 0) yield;
  }
  if (aggregate.maximumBottomCount === 0 && aggregate.elements > 0) {
    const extent = yield* recomputeMaximumBottom(existing, changed, removed, nodesPerStep);
    aggregate.maximumBottom = extent.bottom;
    aggregate.maximumBottomCount = extent.count;
  } else if (aggregate.elements === 0) {
    aggregate.maximumBottom = null;
  }
  return aggregate;
}

export function* connectionRelationsAffectedSteps(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  nodesPerStep = 256,
): Generator<void, boolean> {
  const changedTargets = yield* collectChangedAnchorTargets(
    currentElements,
    changed,
    removed,
    nodesPerStep,
  );
  if (changedTargets === null) return true;
  return (
    changedTargets.size > 0 &&
    (yield* hasConnectionToTarget(currentElements, changedTargets, nodesPerStep))
  );
}

function* collectChangedAnchorTargets(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, ReadonlySet<string> | null> {
  const changedTargets = new Set<string>();
  let visited = 0;
  for (const element of changed.values()) {
    const current = currentElements.get(element.id);
    if (
      hasEndpointConnection(element) ||
      (current !== undefined && hasEndpointConnection(current))
    ) {
      return null;
    }
    if (isAnchorTarget(element) || (current !== undefined && isAnchorTarget(current))) {
      changedTargets.add(element.id);
    }
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const id of removed) {
    if (++visited % nodesPerStep === 0) yield;
    const current = currentElements.get(id);
    if (current === undefined) continue;
    if (hasEndpointConnection(current)) return null;
    if (isAnchorTarget(current)) changedTargets.add(id);
  }
  return changedTargets;
}

function* hasConnectionToTarget(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changedTargets: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, boolean> {
  let visited = 0;
  for (const element of currentElements.values()) {
    if (++visited % nodesPerStep === 0) yield;
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    const startTarget = element.startConnection?.targetId;
    const endTarget = element.endConnection?.targetId;
    if (
      (startTarget !== undefined && changedTargets.has(startTarget)) ||
      (endTarget !== undefined && changedTargets.has(endTarget))
    ) {
      return true;
    }
  }
  return false;
}

export function validateAggregateFacts(
  facts: AggregateFacts,
  page: PageV1,
): ValidationError | null {
  if (facts.elements > FILE_SCHEMA_LIMITS.elements) {
    return validationError("element-limit-exceeded", "Element count exceeds the limit.");
  }
  if (facts.strokes > FILE_SCHEMA_LIMITS.strokes) {
    return validationError("stroke-limit-exceeded", "Freehand stroke count exceeds the limit.");
  }
  if (facts.strokePoints > FILE_SCHEMA_LIMITS.strokePoints) {
    return validationError("stroke-point-limit-exceeded", "Stroke point count exceeds the limit.");
  }
  if (facts.connectedEndpoints > FILE_SCHEMA_LIMITS.connectedEndpoints) {
    return validationError(
      "connection-limit-exceeded",
      "Connected endpoint count exceeds the limit.",
    );
  }
  if (
    facts.spatialMemberships > FILE_SCHEMA_LIMITS.spatialIndexCellMemberships ||
    facts.spatialOverflow > FILE_SCHEMA_LIMITS.spatialIndexOverflowElements
  ) {
    return validationError(
      "spatial-index-limit-exceeded",
      "Spatial-index aggregate capacity exceeds the configured limit.",
    );
  }
  const extent = derivePageExtent(page, facts.maximumBottom);
  if (
    (facts.maximumBottom ?? 0) > MAX_DERIVED_HEIGHT ||
    extent.activeHeight > MAX_DERIVED_HEIGHT ||
    extent.lockedHeight > MAX_DERIVED_HEIGHT
  ) {
    return validationError("invalid-range", "Maximum derived page height exceeds the limit.");
  }
  return null;
}

function validationError(code: ValidationError["code"], message: string): ValidationError {
  return { code, message, path: "$.elements" };
}

function mutableAggregate(): {
  elements: number;
  connectedEndpoints: number;
  maximumBottom: number | null;
  maximumBottomCount: number;
  spatialMemberships: number;
  spatialOverflow: number;
  strokePoints: number;
  strokes: number;
} {
  return {
    connectedEndpoints: 0,
    elements: 0,
    maximumBottom: null,
    maximumBottomCount: 0,
    spatialMemberships: 0,
    spatialOverflow: 0,
    strokePoints: 0,
    strokes: 0,
  };
}

function addFact(aggregate: ReturnType<typeof mutableAggregate>, fact: ElementFacts, sign: 1 | -1) {
  aggregate.elements += sign;
  aggregate.connectedEndpoints += sign * fact.connectedEndpoints;
  aggregate.spatialMemberships += sign * fact.spatialMemberships;
  aggregate.spatialOverflow += sign * fact.spatialOverflow;
  aggregate.strokePoints += sign * fact.strokePoints;
  aggregate.strokes += sign * fact.strokes;
  if (sign === -1) {
    if (fact.bottom === aggregate.maximumBottom) aggregate.maximumBottomCount -= 1;
    return;
  }
  if (aggregate.maximumBottom === null || fact.bottom > aggregate.maximumBottom) {
    aggregate.maximumBottom = fact.bottom;
    aggregate.maximumBottomCount = 1;
  } else if (fact.bottom === aggregate.maximumBottom) {
    aggregate.maximumBottomCount += 1;
  }
}

function* recomputeMaximumBottom(
  existing: ReadonlyMap<string, ElementFacts>,
  changed: ReadonlyMap<string, ElementFacts>,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, { readonly bottom: number | null; readonly count: number }> {
  let bottom: number | null = null;
  let count = 0;
  const include = (fact: ElementFacts) => {
    if (bottom === null || fact.bottom > bottom) {
      bottom = fact.bottom;
      count = 1;
    } else if (fact.bottom === bottom) {
      count += 1;
    }
  };
  let visited = 0;
  for (const [id, fact] of existing) {
    if (!changed.has(id) && !removed.has(id)) include(fact);
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const fact of changed.values()) {
    include(fact);
    if (++visited % nodesPerStep === 0) yield;
  }
  return { bottom, count };
}

function* boundsSteps(element: InkElementV1, samplesPerStep: number) {
  return Number.isFinite(samplesPerStep)
    ? yield* calculateElementBoundsSteps(element, samplesPerStep)
    : calculateElementBounds(element);
}

function hasEndpointConnection(element: InkElementV1): boolean {
  if (element.kind !== "line" && element.kind !== "arrow") return false;
  return element.startConnection !== null || element.endConnection !== null;
}

function connectionCount(element: InkElementV1): number {
  if (element.kind !== "line" && element.kind !== "arrow") return 0;
  return Number(element.startConnection !== null) + Number(element.endConnection !== null);
}
