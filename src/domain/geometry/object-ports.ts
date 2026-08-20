import type {
  AreaGeometryV1,
  ElementId,
  NotePointV1,
  ObjectPortAttachmentV1,
  ObjectPortIdV1,
  SceneElementV1,
} from "../model";
import type { GeometryProjectionV1, GeometryResultV1 } from "./projection";
import {
  geometryFailureV1,
  geometrySuccessV1,
  isFiniteAreaV1,
  isFinitePointV1,
  materializeGeometryPointV1,
  validateProjectionV1,
} from "./projection";

export type ElementLookupV1 = (
  elementId: ElementId,
) => SceneElementV1 | undefined;

export interface ObjectPortResolutionInputV1 {
  readonly attachment: ObjectPortAttachmentV1;
  readonly getElement: ElementLookupV1;
  readonly projection: GeometryProjectionV1;
}

export interface LinearEndpointResolutionInputV1 {
  readonly element: SceneElementV1;
  readonly getElement: ElementLookupV1;
  readonly projection: GeometryProjectionV1;
}

export interface ResolvedLinearEndpointsV1 {
  readonly start: NotePointV1;
  readonly end: NotePointV1;
}

const AREA_PORTS = new Set<ObjectPortIdV1>([
  "area:north",
  "area:east",
  "area:south",
  "area:west",
]);
const AXES_2D_PORTS = new Set<ObjectPortIdV1>([
  "axes:origin",
  "axes:x-positive",
  "axes:y-positive",
]);
const AXES_3D_PORTS = new Set<ObjectPortIdV1>([
  ...AXES_2D_PORTS,
  "axes:z-positive",
]);
const HALF = 2;

function localAreaPort(
  kind: SceneElementV1["kind"],
  portId: ObjectPortIdV1,
  area: AreaGeometryV1,
): NotePointV1 {
  const halfWidth = area.width / HALF;
  const halfHeight = area.height / HALF;
  const triangleWidth = kind === "triangle" ? halfWidth / HALF : halfWidth;
  switch (portId) {
    case "area:north":
      return { x: 0, y: -halfHeight };
    case "area:east":
      return { x: triangleWidth, y: 0 };
    case "area:south":
      return { x: 0, y: halfHeight };
    case "area:west":
      return { x: -triangleWidth, y: 0 };
    default:
      return { x: Number.NaN, y: Number.NaN };
  }
}

function transformAreaPoint(
  area: AreaGeometryV1,
  local: NotePointV1,
): NotePointV1 {
  const cosine = Math.cos(area.rotationRadians);
  const sine = Math.sin(area.rotationRadians);
  return {
    x: area.center.x + local.x * cosine + local.y * sine,
    y: area.center.y - local.x * sine + local.y * cosine,
  };
}

function resolveAreaPort(
  target: SceneElementV1,
  portId: ObjectPortIdV1,
  projection: GeometryProjectionV1,
): GeometryResultV1<NotePointV1> {
  if (!AREA_PORTS.has(portId)) {
    return geometryFailureV1("port-incompatible");
  }
  if (
    target.kind !== "rectangle" &&
    target.kind !== "ellipse" &&
    target.kind !== "triangle" &&
    target.kind !== "diamond" &&
    target.kind !== "octagon" &&
    target.kind !== "table"
  ) {
    return geometryFailureV1("target-kind-unsupported");
  }
  const area = projection.projectArea(target, target.geometry);
  if (area === null || !isFiniteAreaV1(area)) {
    return geometryFailureV1("projection-invalid");
  }
  const point = transformAreaPoint(
    area,
    localAreaPort(target.kind, portId, area),
  );
  return isFinitePointV1(point)
    ? geometrySuccessV1(materializeGeometryPointV1(point))
    : geometryFailureV1("projection-invalid");
}

function resolveAxesPort(
  target: SceneElementV1,
  portId: ObjectPortIdV1,
  projection: GeometryProjectionV1,
): GeometryResultV1<NotePointV1> {
  if (target.kind !== "axes-2d" && target.kind !== "axes-3d") {
    return geometryFailureV1("target-kind-unsupported");
  }
  const validPorts = target.kind === "axes-3d" ? AXES_3D_PORTS : AXES_2D_PORTS;
  if (!validPorts.has(portId)) {
    return geometryFailureV1("port-incompatible");
  }
  let vector = { x: 0, y: 0 };
  if (portId === "axes:x-positive") {
    vector = target.geometry.xAxis;
  } else if (portId === "axes:y-positive") {
    vector = target.geometry.yAxis;
  } else if (portId === "axes:z-positive" && target.kind === "axes-3d") {
    vector = target.geometry.zAxis;
  }
  const canonical = {
    x: target.geometry.origin.x + vector.x,
    y: target.geometry.origin.y + vector.y,
  };
  const point = projection.projectPoint(target, canonical);
  return point !== null && isFinitePointV1(point)
    ? geometrySuccessV1(materializeGeometryPointV1(point))
    : geometryFailureV1("projection-invalid");
}

function resolvePortUnchecked(
  attachment: ObjectPortAttachmentV1,
  getElement: ElementLookupV1,
  projection: GeometryProjectionV1,
): GeometryResultV1<NotePointV1> {
  const target = getElement(attachment.targetElementId);
  if (target === undefined) {
    return geometryFailureV1("target-not-found");
  }
  return attachment.portId.startsWith("area:")
    ? resolveAreaPort(target, attachment.portId, projection)
    : resolveAxesPort(target, attachment.portId, projection);
}

export function resolveObjectPortV1(
  input: ObjectPortResolutionInputV1,
): GeometryResultV1<NotePointV1> {
  const validation = validateProjectionV1(input.projection);
  return validation.ok
    ? resolvePortUnchecked(input.attachment, input.getElement, input.projection)
    : validation;
}

export function resolveLinearEndpointsV1(
  input: LinearEndpointResolutionInputV1,
): GeometryResultV1<ResolvedLinearEndpointsV1> {
  if (input.element.kind !== "line" && input.element.kind !== "arrow") {
    return geometryFailureV1("target-kind-unsupported");
  }
  const validation = validateProjectionV1(input.projection);
  if (!validation.ok) {
    return validation;
  }
  const resolveEndpoint = (
    endpoint: typeof input.element.geometry.start,
  ): GeometryResultV1<NotePointV1> => {
    if (endpoint.attachment !== null) {
      return resolvePortUnchecked(
        endpoint.attachment,
        input.getElement,
        input.projection,
      );
    }
    const point = input.projection.projectPoint(
      input.element,
      endpoint.fallbackPoint,
    );
    return point !== null && isFinitePointV1(point)
      ? geometrySuccessV1(materializeGeometryPointV1(point))
      : geometryFailureV1("projection-invalid");
  };
  const start = resolveEndpoint(input.element.geometry.start);
  if (!start.ok) {
    return start;
  }
  const end = resolveEndpoint(input.element.geometry.end);
  return end.ok
    ? geometrySuccessV1(Object.freeze({ start: start.value, end: end.value }))
    : end;
}
