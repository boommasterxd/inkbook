import {
  canonicalPoint,
  linearPivot,
  pointDistance,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type {
  EndpointConnectionV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
} from "../../domain/schema/public";

import { normalizeLinearBend } from "./linear-bend";
import { isLinearElement } from "./linear-elements";

export interface LinearEndpointEditOptions {
  readonly connection?: EndpointConnectionV1 | null;
  readonly straightTolerance?: number;
}

export function rotateLinearElement(
  element: LinearElementV1,
  center: PointV1,
  degrees: number,
  selectedIds: ReadonlySet<string>,
): LinearElementV1 {
  const world = (point: PointV1): PointV1 =>
    rotatePointClockwise(point, element.pivot, element.rotation);
  const rotateEndpoint = (endpoint: "start" | "end"): PointV1 => {
    const connection = connectionAt(element, endpoint);
    const point = world(element[endpoint]);
    return connection === null || selectedIds.has(connection.targetId)
      ? canonicalPoint(rotatePointClockwise(point, center, degrees))
      : canonicalPoint(point);
  };
  const start = rotateEndpoint("start");
  const end = rotateEndpoint("end");
  const bend =
    element.bend === null
      ? null
      : canonicalPoint(rotatePointClockwise(world(element.bend), center, degrees));
  return { ...element, bend, end, pivot: linearPivot(start, end, bend), rotation: 0, start };
}

export function editLinearEndpoint(
  element: InkElementV1,
  endpoint: "start" | "end",
  point: PointV1,
  options: LinearEndpointEditOptions = {},
): InkElementV1 {
  if (!isLinearElement(element)) throw new TypeError("Endpoint editing requires a linear element.");
  assertFinitePoint(point);
  const opposite = endpoint === "start" ? element.end : element.start;
  if (pointDistance(point, opposite) < 8) {
    throw new RangeError("Linear elements must remain at least 8 page units long.");
  }
  const canonicalEndpoint = canonicalPoint(point);
  const start = endpoint === "start" ? canonicalEndpoint : element.start;
  const end = endpoint === "end" ? canonicalEndpoint : element.end;
  const normalizedExistingBend = normalizeLinearBend(element.start, element.end, element.bend);
  const bend = normalizeEditedBend(start, end, normalizedExistingBend, options.straightTolerance);
  const replacement: LinearElementV1 = {
    ...element,
    [endpoint]: canonicalEndpoint,
    bend,
    pivot: linearPivot(start, end, bend),
  };
  if (element.kind === "straight-highlighter") return replacement;
  return {
    ...replacement,
    [endpoint === "start" ? "startConnection" : "endConnection"]: options.connection ?? null,
  };
}

export function editLinearEndpointFromWorld(
  element: LinearElementV1,
  endpoint: "start" | "end",
  point: PointV1,
  options: LinearEndpointEditOptions = {},
): LinearElementV1 {
  const worldStart = rotatePointClockwise(element.start, element.pivot, element.rotation);
  const worldEnd = rotatePointClockwise(element.end, element.pivot, element.rotation);
  const worldBend =
    element.bend === null
      ? null
      : rotatePointClockwise(element.bend, element.pivot, element.rotation);
  const worldElement: LinearElementV1 = {
    ...element,
    bend: worldBend,
    end: worldEnd,
    pivot: linearPivot(worldStart, worldEnd, worldBend),
    rotation: 0,
    start: worldStart,
  };
  return editLinearEndpoint(worldElement, endpoint, point, options) as LinearElementV1;
}

function normalizeEditedBend(
  start: PointV1,
  end: PointV1,
  bend: PointV1 | null,
  tolerance: number | undefined,
): PointV1 | null {
  return tolerance === undefined
    ? normalizeLinearBend(start, end, bend)
    : normalizeLinearBend(start, end, bend, tolerance);
}

function connectionAt(
  element: LinearElementV1,
  endpoint: "start" | "end",
): EndpointConnectionV1 | null {
  if (element.kind === "straight-highlighter") return null;
  return endpoint === "start" ? element.startConnection : element.endConnection;
}

function assertFinitePoint(point: PointV1): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Points must be finite.");
  }
}
