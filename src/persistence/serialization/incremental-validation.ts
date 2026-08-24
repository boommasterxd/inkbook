import { calculateElementBounds, derivePageExtent } from "../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  MAX_DERIVED_HEIGHT,
  type InkElementV1,
  type PageV1,
  type ValidationError,
} from "../../domain/schema/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../domain/spatial/index";

export interface ElementFacts {
  readonly bottom: number;
  readonly spatialMemberships: number;
  readonly spatialOverflow: number;
  readonly strokePoints: number;
  readonly strokes: number;
}

export interface AggregateFacts {
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

export function elementFacts(element: InkElementV1): ElementFacts {
  const bounds = calculateElementBounds(element);
  const memberships = spatialCellMembershipCount(bounds);
  const spatialOverflow = Number(memberships > MAX_ELEMENT_CELLS);
  return {
    bottom: bounds.maxY,
    spatialMemberships: spatialOverflow === 0 ? memberships : 0,
    spatialOverflow,
    strokePoints: element.kind === "stroke" ? element.points.length / 3 : 0,
    strokes: Number(element.kind === "stroke"),
  };
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
  currentElements: Iterable<InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
): boolean {
  for (const element of changed.values()) {
    if (hasEndpointConnection(element)) return true;
  }
  for (const element of currentElements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    if ((changed.has(element.id) || removed.has(element.id)) && hasEndpointConnection(element)) {
      return true;
    }
    const startTarget = element.startConnection?.targetId;
    const endTarget = element.endConnection?.targetId;
    if (
      (startTarget !== undefined && (changed.has(startTarget) || removed.has(startTarget))) ||
      (endTarget !== undefined && (changed.has(endTarget) || removed.has(endTarget)))
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
  maximumBottom: number | null;
  maximumBottomCount: number;
  spatialMemberships: number;
  spatialOverflow: number;
  strokePoints: number;
  strokes: number;
} {
  return {
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
