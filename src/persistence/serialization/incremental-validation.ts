import {
  calculateElementBounds,
  derivePageExtent,
  isAnchorTarget,
} from "../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  MAX_DERIVED_HEIGHT,
  validatedElementDerivationBounds,
  type ElementValidationDerivation,
  type InkElementV1,
  type PageV1,
  type ValidationError,
} from "../../domain/schema/public";
import {
  MAX_ELEMENT_CELLS,
  spatialCellMembershipCount,
  type SpatialBounds,
} from "../../domain/spatial/index";

export interface ElementFacts {
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

export function elementFacts(
  element: InkElementV1,
  derivation?: ElementValidationDerivation,
): ElementFacts {
  const bounds =
    derivation === undefined
      ? calculateElementBounds(element)
      : validatedElementDerivationBounds(element, derivation);
  return factsFromBounds(element, bounds);
}

export function validatedDeltaElementFacts(
  element: InkElementV1,
  derivation?: ElementValidationDerivation,
): ElementFacts {
  if (derivation === undefined) return elementFacts(element);
  const derivedBounds = validatedElementDerivationBounds(element, derivation);
  const calculatedBounds = calculateElementBounds(element);
  if (!sameBounds(derivedBounds, calculatedBounds)) {
    throw new TypeError("Element derivation does not match its geometry.");
  }
  return factsFromBounds(element, derivedBounds);
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

function sameBounds(left: Readonly<SpatialBounds>, right: Readonly<SpatialBounds>): boolean {
  return (
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY
  );
}

export function aggregateElementFacts(facts: Iterable<ElementFacts>): AggregateFacts {
  const aggregate = mutableAggregate();
  for (const fact of facts) addFact(aggregate, fact, 1);
  return aggregate;
}

export function emptyAggregateFacts(): AggregateFacts {
  return mutableAggregate();
}

export function updateAggregateFacts(
  current: AggregateFacts,
  existing: ReadonlyMap<string, ElementFacts>,
  changed: ReadonlyMap<string, ElementFacts>,
  removed: ReadonlySet<string>,
): AggregateFacts {
  const aggregate = { ...current };
  for (const id of removed) {
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
  }
  if (aggregate.maximumBottomCount === 0 && aggregate.elements > 0) {
    const extent = recomputeMaximumBottom(existing, changed, removed);
    aggregate.maximumBottom = extent.bottom;
    aggregate.maximumBottomCount = extent.count;
  } else if (aggregate.elements === 0) {
    aggregate.maximumBottom = null;
  }
  return aggregate;
}

export function connectionRelationsAffected(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
): boolean {
  const changedTargets = collectChangedAnchorTargets(currentElements, changed, removed);
  if (changedTargets === null) return true;
  return changedTargets.size > 0 && hasConnectionToTarget(currentElements, changedTargets);
}

function collectChangedAnchorTargets(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
): ReadonlySet<string> | null {
  const changedTargets = new Set<string>();
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
  }
  for (const id of removed) {
    const current = currentElements.get(id);
    if (current === undefined) continue;
    if (hasEndpointConnection(current)) return null;
    if (isAnchorTarget(current)) changedTargets.add(id);
  }
  return changedTargets;
}

function hasConnectionToTarget(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changedTargets: ReadonlySet<string>,
): boolean {
  for (const element of currentElements.values()) {
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

function recomputeMaximumBottom(
  existing: ReadonlyMap<string, ElementFacts>,
  changed: ReadonlyMap<string, ElementFacts>,
  removed: ReadonlySet<string>,
): { readonly bottom: number | null; readonly count: number } {
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
  for (const [id, fact] of existing) {
    if (!changed.has(id) && !removed.has(id)) include(fact);
  }
  for (const fact of changed.values()) include(fact);
  return { bottom, count };
}

function hasEndpointConnection(element: InkElementV1): boolean {
  if (element.kind !== "line" && element.kind !== "arrow") return false;
  return element.startConnection !== null || element.endConnection !== null;
}

function connectionCount(element: InkElementV1): number {
  if (element.kind !== "line" && element.kind !== "arrow") return 0;
  return Number(element.startConnection !== null) + Number(element.endConnection !== null);
}
