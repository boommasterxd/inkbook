import type { InkElementV1, PageV1 } from "../../domain/schema/public";
import { calculateElementBoundsSteps } from "../../domain/geometry/bounds";
import { derivePageExtent } from "../../domain/geometry/public";
import {
  MAX_ELEMENT_CELLS,
  measureSpatialCapacitySteps,
  spatialCellMembershipCount,
  type SpatialBounds,
} from "../../domain/spatial/index";
import type { AggregateFacts } from "../serialization/output/incremental-validation";
import { DOCUMENT_LIMITS } from "./constants";
import type { ClipboardResult, ElementBounds } from "./types";

const failure = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "limit-exceeded", message },
});

export function* countDocumentLimitsSteps(
  existing: readonly InkElementV1[],
  inserted: readonly InkElementV1[],
  page: PageV1,
  insertedBounds?: readonly ElementBounds[],
): Generator<void, ClipboardResult<void>> {
  if (existing.length + inserted.length > DOCUMENT_LIMITS.elements)
    return failure("Document element limit is exceeded.");
  let strokes = 0;
  let points = 0;
  let endpoints = 0;
  let maximumBottom: number | null = null;
  const fanout = new Map<string, number>();
  const spatialBounds: SpatialBounds[] = [];
  for (let index = 0; index < existing.length + inserted.length; index += 1) {
    const { element, bounds } = yield* documentElementBoundsSteps(
      existing,
      inserted,
      index,
      insertedBounds,
    );
    if (element.kind === "stroke") {
      strokes += 1;
      points += element.points.length / 3;
    }
    if (element.kind === "line" || element.kind === "arrow") {
      for (const connection of [element.startConnection, element.endConnection]) {
        if (connection === null) continue;
        endpoints += 1;
        fanout.set(connection.targetId, (fanout.get(connection.targetId) ?? 0) + 1);
      }
    }
    spatialBounds.push(bounds);
    maximumBottom = Math.max(maximumBottom ?? bounds.maxY, bounds.maxY);
    yield;
  }
  if (strokes > DOCUMENT_LIMITS.strokes || points > DOCUMENT_LIMITS.strokePoints) {
    return failure("Document stroke limits are exceeded.");
  }
  if (endpoints > DOCUMENT_LIMITS.connectedEndpoints) {
    return failure("Document connected-endpoint limit is exceeded.");
  }
  for (const count of fanout.values()) {
    if (count > DOCUMENT_LIMITS.connectedEndpointsPerTarget)
      return failure("Document per-target connected-endpoint limit is exceeded.");
    yield;
  }
  const spatial = yield* measureSpatialCapacitySteps(spatialBounds);
  if (
    spatial.cellMemberships > DOCUMENT_LIMITS.spatialIndexCellMemberships ||
    spatial.overflowElements > DOCUMENT_LIMITS.spatialIndexOverflowElements
  ) {
    return failure("Document spatial-index capacity limits are exceeded.");
  }
  const extent = derivePageExtent(page, maximumBottom);
  if (extent.activeHeight > (DOCUMENT_LIMITS.maximumDerivedHeight ?? Infinity)) {
    return failure("Document maximum derived height is exceeded.");
  }
  return { ok: true, value: undefined };
}

function* documentElementBoundsSteps(
  existing: readonly InkElementV1[],
  inserted: readonly InkElementV1[],
  index: number,
  insertedBounds: readonly ElementBounds[] | undefined,
): Generator<void, { readonly element: InkElementV1; readonly bounds: ElementBounds }> {
  const retained = index < existing.length;
  const element = retained ? existing[index]! : inserted[index - existing.length]!;
  const bounds = retained
    ? yield* calculateElementBoundsSteps(element)
    : (insertedBounds?.[index - existing.length] ?? (yield* calculateElementBoundsSteps(element)));
  return { element, bounds };
}

export function* countValidatedDocumentLimitsSteps(
  existing: Readonly<AggregateFacts>,
  inserted: readonly InkElementV1[],
  page: PageV1,
  insertedBounds?: readonly ElementBounds[],
): Generator<void, ClipboardResult<void>> {
  if (existing.elements + inserted.length > DOCUMENT_LIMITS.elements) {
    return failure("Document element limit is exceeded.");
  }
  let strokes = existing.strokes;
  let points = existing.strokePoints;
  let endpoints = existing.connectedEndpoints;
  let memberships = existing.spatialMemberships;
  let overflow = existing.spatialOverflow;
  let maximumBottom = existing.maximumBottom;
  const insertedEndpoints = yield* countInsertedConnectionsSteps(inserted);
  if (!insertedEndpoints.ok) return insertedEndpoints;
  endpoints += insertedEndpoints.value;
  if (endpoints > DOCUMENT_LIMITS.connectedEndpoints) {
    return failure("Document connected-endpoint limit is exceeded.");
  }
  for (let index = 0; index < inserted.length; index += 1) {
    const element = inserted[index]!;
    if (element.kind === "stroke") {
      strokes += 1;
      points += element.points.length / 3;
    }
    const bounds = insertedBounds?.[index] ?? (yield* calculateElementBoundsSteps(element));
    const cells = spatialCellMembershipCount(bounds);
    if (cells > MAX_ELEMENT_CELLS) overflow += 1;
    else memberships += cells;
    maximumBottom = Math.max(maximumBottom ?? bounds.maxY, bounds.maxY);
    yield;
  }
  if (strokes > DOCUMENT_LIMITS.strokes || points > DOCUMENT_LIMITS.strokePoints) {
    return failure("Document stroke limits are exceeded.");
  }
  if (
    memberships > DOCUMENT_LIMITS.spatialIndexCellMemberships ||
    overflow > DOCUMENT_LIMITS.spatialIndexOverflowElements
  ) {
    return failure("Document spatial-index capacity limits are exceeded.");
  }
  if (
    derivePageExtent(page, maximumBottom).activeHeight >
    (DOCUMENT_LIMITS.maximumDerivedHeight ?? Infinity)
  ) {
    return failure("Document maximum derived height is exceeded.");
  }
  return { ok: true, value: undefined };
}

function* countInsertedConnectionsSteps(
  inserted: readonly InkElementV1[],
): Generator<void, ClipboardResult<number>> {
  let endpoints = 0;
  const insertedFanout = new Map<string, number>();
  for (const element of inserted) {
    if (element.kind === "line" || element.kind === "arrow") {
      for (const connection of [element.startConnection, element.endConnection]) {
        if (connection === null) continue;
        endpoints += 1;
        const count = (insertedFanout.get(connection.targetId) ?? 0) + 1;
        if (count > DOCUMENT_LIMITS.connectedEndpointsPerTarget) {
          return failure("Document per-target connected-endpoint limit is exceeded.");
        }
        insertedFanout.set(connection.targetId, count);
      }
    }
    yield;
  }
  return { ok: true, value: endpoints };
}
